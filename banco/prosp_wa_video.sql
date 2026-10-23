-- Vídeo pela fila do CRM: prosp_wa_fila.midia (link do arquivo). O conector novo (1.9.2+) chama
-- prosp_wa_puxar / prosp_wa_puxar_manual com p_video=true e recebe "midia" para mandar o vídeo como arquivo.
-- O conector antigo chama a versão de 1 parâmetro e manda só o texto (a legenda já tem o link do vídeo).
alter table prosp_wa_fila add column if not exists midia text;

create or replace function public.prosp_wa_puxar(p_token text, p_video boolean)
 returns json language plpgsql security definer set search_path to 'public' as $function$
declare ini time; fim time; lim int; itv int; agora timestamp := now() at time zone 'America/Recife'; n int; m record; l prosp_leads; i int := 0;
begin
  if not prosp_wa_ok(p_token) then return json_build_object('ok', false, 'erro', 'token_invalido'); end if;
  update prosp_wa_conector set ultimo_contato=now() where id=1;
  update prosp_wa_fila set status='aguardando' where status='enviando' and enviando_em < now() - interval '10 minutes';
  -- mensagem escrita por você na aba WhatsApp: sai na hora
  select id, telefone, texto, tipo, midia into m from prosp_wa_fila where tipo='manual' and status='aguardando' and enviar_apos <= now()
    and criado_em > now() - interval '1 day' order by criado_em limit 1 for update skip locked;
  if m.id is not null then
    update prosp_wa_fila set status='enviando', enviando_em=now(), tentativas=tentativas+1 where id=m.id;
    return json_build_object('ok', true, 'msg', json_build_object('id', m.id, 'telefone', m.telefone, 'texto', m.texto, 'tipo', m.tipo, 'midia', case when p_video then m.midia end));
  end if;
  if prosp_cfg('wa_on','false') <> 'true' then return json_build_object('ok', true, 'msg', null, 'motivo', 'desligado'); end if;
  if prosp_cfg('wa_pausa','false') = 'true' then return json_build_object('ok', true, 'msg', null, 'motivo', 'pausado'); end if;
  ini := prosp_cfg('wa_ini','09:00')::time; fim := prosp_cfg('wa_fim','18:00')::time;
  lim := greatest(1, least(200, prosp_cfg('wa_limite','20')::int)); itv := greatest(1, least(120, prosp_cfg('wa_intervalo','5')::int));
  if extract(dow from agora) = 0 or agora::time < ini or agora::time > fim then return json_build_object('ok', true, 'msg', null, 'motivo', 'fora_do_horario'); end if;
  select count(*) into n from prosp_wa_fila where status='enviada' and tipo<>'manual' and (enviado_em at time zone 'America/Recife')::date = agora::date;
  if n >= lim then return json_build_object('ok', true, 'msg', null, 'motivo', 'limite_diario'); end if;
  if exists (select 1 from prosp_wa_fila where status='enviada' and tipo<>'manual' and enviado_em > now() - make_interval(mins => itv)) then
    return json_build_object('ok', true, 'msg', null, 'motivo', 'intervalo');
  end if;
  loop
    i := i + 1; exit when i > 20;
    select * into m from prosp_wa_fila where status='aguardando' and tipo<>'manual' and enviar_apos <= now() order by enviar_apos limit 1 for update skip locked;
    if m.id is null then return json_build_object('ok', true, 'msg', null, 'motivo', 'fila_vazia'); end if;
    select * into l from prosp_leads where id=m.lead_id;
    if l.id is null or (m.tipo='campanha' and (l.status in ('fechou','interessada') or l.campanha_em is not null)) or (m.tipo<>'campanha' and l.status in ('fechou','sem_interesse')) or (m.tipo='abordagem' and l.enviado_em is not null) or (m.tipo='followup' and l.status not in ('enviado')) then
      update prosp_wa_fila set status='cancelada', erro=case when l.status in ('respondeu','interessada') then 'já respondeu' when m.tipo='abordagem' then 'já tinha sido abordada' else 'status mudou' end where id=m.id;
      continue;
    end if;
    update prosp_wa_fila set status='enviando', enviando_em=now(), tentativas=tentativas+1 where id=m.id;
    return json_build_object('ok', true, 'msg', json_build_object('id', m.id, 'telefone', m.telefone, 'texto', m.texto, 'tipo', m.tipo, 'midia', case when p_video then m.midia end));
  end loop;
  return json_build_object('ok', true, 'msg', null, 'motivo', 'fila_vazia');
end $function$;

create or replace function public.prosp_wa_puxar(p_token text)
 returns json language sql security definer set search_path to 'public' as $$ select public.prosp_wa_puxar(p_token, false) $$;

create or replace function public.prosp_wa_puxar_manual(p_token text, p_video boolean)
 returns json language plpgsql security definer set search_path to 'public' as $function$
declare m record;
begin
  if not prosp_wa_ok(p_token) then return json_build_object('ok', false, 'erro', 'token_invalido'); end if;
  select id, telefone, texto, tipo, midia into m from prosp_wa_fila where tipo='manual' and status='aguardando' and enviar_apos <= now()
    and criado_em > now() - interval '1 day' order by criado_em limit 1 for update skip locked;
  if m.id is null then return json_build_object('ok', true, 'msg', null); end if;
  update prosp_wa_fila set status='enviando', enviando_em=now(), tentativas=tentativas+1 where id=m.id;
  return json_build_object('ok', true, 'msg', json_build_object('id', m.id, 'telefone', m.telefone, 'texto', m.texto, 'tipo', m.tipo, 'midia', case when p_video then m.midia end));
end $function$;

create or replace function public.prosp_wa_puxar_manual(p_token text)
 returns json language sql security definer set search_path to 'public' as $$ select public.prosp_wa_puxar_manual(p_token, false) $$;
