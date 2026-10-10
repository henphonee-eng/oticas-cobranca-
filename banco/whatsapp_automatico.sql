
create table if not exists public.wa_conector (
  otica_id uuid primary key references public.oticas(id) on delete cascade,
  token_hash text,
  estado text not null default 'desconectado',
  numero text,
  ultimo_contato timestamptz,
  criado_em timestamptz not null default now()
);
create table if not exists public.wa_fila (
  id uuid primary key default gen_random_uuid(),
  otica_id uuid not null references public.oticas(id) on delete cascade,
  cliente_id text,
  cliente_nome text,
  tipo text not null,
  telefone text not null,
  texto text not null,
  ref text not null,
  status text not null default 'aprovar' check (status in ('aguardando','aprovar','enviando','enviada','falhou','cancelada','expirada')),
  enviar_apos timestamptz not null default now(),
  expira_em timestamptz,
  tentativas int not null default 0,
  erro text,
  criado_em timestamptz not null default now(),
  enviando_em timestamptz,
  enviado_em timestamptz,
  unique (otica_id, ref)
);
create index if not exists wa_fila_busca on public.wa_fila (otica_id, status, enviar_apos);
create table if not exists public.wa_optout (
  otica_id uuid not null references public.oticas(id) on delete cascade,
  telefone text not null,
  em timestamptz not null default now(),
  primary key (otica_id, telefone)
);
alter table public.wa_conector enable row level security;
alter table public.wa_fila enable row level security;
alter table public.wa_optout enable row level security;
drop policy if exists wa_fila_ler on public.wa_fila;
create policy wa_fila_ler on public.wa_fila for select using (public.minha_otica(otica_id));
drop policy if exists wa_optout_ler on public.wa_optout;
create policy wa_optout_ler on public.wa_optout for select using (public.minha_otica(otica_id));

-- utilidades
create or replace function public.wa_tel(p text) returns text language sql immutable set search_path=public as $$
  select case
    when d = '' then null
    when length(d) in (10,11) then '55'||d
    when length(d) in (12,13) and left(d,2)='55' then d
    else null end
  from (select regexp_replace(coalesce(p,''),'\D','','g') as d) x
$$;
create or replace function public.wa_brl(c numeric) returns text language sql immutable set search_path=public as $$
  select 'R$ '||regexp_replace(trunc(c/100)::bigint::text,'(\d)(?=(\d{3})+$)','\1.','g')||','||lpad((abs(c)::bigint % 100)::text,2,'0')
$$;
create or replace function public.wa_rodape(t text) returns text language sql immutable set search_path=public as $$
  select case when t ilike '%responda sair%' then t else t||E'\n\nPara não receber mais avisos, responda SAIR.' end
$$;
create or replace function public.wa_render(t text, v jsonb) returns text language plpgsql immutable set search_path=public as $$
declare r text := t; k text; x text;
begin
  for k, x in select * from jsonb_each_text(v) loop r := replace(r, '{'||k||'}', coalesce(x,'')); end loop;
  return r;
end $$;

-- entra na fila (uso interno)
create or replace function public.wa_ins(o uuid, cid text, nome text, tp text, tel text, txt text, rf text, apos timestamptz, expira timestamptz, forcar boolean)
returns text language plpgsql security definer set search_path=public as $$
declare cfg jsonb; modo text; st text; t text;
begin
  select data into cfg from docs where otica_id=o and col='config' and id='wa';
  cfg := coalesce(cfg,'{}'::jsonb);
  if coalesce(cfg->>'on','false') <> 'true' then return 'off'; end if;
  modo := coalesce(cfg->'modo'->>tp,'aprovar');
  if modo not in ('auto','aprovar') then return 'off'; end if;
  t := wa_tel(tel);
  if t is null then return 'sem_telefone'; end if;
  if exists (select 1 from wa_optout where otica_id=o and telefone=t) then return 'optout'; end if;
  st := case when modo='auto' and not coalesce(forcar,false) then 'aguardando' else 'aprovar' end;
  insert into wa_fila(otica_id,cliente_id,cliente_nome,tipo,telefone,texto,ref,status,enviar_apos,expira_em)
  values (o,cid,nome,tp,t,wa_rodape(txt),rf,st,coalesce(apos,now()),expira)
  on conflict (otica_id,ref) do nothing;
  if not found then return 'dup'; end if;
  return 'ok';
