-- Locais de atendimento do exame de vista.
-- Cada local tem os seus dias da semana (e, se quiser, horários fixos). O local de um exame é
-- definido pelo dia da semana: o primeiro local da lista que atende naquele dia.
-- Ex.: Óticas DK -> quarta às 16:00; Consultório em Beberibe -> segunda, terça, quinta, sexta e sábado.
-- Sem locais cadastrados, tudo funciona como antes (endereço e horários da configuração geral).

alter table public.ex_config add column if not exists locais jsonb not null default '[]'::jsonb;

-- local que atende no dia (null = nenhum local cadastrado para o dia, ou nenhum local cadastrado)
create or replace function public.ex_local(c public.ex_config, d date)
returns jsonb language sql stable set search_path to 'public' as $$
  select l from jsonb_array_elements(case when jsonb_typeof(c.locais)='array' then c.locais else '[]'::jsonb end) l
  where jsonb_typeof(l->'dias') is distinct from 'array' or jsonb_array_length(l->'dias')=0 or (l->'dias') @> to_jsonb(extract(dow from d)::int)
  limit 1
$$;

-- o dia aceita exames? (dia ligado na configuração e, se houver locais, algum local atende nele)
create or replace function public.ex_dia_ok(c public.ex_config, d date)
returns boolean language sql stable set search_path to 'public' as $$
  select (extract(dow from d)::int = any(c.dias))
     and (jsonb_typeof(c.locais) is distinct from 'array' or jsonb_array_length(c.locais)=0 or public.ex_local(c,d) is not null)
$$;

-- horários do dia: os fixos do local ou, sem eles, de hora_ini a hora_fim de duracao_min em duracao_min
create or replace function public.ex_horas(c public.ex_config, d date)
returns time[] language plpgsql stable set search_path to 'public' as $$
declare l jsonb := public.ex_local(c,d); h time; res time[] := '{}';
begin
  if l is not null and jsonb_typeof(l->'horas')='array' and jsonb_array_length(l->'horas')>0 then
    return array(select distinct x::time from jsonb_array_elements_text(l->'horas') x where x ~ '^\d{1,2}:\d{2}$' order by 1);
  end if;
  h := c.hora_ini;
  while h + make_interval(mins=>c.duracao_min) <= c.hora_fim + interval '1 minute' and h >= c.hora_ini loop
    res := res || h; h := h + make_interval(mins=>c.duracao_min);
  end loop;
  return res;
end $$;

-- texto de endereço do exame (nome do local + endereço + link do mapa), usado nas mensagens
create or replace function public.ex_endereco(c public.ex_config, d date)
returns text language plpgsql stable set search_path to 'public' as $$
declare l jsonb := public.ex_local(c,d); t text;
begin
  if l is null or coalesce(trim(l->>'endereco'),'')='' then
    t := coalesce(nullif(trim(c.endereco),''), (select data->>'endereco' from docs where otica_id=c.otica_id and col='config' and id='otica'), '');
    if coalesce(c.cidade,'')<>'' and t<>'' then t := t||', '||c.cidade; end if;
    return t;
  end if;
  t := trim(l->>'endereco');
  if coalesce(trim(l->>'nome'),'')<>'' then t := trim(l->>'nome')||' – '||t; end if;
  if coalesce(trim(l->>'maps_url'),'')<>'' then t := t||E'\n'||trim(l->>'maps_url'); end if;
  return t;
end $$;

-- para o agente de IA (edge function): local de uma data
create or replace function public.ex_local_info(p_otica uuid, p_data date)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare c ex_config;
begin
  select * into c from ex_config where otica_id=p_otica; if not found then return null; end if;
  return jsonb_build_object('local', public.ex_local(c,p_data), 'endereco', public.ex_endereco(c,p_data));
end $$;
revoke all on function public.ex_local_info(uuid,date) from public, anon, authenticated;

