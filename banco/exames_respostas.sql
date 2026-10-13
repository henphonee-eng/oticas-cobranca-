-- Exames de vista: respostas dos clientes pelo WhatsApp (SIM / CANCELAR / REMARCAR) e agente de IA.
-- Rodar depois de exames_trafego.sql e exames_avisos.sql.

create table if not exists public.wa_conversa (
  id uuid primary key default gen_random_uuid(),
  otica_id uuid not null references public.oticas(id) on delete cascade,
  telefone text not null,
  papel text not null check (papel in ('cliente','agente','sistema')),
  texto text not null,
  criado_em timestamptz not null default now()
);
create index if not exists wa_conversa_busca on public.wa_conversa(otica_id, telefone, criado_em desc);
alter table public.wa_conversa enable row level security;
drop policy if exists wa_conversa_sel on public.wa_conversa;
create policy wa_conversa_sel on public.wa_conversa for select to authenticated using (public.sou_dono(otica_id));

insert into public.app_segredos(chave,valor) values ('agente_secret', encode(gen_random_bytes(24),'hex')) on conflict (chave) do nothing;

-- envia uma mensagem avulsa pela fila do WhatsApp (sem o rodapé de SAIR)
create or replace function public.ex_enviar(p_otica uuid, p_tel text, p_nome text, p_tipo text, p_txt text) returns void
language plpgsql security definer set search_path=public as $$
declare cfg jsonb; t text := wa_tel(p_tel);
begin
  select data into cfg from docs where otica_id=p_otica and col='config' and id='wa';
  if coalesce(cfg->>'on','false') <> 'true' or t is null then return; end if;
  if exists (select 1 from wa_optout where otica_id=p_otica and telefone=t) then return; end if;
  insert into wa_fila(otica_id,cliente_id,cliente_nome,tipo,telefone,texto,ref,status,enviar_apos,expira_em)
  values (p_otica,'resp',coalesce(p_nome,''),p_tipo,t,p_txt,'exresp:'||gen_random_uuid(),'aguardando',now(),now()+interval '1 day');
end $$;

create or replace function public.ex_avisar_donos(p_otica uuid, p_txt text) returns void
language plpgsql security definer set search_path=public as $$
declare c ex_config; n text;
begin
  select * into c from ex_config where otica_id=p_otica;
  if not found or jsonb_typeof(c.tpl->'avisar') is distinct from 'array' then return; end if;
  for n in select jsonb_array_elements_text(c.tpl->'avisar') loop
    perform ex_enviar(p_otica, n, 'Equipe', 'exame_equipe', p_txt);
  end loop;
end $$;

-- exame "alvo" de um telefone: o próximo marcado; se não houver, o último que faltou/cancelou nos últimos 7 dias
create or replace function public.ex_alvo(p_otica uuid, p_tel text) returns ex_agend
language plpgsql stable security definer set search_path=public as $$
declare t text := wa_tel(p_tel); r ex_agend; agora timestamp := now() at time zone 'America/Recife';
begin
  if t is null then return null; end if;
  select * into r from ex_agend where otica_id=p_otica and right(whatsapp,8)=right(t,8) and status in ('agendado','confirmado') and (data+hora) >= agora - interval '2 hours' order by data,hora limit 1;
  if found then return r; end if;
  select * into r from ex_agend where otica_id=p_otica and right(whatsapp,8)=right(t,8) and status in ('faltou','cancelado') and data >= (agora::date - 7) order by data desc, hora desc limit 1;
  if found then return r; end if;
  return null;
end $$;

create or replace function public.ex_horarios_livres(p_otica uuid, p_de date default null, p_dias int default 7) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare c ex_config; hoje date := (now() at time zone 'America/Recife')::date; agora timestamp := now() at time zone 'America/Recife';
  d date; h time; ini date; n int; hs jsonb; res jsonb := '[]'::jsonb; nomes text[] := array['domingo','segunda','terça','quarta','quinta','sexta','sábado'];
begin
  select * into c from ex_config where otica_id=p_otica and ativo; if not found then return res; end if;
  ini := greatest(coalesce(p_de,hoje),hoje);
  for d in select g::date from generate_series(ini, least(ini+greatest(least(p_dias,14),1)-1, hoje+c.janela_dias), interval '1 day') g loop
    if not (extract(dow from d)::int = any(c.dias)) then continue; end if;
    hs := '[]'::jsonb; h := c.hora_ini;
    while h + make_interval(mins=>c.duracao_min) <= c.hora_fim + interval '1 minute' and h >= c.hora_ini loop
      if (d + h) >= agora + make_interval(hours=>c.antecedencia_h) then
        select count(*) into n from ex_agend where otica_id=p_otica and data=d and hora=h and status in ('agendado','confirmado','compareceu');
        if n < c.vagas then hs := hs || to_jsonb(to_char(h,'HH24:MI')); end if;
      end if;
      h := h + make_interval(mins=>c.duracao_min);
    end loop;
    if jsonb_array_length(hs) > 0 then res := res || jsonb_build_object('data',d,'dia',nomes[extract(dow from d)::int+1]||' '||to_char(d,'DD/MM'),'horas',hs); end if;
  end loop;
  return res;
