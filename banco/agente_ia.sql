-- Agente de IA (função Premium "agente") — aplicado como migrations agente_config, agente_bucket, agente_contato
-- e patches em wa_puxar / wa_puxar_manual (tipo 'agente' sai na hora, com mídia), wa_receber (encaminha para a função agente-ia).
create table if not exists public.agente_config(
  otica_id uuid primary key references public.oticas(id),
  ativo boolean not null default false,
  cfg jsonb not null default '{}'::jsonb,
  testado_em timestamptz,
  atualizado_em timestamptz not null default now()
);
alter table public.agente_config enable row level security;
create policy agente_config_sel on public.agente_config for select using (minha_otica(otica_id));
create policy agente_config_ins on public.agente_config for insert with check (sou_dono(otica_id) and ot_mod_on(otica_id,'agente'));
create policy agente_config_upd on public.agente_config for update using (sou_dono(otica_id)) with check (sou_dono(otica_id) and ot_mod_on(otica_id,'agente'));
alter table public.wa_fila add column if not exists midia text;
-- imagens que o agente pode enviar: bucket público "agente", pasta = id da ótica (só o dono envia)
-- ag_contato(otica, tel): cliente cadastrado / empresa do Tráfego Orgânico / oferta para empresas (só service role)

-- CRM: campanha Tráfego Orgânico + Agente de IA para óticas já abordadas (migration prosp_campanha)
alter table public.prosp_leads add column if not exists campanha_em timestamptz;
-- prosp_wa_fila.tipo aceita 'campanha'; prosp_wa_puxar envia campanha também para "sem interesse" (não para "fechou" nem repetida);
-- prosp_wa_resultado marca campanha_em; prosp_wa_receber volta "sem interesse" para "respondeu" se responder até 30 dias após a campanha.