end $$;
revoke all on function public.wa_ins(uuid,text,text,text,text,text,text,timestamptz,timestamptz,boolean) from public, anon, authenticated;

-- usado pelo sistema (boas-vindas, recibo, chegou, agradecimento)
create or replace function public.wa_enfileirar(p_otica uuid, p_cliente text, p_nome text, p_tipo text, p_tel text, p_texto text, p_ref text)
returns text language plpgsql security definer set search_path=public as $$
begin
  if not public.minha_otica(p_otica) then raise exception 'Sem permissão'; end if;
  if p_tipo not in ('boasvindas','recibo','chegou','agradecimento') then raise exception 'Tipo inválido'; end if;
  if length(coalesce(p_texto,'')) < 5 or length(p_texto) > 2000 then raise exception 'Texto inválido'; end if;
  return public.wa_ins(p_otica, p_cliente, p_nome, p_tipo, p_tel, p_texto, p_ref, now(), now() + interval '3 days', false);
end $$;
grant execute on function public.wa_enfileirar(uuid,text,text,text,text,text,text) to authenticated;

create or replace function public.wa_decidir(p_id uuid, p_acao text)
returns void language plpgsql security definer set search_path=public as $$
declare o uuid;
begin
  select otica_id into o from wa_fila where id=p_id;
  if o is null then raise exception 'Mensagem não encontrada'; end if;
  if public.meu_papel(o) <> 'dono' then raise exception 'Só o dono pode fazer isso'; end if;
  if p_acao='aprovar' then update wa_fila set status='aguardando', enviar_apos=now(), expira_em=greatest(coalesce(expira_em,now()), now()+interval '1 day') where id=p_id and status in ('aprovar','cancelada','falhou','expirada');
  elsif p_acao='cancelar' then update wa_fila set status='cancelada' where id=p_id and status in ('aprovar','aguardando','falhou');
  else raise exception 'Ação inválida'; end if;
end $$;
grant execute on function public.wa_decidir(uuid,text) to authenticated;

create or replace function public.wa_aprovar_todas(p_otica uuid)
returns int language plpgsql security definer set search_path=public as $$
declare n int;
begin
  if public.meu_papel(p_otica) <> 'dono' then raise exception 'Só o dono pode fazer isso'; end if;
  update wa_fila set status='aguardando', enviar_apos=now(), expira_em=greatest(coalesce(expira_em,now()), now()+interval '1 day') where otica_id=p_otica and status='aprovar';
  get diagnostics n = row_count; return n;
end $$;
grant execute on function public.wa_aprovar_todas(uuid) to authenticated;

create or replace function public.wa_gerar_token(p_otica uuid)
returns text language plpgsql security definer set search_path=public, extensions as $$
declare tk text;
begin
  if public.meu_papel(p_otica) <> 'dono' then raise exception 'Só o dono pode fazer isso'; end if;
  tk := 'wa_'||encode(gen_random_bytes(24),'hex');
  insert into wa_conector(otica_id, token_hash, estado) values (p_otica, encode(digest(tk,'sha256'),'hex'), 'desconectado')
  on conflict (otica_id) do update set token_hash=excluded.token_hash, estado='desconectado', ultimo_contato=null;
  return tk;
end $$;
grant execute on function public.wa_gerar_token(uuid) to authenticated;

create or replace function public.wa_status(p_otica uuid)
returns json language plpgsql security definer set search_path=public as $$
declare c record; hoje date := (now() at time zone 'America/Recife')::date;
begin
  if not public.minha_otica(p_otica) then return null; end if;
  select * into c from wa_conector where otica_id=p_otica;
  return json_build_object(
    'tem_token', c.token_hash is not null,
    'estado', case when c.otica_id is null then 'sem_conector' when c.ultimo_contato is null or c.ultimo_contato < now() - interval '3 minutes' then 'offline' else c.estado end,
    'ultimo_contato', c.ultimo_contato,
    'numero', c.numero,
    'enviadas_hoje', (select count(*) from wa_fila where otica_id=p_otica and status='enviada' and (enviado_em at time zone 'America/Recife')::date=hoje),
    'na_fila', (select count(*) from wa_fila where otica_id=p_otica and status in ('aguardando','enviando')),
    'aprovar', (select count(*) from wa_fila where otica_id=p_otica and status='aprovar'),
    'falhas', (select count(*) from wa_fila where otica_id=p_otica and status='falhou' and criado_em > now() - interval '7 days'));
