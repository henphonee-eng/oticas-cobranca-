-- CRM de prospecção: envio automático pelo WhatsApp (chip próprio do ADM, segundo conector).
-- O admin marca as óticas no CRM (isso já é a aprovação); a abordagem entra na fila e o conector
-- manda aos poucos (horário, limite por dia e intervalo). O follow-up fica esperando e é liberado
-- sozinho alguns dias depois da abordagem; se a ótica responder ou pedir para sair, ele é cancelado.

create table if not exists public.prosp_wa_conector (
  id int primary key default 1 check (id = 1),
  token_hash text,
  estado text not null default 'desconectado',
  numero text,
  ultimo_contato timestamptz
);
alter table public.prosp_wa_conector enable row level security;

create table if not exists public.prosp_wa_fila (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.prosp_leads(id) on delete cascade,
  tipo text not null check (tipo in ('abordagem','followup')),
  telefone text not null,
  texto text not null,
  status text not null default 'aguardando', -- espera (follow-up esperando a abordagem), aguardando, enviando, enviada, falhou, cancelada
  enviar_apos timestamptz not null default now(),
  tentativas int not null default 0,
  erro text,
  criado_em timestamptz not null default now(),
  enviando_em timestamptz,
  enviado_em timestamptz
);
create index if not exists prosp_wa_fila_st on public.prosp_wa_fila(status, enviar_apos);
create index if not exists prosp_wa_fila_lead on public.prosp_wa_fila(lead_id);
alter table public.prosp_wa_fila enable row level security;
create policy prosp_wa_fila_sel on public.prosp_wa_fila for select using (public.sou_admin());
create policy prosp_wa_fila_ins on public.prosp_wa_fila for insert with check (public.sou_admin());
create policy prosp_wa_fila_upd on public.prosp_wa_fila for update using (public.sou_admin()) with check (public.sou_admin());
grant select, insert, update on public.prosp_wa_fila to authenticated;

create or replace function public.prosp_cfg(k text, def text)
returns text language sql stable security definer set search_path to 'public' as $$
  select coalesce(nullif(trim((select valor from prosp_config where chave = k)),''), def)
$$;

create or replace function public.prosp_wa_ok(p_token text)
returns boolean language sql stable security definer set search_path to 'public', 'extensions' as $$
  select exists (select 1 from prosp_wa_conector where token_hash is not null and token_hash = encode(digest(coalesce(p_token,''),'sha256'),'hex'))
$$;

create or replace function public.prosp_wa_gerar_token()
returns text language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare tk text;
begin
  if not public.sou_admin() then raise exception 'Só o administrador pode fazer isso'; end if;
  tk := 'wa_'||encode(gen_random_bytes(24),'hex');
  insert into prosp_wa_conector(id, token_hash, estado) values (1, encode(digest(tk,'sha256'),'hex'), 'desconectado')
  on conflict (id) do update set token_hash=excluded.token_hash, estado='desconectado', ultimo_contato=null;
  return tk;
end $$;

create or replace function public.prosp_wa_status()
returns json language plpgsql stable security definer set search_path to 'public' as $$
declare c record; hoje date := (now() at time zone 'America/Recife')::date;
begin
  if not public.sou_admin() then return null; end if;
  select * into c from prosp_wa_conector where id=1;
  return json_build_object(
    'tem_token', c.token_hash is not null,
    'estado', case when c.id is null or c.token_hash is null then 'sem_conector' when c.ultimo_contato is null or c.ultimo_contato < now() - interval '3 minutes' then 'offline' else c.estado end,
    'numero', c.numero, 'ultimo_contato', c.ultimo_contato,
    'enviadas_hoje', (select count(*) from prosp_wa_fila where status='enviada' and (enviado_em at time zone 'America/Recife')::date = hoje),
    'na_fila', (select count(*) from prosp_wa_fila where status in ('aguardando','enviando')),
    'esperando', (select count(*) from prosp_wa_fila where status='espera'));
end $$;

create or replace function public.prosp_wa_ping(p_token text, p_estado text, p_numero text)
returns json language plpgsql security definer set search_path to 'public' as $$
begin
  if not prosp_wa_ok(p_token) then return json_build_object('ok', false, 'erro', 'token_invalido'); end if;
  update prosp_wa_conector set ultimo_contato=now(), estado=case when p_estado in ('conectado','qr','desconectado') then p_estado else 'desconectado' end, numero=coalesce(left(p_numero,20), numero) where id=1;
  return json_build_object('ok', true);
end $$;

