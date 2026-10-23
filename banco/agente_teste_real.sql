-- Teste real do agente no WhatsApp da empresa do cliente.
-- O cliente lê um QR Code com o WhatsApp da empresa (WhatsApp na nuvem, como na implantação)
-- e o agente responde SÓ o número que ele escolheu para testar. Os outros clientes não são atendidos
-- e nada das conversas da empresa é guardado. Cada teste usa um "inquilino" escondido (oticas.plano = 'teste').

-- o plano 'teste' marca o inquilino escondido de cada teste real
alter table oticas drop constraint if exists oticas_plano_check;
alter table oticas add constraint oticas_plano_check check (plano = any (array['basico','premium','empresa','teste']));

alter table agente_testes
  add column if not exists modo text not null default 'simulado',
  add column if not exists tel_teste text,
  add column if not exists otica_id uuid references oticas(id) on delete set null,
  add column if not exists cod text,
  add column if not exists pedido_modo text,
  add column if not exists pedido_tel_teste text;
create unique index if not exists agente_testes_cod on agente_testes(cod) where cod is not null;

-- o teste simulado (cliente fala com o número do CRM) não vale para os testes reais
create or replace function agente_teste_de(p_tel text) returns uuid
language sql stable security definer set search_path = public as $$
  select id from agente_testes where ativo and modo = 'simulado' and (expira_em is null or expira_em > now())
    and length(right(regexp_replace(coalesce(p_tel,''),'\D','','g'),8)) = 8
    and right(telefone,8) = right(regexp_replace(coalesce(p_tel,''),'\D','','g'),8) limit 1
$$;

-- é um inquilino de teste? (WhatsApp de cliente ligado só para o teste)
create or replace function teste_real_otica(p_otica uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from oticas where id = p_otica and plano = 'teste')
$$;

-- o teste real ligado nesse WhatsApp para esse número (o único que o agente responde)
create or replace function teste_real_permite(p_otica uuid, p_tel text) returns uuid
language sql stable security definer set search_path = public as $$
  select id from agente_testes where otica_id = p_otica and modo = 'real' and ativo
    and (expira_em is null or expira_em > now())
    and length(right(regexp_replace(coalesce(p_tel,''),'\D','','g'),8)) = 8
    and right(coalesce(tel_teste,''),8) = right(regexp_replace(coalesce(p_tel,''),'\D','','g'),8) limit 1
$$;

