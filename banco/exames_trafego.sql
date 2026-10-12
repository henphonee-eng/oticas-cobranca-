-- Exames de vista (agendamento) + Tráfego pago (Meta). Módulo adicional "exames" (não vem no Premium).
create extension if not exists pg_net;

create or replace function public.sou_dono(o uuid) returns boolean language sql stable security definer set search_path=public as $$
  select public.sou_admin() or exists (select 1 from public.membros m join public.oticas t on t.id=m.otica_id
    where m.user_id=auth.uid() and m.otica_id=o and m.ativo and t.ativa and m.papel='dono');
$$;

create table if not exists public.ex_config (
  otica_id uuid primary key references public.oticas(id) on delete cascade,
  ativo boolean not null default false,
  titulo text not null default 'Agende seu exame de vista',
  subtitulo text not null default 'Escolha o melhor dia e horário. Leva poucos minutos e a gente confirma pelo WhatsApp.',
  endereco text, cidade text, maps_url text, whatsapp text,
  lat numeric, lng numeric,
  dias int[] not null default '{1,2,3,4,5,6}',
  hora_ini time not null default '09:00', hora_fim time not null default '17:00',
  duracao_min int not null default 30 check (duracao_min between 10 and 180),
  vagas int not null default 1 check (vagas between 1 and 20),
  antecedencia_h int not null default 2 check (antecedencia_h between 0 and 168),
  janela_dias int not null default 14 check (janela_dias between 1 and 60),
  valor_texto text not null default 'Exame de vista sem compromisso',
  pixel_id text,
  tpl jsonb not null default '{}'::jsonb,
  atualizado_em timestamptz not null default now()
);

create table if not exists public.ex_agend (
  id uuid primary key default gen_random_uuid(),
  otica_id uuid not null references public.oticas(id) on delete cascade,
  nome text not null, whatsapp text not null,
  data date not null, hora time not null,
  status text not null default 'agendado' check (status in ('agendado','confirmado','compareceu','faltou','cancelado')),
  origem text, campanha text, anuncio text, obs text, cliente_id text,
  consentimento boolean not null default true,
  criado_em timestamptz not null default now(), atualizado_em timestamptz not null default now()
);
create index if not exists ex_agend_busca on public.ex_agend(otica_id, data, hora);
create index if not exists ex_agend_anuncio on public.ex_agend(otica_id, anuncio);

create table if not exists public.ads_conexao (
  otica_id uuid primary key references public.oticas(id) on delete cascade,
  estado text not null default 'desconectado' check (estado in ('desconectado','escolher','conectado','erro')),
  token text, token_exp timestamptz, usuario_meta text,
  page_id text, page_nome text, ig_id text, ig_nome text,
  ad_account_id text, ad_account_nome text, pixel_id text,
  opcoes jsonb not null default '{}'::jsonb,
  config jsonb not null default '{}'::jsonb,
  campanha_id text, adset_id text,
  erro text, ultima_sync timestamptz,
  atualizado_em timestamptz not null default now()
);

create table if not exists public.ads_criativos (
  id uuid primary key default gen_random_uuid(),
  otica_id uuid not null references public.oticas(id) on delete cascade,
  tipo text not null default 'imagem' check (tipo in ('imagem','video')),
  origem text not null default 'gerado' check (origem in ('gerado','upload')),
  nome text not null default '', titulo text not null default '', texto text not null default '',
  midia_url text, thumb_url text,
  status text not null default 'pronto' check (status in ('pronto','ativo','pausado','reprovado','arquivado')),
  meta_ad_id text, meta_creative_id text, erro text,
  criado_em timestamptz not null default now()
);
create index if not exists ads_criativos_o on public.ads_criativos(otica_id, status);

create table if not exists public.ads_metricas (
  otica_id uuid not null references public.oticas(id) on delete cascade,
  dia date not null, ad_id text not null,
  gasto numeric(12,2) not null default 0, impressoes int not null default 0, alcance int not null default 0,
  cliques int not null default 0, leads int not null default 0,
  primary key (otica_id, dia, ad_id)
);

