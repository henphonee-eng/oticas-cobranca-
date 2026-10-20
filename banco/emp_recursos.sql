-- Recursos do agente das empresas da Connecta (migration emp_recursos):
-- agenda própria, lembretes, follow-up, aniversários e campanha do mês.
-- Quem usa: agente-ia (agenda pelo WhatsApp), emp-recursos (rotinas automáticas e área do cliente).
-- Plano: Essencial = follow-up; Profissional = + agenda, lembretes, aniversário, 1 campanha/mês; Sob medida = até 4 campanhas/mês.

create table if not exists public.emp_agenda(
  id uuid primary key default gen_random_uuid(),
  otica_id uuid not null references public.oticas(id) on delete cascade,
  telefone text,
  nome text not null,
  servico text,
  inicio timestamptz not null,
  fim timestamptz not null,
  status text not null default 'marcado' check (status in ('marcado','confirmado','cancelado','concluido','faltou')),
  origem text not null default 'agente',
  obs text,
  lembrete_v timestamptz,   -- lembrete da véspera enviado
  lembrete_d timestamptz,   -- lembrete do dia enviado
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists emp_agenda_quando on public.emp_agenda(otica_id, inicio);
create index if not exists emp_agenda_tel on public.emp_agenda(otica_id, telefone);
alter table public.emp_agenda enable row level security;
create policy emp_agenda_admin on public.emp_agenda for all using (sou_admin()) with check (sou_admin());

-- contatos de cada empresa (quem falou com o agente ou foi cadastrado na área do cliente)
create table if not exists public.emp_contatos(
  otica_id uuid not null references public.oticas(id) on delete cascade,
  telefone text not null,
  nome text,
  aniv_dia smallint check (aniv_dia between 1 and 31),
  aniv_mes smallint check (aniv_mes between 1 and 12),
  optout boolean not null default false,          -- respondeu SAIR: não recebe campanha
  origem text not null default 'whatsapp',
  primeiro_em timestamptz not null default now(),
  ultimo_em timestamptz not null default now(),
  followup_em timestamptz,                        -- último follow-up automático
  parabens_ano smallint,                          -- ano do último parabéns
  campanha_mes text,                              -- AAAA-MM da última campanha recebida
  primary key (otica_id, telefone)
);
alter table public.emp_contatos enable row level security;
create policy emp_contatos_admin on public.emp_contatos for all using (sou_admin()) with check (sou_admin());

-- campanha da promoção do mês
create table if not exists public.emp_campanhas(
  id uuid primary key default gen_random_uuid(),
  otica_id uuid not null references public.oticas(id) on delete cascade,
  mes text not null,
  texto text not null,
  status text not null default 'agendada' check (status in ('agendada','enviando','enviada','cancelada')),
  enviar_em timestamptz not null default now(),
  total int not null default 0,
  criado_em timestamptz not null default now(),
  iniciada_em timestamptz
);
create index if not exists emp_campanhas_otica on public.emp_campanhas(otica_id, mes);
alter table public.emp_campanhas enable row level security;
create policy emp_campanhas_admin on public.emp_campanhas for all using (sou_admin()) with check (sou_admin());

-- grade da agenda a partir do cadastro da implantação (horários, duração, antecedência)
create or replace function public.emp_grade_de(p_cad jsonb) returns jsonb
language plpgsql immutable set search_path = public as $$
declare d text := lower(coalesce(p_cad->'agenda'->>'duracao','')); a text := lower(coalesce(p_cad->'agenda'->>'antecedencia','')); dur int; ant int; n int; k text; dias jsonb := '{}';
begin
  n := nullif(substring(d from '(\d+)'),'')::int;
  dur := case when n is null then 60 when d ~ 'h' and d !~ 'min' then n*60 else n end;
  if d ~ '1h30|1 hora e meia' then dur := 90; end if;
  n := nullif(substring(a from '(\d+)'),'')::int;
  ant := case when n is null then 2 when a ~ 'dia' then n*24 when a ~ 'min' then 1 else n end;
  foreach k in array array['dom','seg','ter','qua','qui','sex','sab'] loop
    dias := dias || jsonb_build_object(k, jsonb_build_object(
      'aberto', coalesce((p_cad->'horarios'->k->>'aberto')::boolean, false),
      'abre', coalesce(nullif(p_cad->'horarios'->k->>'abre',''), '08:00'),
      'fecha', coalesce(nullif(p_cad->'horarios'->k->>'fecha',''), '18:00')));
  end loop;
  return jsonb_build_object('dias', dias, 'dur', greatest(10, least(480, coalesce(dur,60))), 'antec_h', greatest(0, least(168, ant)), 'vagas', 1);
end $$;

create or replace function public.emp_grade(p_otica uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select cfg->'empresa'->'grade' from agente_config where otica_id = p_otica and jsonb_typeof(cfg->'empresa'->'grade') = 'object'),
    (select emp_grade_de(cadastro) from prosp_impl where otica_id = p_otica order by criado_em desc limit 1),
    '{}'::jsonb)
