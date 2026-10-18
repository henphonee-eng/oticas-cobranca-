-- Áudio, foto, vídeo e figurinha nas abas de conversa (ótica e CRM)
alter table wa_msg add column if not exists midia text;
alter table prosp_wa_msg add column if not exists midia text;
insert into storage.buckets (id, name, public, file_size_limit) values ('wa-midia', 'wa-midia', false, 20971520) on conflict (id) do nothing;
create policy wa_midia_ler on storage.objects for select to authenticated
using (bucket_id = 'wa-midia' and (public.sou_admin() or (split_part(name, '/', 1) = 'otica' and exists (
  select 1 from public.membros m where m.user_id = auth.uid() and m.ativo and m.otica_id::text = split_part(name, '/', 2)))));