create or replace function public.prosp_wa_puxar(p_token text)
returns json language plpgsql security definer set search_path to 'public' as $$
declare ini time; fim time; lim int; itv int; agora timestamp := now() at time zone 'America/Recife'; n int; m record; l prosp_leads; i int := 0;
begin
  if not prosp_wa_ok(p_token) then return json_build_object('ok', false, 'erro', 'token_invalido'); end if;
  update prosp_wa_conector set ultimo_contato=now() where id=1;
  update prosp_wa_fila set status='aguardando' where status='enviando' and enviando_em < now() - interval '10 minutes';
  if prosp_cfg('wa_on','false') <> 'true' then return json_build_object('ok', true, 'msg', null, 'motivo', 'desligado'); end if;
  if prosp_cfg('wa_pausa','false') = 'true' then return json_build_object('ok', true, 'msg', null, 'motivo', 'pausado'); end if;
  ini := prosp_cfg('wa_ini','09:00')::time; fim := prosp_cfg('wa_fim','18:00')::time;
  lim := greatest(1, least(80, prosp_cfg('wa_limite','20')::int)); itv := greatest(1, least(120, prosp_cfg('wa_intervalo','5')::int));
  if extract(dow from agora) = 0 or agora::time < ini or agora::time > fim then return json_build_object('ok', true, 'msg', null, 'motivo', 'fora_do_horario'); end if;
  select count(*) into n from prosp_wa_fila where status='enviada' and (enviado_em at time zone 'America/Recife')::date = agora::date;
  if n >= lim then return json_build_object('ok', true, 'msg', null, 'motivo', 'limite_diario'); end if;
  if exists (select 1 from prosp_wa_fila where status='enviada' and enviado_em > now() - make_interval(mins => itv)) then
    return json_build_object('ok', true, 'msg', null, 'motivo', 'intervalo');
  end if;
  loop
    i := i + 1; exit when i > 20;
    select * into m from prosp_wa_fila where status='aguardando' and enviar_apos <= now() order by enviar_apos limit 1 for update skip locked;
    if m.id is null then return json_build_object('ok', true, 'msg', null, 'motivo', 'fila_vazia'); end if;
    select * into l from prosp_leads where id=m.lead_id;
    -- ótica que já fechou, recusou, ou que já foi abordada à mão: não manda de novo
    if l.id is null or l.status in ('fechou','sem_interesse') or (m.tipo='abordagem' and l.enviado_em is not null) or (m.tipo='followup' and l.status not in ('enviado')) then
      update prosp_wa_fila set status='cancelada', erro=case when l.status in ('respondeu','interessada') then 'já respondeu' when m.tipo='abordagem' then 'já tinha sido abordada' else 'status mudou' end where id=m.id;
      continue;
    end if;
    update prosp_wa_fila set status='enviando', enviando_em=now(), tentativas=tentativas+1 where id=m.id;
    return json_build_object('ok', true, 'msg', json_build_object('id', m.id, 'telefone', m.telefone, 'texto', m.texto, 'tipo', m.tipo));
  end loop;
  return json_build_object('ok', true, 'msg', null, 'motivo', 'fila_vazia');
end $$;

create or replace function public.prosp_wa_resultado(p_token text, p_id uuid, p_ok boolean, p_erro text)
returns json language plpgsql security definer set search_path to 'public' as $$
declare m prosp_wa_fila; dias int := greatest(1, least(30, prosp_cfg('wa_followup_dias','3')::int)); hoje date := (now() at time zone 'America/Recife')::date;
begin
  if not prosp_wa_ok(p_token) then return json_build_object('ok', false, 'erro', 'token_invalido'); end if;
  select * into m from prosp_wa_fila where id=p_id; if m.id is null then return json_build_object('ok', false, 'erro', 'nao_encontrada'); end if;
  if p_ok then
    update prosp_wa_fila set status='enviada', enviado_em=now(), erro=null where id=p_id;
    if m.tipo='abordagem' then
      update prosp_leads set status=case when status='novo' then 'enviado' else status end, enviado_em=now(), follow_up=hoje+dias, atualizado_em=now(),
        historico=coalesce(historico,'[]'::jsonb)||jsonb_build_array(jsonb_build_object('em',now(),'txt','Abordagem enviada pelo envio automático')) where id=m.lead_id;
      update prosp_wa_fila set status='aguardando', enviar_apos=now()+make_interval(days=>dias) where lead_id=m.lead_id and tipo='followup' and status='espera';
    else
      update prosp_leads set follow_up=hoje+4, atualizado_em=now(),
        historico=coalesce(historico,'[]'::jsonb)||jsonb_build_array(jsonb_build_object('em',now(),'txt','Follow-up enviado pelo envio automático')) where id=m.lead_id;
    end if;
  elsif p_erro = 'sem_whatsapp' or m.tentativas >= 3 then
    update prosp_wa_fila set status='falhou', erro=left(coalesce(p_erro,'erro'),200) where id=p_id;
    update prosp_wa_fila set status='cancelada', erro='a abordagem não foi enviada' where lead_id=m.lead_id and status='espera';
    update prosp_leads set atualizado_em=now(), historico=coalesce(historico,'[]'::jsonb)||jsonb_build_array(jsonb_build_object('em',now(),'txt',case when p_erro='sem_whatsapp' then 'Envio automático: esse número não tem WhatsApp' else 'Envio automático falhou' end)) where id=m.lead_id;
  else
    update prosp_wa_fila set status='aguardando', enviar_apos=now()+interval '10 minutes', erro=left(coalesce(p_erro,'erro'),200) where id=p_id;
  end if;
  return json_build_object('ok', true);
