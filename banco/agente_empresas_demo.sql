-- Demonstração do Agente de IA para outras empresas (link /a/<código> que vai na abordagem do CRM)
-- Só acrescenta duas funções públicas; não altera tabelas nem funções existentes.

-- dados públicos do lead (os mesmos que vieram do Google Maps) para montar a demonstração
create or replace function public.prosp_agente_codigo(p_cod text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c text := lower(coalesce(p_cod,'')); n int; r prosp_leads;
begin
  if c !~ '^[0-9a-f]{7,32}$' then return null; end if;
  select count(*) into n from prosp_leads where replace(id::text,'-','') like c||'%';
  if n <> 1 then return null; end if;
  select * into r from prosp_leads where replace(id::text,'-','') like c||'%';
  return jsonb_build_object('nome', r.nome, 'lead', r.id, 'segmento', r.segmento, 'cidade', r.cidade, 'endereco', r.endereco);
end $$;

-- registra que a empresa abriu a demonstração do agente (aparece no CRM como "Agente")
create or replace function public.prosp_agente_aberto(p_lead uuid, p_aparelho text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from prosp_leads where id = p_lead) then return; end if;
  if exists (select 1 from prosp_acessos where lead_id = p_lead and tipo = 'agente' and coalesce(aparelho,'') = coalesce(left(p_aparelho,60),'') and em > now() - interval '30 minutes') then return; end if;
  insert into prosp_acessos(lead_id, aparelho, tipo) values (p_lead, left(p_aparelho,60), 'agente');
  update prosp_leads set demo_aberturas = demo_aberturas + 1, demo_aberto_em = now() where id = p_lead;
end $$;

grant execute on function public.prosp_agente_codigo(text) to anon, authenticated;
grant execute on function public.prosp_agente_aberto(uuid, text) to anon, authenticated;