create table if not exists public.ads_sugestoes (
  id uuid primary key default gen_random_uuid(),
  otica_id uuid not null references public.oticas(id) on delete cascade,
  tipo text not null, titulo text not null, detalhe text not null default '',
  criativo_id uuid, ad_id text, valor numeric,
  status text not null default 'pendente' check (status in ('pendente','aplicada','ignorada','automatica')),
  criada_em timestamptz not null default now()
);
create index if not exists ads_sug_o on public.ads_sugestoes(otica_id, status, criada_em desc);

alter table public.ex_config enable row level security;
alter table public.ex_agend enable row level security;
alter table public.ads_conexao enable row level security;
alter table public.ads_criativos enable row level security;
alter table public.ads_metricas enable row level security;
alter table public.ads_sugestoes enable row level security;

drop policy if exists ex_config_all on public.ex_config;
create policy ex_config_all on public.ex_config for all to authenticated using (public.minha_otica(otica_id)) with check (public.sou_dono(otica_id));
drop policy if exists ex_agend_all on public.ex_agend;
create policy ex_agend_all on public.ex_agend for all to authenticated using (public.minha_otica(otica_id)) with check (public.minha_otica(otica_id));
drop policy if exists ads_criativos_all on public.ads_criativos;
create policy ads_criativos_all on public.ads_criativos for all to authenticated using (public.sou_dono(otica_id)) with check (public.sou_dono(otica_id));
drop policy if exists ads_metricas_sel on public.ads_metricas;
create policy ads_metricas_sel on public.ads_metricas for select to authenticated using (public.sou_dono(otica_id));
drop policy if exists ads_sug_sel on public.ads_sugestoes;
create policy ads_sug_sel on public.ads_sugestoes for select to authenticated using (public.sou_dono(otica_id));
drop policy if exists ads_sug_upd on public.ads_sugestoes;
create policy ads_sug_upd on public.ads_sugestoes for update to authenticated using (public.sou_dono(otica_id)) with check (public.sou_dono(otica_id));
-- ads_conexao: sem política de propósito (guarda o token da Meta). Acesso só pelas funções abaixo e pelas Edge Functions.

-- ---------- WhatsApp: avisos de exame saem sozinhos por padrão ----------
create or replace function public.wa_ins(o uuid, cid text, nome text, tp text, tel text, txt text, rf text, apos timestamp with time zone, expira timestamp with time zone, forcar boolean)
returns text language plpgsql security definer set search_path to 'public' as $function$
declare cfg jsonb; modo text; st text; t text;
begin
  select data into cfg from docs where otica_id=o and col='config' and id='wa';
  cfg := coalesce(cfg,'{}'::jsonb);
  if coalesce(cfg->>'on','false') <> 'true' then return 'off'; end if;
  modo := coalesce(cfg->'modo'->>tp, case when tp like 'exame\_%' then 'auto' else 'aprovar' end);
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
end $function$;

-- ---------- mensagens do exame ----------
create or replace function public.ex_enfileirar(p_id uuid) returns void language plpgsql security definer set search_path=public as $$
declare a ex_agend; o oticas; c ex_config; nome_o text; end_t text; dias text[] := array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
  vars jsonb; ts timestamptz; lem timestamptz; quando text; tpl_c text; tpl_l text;
  def_c text := 'Olá, {nome}! 👋 Aqui é da {otica}.

Seu exame de vista está agendado para {dia}, às {hora}. ✅

📍 {endereco}

Se precisar remarcar, é só responder por aqui. Esperamos você! 👓';
  def_l text := 'Oi, {nome}! 😊 Passando para lembrar do seu exame de vista {quando}, às {hora}, na {otica}.

📍 {endereco}