$$;

-- horários livres: [{data, dia, horas[]}] a partir de p_de, até p_dias dias com vaga
create or replace function public.emp_livres(p_otica uuid, p_de date default null, p_dias int default 10, p_ignorar uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare g jsonb := emp_grade(p_otica); dur int; ant int; vagas int; hoje date := (now() at time zone 'America/Recife')::date; d date; dd jsonb; t time; tf time; ab time;
  ini timestamptz; fimi timestamptz; out jsonb := '[]'; horas jsonb; n int := 0; al_i time; al_f time;
  keys text[] := array['dom','seg','ter','qua','qui','sex','sab'];
  nomes text[] := array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
begin
  if g->'dias' is null then return '[]'; end if;
  dur := greatest(10, least(480, coalesce((g->>'dur')::int, 60)));
  ant := greatest(0, least(168, coalesce((g->>'antec_h')::int, 2)));
  vagas := greatest(1, least(20, coalesce((g->>'vagas')::int, 1)));
  if coalesce(g->'almoco'->>'ini','') ~ '^\d{2}:\d{2}$' and coalesce(g->'almoco'->>'fim','') ~ '^\d{2}:\d{2}$' then al_i := (g->'almoco'->>'ini')::time; al_f := (g->'almoco'->>'fim')::time; end if;
  d := greatest(coalesce(p_de, hoje), hoje);
  for i in 0..90 loop
    exit when n >= greatest(1, least(coalesce(p_dias,10), 30));
    dd := g->'dias'->keys[extract(dow from d + i)::int + 1];
    continue when not coalesce((dd->>'aberto')::boolean, false);
    continue when coalesce(dd->>'abre','') !~ '^\d{2}:\d{2}$' or coalesce(dd->>'fecha','') !~ '^\d{2}:\d{2}$';
    continue when jsonb_typeof(g->'bloqueios') = 'array' and (g->'bloqueios') ? to_char(d + i, 'YYYY-MM-DD');
    horas := '[]'; ab := (dd->>'abre')::time; tf := (dd->>'fecha')::time; t := ab;
    while t >= ab and t + make_interval(mins => dur) <= tf and t + make_interval(mins => dur) > t loop
      ini := ((d + i) + t) at time zone 'America/Recife';
      fimi := ini + make_interval(mins => dur);
      if ini >= now() + make_interval(hours => ant)
         and not (al_i is not null and t < al_f and t + make_interval(mins => dur) > al_i)
         and (select count(*) from emp_agenda a where a.otica_id = p_otica and a.status in ('marcado','confirmado') and a.inicio < fimi and a.fim > ini and (p_ignorar is null or a.id <> p_ignorar)) < vagas then
        horas := horas || to_jsonb(to_char(t, 'HH24:MI'));
      end if;
      t := t + make_interval(mins => dur);
    end loop;
    if jsonb_array_length(horas) > 0 then
      out := out || jsonb_build_object('data', to_char(d + i, 'YYYY-MM-DD'), 'dia', nomes[extract(dow from d + i)::int + 1], 'horas', horas);
      n := n + 1;
    end if;
  end loop;
  return out;
end $$;

-- marca um horário (p_livre = true deixa a empresa marcar fora da grade pela área do cliente)
create or replace function public.emp_agendar(p_otica uuid, p_tel text, p_nome text, p_servico text, p_data date, p_hora time, p_origem text default 'agente', p_obs text default null, p_livre boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g jsonb; dur int; ini timestamptz; l jsonb; ok boolean := false; nid uuid; t text := nullif(regexp_replace(coalesce(p_tel,''),'\D','','g'),'');
begin
  perform pg_advisory_xact_lock(hashtext('emp_agenda:' || p_otica::text));
  if coalesce(trim(p_nome),'') = '' then return jsonb_build_object('ok', false, 'erro', 'Falta o nome do cliente.'); end if;
  g := emp_grade(p_otica);
  dur := greatest(10, least(480, coalesce((g->>'dur')::int, 60)));
  ini := (p_data + p_hora) at time zone 'America/Recife';
  if not p_livre then
    l := emp_livres(p_otica, p_data, 1);
    ok := jsonb_array_length(l) > 0 and l->0->>'data' = to_char(p_data,'YYYY-MM-DD') and (l->0->'horas') ? to_char(p_hora,'HH24:MI');
    if not ok then return jsonb_build_object('ok', false, 'erro', 'Esse horário não está livre. Consulte os horários livres de novo.'); end if;
  elsif ini < now() - interval '1 day' then
    return jsonb_build_object('ok', false, 'erro', 'Data no passado.');
  end if;
  insert into emp_agenda(otica_id, telefone, nome, servico, inicio, fim, origem, obs)
  values (p_otica, t, left(trim(p_nome),80), nullif(left(trim(coalesce(p_servico,'')),80),''), ini, ini + make_interval(mins => dur), left(coalesce(p_origem,'agente'),20), nullif(left(coalesce(p_obs,''),300),''))
  returning id into nid;
  if t is not null then
    insert into emp_contatos(otica_id, telefone, nome, origem) values (p_otica, t, left(trim(p_nome),80), case when p_origem = 'painel' then 'painel' else 'whatsapp' end)
    on conflict (otica_id, telefone) do update set nome = coalesce(emp_contatos.nome, excluded.nome);
  end if;
  return jsonb_build_object('ok', true, 'id', nid, 'data', to_char(p_data,'YYYY-MM-DD'), 'hora', to_char(p_hora,'HH24:MI'), 'duracao_min', dur);
end $$;

-- remarca (o próprio horário antigo não conta como ocupado)
create or replace function public.emp_remarcar(p_otica uuid, p_id uuid, p_data date, p_hora time) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a emp_agenda; l jsonb; ini timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('emp_agenda:' || p_otica::text));
  select * into a from emp_agenda where id = p_id and otica_id = p_otica and status in ('marcado','confirmado');
  if a.id is null then return jsonb_build_object('ok', false, 'erro', 'Agendamento não encontrado.'); end if;
  l := emp_livres(p_otica, p_data, 1, p_id);
  if not (jsonb_array_length(l) > 0 and l->0->>'data' = to_char(p_data,'YYYY-MM-DD') and (l->0->'horas') ? to_char(p_hora,'HH24:MI')) then
    return jsonb_build_object('ok', false, 'erro', 'Esse horário não está livre. Consulte os horários livres de novo.');
  end if;
  ini := (p_data + p_hora) at time zone 'America/Recife';
  update emp_agenda set inicio = ini, fim = ini + (a.fim - a.inicio), status = 'marcado', lembrete_v = null, lembrete_d = null, atualizado_em = now() where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id, 'data', to_char(p_data,'YYYY-MM-DD'), 'hora', to_char(p_hora,'HH24:MI'), 'antes', to_char(a.inicio at time zone 'America/Recife','DD/MM HH24:MI'));
end $$;

-- próximos horários de um contato
create or replace function public.emp_do_contato(p_otica uuid, p_tel text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'servico', servico, 'nome', nome, 'status', status,
           'data', to_char(inicio at time zone 'America/Recife','YYYY-MM-DD'), 'hora', to_char(inicio at time zone 'America/Recife','HH24:MI')) order by inicio), '[]')
  from emp_agenda where otica_id = p_otica and telefone = regexp_replace(coalesce(p_tel,''),'\D','','g') and status in ('marcado','confirmado') and inicio > now() - interval '1 hour'
$$;

revoke all on function public.emp_livres(uuid,date,int,uuid), public.emp_agendar(uuid,text,text,text,date,time,text,text,boolean), public.emp_remarcar(uuid,uuid,date,time), public.emp_do_contato(uuid,text), public.emp_grade(uuid) from public, anon, authenticated;

-- rotina (migration emp_recursos_cron): a cada 5 minutos chama a função emp-recursos (lembretes, campanhas, aniversários, follow-up)
-- create function emp_rotina() ... net.http_post(.../functions/v1/emp-recursos, x-agente, {modo:'rotina'})
-- select cron.schedule('emp-recursos', '*/5 * * * *', 'select public.emp_rotina()');