end $$;

create or replace function public.ex_remarcar_tel(p_otica uuid, p_tel text, p_data date, p_hora time) returns jsonb
language plpgsql security definer set search_path=public as $$
declare a ex_agend; c ex_config; hoje date := (now() at time zone 'America/Recife')::date; agora timestamp := now() at time zone 'America/Recife'; n int; mins int;
begin
  a := ex_alvo(p_otica, p_tel);
  if a.id is null then return jsonb_build_object('ok',false,'erro','Não encontrei exame para este número.'); end if;
  select * into c from ex_config where otica_id=p_otica and ativo; if not found then return jsonb_build_object('ok',false,'erro','Agendamento indisponível.'); end if;
  if p_data is null or p_hora is null or p_data < hoje or p_data > hoje + c.janela_dias then return jsonb_build_object('ok',false,'erro','Dia fora do período disponível.'); end if;
  if not (extract(dow from p_data)::int = any(c.dias)) then return jsonb_build_object('ok',false,'erro','Não atendemos nesse dia.'); end if;
  mins := (extract(epoch from (p_hora - c.hora_ini))/60)::int;
  if p_hora < c.hora_ini or p_hora + make_interval(mins=>c.duracao_min) > c.hora_fim + interval '1 minute' or mins % c.duracao_min <> 0 then return jsonb_build_object('ok',false,'erro','Horário indisponível.'); end if;
  if (p_data + p_hora) < agora + make_interval(hours=>c.antecedencia_h) then return jsonb_build_object('ok',false,'erro','Esse horário já passou ou está muito próximo.'); end if;
  perform pg_advisory_xact_lock(hashtext(p_otica::text||p_data::text));
  select count(*) into n from ex_agend where otica_id=p_otica and data=p_data and hora=p_hora and status in ('agendado','confirmado','compareceu') and id<>a.id;
  if n >= c.vagas then return jsonb_build_object('ok',false,'erro','Esse horário já foi preenchido.'); end if;
  update ex_agend set data=p_data, hora=p_hora, status='agendado' where id=a.id;
  return jsonb_build_object('ok',true,'data',p_data,'hora',to_char(p_hora,'HH24:MI'));
end $$;

