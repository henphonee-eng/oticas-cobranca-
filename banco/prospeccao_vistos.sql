-- Prospecção: tabela criada para guardar óticas vistas e descartadas nas buscas.
-- NÃO É USADA: o Éder preferiu que só as óticas adicionadas ao CRM deixem de aparecer.
create table if not exists public.prosp_vistos (
  place_id text primary key,
  nome text,
  telefone text,
  cidade text,
  busca text,
  visto_em timestamptz not null default now()
);
alter table public.prosp_vistos enable row level security;
create policy prosp_vistos_sel on public.prosp_vistos for select using (public.sou_admin());
create policy prosp_vistos_ins on public.prosp_vistos for insert with check (public.sou_admin());
create policy prosp_vistos_upd on public.prosp_vistos for update using (public.sou_admin()) with check (public.sou_admin());
grant select, insert, update on public.prosp_vistos to authenticated;
