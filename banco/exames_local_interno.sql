-- Exames: locais "só para a equipe" (interno=true) e local escolhido salvo no exame.
-- Um local interno não aparece no site nem para o agente de IA; só a equipe agenda nele pelo sistema.
-- Quando a equipe escolhe um local diferente do padrão do dia, ele fica salvo em ex_agend.local
-- e as mensagens (confirmação, alteração, lembrete, aviso aos donos) usam esse endereço.

alter table public.ex_agend add column if not exists local jsonb;

-- local padrão (público) do dia: ignora os internos
create or replace function public.ex_local(c ex_config, d date)
returns jsonb language sql stable set search_path to 'public' as $function$
  select l from jsonb_array_elements(case when jsonb_typeof(c.locais)='array' then c.locais else '[]'::jsonb end) l
  where coalesce(l->>'interno','false') <> 'true'
    and (jsonb_typeof(l->'dias') is distinct from 'array' or jsonb_array_length(l->'dias')=0 or (l->'dias') @> to_jsonb(extract(dow from d)::int))
  limit 1
$function$;

-- endereço do exame: o local salvo no exame, senão o padrão do dia
create or replace function public.ex_endereco_ag(a ex_agend, c ex_config)
returns text language plpgsql stable set search_path to 'public' as $function$
declare l jsonb := a.local; t text;
begin
  if l is null or coalesce(trim(l->>'endereco'),'')='' then return public.ex_endereco(c, a.data); end if;
  t := trim(l->>'endereco');
  if coalesce(trim(l->>'nome'),'')<>'' then t := trim(l->>'nome')||' – '||t; end if;
  if coalesce(trim(l->>'maps_url'),'')<>'' then t := t||E'\n'||trim(l->>'maps_url'); end if;
  return t;
end $function$;

create or replace function public.ex_local_nome_ag(a ex_agend, c ex_config)
returns text language sql stable set search_path to 'public' as $function$
  select coalesce(nullif(trim(a.local->>'nome'),''), public.ex_local(c, a.data)->>'nome')
$function$;

-- site público: não envia os locais internos
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
      'locais',coalesce((select jsonb_agg(l) from jsonb_array_elements(case when jsonb_typeof(c.locais)='array' then c.locais else '[]'::jsonb end) l where coalesce(l->>'interno','false')<>'true'),'[]'::jsonb)),
    'agora', to_char(now() at time zone 'America/Recife','YYYY-MM-DD"T"HH24:MI'),
    'ocupados', coalesce((select jsonb_agg(jsonb_build_object('d',x.data,'h',to_char(x.hora,'HH24:MI'),'n',x.n)) from
       (select data,hora,count(*) n from ex_agend where otica_id=o.id and status in ('agendado','confirmado','compareceu')
          and data >= (now() at time zone 'America/Recife')::date and data <= (now() at time zone 'America/Recife')::date + c.janela_dias group by 1,2) x),'[]'::jsonb));
end $function$;

-- mensagens de confirmação/alteração e lembrete usam o local salvo
create or replace function public.ex_enfileirar_x(p_id uuid, p_alterado boolean)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare a ex_agend; o oticas; c ex_config; nome_o text; end_t text; dias text[] := array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
  vars jsonb; ts timestamptz; lem timestamptz; quando text; tpl_c text; tpl_l text; suf text;
  def_c text := E'Olá, {nome}! 👋 Aqui é da {otica}.\n\nSeu exame de vista está agendado para {dia}, às {hora}. ✅\n\n📍 {endereco}\n\nSe precisar remarcar, é só responder por aqui. Esperamos você! 👓';
  def_a text := E'Olá, {nome}! 👋 Aqui é da {otica}.\n\nSeu exame de vista foi alterado. ✏️\n\n🗓️ Novo dia e horário: {dia}, às {hora}\n📍 {endereco}\n\nSe precisar mudar de novo, é só responder por aqui. Esperamos você! 👓';
  def_l text := E'Oi, {nome}! 😊 Passando para lembrar do seu exame de vista {quando}, às {hora}.\n\n📍 {endereco}\n\nPode confirmar respondendo "SIM"? Se não conseguir vir, avise por aqui que a gente remarca. 🙏';