Pode confirmar respondendo "SIM"? Se não conseguir vir, avise por aqui que a gente remarca. 🙏';
begin
  select * into a from ex_agend where id=p_id; if not found then return; end if;
  select * into o from oticas where id=a.otica_id;
  select * into c from ex_config where otica_id=a.otica_id;
  nome_o := coalesce((select data->>'nome' from docs where otica_id=a.otica_id and col='config' and id='otica'), o.nome);
  end_t := coalesce(nullif(trim(c.endereco),''), (select data->>'endereco' from docs where otica_id=a.otica_id and col='config' and id='otica'), '');
  if c.cidade is not null and c.cidade<>'' and end_t<>'' then end_t := end_t||', '||c.cidade; end if;
  ts := (a.data + a.hora) at time zone 'America/Recife';
  if ts < now() then return; end if;
  tpl_c := coalesce(nullif(c.tpl->>'conf',''), def_c); tpl_l := coalesce(nullif(c.tpl->>'lemb',''), def_l);
  vars := jsonb_build_object('nome', initcap(lower(split_part(trim(a.nome),' ',1))), 'otica', nome_o,
    'dia', dias[extract(dow from a.data)::int+1]||' ('||to_char(a.data,'DD/MM')||')', 'hora', to_char(a.hora,'HH24:MI'), 'endereco', end_t);
  perform wa_ins(a.otica_id, a.id::text, a.nome, 'exame_conf', a.whatsapp, wa_render(tpl_c, vars),
    'exconf:'||a.id||':'||a.data||':'||to_char(a.hora,'HH24MI'), now(), ts, false);
  lem := ((a.data - 1)::timestamp + time '17:00') at time zone 'America/Recife'; quando := 'amanhã';
  if lem < now() + interval '1 hour' then lem := ts - interval '2 hours'; quando := 'hoje'; end if;
  if lem >= now() + interval '1 hour' and lem < ts then
    perform wa_ins(a.otica_id, a.id::text, a.nome, 'exame_lembrete', a.whatsapp, wa_render(tpl_l, vars||jsonb_build_object('quando',quando)),
      'exlem:'||a.id||':'||a.data||':'||to_char(a.hora,'HH24MI'), lem, ts, false);
  end if;
end $$;

create or replace function public.ex_tg_upd() returns trigger language plpgsql security definer set search_path=public as $$
begin
  new.atualizado_em := now();
  if new.status in ('cancelado','faltou','compareceu') or new.data is distinct from old.data or new.hora is distinct from old.hora then
    update wa_fila set status='cancelada' where otica_id=new.otica_id and cliente_id=new.id::text and tipo in ('exame_conf','exame_lembrete')
      and status in ('aguardando','aprovar') and (new.status in ('cancelado','faltou','compareceu') or ref not like '%'||new.data||':'||to_char(new.hora,'HH24MI'));
  end if;
  return new;
end $$;
create or replace function public.ex_tg_pos() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.status in ('agendado','confirmado') and (new.data is distinct from old.data or new.hora is distinct from old.hora) then perform public.ex_enfileirar(new.id); end if;
  return null;
end $$;
drop trigger if exists ex_agend_upd on public.ex_agend;
create trigger ex_agend_upd before update on public.ex_agend for each row execute function public.ex_tg_upd();
drop trigger if exists ex_agend_pos on public.ex_agend;
create trigger ex_agend_pos after update on public.ex_agend for each row execute function public.ex_tg_pos();

-- ---------- página pública ----------
create or replace function public.ex_publico(p_slug text) returns jsonb language plpgsql stable security definer set search_path=public as $$
declare o oticas; c ex_config; oc jsonb;
begin
  select * into o from oticas where slug=lower(trim(p_slug)) and ativa and coalesce(modulos->>'exames','false')='true';
  if not found then return null; end if;
  select * into c from ex_config where otica_id=o.id and ativo; if not found then return null; end if;
  select data into oc from docs where otica_id=o.id and col='config' and id='otica';
  return jsonb_build_object('nome', coalesce(oc->>'nome', o.nome), 'cor1', o.cor1, 'cor2', o.cor2, 'logo_claro', o.logo_claro, 'logo_escuro', o.logo_escuro,
    'cfg', jsonb_build_object('titulo',c.titulo,'subtitulo',c.subtitulo,'endereco',coalesce(nullif(c.endereco,''),oc->>'endereco'),'cidade',c.cidade,'maps_url',c.maps_url,
      'whatsapp',coalesce(nullif(c.whatsapp,''),oc->>'whatsapp'),'dias',c.dias,'hora_ini',to_char(c.hora_ini,'HH24:MI'),'hora_fim',to_char(c.hora_fim,'HH24:MI'),
      'duracao',c.duracao_min,'vagas',c.vagas,'antecedencia_h',c.antecedencia_h,'janela',c.janela_dias,'valor_texto',c.valor_texto,'pixel_id',c.pixel_id),
    'agora', to_char(now() at time zone 'America/Recife','YYYY-MM-DD"T"HH24:MI'),
    'ocupados', coalesce((select jsonb_agg(jsonb_build_object('d',x.data,'h',to_char(x.hora,'HH24:MI'),'n',x.n)) from
       (select data,hora,count(*) n from ex_agend where otica_id=o.id and status in ('agendado','confirmado','compareceu')
          and data >= (now() at time zone 'America/Recife')::date and data <= (now() at time zone 'America/Recife')::date + c.janela_dias group by 1,2) x),'[]'::jsonb));