create or replace function public.ex_publico(p_slug text)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare o oticas; c ex_config; oc jsonb;
begin
  select * into o from oticas where slug=lower(trim(p_slug)) and ativa and coalesce(modulos->>'exames','false')='true';
  if not found then return null; end if;
  select * into c from ex_config where otica_id=o.id and ativo; if not found then return null; end if;
  select data into oc from docs where otica_id=o.id and col='config' and id='otica';
  return jsonb_build_object('nome', coalesce(oc->>'nome', o.nome), 'cor1', o.cor1, 'cor2', o.cor2, 'logo_claro', o.logo_claro, 'logo_escuro', o.logo_escuro,
    'cfg', jsonb_build_object('titulo',c.titulo,'subtitulo',c.subtitulo,'endereco',coalesce(nullif(c.endereco,''),oc->>'endereco'),'cidade',c.cidade,'maps_url',c.maps_url,
      'whatsapp',coalesce(nullif(c.whatsapp,''),oc->>'whatsapp'),'dias',c.dias,'hora_ini',to_char(c.hora_ini,'HH24:MI'),'hora_fim',to_char(c.hora_fim,'HH24:MI'),
      'duracao',c.duracao_min,'vagas',c.vagas,'antecedencia_h',c.antecedencia_h,'janela',c.janela_dias,'valor_texto',c.valor_texto,'pixel_id',c.pixel_id,
      'locais',case when jsonb_typeof(c.locais)='array' then c.locais else '[]'::jsonb end),
    'agora', to_char(now() at time zone 'America/Recife','YYYY-MM-DD"T"HH24:MI'),
    'ocupados', coalesce((select jsonb_agg(jsonb_build_object('d',x.data,'h',to_char(x.hora,'HH24:MI'),'n',x.n)) from
       (select data,hora,count(*) n from ex_agend where otica_id=o.id and status in ('agendado','confirmado','compareceu')
          and data >= (now() at time zone 'America/Recife')::date and data <= (now() at time zone 'America/Recife')::date + c.janela_dias group by 1,2) x),'[]'::jsonb));
end $function$;