end $$;

-- resposta de uma ótica: marca "Respondeu", guarda o texto no histórico e cancela o follow-up
create or replace function public.prosp_wa_receber(p_token text, p_telefone text, p_texto text, p_nome text default null)
returns json language plpgsql security definer set search_path to 'public' as $$
declare t text := right(regexp_replace(coalesce(p_telefone,''),'\D','','g'), 8); l prosp_leads;
begin
  if not prosp_wa_ok(p_token) then return json_build_object('ok', false, 'erro', 'token_invalido'); end if;
  if length(t) < 8 or coalesce(trim(p_texto),'') = '' then return json_build_object('ok', true); end if;
  select * into l from prosp_leads where enviado_em is not null
    and (right(regexp_replace(coalesce(whatsapp,''),'\D','','g'),8) = t or right(regexp_replace(coalesce(telefone,''),'\D','','g'),8) = t)
    order by enviado_em desc limit 1;
  if l.id is null then return json_build_object('ok', true, 'ignorado', true); end if;
  update prosp_leads set status=case when status='enviado' then 'respondeu' else status end, atualizado_em=now(),
    historico=coalesce(historico,'[]'::jsonb)||jsonb_build_array(jsonb_build_object('em',now(),'txt','Respondeu no WhatsApp: «'||left(trim(p_texto),300)||'»')) where id=l.id;
  update prosp_wa_fila set status='cancelada', erro='a ótica respondeu' where lead_id=l.id and status in ('espera','aguardando');
  return json_build_object('ok', true, 'acao', 'respondeu');
end $$;

create or replace function public.prosp_wa_sair(p_token text, p_telefone text)
returns json language plpgsql security definer set search_path to 'public' as $$
declare t text := right(regexp_replace(coalesce(p_telefone,''),'\D','','g'), 8);
begin
  if not prosp_wa_ok(p_token) then return json_build_object('ok', false, 'erro', 'token_invalido'); end if;
  if length(t) < 8 then return json_build_object('ok', true); end if;
  update prosp_wa_fila set status='cancelada', erro='pediu para sair' where status in ('espera','aguardando')
    and lead_id in (select id from prosp_leads where right(regexp_replace(coalesce(whatsapp,''),'\D','','g'),8)=t or right(regexp_replace(coalesce(telefone,''),'\D','','g'),8)=t);
  update prosp_leads set status='sem_interesse', follow_up=null, atualizado_em=now(),
    historico=coalesce(historico,'[]'::jsonb)||jsonb_build_array(jsonb_build_object('em',now(),'txt','Pediu para não receber mais mensagens'))
    where right(regexp_replace(coalesce(whatsapp,''),'\D','','g'),8)=t or right(regexp_replace(coalesce(telefone,''),'\D','','g'),8)=t;
  return json_build_object('ok', true);
end $$;

revoke execute on function public.prosp_wa_gerar_token() from anon;
revoke execute on function public.prosp_wa_status() from anon;
grant execute on function public.prosp_wa_ping(text,text,text), public.prosp_wa_puxar(text), public.prosp_wa_resultado(text,uuid,boolean,text),
  public.prosp_wa_receber(text,text,text,text), public.prosp_wa_sair(text,text) to anon, authenticated;
grant execute on function public.prosp_wa_gerar_token(), public.prosp_wa_status() to authenticated;
revoke execute on function public.prosp_cfg(text,text), public.prosp_wa_ok(text) from anon, authenticated, public;
do $$ begin
  begin alter publication supabase_realtime add table public.prosp_wa_fila; exception when duplicate_object then null; when undefined_object then null; end;
end $$;