end $$;
grant execute on function public.wa_status(uuid) to authenticated;

-- API do conector (chamada pelo programa do PC com o token)
create or replace function public.wa_conector_otica(p_token text) returns uuid language sql stable security definer set search_path=public, extensions as $$
  select otica_id from wa_conector where token_hash = encode(digest(coalesce(p_token,''),'sha256'),'hex') limit 1
$$;
revoke all on function public.wa_conector_otica(text) from public, anon, authenticated;

create or replace function public.wa_puxar(p_token text)
returns json language plpgsql security definer set search_path=public as $$
declare o uuid; cfg jsonb; ini time; fim time; lim int; agora time; hoje date; enviadas int; m record;
begin
  o := wa_conector_otica(p_token);
  if o is null then return json_build_object('ok', false, 'erro', 'token_invalido'); end if;
  update wa_conector set ultimo_contato=now() where otica_id=o;
  update wa_fila set status='aguardando' where otica_id=o and status='enviando' and enviando_em < now() - interval '10 minutes';
  update wa_fila set status='expirada' where otica_id=o and status in ('aguardando','aprovar') and expira_em is not null and expira_em < now();
  select data into cfg from docs where otica_id=o and col='config' and id='wa';
  cfg := coalesce(cfg,'{}'::jsonb);
  if coalesce(cfg->>'on','false') <> 'true' then return json_build_object('ok', true, 'msg', null, 'motivo', 'desligado'); end if;
  if coalesce(cfg->>'pausa','false') = 'true' then return json_build_object('ok', true, 'msg', null, 'motivo', 'pausado'); end if;
  ini := coalesce(nullif(cfg->>'ini',''),'08:00')::time; fim := coalesce(nullif(cfg->>'fim',''),'18:30')::time;
  lim := coalesce(nullif(cfg->>'limite','')::int, 30);
  agora := (now() at time zone 'America/Recife')::time; hoje := (now() at time zone 'America/Recife')::date;
  if agora < ini or agora > fim then return json_build_object('ok', true, 'msg', null, 'motivo', 'fora_do_horario'); end if;
  select count(*) into enviadas from wa_fila where otica_id=o and status='enviada' and (enviado_em at time zone 'America/Recife')::date=hoje;
  if enviadas >= lim then return json_build_object('ok', true, 'msg', null, 'motivo', 'limite_diario'); end if;
  if exists (select 1 from wa_fila where otica_id=o and status='enviada' and enviado_em > now() - interval '20 seconds') then
    return json_build_object('ok', true, 'msg', null, 'motivo', 'intervalo');
  end if;
  select id, telefone, texto into m from wa_fila
   where otica_id=o and status='aguardando' and enviar_apos <= now() and (expira_em is null or expira_em > now())
   order by enviar_apos limit 1 for update skip locked;
  if m.id is null then return json_build_object('ok', true, 'msg', null, 'motivo', 'fila_vazia'); end if;
  update wa_fila set status='enviando', enviando_em=now(), tentativas=tentativas+1 where id=m.id;
  return json_build_object('ok', true, 'msg', json_build_object('id', m.id, 'telefone', m.telefone, 'texto', m.texto));
end $$;
grant execute on function public.wa_puxar(text) to anon, authenticated;

create or replace function public.wa_resultado(p_token text, p_id uuid, p_ok boolean, p_erro text)
returns json language plpgsql security definer set search_path=public as $$
declare o uuid; t int;
begin
  o := wa_conector_otica(p_token);
  if o is null then return json_build_object('ok', false, 'erro', 'token_invalido'); end if;
  select tentativas into t from wa_fila where id=p_id and otica_id=o;
  if t is null then return json_build_object('ok', false, 'erro', 'nao_encontrada'); end if;
  if p_ok then
    update wa_fila set status='enviada', enviado_em=now(), erro=null where id=p_id;
  elsif p_erro = 'sem_whatsapp' or t >= 3 then
    update wa_fila set status='falhou', erro=left(coalesce(p_erro,'erro'),200) where id=p_id;
  else
    update wa_fila set status='aguardando', enviar_apos=now()+interval '10 minutes', erro=left(coalesce(p_erro,'erro'),200) where id=p_id;
  end if;
  return json_build_object('ok', true);