create or replace function public.ex_agendar(p_slug text, p_nome text, p_tel text, p_data date, p_hora time without time zone, p_consent boolean, p_origem text default null, p_campanha text default null, p_anuncio text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare o oticas; c ex_config; t text; agora timestamp := (now() at time zone 'America/Recife'); hoje date := (now() at time zone 'America/Recife')::date;
  n int; nid uuid; nome text := regexp_replace(trim(coalesce(p_nome,'')),'\s+',' ','g');
begin
  select * into o from oticas where slug=lower(trim(p_slug)) and ativa and coalesce(modulos->>'exames','false')='true';
  if not found then return jsonb_build_object('ok',false,'erro','Agendamento indisponível no momento.'); end if;
  select * into c from ex_config where otica_id=o.id and ativo;
  if not found then return jsonb_build_object('ok',false,'erro','Agendamento indisponível no momento.'); end if;
  if length(nome) < 2 or length(nome) > 80 then return jsonb_build_object('ok',false,'erro','Informe seu nome.'); end if;
  t := wa_tel(p_tel);
  if t is null then return jsonb_build_object('ok',false,'erro','Informe um WhatsApp válido, com DDD.'); end if;
  if not coalesce(p_consent,false) then return jsonb_build_object('ok',false,'erro','Para agendar, aceite receber a confirmação pelo WhatsApp.'); end if;
  if p_data is null or p_hora is null or p_data < hoje or p_data > hoje + c.janela_dias then return jsonb_build_object('ok',false,'erro','Escolha um dia disponível.'); end if;
  if not ex_dia_ok(c, p_data) then return jsonb_build_object('ok',false,'erro','Não atendemos nesse dia.'); end if;
  if not (p_hora = any(ex_horas(c, p_data))) then return jsonb_build_object('ok',false,'erro','Horário indisponível.'); end if;
  if (p_data + p_hora) < agora + make_interval(hours=>c.antecedencia_h) then return jsonb_build_object('ok',false,'erro','Esse horário já passou ou está muito próximo. Escolha outro.'); end if;
  perform pg_advisory_xact_lock(hashtext(o.id::text||p_data::text));
  select count(*) into n from ex_agend where otica_id=o.id and data=p_data and hora=p_hora and status in ('agendado','confirmado','compareceu');
  if n >= c.vagas then return jsonb_build_object('ok',false,'erro','Esse horário acabou de ser preenchido. Escolha outro.','recarregar',true); end if;
  if exists (select 1 from ex_agend where otica_id=o.id and whatsapp=t and data=p_data and status in ('agendado','confirmado')) then return jsonb_build_object('ok',false,'erro','Você já tem um exame marcado nesse dia.'); end if;
  select count(*) into n from ex_agend where otica_id=o.id and whatsapp=t and data>=hoje and status in ('agendado','confirmado');
  if n >= 2 then return jsonb_build_object('ok',false,'erro','Você já tem exames marcados. Fale com a gente pelo WhatsApp para alterar.'); end if;
  select count(*) into n from ex_agend where otica_id=o.id and criado_em > now() - interval '1 hour';
  if n >= 60 then return jsonb_build_object('ok',false,'erro','Muitos agendamentos agora. Tente novamente em alguns minutos.'); end if;
  insert into ex_agend(otica_id,nome,whatsapp,data,hora,origem,campanha,anuncio,consentimento)
  values (o.id, nome, t, p_data, p_hora, left(regexp_replace(coalesce(p_origem,''),'[^A-Za-z0-9_.\- ]','','g'),60), left(regexp_replace(coalesce(p_campanha,''),'[^A-Za-z0-9_.\- ]','','g'),80), left(regexp_replace(coalesce(p_anuncio,''),'[^A-Za-z0-9_.\- ]','','g'),60), true)
  returning id into nid;
  return jsonb_build_object('ok',true,'id',nid);
end $function$;

create or replace function public.ex_remarcar_tel(p_otica uuid, p_tel text, p_data date, p_hora time without time zone)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare a ex_agend; c ex_config; hoje date := (now() at time zone 'America/Recife')::date; agora timestamp := now() at time zone 'America/Recife'; n int;
begin
  a := ex_alvo(p_otica, p_tel);
  if a.id is null then return jsonb_build_object('ok',false,'erro','Não encontrei exame para este número.'); end if;
  select * into c from ex_config where otica_id=p_otica and ativo; if not found then return jsonb_build_object('ok',false,'erro','Agendamento indisponível.'); end if;
  if p_data is null or p_hora is null or p_data < hoje or p_data > hoje + c.janela_dias then return jsonb_build_object('ok',false,'erro','Dia fora do período disponível.'); end if;
  if not ex_dia_ok(c, p_data) then return jsonb_build_object('ok',false,'erro','Não atendemos nesse dia.'); end if;
  if not (p_hora = any(ex_horas(c, p_data))) then return jsonb_build_object('ok',false,'erro','Horário indisponível.'); end if;
  if (p_data + p_hora) < agora + make_interval(hours=>c.antecedencia_h) then return jsonb_build_object('ok',false,'erro','Esse horário já passou ou está muito próximo.'); end if;
  perform pg_advisory_xact_lock(hashtext(p_otica::text||p_data::text));
  select count(*) into n from ex_agend where otica_id=p_otica and data=p_data and hora=p_hora and status in ('agendado','confirmado','compareceu') and id<>a.id;
  if n >= c.vagas then return jsonb_build_object('ok',false,'erro','Esse horário já foi preenchido.'); end if;
  update ex_agend set data=p_data, hora=p_hora, status='agendado' where id=a.id;
  return jsonb_build_object('ok',true,'data',p_data,'hora',to_char(p_hora,'HH24:MI'),'local',ex_local(c,p_data)->>'nome','endereco',ex_endereco(c,p_data));
end $function$;

create or replace function public.ex_horarios_livres(p_otica uuid, p_de date default null, p_dias integer default 7)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare c ex_config; hoje date := (now() at time zone 'America/Recife')::date; agora timestamp := now() at time zone 'America/Recife';
  d date; h time; ini date; n int; hs jsonb; res jsonb := '[]'::jsonb; nomes text[] := array['domingo','segunda','terça','quarta','quinta','sexta','sábado'];
begin
  select * into c from ex_config where otica_id=p_otica and ativo; if not found then return res; end if;
  ini := greatest(coalesce(p_de,hoje),hoje);
  for d in select g::date from generate_series(ini, least(ini+greatest(least(p_dias,14),1)-1, hoje+c.janela_dias), interval '1 day') g loop
    if not ex_dia_ok(c, d) then continue; end if;
    hs := '[]'::jsonb;
    foreach h in array ex_horas(c, d) loop
      if (d + h) >= agora + make_interval(hours=>c.antecedencia_h) then
        select count(*) into n from ex_agend where otica_id=p_otica and data=d and hora=h and status in ('agendado','confirmado','compareceu');
        if n < c.vagas then hs := hs || to_jsonb(to_char(h,'HH24:MI')); end if;
      end if;
    end loop;
    if jsonb_array_length(hs) > 0 then res := res || jsonb_build_object('data',d,'dia',nomes[extract(dow from d)::int+1]||' '||to_char(d,'DD/MM'),'horas',hs,'local',ex_local(c,d)->>'nome'); end if;
  end loop;
  return res;
end $function$;

create or replace function public.ex_enfileirar(p_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare a ex_agend; o oticas; c ex_config; nome_o text; end_t text; dias text[] := array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
  vars jsonb; ts timestamptz; lem timestamptz; quando text; tpl_c text; tpl_l text;
  def_c text := E'Olá, {nome}! 👋 Aqui é da {otica}.\n\nSeu exame de vista está agendado para {dia}, às {hora}. ✅\n\n📍 {endereco}\n\nSe precisar remarcar, é só responder por aqui. Esperamos você! 👓';
  def_l text := E'Oi, {nome}! 😊 Passando para lembrar do seu exame de vista {quando}, às {hora}.\n\n📍 {endereco}\n\nPode confirmar respondendo "SIM"? Se não conseguir vir, avise por aqui que a gente remarca. 🙏';
begin
  select * into a from ex_agend where id=p_id; if not found then return; end if;
  select * into o from oticas where id=a.otica_id;
  select * into c from ex_config where otica_id=a.otica_id;
  nome_o := coalesce((select data->>'nome' from docs where otica_id=a.otica_id and col='config' and id='otica'), o.nome);
  end_t := ex_endereco(c, a.data);
  ts := (a.data + a.hora) at time zone 'America/Recife';
  if ts < now() then return; end if;
  tpl_c := coalesce(nullif(c.tpl->>'conf',''), def_c); tpl_l := coalesce(nullif(c.tpl->>'lemb',''), def_l);
  vars := jsonb_build_object('nome', initcap(lower(split_part(trim(a.nome),' ',1))), 'otica', nome_o,
    'dia', dias[extract(dow from a.data)::int+1]||' ('||to_char(a.data,'DD/MM')||')', 'hora', to_char(a.hora,'HH24:MI'), 'endereco', end_t,
    'local', coalesce(ex_local(c,a.data)->>'nome', nome_o));
  perform wa_ins(a.otica_id, a.id::text, a.nome, 'exame_conf', a.whatsapp, wa_render(tpl_c, vars),
    'exconf:'||a.id||':'||a.data||':'||to_char(a.hora,'HH24MI'), now(), ts, false);
  lem := ((a.data - 1)::timestamp + time '17:00') at time zone 'America/Recife'; quando := 'amanhã';
  if lem < now() + interval '1 hour' then lem := ts - interval '2 hours'; quando := 'hoje'; end if;
  if lem >= now() + interval '1 hour' and lem < ts then
    perform wa_ins(a.otica_id, a.id::text, a.nome, 'exame_lembrete', a.whatsapp, wa_render(tpl_l, vars||jsonb_build_object('quando',quando)),
      'exlem:'||a.id||':'||a.data||':'||to_char(a.hora,'HH24MI'), lem, ts, false);
  end if;
end $function$;

create or replace function public.ex_aviso_equipe(p_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare a ex_agend; c ex_config; o oticas; cfg jsonb; nome_o text; dias text[] := array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
  n text; t text; txt text; tel_f text; ts timestamptz; orig text; loc text;
begin
  select * into a from ex_agend where id=p_id; if not found then return; end if;
  select * into c from ex_config where otica_id=a.otica_id; if not found then return; end if;
  if jsonb_typeof(c.tpl->'avisar') is distinct from 'array' or jsonb_array_length(c.tpl->'avisar')=0 then return; end if;
  select data into cfg from docs where otica_id=a.otica_id and col='config' and id='wa';
  if coalesce(cfg->>'on','false') <> 'true' then return; end if;
  select * into o from oticas where id=a.otica_id;
  nome_o := coalesce((select data->>'nome' from docs where otica_id=a.otica_id and col='config' and id='otica'), o.nome);
  ts := (a.data + a.hora) at time zone 'America/Recife';
  tel_f := case when length(a.whatsapp)=13 then '('||substr(a.whatsapp,3,2)||') '||substr(a.whatsapp,5,5)||'-'||substr(a.whatsapp,10) when length(a.whatsapp)=12 then '('||substr(a.whatsapp,3,2)||') '||substr(a.whatsapp,5,4)||'-'||substr(a.whatsapp,9) else a.whatsapp end;
  orig := case when coalesce(a.origem,'')='equipe' then 'cadastrado pela equipe' when coalesce(a.origem,'')='' then 'pelo link de agendamento' when a.origem='meta' then 'pelo anúncio' else 'pelo link de agendamento' end;
  loc := ex_local(c, a.data)->>'nome';
  txt := '📅 Novo exame de vista agendado na '||nome_o||E'!\n\n👤 '||initcap(lower(a.nome))||E'\n📱 '||tel_f||E'\n🗓️ '||dias[extract(dow from a.data)::int+1]||' ('||to_char(a.data,'DD/MM')||'), às '||to_char(a.hora,'HH24:MI')
    ||case when coalesce(loc,'')<>'' then E'\n📍 '||loc else '' end||E'\n🔎 '||orig||E'\n\nPara não receber mais avisos, responda SAIR.';
  for n in select jsonb_array_elements_text(c.tpl->'avisar') loop
    t := wa_tel(n); if t is null then continue; end if;
    insert into wa_fila(otica_id,cliente_id,cliente_nome,tipo,telefone,texto,ref,status,enviar_apos,expira_em)
    values (a.otica_id, a.id::text, 'Equipe', 'exame_equipe', t, txt, 'exeq:'||a.id||':'||t, 'aguardando', now(), greatest(ts, now()+interval '1 day'))
    on conflict (otica_id,ref) do nothing;
  end loop;
end $function$;

revoke all on function public.ex_endereco(public.ex_config, date) from public, anon, authenticated;