begin
  select * into a from ex_agend where id=p_id; if not found then return; end if;
  select * into o from oticas where id=a.otica_id;
  select * into c from ex_config where otica_id=a.otica_id;
  nome_o := coalesce((select data->>'nome' from docs where otica_id=a.otica_id and col='config' and id='otica'), o.nome);
  end_t := ex_endereco_ag(a, c);
  suf := case when a.local is null then '' else ':'||left(md5(coalesce(a.local->>'nome','')||'|'||coalesce(a.local->>'endereco','')),6) end;
  ts := (a.data + a.hora) at time zone 'America/Recife';
  if ts < now() then return; end if;
  tpl_c := case when p_alterado then coalesce(nullif(c.tpl->>'alt',''), def_a) else coalesce(nullif(c.tpl->>'conf',''), def_c) end;
  tpl_l := coalesce(nullif(c.tpl->>'lemb',''), def_l);
  vars := jsonb_build_object('nome', initcap(lower(split_part(trim(a.nome),' ',1))), 'otica', nome_o,
    'dia', dias[extract(dow from a.data)::int+1]||' ('||to_char(a.data,'DD/MM')||')', 'hora', to_char(a.hora,'HH24:MI'), 'endereco', end_t,
    'local', coalesce(ex_local_nome_ag(a,c), nome_o));
  perform wa_ins(a.otica_id, a.id::text, a.nome, 'exame_conf', a.whatsapp, wa_render(tpl_c, vars),
    'exconf:'||a.id||':'||a.data||':'||to_char(a.hora,'HH24MI')||suf, now(), ts, false);
  lem := ((a.data - 1)::timestamp + time '17:00') at time zone 'America/Recife'; quando := 'amanhã';
  if lem < now() + interval '1 hour' then lem := ts - interval '2 hours'; quando := 'hoje'; end if;
  if lem >= now() + interval '1 hour' and lem < ts then
    perform wa_ins(a.otica_id, a.id::text, a.nome, 'exame_lembrete', a.whatsapp, wa_render(tpl_l, vars||jsonb_build_object('quando',quando)),
      'exlem:'||a.id||':'||a.data||':'||to_char(a.hora,'HH24MI')||suf, lem, ts, false);
  end if;
end $function$;

-- aviso aos donos com o local salvo
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
  loc := ex_local_nome_ag(a, c);
  txt := '📅 Novo exame de vista agendado na '||nome_o||E'!\n\n👤 '||initcap(lower(a.nome))||E'\n📱 '||tel_f||E'\n🗓️ '||dias[extract(dow from a.data)::int+1]||' ('||to_char(a.data,'DD/MM')||'), às '||to_char(a.hora,'HH24:MI')
    ||case when coalesce(loc,'')<>'' then E'\n📍 '||loc else '' end||E'\n🔎 '||orig||E'\n\nPara não receber mais avisos, responda SAIR.';
  for n in select jsonb_array_elements_text(c.tpl->'avisar') loop
    t := wa_tel(n); if t is null then continue; end if;
    insert into wa_fila(otica_id,cliente_id,cliente_nome,tipo,telefone,texto,ref,status,enviar_apos,expira_em)
    values (a.otica_id, a.id::text, 'Equipe', 'exame_equipe', t, txt, 'exeq:'||a.id||':'||t, 'aguardando', now(), greatest(ts, now()+interval '1 day'))
    on conflict (otica_id,ref) do nothing;
  end loop;
end $function$;

-- remarcação pelo cliente/IA volta para o local padrão do dia
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
  update ex_agend set data=p_data, hora=p_hora, local=null, status='agendado' where id=a.id;
  return jsonb_build_object('ok',true,'data',p_data,'hora',to_char(p_hora,'HH24:MI'),'local',ex_local(c,p_data)->>'nome','endereco',ex_endereco(c,p_data));
end $function$;

-- trocar só o local também conta como alteração
create or replace function public.ex_tg_upd()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  new.atualizado_em := now();
  if new.status in ('cancelado','faltou','compareceu') or new.data is distinct from old.data or new.hora is distinct from old.hora or new.local is distinct from old.local then
    update wa_fila set status='cancelada' where otica_id=new.otica_id and cliente_id=new.id::text and tipo in ('exame_conf','exame_lembrete')
      and status in ('aguardando','aprovar');
  end if;
  return new;
end $function$;

create or replace function public.ex_tg_pos()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  if new.status in ('agendado','confirmado') and (new.data is distinct from old.data or new.hora is distinct from old.hora or new.local is distinct from old.local) then perform public.ex_enfileirar_x(new.id, true); end if;
  if new.status='faltou' and old.status is distinct from 'faltou' then
    begin perform public.ex_enfileirar_falta(new.id); exception when others then null; end;
  end if;
  return null;
end $function$;
