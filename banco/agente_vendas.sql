-- Agente de vendas do CRM: responde as empresas que voltam a falar depois da abordagem.
-- Só acrescenta colunas, uma tabela e funções; o envio continua pelo mesmo chip do CRM.

alter table prosp_leads add column if not exists ag_estado text;      -- null | humano | automatico | passado | pausado
alter table prosp_leads add column if not exists ag_em timestamptz;
alter table prosp_wa_fila add column if not exists origem text;       -- 'agente' quando quem escreveu foi o agente

create table if not exists prosp_reunioes (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references prosp_leads(id) on delete cascade,
  inicio timestamptz not null,
  nome text, assunto text, forma text,
  status text not null default 'marcada',
  criado_em timestamptz not null default now()
);
alter table prosp_reunioes enable row level security;
create policy prosp_reunioes_admin on prosp_reunioes for all using (sou_admin()) with check (sou_admin());

-- abertura do teste do agente que devolve se é um acesso novo (para avisar no celular)
create or replace function public.prosp_agente_registrar(p_lead uuid, p_aparelho text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from prosp_leads where id = p_lead) then return false; end if;
  if exists (select 1 from prosp_acessos where lead_id = p_lead and tipo = 'agente' and coalesce(aparelho,'') = coalesce(left(p_aparelho,60),'') and em > now() - interval '30 minutes') then return false; end if;
  insert into prosp_acessos(lead_id, aparelho, tipo) values (p_lead, left(p_aparelho,60), 'agente');
  update prosp_leads set demo_aberturas = demo_aberturas + 1, demo_aberto_em = now() where id = p_lead;
  return true;
end $$;
revoke execute on function public.prosp_agente_registrar(uuid, text) from public, anon, authenticated;

-- resposta recebida no chip do CRM: igual a antes e, se o agente de vendas estiver ligado, chama o agente
create or replace function public.prosp_wa_receber(p_token text, p_telefone text, p_texto text, p_nome text DEFAULT NULL::text)
 returns json language plpgsql security definer set search_path to 'public' as $function$
declare t text := right(regexp_replace(coalesce(p_telefone,''),'\D','','g'), 8); l prosp_leads;
begin
  if not prosp_wa_ok(p_token) then return json_build_object('ok', false, 'erro', 'token_invalido'); end if;
  if length(t) < 8 or coalesce(trim(p_texto),'') = '' then return json_build_object('ok', true); end if;
  select * into l from prosp_leads where enviado_em is not null
    and (right(regexp_replace(coalesce(whatsapp,''),'\D','','g'),8) = t or right(regexp_replace(coalesce(telefone,''),'\D','','g'),8) = t)
    order by enviado_em desc limit 1;
  if l.id is null then return json_build_object('ok', true, 'ignorado', true); end if;
  update prosp_leads set status=case when status='enviado' or (status='sem_interesse' and campanha_em > now() - interval '30 days') then 'respondeu' else status end, atualizado_em=now(),
    historico=coalesce(historico,'[]'::jsonb)||jsonb_build_array(jsonb_build_object('em',now(),'txt','Respondeu no WhatsApp: «'||left(trim(p_texto),300)||'»')) where id=l.id;
  update prosp_wa_fila set status='cancelada', erro='a ótica respondeu' where lead_id=l.id and status in ('espera','aguardando');
  if prosp_cfg('ag_on','false') = 'true' and coalesce(l.ag_estado,'') not in ('passado','pausado') then
    begin
      perform net.http_post(
        url := 'https://ovynkeifzhavhjdkjjui.supabase.co/functions/v1/agente-vendas',
        headers := jsonb_build_object('Content-Type','application/json','x-agente',(select valor from app_segredos where chave='agente_secret')),
        body := jsonb_build_object('modo','msg','lead',l.id,'telefone',regexp_replace(coalesce(p_telefone,''),'\D','','g'),'texto',left(p_texto,1500),'nome',left(coalesce(p_nome,''),60),'em',now()),
        timeout_milliseconds := 5000);
    exception when others then null;
    end;
  end if;
  return json_build_object('ok', true, 'acao', 'respondeu');
end $function$;
