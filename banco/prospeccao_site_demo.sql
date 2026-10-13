-- Site demonstrativo para óticas sem site (/s/<código>, página vitrine/index.html).
alter table public.prosp_acessos add column if not exists tipo text not null default 'demo';
-- prosp_site_codigo(p_cod): devolve nome, endereço, cidade, telefone, nota e avaliações públicas do lead (para montar a prévia)
-- prosp_site_aberto(p_lead, p_aparelho): registra o acesso ao site (tipo 'site'), ignorando repetição em 30 minutos
-- Definições aplicadas na migração prosp_site_demo.