end $$;
grant execute on function public.wa_resultado(text,uuid,boolean,text) to anon, authenticated;

create or replace function public.wa_ping(p_token text, p_estado text, p_numero text)
returns json language plpgsql security definer set search_path=public as $$
declare o uuid;
begin
  o := wa_conector_otica(p_token);
  if o is null then return json_build_object('ok', false, 'erro', 'token_invalido'); end if;
  update wa_conector set ultimo_contato=now(), estado=case when p_estado in ('conectado','qr','desconectado') then p_estado else 'desconectado' end, numero=coalesce(left(p_numero,20), numero) where otica_id=o;
  return json_build_object('ok', true);
end $$;
grant execute on function public.wa_ping(text,text,text) to anon, authenticated;

create or replace function public.wa_sair(p_token text, p_telefone text)
returns json language plpgsql security definer set search_path=public as $$
declare o uuid; t text;
begin
  o := wa_conector_otica(p_token);
  if o is null then return json_build_object('ok', false, 'erro', 'token_invalido'); end if;
  t := wa_tel(p_telefone);
  if t is null then return json_build_object('ok', true); end if;
  insert into wa_optout(otica_id, telefone) values (o, t) on conflict do nothing;
  update wa_fila set status='cancelada', erro='pediu para sair' where otica_id=o and telefone=t and status in ('aguardando','aprovar');
  return json_build_object('ok', true);
end $$;
grant execute on function public.wa_sair(text,text) to anon, authenticated;

-- regras por data (rodam sozinhas)
create or replace function public.wa_gerar_fila() returns void language plpgsql security definer set search_path=public as $$
declare o record; v record; c record; p jsonb; i int; hoje date := (now() at time zone 'America/Recife')::date;
  nome_o text; cfg jsonb; venc date; dias int; tp text; tpl text; txt text; vars jsonb; ref date; cli jsonb; nrev int; ult date; rc date;
  def_lem text := 'Olá, {cliente}! Aqui é da {otica}. Passando para lembrar que a parcela {parcela}, de {valor}, vence amanhã ({vencimento}). Qualquer dúvida é só responder por aqui.';
  def_atr text := 'Olá, {cliente}! Tudo bem? Aqui é da {otica}. A parcela {parcela}, de {valor}, venceu em {vencimento} e ainda está em aberto. Se já pagou, pode desconsiderar e nos enviar o comprovante. Se precisar combinar, é só responder por aqui.';
  def_ani text := 'Olá, {cliente}! A equipe da {otica} deseja a você um feliz aniversário, com muita saúde, alegria e um ano cheio de boas imagens. Um grande abraço!';
  def_rev text := 'Olá, {cliente}! Aqui é da {otica}. Já faz um bom tempo desde a sua última visita. Que tal revisar o seu grau e dar uma conferida nos seus óculos? É rápido e a gente cuida de você. Posso agendar um horário?';
