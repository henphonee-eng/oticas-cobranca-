-- WhatsApp dentro do sistema (função Premium "wachat").
-- O conector registra as mensagens de conversa (recebidas e enviadas) em wa_msg;
-- a equipe responde pelo sistema (wa_enviar_manual), que entra na fila com tipo 'manual'
-- e sai na hora (sem horário comercial, limite diário, intervalo, pausa ou rodapé).

create table if not exists public.wa_msg (
  id uuid primary key default gen_random_uuid(),
  otica_id uuid not null references public.oticas(id) on delete cascade,
  telefone text not null,             -- número da conversa (só dígitos, como o WhatsApp entrega)
  nome text,                          -- nome que aparece no WhatsApp do cliente
  de_mim boolean not null default false,
  texto text not null,
  tipo text not null default 'texto', -- texto, foto, audio, video, documento, figurinha, outro
  origem text,                        -- celular, sistema, automatico
  wa_id text,
  lido boolean not null default false,
  criado_em timestamptz not null default now()
);
create unique index if not exists wa_msg_waid on public.wa_msg(otica_id, wa_id) where wa_id is not null;
create index if not exists wa_msg_conv on public.wa_msg(otica_id, telefone, criado_em desc);
create index if not exists wa_msg_recente on public.wa_msg(otica_id, criado_em desc);
alter table public.wa_msg enable row level security;
drop policy if exists wa_msg_sel on public.wa_msg;
create policy wa_msg_sel on public.wa_msg for select using (public.minha_otica(otica_id));
drop policy if exists wa_msg_upd on public.wa_msg;
create policy wa_msg_upd on public.wa_msg for update using (public.minha_otica(otica_id)) with check (public.minha_otica(otica_id));
grant select, update on public.wa_msg to authenticated;
do $$ begin
  begin alter publication supabase_realtime add table public.wa_msg; exception when duplicate_object then null; when undefined_object then null; end;
end $$;