create or replace function agente_teste_desligar_nuvem(p_otica uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_otica is null then return; end if;
  update wa_nuvem set ativo = false where id = 'otica:' || p_otica;
  update oticas set ativa = false where id = p_otica and plano = 'teste';
  update wa_fila set status = 'cancelada', erro = 'teste desligado' where otica_id = p_otica and status in ('aguardando', 'aprovar');
end $$;

-- liga o teste real: cria (ou reaproveita) o inquilino de teste, liga o WhatsApp na nuvem e manda o link do QR Code ao cliente
create or replace function agente_teste_real_ligar(p_id uuid, p_tel_teste text, p_min integer default null, p_avisar boolean default true)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare t agente_testes; o uuid; tk text; d text := regexp_replace(coalesce(p_tel_teste,''),'\D','','g'); m int; base text; link text; fone text;
begin
  if not sou_admin() then raise exception 'sem permissão'; end if;
  select * into t from agente_testes where id = p_id;
  if t.id is null then return jsonb_build_object('ok', false, 'erro', 'Teste não encontrado'); end if;
  if length(d) in (10, 11) then d := '55' || d; end if;
  if length(d) not in (12, 13) then return jsonb_build_object('ok', false, 'erro', 'Escreva o número que vai testar a conversa, com DDD.'); end if;
  m := case when coalesce(p_min, 0) > 0 then least(p_min, 60 * 24 * 7) else 120 end; -- teste real sempre tem tempo para acabar
  o := t.otica_id;
  if o is null or not exists (select 1 from oticas where id = o) then
    insert into oticas(slug, nome, plano, modulos, ativa)
    values ('teste-' || left(replace(t.id::text, '-', ''), 12), left('🧪 Teste · ' || t.empresa, 80), 'teste', '{"wachat":false,"agente":false}'::jsonb, true)
    on conflict (slug) do update set ativa = true
    returning id into o;
  else
    update oticas set ativa = true, nome = left('🧪 Teste · ' || t.empresa, 80), plano = 'teste' where id = o;
  end if;
  -- WhatsApp na nuvem desse teste: o servidor liga em até 30 segundos e manda o QR Code
  tk := 'wa_' || encode(gen_random_bytes(24), 'hex');
  insert into wa_conector(otica_id, token_hash, estado) values (o, encode(digest(tk, 'sha256'), 'hex'), 'desconectado')
  on conflict (otica_id) do update set token_hash = excluded.token_hash, estado = 'desconectado', ultimo_contato = null, qr = null, qr_em = null;
  insert into wa_nuvem(id, modo, otica_id, token) values ('otica:' || o, 'otica', o, tk)
  on conflict (id) do update set token = excluded.token, criado_em = now(), ativo = true;
  -- outros testes com o mesmo número de teste ficam desligados
  update agente_testes set ativo = false, hist = '[]'::jsonb where id <> t.id and ativo and modo = 'real' and right(coalesce(tel_teste,''), 8) = right(d, 8);
  update agente_testes set modo = 'real', tel_teste = d, otica_id = o, ativo = true, hist = '[]'::jsonb,
    cod = coalesce(cod, encode(gen_random_bytes(9), 'hex')), ativado_em = now(),
    expira_em = now() + make_interval(mins => m), atualizado_em = now()
  where id = t.id returning * into t;
  base := coalesce(nullif(trim((select valor from prosp_config where chave = 'link_base_emp')), ''), 'https://teste-agente-ia.vercel.app');
  if base !~* '^https?://' then base := 'https://' || base; end if;
  link := rtrim(base, '/') || '/conectar?c=' || t.cod;
  fone := case when length(d) = 13 then '(' || substr(d, 3, 2) || ') ' || substr(d, 5, 5) || '-' || substr(d, 10) else '(' || substr(d, 3, 2) || ') ' || substr(d, 5, 4) || '-' || substr(d, 9) end;
  if p_avisar then
    insert into prosp_wa_fila(lead_id, tipo, telefone, texto, status, enviar_apos, origem)
    values (prosp_lead_tel(t.telefone), 'manual', t.telefone,
      'Oi' || coalesce(', ' || nullif(split_part(coalesce(t.cliente, ''), ' ', 1), ''), '') || '! 👋 O teste do *Agente de IA* no WhatsApp da *' || t.empresa || E'* está pronto.\n\n'
      || E'1️⃣ Abra este link *no computador ou em outro celular*:\n' || link || E'\n\n'
      || E'2️⃣ No celular da empresa, abra o WhatsApp > *Aparelhos conectados* > *Conectar um aparelho* e leia o QR Code que aparece no link.\n\n'
      || '3️⃣ Depois, do número *' || fone || E'*, mande uma mensagem para o WhatsApp da empresa como se fosse um cliente.\n\n'
      || 'O agente só responde esse número: os outros clientes continuam com vocês, normalmente. O teste fica ligado por *'
      || case when m % 1440 = 0 then (m / 1440) || case when m = 1440 then ' dia' else ' dias' end when m % 60 = 0 then (m / 60) || case when m = 60 then ' hora' else ' horas' end else m || ' minutos' end || '*.',
      'aguardando', now() + interval '2 seconds', 'teste');
  end if;
  return jsonb_build_object('ok', true, 'link', link, 'expira_em', t.expira_em, 'minutos', m);
end $$;
grant execute on function agente_teste_real_ligar(uuid, text, integer, boolean) to authenticated;

-- página pública do QR Code (/conectar?c=...): só quem tem o código vê
create or replace function agente_teste_qr(p_cod text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t agente_testes; c wa_conector; est text;
begin
  if coalesce(length(p_cod), 0) < 12 then return jsonb_build_object('ok', false); end if;
  select * into t from agente_testes where cod = p_cod and modo = 'real';
  if t.id is null then return jsonb_build_object('ok', false); end if;
  if not (t.ativo and (t.expira_em is null or t.expira_em > now())) then
    return jsonb_build_object('ok', true, 'ligado', false, 'empresa', t.empresa);
  end if;
  select * into c from wa_conector where otica_id = t.otica_id;
  est := case when c.otica_id is null or c.ultimo_contato is null or c.ultimo_contato < now() - interval '3 minutes' then 'iniciando' else c.estado end;
  return jsonb_build_object('ok', true, 'ligado', true, 'empresa', t.empresa, 'estado', est,
    'qr', case when est = 'qr' and c.qr_em > now() - interval '2 minutes' then c.qr end,
    'numero', case when est = 'conectado' then c.numero end, 'tel_teste', t.tel_teste, 'expira_em', t.expira_em);
end $$;
grant execute on function agente_teste_qr(text) to anon, authenticated;

-- ligar/desligar pelo ADM: desligar um teste real também desliga o WhatsApp da nuvem;
-- ligar por aqui é sempre o teste simulado (no número do CRM)
create or replace function agente_teste_ligar_tempo(p_id uuid, p_on boolean, p_msg text default null, p_min integer default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t agente_testes; antes agente_testes;
begin
  if not sou_admin() then raise exception 'sem permissão'; end if;
  select * into antes from agente_testes where id = p_id;
  update agente_testes set ativo = p_on, hist = '[]'::jsonb,
    modo = case when p_on then 'simulado' else modo end,
    ativado_em = case when p_on then now() else ativado_em end,
    expira_em = case when p_on and coalesce(p_min,0) > 0 then now() + make_interval(mins => least(p_min, 60*24*30)) when p_on then null else expira_em end,
    atualizado_em = now()
  where id = p_id returning * into t;
  if t.id is null then return jsonb_build_object('ok', false, 'erro', 'Teste não encontrado'); end if;
  if antes.modo = 'real' then perform agente_teste_desligar_nuvem(antes.otica_id); end if;
  if p_on then
    update agente_testes set ativo = false, hist = '[]'::jsonb where id <> t.id and right(telefone, 8) = right(t.telefone, 8) and ativo and modo = 'simulado';
    if coalesce(trim(p_msg), '') <> '' then
      insert into prosp_wa_fila(lead_id, tipo, telefone, texto, status, enviar_apos, origem)
      values (null, 'manual', t.telefone, left(p_msg, 1500), 'aguardando', now() + interval '2 seconds', 'teste');
    end if;
  end if;
  return jsonb_build_object('ok', true, 'ativo', t.ativo, 'expira_em', t.expira_em);
end $$;

-- fim do tempo: desliga e avisa o cliente (no teste real, também tira o WhatsApp da nuvem)
create or replace function agente_teste_expirar() returns void
language plpgsql security definer set search_path = public as $$
declare t agente_testes;
begin
  for t in select * from agente_testes where ativo and expira_em is not null and expira_em <= now() loop
    update agente_testes set ativo = false, hist = '[]'::jsonb, atualizado_em = now() where id = t.id;
    if t.modo = 'real' then perform agente_teste_desligar_nuvem(t.otica_id); end if;
    insert into prosp_wa_fila(lead_id, tipo, telefone, texto, status, enviar_apos, origem)
    values (prosp_lead_tel(t.telefone), 'manual', t.telefone,
      'O tempo do teste do agente da *' || t.empresa || '* terminou ⏰ Obrigado por testar!'
      || case when t.modo = 'real' then E'\n\nO agente já parou de responder no WhatsApp da empresa. Para tirar a conexão do celular: WhatsApp > *Aparelhos conectados* > toque no aparelho do teste > *Desconectar*.' else '' end
      || E'\n\nSe quiser o agente atendendo os clientes de vocês de verdade, é só me responder por aqui.',
      'aguardando', now() + interval '3 seconds', 'teste');
  end loop;
end $$;

-- pedido pela página /experimente com a forma de testar escolhida pelo cliente
create or replace function agente_teste_pedir2(p_nome text, p_tel text, p_empresa text, p_ramo text, p_info text default null, p_agente text default null, p_modo text default 'simulado', p_tel_teste text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; d text := regexp_replace(coalesce(p_tel,''),'\D','','g'); tt text := regexp_replace(coalesce(p_tel_teste,''),'\D','','g');
begin
  if length(d) in (10, 11) then d := '55' || d; end if;
  if length(tt) in (10, 11) then tt := '55' || tt; end if;
  if p_modo = 'real' and length(tt) not in (12, 13) then return jsonb_build_object('ok', false, 'erro', 'Escreva o número de onde você vai mandar as mensagens de teste, com DDD.'); end if;
  if p_modo = 'real' and right(tt, 8) = right(d, 8) then return jsonb_build_object('ok', false, 'erro', 'O número de teste precisa ser diferente do WhatsApp da empresa: o WhatsApp não deixa mandar mensagem para o próprio número.'); end if;
  r := agente_teste_pedir(p_nome, p_tel, p_empresa, p_ramo, p_info, p_agente);
  if coalesce((r->>'ok')::boolean, false) then
    update agente_testes set pedido_modo = case when p_modo = 'real' then 'real' else 'simulado' end,
      pedido_tel_teste = case when p_modo = 'real' then tt end
    where right(telefone, 8) = right(d, 8);
  end if;
  return r;
end $$;
grant execute on function agente_teste_pedir2(text, text, text, text, text, text, text, text) to anon, authenticated;

-- a base de contatos do WhatsApp do cliente não é guardada no teste
do $$
declare d text;
begin
  d := pg_get_functiondef('public.wa_conhecidos_add(text,text[])'::regprocedure);
  if position('teste_real_otica' in d) = 0 then
    d := replace(d, $x$  if o is null then return jsonb_build_object('ok', false, 'erro', 'token_invalido'); end if;$x$,
      $x$  if o is null then return jsonb_build_object('ok', false, 'erro', 'token_invalido'); end if;
  if teste_real_otica(o) then return jsonb_build_object('ok', true, 'teste', true); end if;$x$);
    if position('teste_real_otica' in d) = 0 then raise exception 'wa_conhecidos_add: trecho não encontrado'; end if;
    execute d;
  end if;
end $$;

-- mensagem chegando no WhatsApp de teste: só o número liberado vai para o agente; o resto é ignorado (e não fica guardado)
do $$
declare d text;
begin
  d := pg_get_functiondef('public.wa_receber(text,text,text,text)'::regprocedure);
  if position('teste_real_otica' in d) = 0 then
    d := replace(d, $x$  if t is null or txt = '' then return json_build_object('ok', true); end if;$x$,
      $x$  if t is null or txt = '' then return json_build_object('ok', true); end if;
  if teste_real_otica(o) then
    declare tid uuid := teste_real_permite(o, t);
    begin
      if tid is null then return json_build_object('ok', true, 'ignorado', true); end if;
      perform net.http_post(
        url := 'https://ovynkeifzhavhjdkjjui.supabase.co/functions/v1/agente-vendas',
        headers := jsonb_build_object('Content-Type','application/json','x-agente',(select valor from app_segredos where chave='agente_secret')),
        body := jsonb_build_object('modo','demo_wa','teste',tid,'telefone',t,'texto',txt,'otica',o),
        timeout_milliseconds := 5000);
      return json_build_object('ok', true, 'acao', 'teste_real');
    end;
  end if;$x$);
    if position('teste_real_otica' in d) = 0 then raise exception 'wa_receber: trecho não encontrado'; end if;
    execute d;
  end if;
end $$;

-- SAIR no WhatsApp de teste: o conector (1.9.1+) não responde ninguém por conta própria
do $$
declare d text;
begin
  d := pg_get_functiondef('public.wa_sair(text,text)'::regprocedure);
  if position('teste_real_otica' in d) = 0 then
    d := replace(d, $x$  if o is null then return json_build_object('ok', false, 'erro', 'token_invalido'); end if;$x$,
      $x$  if o is null then return json_build_object('ok', false, 'erro', 'token_invalido'); end if;
  if teste_real_otica(o) then return json_build_object('ok', true, 'silencio', true); end if;$x$);
    if position('teste_real_otica' in d) = 0 then raise exception 'wa_sair: trecho não encontrado'; end if;
    execute d;
  end if;
end $$;

-- pedido da página /experimente (versão usada pela página): no teste real, o número de teste é o WhatsApp
-- da própria pessoa e o da empresa serve só para conferir que são números diferentes
create or replace function agente_teste_pedir3(p_nome text, p_tel text, p_empresa text, p_ramo text, p_info text default null, p_agente text default null, p_modo text default 'simulado', p_tel_empresa text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; d text := regexp_replace(coalesce(p_tel,''),'\D','','g'); e text := regexp_replace(coalesce(p_tel_empresa,''),'\D','','g');
begin
  if length(d) in (10, 11) then d := '55' || d; end if;
  if length(e) in (10, 11) then e := '55' || e; end if;
  if p_modo = 'real' and length(e) not in (12, 13) then return jsonb_build_object('ok', false, 'erro', 'Escreva o WhatsApp da empresa, com DDD.'); end if;
  if p_modo = 'real' and right(e, 8) = right(d, 8) then return jsonb_build_object('ok', false, 'erro', 'Para testar no WhatsApp da empresa, o seu WhatsApp precisa ser outro número: é dele que você vai mandar as mensagens de teste (o WhatsApp não deixa mandar mensagem para o próprio número).'); end if;
  r := agente_teste_pedir(p_nome, p_tel, p_empresa, p_ramo, p_info, p_agente);
  if coalesce((r->>'ok')::boolean, false) then
    update agente_testes set pedido_modo = case when p_modo = 'real' then 'real' else 'simulado' end,
      pedido_tel_teste = case when p_modo = 'real' then d end
    where right(telefone, 8) = right(d, 8);
  end if;
  return r;
end $$;
grant execute on function agente_teste_pedir3(text, text, text, text, text, text, text, text) to anon, authenticated;

-- respostas do teste real entram na wa_fila sem "ref" (cada uma ganha um código próprio)
alter table wa_fila alter column ref set default ('auto:' || gen_random_uuid());

-- Lembrete do cadastro do teste (origem 'fu_teste' na prosp_wa_fila, agendado pelo agente-vendas 20 min depois de mandar o link /experimente).
-- Ao preencher o cadastro, agente_teste_pedir3 cancela o lembrete pendente (mesmo número da pessoa ou da empresa).
-- (a versão aplicada no banco de agente_teste_pedir3 inclui:)
--   update prosp_wa_fila set status = 'cancelada', erro = 'já fez o cadastro do teste'
--     where origem = 'fu_teste' and status = 'aguardando'
--       and right(regexp_replace(coalesce(telefone,''),'\D','','g'), 8) in (right(d, 8), case when length(e) >= 8 then right(e, 8) else '--------' end);