begin
  for o in select ot.id, ot.nome from oticas ot where exists (select 1 from docs d where d.otica_id=ot.id and d.col='config' and d.id='wa' and d.data->>'on'='true') loop
    select data into cfg from docs where otica_id=o.id and col='config' and id='wa';
    nome_o := coalesce((select data->>'nome' from docs where otica_id=o.id and col='config' and id='otica'), o.nome);
    -- parcelas: lembrete e atrasos
    for v in select d.id, d.data from docs d where d.otica_id=o.id and d.col='vendas' and coalesce(d.data->>'aguardando','false')<>'true' loop
      select data into cli from docs where otica_id=o.id and col='clientes' and id=v.data->>'clienteId';
      if cli is null then continue; end if;
      for i in 0..coalesce(jsonb_array_length(v.data->'parcelas'),0)-1 loop
        p := v.data->'parcelas'->i;
        if coalesce(p->>'pago','false')='true' then continue; end if;
        begin venc := (p->>'venc')::date; exception when others then continue; end;
        dias := hoje - venc;
        tp := case when dias=-1 then 'lembrete' when dias in (1,7,15) then 'atraso' else null end;
        if tp is null then continue; end if;
        tpl := coalesce(cfg->'tpl'->>tp, case when tp='lembrete' then def_lem else def_atr end);
        vars := jsonb_build_object('cliente', split_part(trim(cli->>'nome'),' ',1), 'otica', nome_o,
          'parcela', case when p->>'tipo'='entrada' then 'de entrada' else coalesce(p->>'n','')||'/'||coalesce(v.data->>'n','') end,
          'valor', wa_brl((p->>'valor')::numeric), 'vencimento', to_char(venc,'DD/MM/YYYY'), 'dias', dias::text);
        perform wa_ins(o.id, cli->>'id', cli->>'nome', tp, cli->>'whatsapp', wa_render(tpl, vars),
          tp||':'||v.id||':'||i||':'||venc||':'||dias, now(),
          case when tp='lembrete' then (venc::timestamp + interval '1 day') at time zone 'America/Recife' else now() + interval '2 days' end,
          dias >= 15);
      end loop;
    end loop;
    -- aniversários
    for c in select d.data from docs d where d.otica_id=o.id and d.col='clientes' and length(coalesce(d.data->>'nascimento',''))=10 and substr(d.data->>'nascimento',6)=to_char(hoje,'MM-DD') loop
      tpl := coalesce(cfg->'tpl'->>'aniversario', def_ani);
      vars := jsonb_build_object('cliente', split_part(trim(c.data->>'nome'),' ',1), 'otica', nome_o);
      perform wa_ins(o.id, c.data->>'id', c.data->>'nome', 'aniversario', c.data->>'whatsapp', wa_render(tpl, vars),
        'ani:'||(c.data->>'id')||':'||to_char(hoje,'YYYY'), now(), now() + interval '1 day', false);
    end loop;
    -- revisão do grau (11 meses sem compra ou receita; no máximo 5 por dia)
    select count(*) into nrev from wa_fila where otica_id=o.id and tipo='revisao' and (criado_em at time zone 'America/Recife')::date=hoje;
    for c in select d.data from docs d where d.otica_id=o.id and d.col='clientes' and nrev < 5 loop
      select max((x.data->>'data')::date) into ult from docs x where x.otica_id=o.id and x.col='vendas' and x.data->>'clienteId'=c.data->>'id' and coalesce(x.data->>'aguardando','false')<>'true' and x.data->>'data' ~ '^\d{4}-\d{2}-\d{2}$';
      select max((r->>'data')::date) into rc from jsonb_array_elements(coalesce(c.data->'receitas','[]'::jsonb)) r where r->>'data' ~ '^\d{4}-\d{2}-\d{2}$';
      ref := greatest(ult, rc);
      if ref is null or ref > hoje - 335 then continue; end if;
      if exists (select 1 from wa_fila where otica_id=o.id and tipo='revisao' and cliente_id=c.data->>'id' and criado_em > now() - interval '180 days') then continue; end if;
      if coalesce(c.data->>'revEm','') ~ '^\d{4}-\d{2}-\d{2}$' and hoje - (c.data->>'revEm')::date < 180 then continue; end if;
      tpl := coalesce(cfg->'tpl'->>'revisao', def_rev);
      vars := jsonb_build_object('cliente', split_part(trim(c.data->>'nome'),' ',1), 'otica', nome_o);
      if wa_ins(o.id, c.data->>'id', c.data->>'nome', 'revisao', c.data->>'whatsapp', wa_render(tpl, vars), 'rev:'||(c.data->>'id')||':'||to_char(hoje,'YYYY-MM'), now(), now() + interval '30 days', false) = 'ok' then nrev := nrev + 1; end if;
    end loop;
  end loop;
  update wa_fila set status='expirada' where status in ('aguardando','aprovar') and expira_em is not null and expira_em < now();
end $$;
revoke all on function public.wa_gerar_fila() from public, anon, authenticated;

-- agenda a geração automática a cada 15 minutos
create extension if not exists pg_cron;
select cron.schedule('wa-gerar-fila','*/15 * * * *','select public.wa_gerar_fila()');