-- módulo ligado? (mesma regra do sistema: chave em modulos, senão vale o plano premium)
create or replace function public.ot_mod_on(o uuid, k text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce((select case when t.modulos ? k then t.modulos->>k = 'true' else t.plano = 'premium' end from oticas t where t.id = o), false)
$$;

-- o conector registra cada mensagem de conversa
create or replace function public.wa_registrar(p_token text, p_tel text, p_nome text, p_de_mim boolean, p_texto text, p_tipo text default 'texto', p_wa_id text default null, p_origem text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare o uuid; t text := regexp_replace(coalesce(p_tel,''),'\D','','g');
begin
  o := wa_conector_otica(p_token);
  if o is null then return jsonb_build_object('ok', false, 'erro', 'token_invalido'); end if;
  if not ot_mod_on(o, 'wachat') then return jsonb_build_object('ok', true, 'off', true); end if;
  if length(t) < 10 or length(t) > 15 or coalesce(trim(p_texto),'') = '' then return jsonb_build_object('ok', true); end if;
  insert into wa_msg(otica_id, telefone, nome, de_mim, texto, tipo, origem, wa_id, lido)
  values (o, t, nullif(left(trim(coalesce(p_nome,'')),80),''), coalesce(p_de_mim,false), left(p_texto,4000),
          case when p_tipo in ('texto','foto','audio','video','documento','figurinha','outro') then p_tipo else 'outro' end,
          left(coalesce(p_origem,''),20), nullif(left(coalesce(p_wa_id,''),80),''), coalesce(p_de_mim,false))
  on conflict (otica_id, wa_id) where wa_id is not null do nothing;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.wa_registrar(text,text,text,boolean,text,text,text,text) to anon, authenticated;

-- a equipe envia uma mensagem pelo sistema
create or replace function public.wa_enviar_manual(p_otica uuid, p_tel text, p_texto text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare t text := regexp_replace(coalesce(p_tel,''),'\D','','g'); fid uuid;
begin
  if not public.minha_otica(p_otica) then raise exception 'Sem permissão'; end if;
  if not ot_mod_on(p_otica, 'wachat') then raise exception 'Função não liberada'; end if;
  if length(t) = 10 or length(t) = 11 then t := '55'||t; end if;
  if length(t) < 12 or length(t) > 15 then raise exception 'Número inválido'; end if;
  if length(trim(coalesce(p_texto,''))) < 1 or length(p_texto) > 4000 then raise exception 'Mensagem vazia ou muito longa'; end if;
  insert into wa_fila(otica_id, cliente_id, cliente_nome, tipo, telefone, texto, ref, status, enviar_apos, expira_em)
  values (p_otica, 'chat', 'Conversa', 'manual', t, p_texto, 'man:'||gen_random_uuid(), 'aguardando', now(), now() + interval '1 day')
  returning id into fid;
  return jsonb_build_object('ok', true, 'id', fid);
end $$;
grant execute on function public.wa_enviar_manual(uuid,text,text) to authenticated;

-- fila do conector: mensagens manuais saem primeiro e sem as travas dos avisos automáticos
create or replace function public.wa_puxar(p_token text)
returns json language plpgsql security definer set search_path to 'public' as $function$
declare o uuid; cfg jsonb; ini time; fim time; lim int; agora time; hoje date; enviadas int; m record;
begin
  o := wa_conector_otica(p_token);
  if o is null then return json_build_object('ok', false, 'erro', 'token_invalido'); end if;
  update wa_conector set ultimo_contato=now() where otica_id=o;
  update wa_fila set status='aguardando' where otica_id=o and status='enviando' and enviando_em < now() - interval '10 minutes';
  update wa_fila set status='expirada' where otica_id=o and status in ('aguardando','aprovar') and expira_em is not null and expira_em < now();
  -- conversa manual: na hora
  select id, telefone, texto, tipo into m from wa_fila
   where otica_id=o and tipo='manual' and status='aguardando' and enviar_apos <= now() and (expira_em is null or expira_em > now())
   order by criado_em limit 1 for update skip locked;
  if m.id is not null then
    update wa_fila set status='enviando', enviando_em=now(), tentativas=tentativas+1 where id=m.id;
    return json_build_object('ok', true, 'msg', json_build_object('id', m.id, 'telefone', m.telefone, 'texto', m.texto, 'tipo', m.tipo));
  end if;
  select data into cfg from docs where otica_id=o and col='config' and id='wa';
  cfg := coalesce(cfg,'{}'::jsonb);
  if coalesce(cfg->>'on','false') <> 'true' then return json_build_object('ok', true, 'msg', null, 'motivo', 'desligado'); end if;
  if coalesce(cfg->>'pausa','false') = 'true' then return json_build_object('ok', true, 'msg', null, 'motivo', 'pausado'); end if;
  ini := coalesce(nullif(cfg->>'ini',''),'08:00')::time; fim := coalesce(nullif(cfg->>'fim',''),'18:30')::time;
  lim := coalesce(nullif(cfg->>'limite','')::int, 30);
  agora := (now() at time zone 'America/Recife')::time; hoje := (now() at time zone 'America/Recife')::date;
  if agora < ini or agora > fim then return json_build_object('ok', true, 'msg', null, 'motivo', 'fora_do_horario'); end if;
  select count(*) into enviadas from wa_fila where otica_id=o and status='enviada' and tipo<>'manual' and (enviado_em at time zone 'America/Recife')::date=hoje;
  if enviadas >= lim then return json_build_object('ok', true, 'msg', null, 'motivo', 'limite_diario'); end if;
  if exists (select 1 from wa_fila where otica_id=o and status='enviada' and tipo<>'manual' and enviado_em > now() - interval '20 seconds') then
    return json_build_object('ok', true, 'msg', null, 'motivo', 'intervalo');
  end if;
  select id, telefone, texto, tipo into m from wa_fila
   where otica_id=o and status='aguardando' and tipo<>'manual' and enviar_apos <= now() and (expira_em is null or expira_em > now())
   order by enviar_apos limit 1 for update skip locked;
  if m.id is null then return json_build_object('ok', true, 'msg', null, 'motivo', 'fila_vazia'); end if;
  update wa_fila set status='enviando', enviando_em=now(), tentativas=tentativas+1 where id=m.id;
  return json_build_object('ok', true, 'msg', json_build_object('id', m.id, 'telefone', m.telefone, 'texto', m.texto, 'tipo', m.tipo));
end $function$;

-- o conector, durante a pausa entre avisos automáticos, continua buscando só as mensagens da conversa
create or replace function public.wa_puxar_manual(p_token text)
returns json language plpgsql security definer set search_path to 'public' as $function$
declare o uuid; m record;
begin
  o := wa_conector_otica(p_token);
  if o is null then return json_build_object('ok', false, 'erro', 'token_invalido'); end if;
  select id, telefone, texto, tipo into m from wa_fila
   where otica_id=o and tipo='manual' and status='aguardando' and enviar_apos <= now() and (expira_em is null or expira_em > now())
   order by criado_em limit 1 for update skip locked;
  if m.id is null then return json_build_object('ok', true, 'msg', null); end if;
  update wa_fila set status='enviando', enviando_em=now(), tentativas=tentativas+1 where id=m.id;
  return json_build_object('ok', true, 'msg', json_build_object('id', m.id, 'telefone', m.telefone, 'texto', m.texto, 'tipo', m.tipo));
end $function$;
grant execute on function public.wa_puxar_manual(text) to anon, authenticated;

-- mensagem manual que falhou: tenta de novo em 1 minuto (não em 10)
create or replace function public.wa_resultado(p_token text, p_id uuid, p_ok boolean, p_erro text)
returns json language plpgsql security definer set search_path to 'public' as $function$
declare o uuid; t int; tp text;
begin
  o := wa_conector_otica(p_token);
  if o is null then return json_build_object('ok', false, 'erro', 'token_invalido'); end if;
  select tentativas, tipo into t, tp from wa_fila where id=p_id and otica_id=o;
  if t is null then return json_build_object('ok', false, 'erro', 'nao_encontrada'); end if;
  if p_ok then
    update wa_fila set status='enviada', enviado_em=now(), erro=null where id=p_id;
  elsif p_erro = 'sem_whatsapp' or t >= 3 then
    update wa_fila set status='falhou', erro=left(coalesce(p_erro,'erro'),200) where id=p_id;
  else
    update wa_fila set status='aguardando', enviar_apos=now()+case when tp='manual' then interval '1 minute' else interval '10 minutes' end, erro=left(coalesce(p_erro,'erro'),200) where id=p_id;
  end if;
  return json_build_object('ok', true);
end $function$;

-- wa_status: os contadores do WhatsApp Automático não contam as mensagens da conversa (tipo 'manual')
-- (aplicado trocando "where otica_id=p_otica and status..." por "where otica_id=p_otica and tipo<>'manual' and status..." nos três contadores)
