-- Pós-venda da Connecta (aplicado como migration pos_venda): cobrança automática, relatório mensal,
-- vigia dos agentes ligados e área do cliente. A lógica fica na função connecta-pos.

-- implantação: liga ao "inquilino" (linha em oticas, plano 'empresa') que roda o agente no WhatsApp da empresa
alter table public.prosp_impl add column if not exists otica_id uuid references public.oticas(id);
alter table public.prosp_impl add column if not exists conectado_em timestamptz;   -- 1ª vez que o WhatsApp conectou (= entrega)
alter table public.prosp_impl add column if not exists encerrada_em timestamptz;   -- cliente cancelou
alter table public.prosp_impl add column if not exists saude jsonb not null default '{}'::jsonb; -- estado da vigia (alertas já enviados)

-- cobranças das empresas (entrada 50%, entrega 50%, mensalidades)
create table if not exists public.prosp_cobr(
  id uuid primary key default gen_random_uuid(),
  impl_id uuid not null references public.prosp_impl(id) on delete cascade,
  tipo text not null check (tipo in ('entrada','entrega','mensal')),
  parcela int not null default 1,
  venc date not null,
  valor numeric(10,2) not null check (valor >= 0),
  pago boolean not null default false,
  pago_em date,
  cancelada boolean not null default false,
  avisos int not null default 0,
  ultimo_aviso date,
  comprovante_em timestamptz,
  criado_em timestamptz not null default now(),
  unique (impl_id, tipo, parcela)
);
alter table public.prosp_cobr enable row level security;
create policy prosp_cobr_admin on public.prosp_cobr for all using (sou_admin()) with check (sou_admin());

-- relatório mensal enviado para cada empresa
create table if not exists public.prosp_relatorios(
  impl_id uuid not null references public.prosp_impl(id) on delete cascade,
  mes text not null,                       -- 'AAAA-MM'
  dados jsonb not null default '{}'::jsonb,
  enviado_em timestamptz,
  primary key (impl_id, mes)
);
alter table public.prosp_relatorios enable row level security;
create policy prosp_relatorios_admin on public.prosp_relatorios for all using (sou_admin()) with check (sou_admin());

-- prosp_impl_tenant(impl): cria o inquilino da empresa (só service role): oticas plano 'empresa' com o módulo agente,
-- agente_config (cfg.tipo='empresa' com a configuração da implantação), avisos para o dono e o WhatsApp na nuvem (QR Code).
-- prosp_cobr_comprovante (gatilho em prosp_wa_msg): a empresa mandou comprovante/“paguei” com cobrança em aberto -> avisa o Éder.
-- crons: connecta-vigia (*/10), connecta-cobranca (diário 12:10 UTC), connecta-relatorio (dia 1, 13:05 UTC).