end $$;

create or replace function public.ex_agendar(p_slug text, p_nome text, p_tel text, p_data date, p_hora time, p_consent boolean,
  p_origem text default null, p_campanha text default null, p_anuncio text default null) returns jsonb language plpgsql security definer set search_path=public as $$
declare o oticas; c ex_config; t text; agora timestamp := (now() at time zone 'America/Recife'); hoje date := (now() at time zone 'America/Recife')::date;
  n int; nid uuid; mins int; nome text := regexp_replace(trim(coalesce(p_nome,'')),'\s+',' ','g');
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
  if not (extract(dow from p_data)::int = any(c.dias)) then return jsonb_build_object('ok',false,'erro','Não atendemos nesse dia.'); end if;
  mins := (extract(epoch from (p_hora - c.hora_ini))/60)::int;
  if p_hora < c.hora_ini or p_hora + make_interval(mins=>c.duracao_min) > c.hora_fim + interval '1 minute' or mins % c.duracao_min <> 0 then return jsonb_build_object('ok',false,'erro','Horário indisponível.'); end if;
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
end $$;

grant execute on function public.ex_publico(text) to anon, authenticated;
grant execute on function public.ex_agendar(text,text,text,date,time,boolean,text,text,text) to anon, authenticated;
revoke execute on function public.ex_enfileirar(uuid) from public, anon, authenticated;

-- ---------- Meta: estado e configuração (sem expor o token) ----------
create or replace function public.ads_estado(p_otica uuid) returns jsonb language plpgsql stable security definer set search_path=public as $$
declare r ads_conexao;
begin
  if not public.sou_dono(p_otica) then raise exception 'Sem permissão'; end if;
  select * into r from ads_conexao where otica_id=p_otica;
  if not found then return jsonb_build_object('estado','desconectado','config','{}'::jsonb,'opcoes','{}'::jsonb); end if;
  return jsonb_build_object('estado',r.estado,'usuario_meta',r.usuario_meta,'page_id',r.page_id,'page_nome',r.page_nome,'ig_id',r.ig_id,'ig_nome',r.ig_nome,
    'ad_account_id',r.ad_account_id,'ad_account_nome',r.ad_account_nome,'pixel_id',r.pixel_id,'opcoes',r.opcoes,'config',r.config,
    'campanha_id',r.campanha_id,'erro',r.erro,'ultima_sync',r.ultima_sync,'token_exp',r.token_exp);
end $$;

create or replace function public.ads_escolher(p_otica uuid, p_page text, p_ig text, p_conta text, p_pixel text) returns void language plpgsql security definer set search_path=public as $$
declare r ads_conexao; pg jsonb; ct jsonb; px jsonb;
begin
  if not public.sou_dono(p_otica) then raise exception 'Sem permissão'; end if;
  select * into r from ads_conexao where otica_id=p_otica; if not found then raise exception 'Conecte a conta da Meta primeiro'; end if;
  select x into pg from jsonb_array_elements(coalesce(r.opcoes->'paginas','[]')) x where x->>'id'=p_page limit 1;
  select x into ct from jsonb_array_elements(coalesce(r.opcoes->'contas','[]')) x where x->>'id'=p_conta limit 1;
  if pg is null or ct is null then raise exception 'Opção inválida'; end if;
  select x into px from jsonb_array_elements(coalesce(ct->'pixels','[]')) x where x->>'id'=p_pixel limit 1;
  update ads_conexao set page_id=pg->>'id', page_nome=pg->>'nome', ig_id=nullif(p_ig,''), ig_nome=case when p_ig=pg->>'ig_id' then pg->>'ig_nome' else null end,
    ad_account_id=ct->>'id', ad_account_nome=ct->>'nome', pixel_id=px->>'id', estado='conectado', erro=null, atualizado_em=now() where otica_id=p_otica;
