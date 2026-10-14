-- WhatsApp na nuvem: desligar o chip do CRM (aplicado como migration prosp_wa_nuvem_desligar)
create or replace function public.prosp_wa_nuvem_desligar() returns jsonb language plpgsql security definer set search_path to 'public','extensions' as $$
begin
  if not public.sou_admin() then raise exception 'Só o administrador pode fazer isso'; end if;
  update wa_nuvem set ativo=false where id='prosp';
  return jsonb_build_object('ok', true);
end $$;