create or replace function public.ex_cancelar_tel(p_otica uuid, p_tel text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare a ex_agend;
begin
  a := ex_alvo(p_otica, p_tel);
  if a.id is null or a.status not in ('agendado','confirmado') then return jsonb_build_object('ok',false,'erro','Não há exame marcado para cancelar.'); end if;
  update ex_agend set status='cancelado' where id=a.id;
  return jsonb_build_object('ok',true);
end $$;

create or replace function public.ex_confirmar_tel(p_otica uuid, p_tel text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare a ex_agend;
begin
  a := ex_alvo(p_otica, p_tel);
  if a.id is null or a.status not in ('agendado','confirmado') then return jsonb_build_object('ok',false,'erro','Não há exame marcado para confirmar.'); end if;
  update ex_agend set status='confirmado' where id=a.id;
  return jsonb_build_object('ok',true);
end $$;

-- chamado pelo conector quando chega uma mensagem de um cliente
create or replace function public.wa_receber(p_token text, p_telefone text, p_texto text, p_nome text default null) returns json
language plpgsql security definer set search_path=public as $$
declare o uuid; t text; a ex_agend; c ex_config; n text; txt text := left(trim(coalesce(p_texto,'')),1000); nome text; link text; ia boolean; ot oticas; nome_o text; quando text;
  dias text[] := array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
begin
  o := wa_conector_otica(p_token);
  if o is null then return json_build_object('ok', false, 'erro', 'token_invalido'); end if;
  t := wa_tel(p_telefone);
  if t is null or txt = '' then return json_build_object('ok', true); end if;
  a := ex_alvo(o, t);
  if a.id is null then return json_build_object('ok', true, 'ignorado', true); end if;
  select * into c from ex_config where otica_id=o;
  select * into ot from oticas where id=o;
  nome_o := coalesce((select data->>'nome' from docs where otica_id=o and col='config' and id='otica'), ot.nome);
  link := 'https://'||coalesce((select d from unnest(ot.dominios) d where d is not null and d<>'' and d not like '%localhost%' limit 1),'oticas-cobranca.vercel.app')||'/exame/'||ot.slug;
  nome := initcap(lower(split_part(trim(a.nome),' ',1)));
  quando := dias[extract(dow from a.data)::int+1]||' ('||to_char(a.data,'DD/MM')||'), às '||to_char(a.hora,'HH24:MI');
  if (select count(*) from wa_conversa where otica_id=o and telefone=t and papel='cliente' and criado_em > now()-interval '1 hour') >= 20 then return json_build_object('ok', true, 'limite', true); end if;
  insert into wa_conversa(otica_id,telefone,papel,texto) values (o,t,'cliente',txt);
  ia := coalesce(c.tpl->>'ia','false') = 'true';
  n := trim(regexp_replace(lower(translate(txt,'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','aaaaaeeeeiiiiooooouuuucaaaaaeeeeiiiiooooouuuuc')),'[^a-z0-9 ]',' ','g'));
  n := regexp_replace(n,'\s+',' ','g');
  if length(n) <= 40 and n ~ '^(cancelar|cancela|cancelo|nao vou|nao poderei|nao posso|nao consigo|desmarcar|desmarca)( |$)' and a.status in ('agendado','confirmado') then
    perform ex_cancelar_tel(o, t);
    perform ex_enviar(o,t,nome,'exame_resp','Tudo bem, '||nome||'! Cancelei o seu exame de '||quando||E'.\n\nQuando quiser, é só escolher um novo horário aqui: '||link);
    perform ex_avisar_donos(o,'❌ '||nome||' ('||t||') cancelou o exame de '||quando||'.');
    insert into wa_conversa(otica_id,telefone,papel,texto) values (o,t,'sistema','Exame cancelado pelo cliente');
    return json_build_object('ok', true, 'acao', 'cancelar');
  elsif length(n) <= 40 and n ~ '^(sim|s|ok|confirmo|confirmado|confirmar|certo|combinado|blz|beleza|pode ser|estarei la|estarei ai|vou sim|ta bom|esta bom|perfeito|show)( |$)' and a.status in ('agendado','confirmado') then
    perform ex_confirmar_tel(o, t);
    perform ex_enviar(o,t,nome,'exame_resp','Perfeito, '||nome||'! Seu exame de vista está confirmado para '||quando||E'. Te esperamos! 👓');
    insert into wa_conversa(otica_id,telefone,papel,texto) values (o,t,'sistema','Exame confirmado pelo cliente');
    return json_build_object('ok', true, 'acao', 'confirmar');
  elsif length(n) <= 40 and n ~ '^(remarcar|remarca|remarco|reagendar|reagenda|mudar|trocar|outro dia|outro horario|outra data)( |$)' and not ia then
    perform ex_enviar(o,t,nome,'exame_resp','Claro, '||nome||'! Escolha o melhor dia e horário neste link e a gente remarca na hora: '||link);
    perform ex_avisar_donos(o,'🔁 '||nome||' ('||t||') pediu para remarcar o exame de '||quando||'.');
    return json_build_object('ok', true, 'acao', 'remarcar');
  end if;
  if ia then
    begin
      perform net.http_post(
        url := 'https://ovynkeifzhavhjdkjjui.supabase.co/functions/v1/wa-agente',
        headers := jsonb_build_object('Content-Type','application/json','x-agente',(select valor from app_segredos where chave='agente_secret')),
        body := jsonb_build_object('otica',o,'telefone',t,'texto',txt),
        timeout_milliseconds := 5000);
    exception when others then
      perform ex_avisar_donos(o,'📩 '||nome||' ('||t||') respondeu: «'||left(txt,300)||'»');
    end;
    return json_build_object('ok', true, 'acao', 'agente');
  end if;
  perform ex_avisar_donos(o,'📩 '||nome||' ('||t||') respondeu sobre o exame de '||quando||': «'||left(txt,300)||'»');
  return json_build_object('ok', true, 'acao', 'repassar');
end $$;

grant execute on function public.wa_receber(text,text,text,text) to anon, authenticated;
revoke execute on function public.ex_enviar(uuid,text,text,text,text), public.ex_avisar_donos(uuid,text), public.ex_alvo(uuid,text),
  public.ex_horarios_livres(uuid,date,int), public.ex_remarcar_tel(uuid,text,date,time), public.ex_cancelar_tel(uuid,text), public.ex_confirmar_tel(uuid,text) from public, anon, authenticated;
grant execute on function public.ex_enviar(uuid,text,text,text,text), public.ex_avisar_donos(uuid,text), public.ex_alvo(uuid,text),
  public.ex_horarios_livres(uuid,date,int), public.ex_remarcar_tel(uuid,text,date,time), public.ex_cancelar_tel(uuid,text), public.ex_confirmar_tel(uuid,text) to service_role;