end $$;

create or replace function public.ads_config(p_otica uuid, p_cfg jsonb) returns jsonb language plpgsql security definer set search_path=public as $$
declare novo jsonb := '{}'::jsonb; k text; permitido text[] := array['orcamento_dia','teto_dia','raio_km','lat','lng','cpa_alvo','modo','ativo','idade_min','objetivo'];
begin
  if not public.sou_dono(p_otica) then raise exception 'Sem permissão'; end if;
  foreach k in array permitido loop if p_cfg ? k then novo := novo || jsonb_build_object(k, p_cfg->k); end if; end loop;
  insert into ads_conexao(otica_id, config) values (p_otica, novo)
  on conflict (otica_id) do update set config = ads_conexao.config || excluded.config, atualizado_em=now();
  return (select config from ads_conexao where otica_id=p_otica);
end $$;

create or replace function public.ads_desconectar(p_otica uuid) returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.sou_dono(p_otica) then raise exception 'Sem permissão'; end if;
  update ads_conexao set token=null, token_exp=null, estado='desconectado', usuario_meta=null, page_id=null, page_nome=null, ig_id=null, ig_nome=null,
    ad_account_id=null, ad_account_nome=null, pixel_id=null, opcoes='{}'::jsonb, campanha_id=null, adset_id=null, erro=null, atualizado_em=now() where otica_id=p_otica;
end $$;
grant execute on function public.ads_estado(uuid), public.ads_escolher(uuid,text,text,text,text), public.ads_config(uuid,jsonb), public.ads_desconectar(uuid), public.sou_dono(uuid) to authenticated;

-- ---------- mídia dos anúncios ----------
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('ads-midia','ads-midia',true,104857600,array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime'])
on conflict (id) do nothing;
drop policy if exists ads_midia_ins on storage.objects;
create policy ads_midia_ins on storage.objects for insert to authenticated with check (bucket_id='ads-midia' and public.sou_dono(((storage.foldername(name))[1])::uuid));
drop policy if exists ads_midia_upd on storage.objects;
create policy ads_midia_upd on storage.objects for update to authenticated using (bucket_id='ads-midia' and public.sou_dono(((storage.foldername(name))[1])::uuid));
drop policy if exists ads_midia_del on storage.objects;
create policy ads_midia_del on storage.objects for delete to authenticated using (bucket_id='ads-midia' and public.sou_dono(((storage.foldername(name))[1])::uuid));

-- ---------- rotina automática (a cada 6 h) ----------
insert into public.app_segredos(chave,valor) values ('cron_secret', encode(gen_random_bytes(24),'hex')) on conflict (chave) do nothing;

-- agendamento feito pela equipe (aba Exames de vista) também envia a confirmação
create or replace function public.ex_tg_ins() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.status in ('agendado','confirmado') then perform public.ex_enfileirar(new.id); end if;
  return null;
end $$;
drop trigger if exists ex_agend_ins on public.ex_agend;
create trigger ex_agend_ins after insert on public.ex_agend for each row execute function public.ex_tg_ins();

-- atualiza resultados e sugestões dos anúncios a cada 6 horas
do $$ begin perform cron.unschedule('meta-cron'); exception when others then null; end $$;
select cron.schedule('meta-cron','0 */6 * * *', $c$
  select net.http_post(
    url := 'https://ovynkeifzhavhjdkjjui.supabase.co/functions/v1/meta-cron',
    headers := jsonb_build_object('Content-Type','application/json','x-cron',(select valor from public.app_segredos where chave='cron_secret')),
    body := '{}'::jsonb);
$c$);
