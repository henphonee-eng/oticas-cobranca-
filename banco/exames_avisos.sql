-- Exames de vista: aviso para os donos quando alguém agenda + mensagem para quem faltou.
-- Rodar depois de exames_trafego.sql.

-- números dos donos ficam em ex_config.tpl->'avisar' (lista de telefones); mensagem de falta em tpl->>'falt'
create or replace function public.ex_aviso_equipe(p_id uuid) returns void language plpgsql security definer set search_path=public as $$
declare a ex_agend; c ex_config; o oticas; cfg jsonb; nome_o text; dias text[] := array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
  n text; t text; txt text; tel_f text; ts timestamptz; orig text;
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
  txt := '📅 Novo exame de vista agendado na '||nome_o||E'!\n\n👤 '||initcap(lower(a.nome))||E'\n📱 '||tel_f||E'\n🗓️ '||dias[extract(dow from a.data)::int+1]||' ('||to_char(a.data,'DD/MM')||'), às '||to_char(a.hora,'HH24:MI')||E'\n🔎 '||orig||E'\n\nPara não receber mais avisos, responda SAIR.';
  for n in select jsonb_array_elements_text(c.tpl->'avisar') loop
    t := wa_tel(n); if t is null then continue; end if;
    insert into wa_fila(otica_id,cliente_id,cliente_nome,tipo,telefone,texto,ref,status,enviar_apos,expira_em)
    values (a.otica_id, a.id::text, 'Equipe', 'exame_equipe', t, txt, 'exeq:'||a.id||':'||t, 'aguardando', now(), greatest(ts, now()+interval '1 day'))
    on conflict (otica_id,ref) do nothing;
  end loop;
end $$;

create or replace function public.ex_enfileirar_falta(p_id uuid) returns void language plpgsql security definer set search_path=public as $$
declare a ex_agend; o oticas; c ex_config; nome_o text; link text; vars jsonb; tpl text;
  def text := 'Oi, {nome}! 😊 Aqui é da {otica}. Sentimos sua falta no seu exame de vista.

Sem problema, a gente remarca para o melhor dia e horário para você. É só responder por aqui ou escolher um novo horário neste link:
{link}

Esperamos você! 👓';
begin
  select * into a from ex_agend where id=p_id; if not found then return; end if;
  select * into o from oticas where id=a.otica_id;
  select * into c from ex_config where otica_id=a.otica_id;
  nome_o := coalesce((select data->>'nome' from docs where otica_id=a.otica_id and col='config' and id='otica'), o.nome);
  link := 'https://'||coalesce((select d from unnest(o.dominios) d where d is not null and d<>'' and d not like '%localhost%' limit 1),'oticas-cobranca.vercel.app')||'/exame/'||o.slug;
  tpl := coalesce(nullif(c.tpl->>'falt',''), def);
  vars := jsonb_build_object('nome', initcap(lower(split_part(trim(a.nome),' ',1))), 'otica', nome_o, 'link', link,
    'dia', to_char(a.data,'DD/MM'), 'hora', to_char(a.hora,'HH24:MI'));
  perform wa_ins(a.otica_id, a.id::text, a.nome, 'exame_faltou', a.whatsapp, wa_render(tpl, vars), 'exfalt:'||a.id, now()+interval '1 hour', now()+interval '3 days', false);
end $$;

create or replace function public.ex_tg_ins() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.status in ('agendado','confirmado') then
    perform public.ex_enfileirar(new.id);
    begin perform public.ex_aviso_equipe(new.id); exception when others then null; end;
  end if;
  return null;
end $$;

create or replace function public.ex_tg_pos() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.status in ('agendado','confirmado') and (new.data is distinct from old.data or new.hora is distinct from old.hora) then perform public.ex_enfileirar(new.id); end if;
  if new.status='faltou' and old.status is distinct from 'faltou' then
    begin perform public.ex_enfileirar_falta(new.id); exception when others then null; end;
  end if;
  return null;
end $$;

revoke execute on function public.ex_aviso_equipe(uuid), public.ex_enfileirar_falta(uuid) from public, anon, authenticated;

-- números dos donos da Óticas DK
update public.ex_config set tpl = coalesce(tpl,'{}'::jsonb) || '{"avisar":["81987658981","81995270600"]}'::jsonb
where otica_id=(select id from public.oticas where slug='oticadk');
