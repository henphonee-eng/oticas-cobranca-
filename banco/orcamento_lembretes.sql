-- Orçamentos (vendas com aguardando=true) ganham a data que o cliente vai pagar (vendas.pagarEm, AAAA-MM-DD).
-- O WhatsApp Automático manda:
--   orc_valor     3 dias antes da data: o orçamento com o valor
--   orc_lembrete  1 dia antes: lembrete de que estamos aguardando para mandar ao laboratório
-- Os dois saem às 9h do dia (ou na hora, se o agendador rodar depois). Se o orçamento virar venda, for excluído
-- ou mudar de data, o que estiver na fila é cancelado. Os textos podem ser trocados em Mensagens (config otica.tpl).
-- Tipos orc_* começam no automático (como os do exame de vista).

create or replace function public.wa_ins(o uuid, cid text, nome text, tp text, tel text, txt text, rf text, apos timestamp with time zone, expira timestamp with time zone, forcar boolean)
 returns text language plpgsql security definer set search_path to 'public' as $function$
declare cfg jsonb; modo text; st text; t text;
begin
  select data into cfg from docs where otica_id=o and col='config' and id='wa';
  cfg := coalesce(cfg,'{}'::jsonb);
  if coalesce(cfg->>'on','false') <> 'true' then return 'off'; end if;
  modo := coalesce(cfg->'modo'->>tp, case when tp like 'exame\_%' or tp like 'orc\_%' then 'auto' else 'aprovar' end);
  if modo not in ('auto','aprovar') then return 'off'; end if;
  t := wa_tel(tel);
  if t is null then return 'sem_telefone'; end if;
  if exists (select 1 from wa_optout where otica_id=o and telefone=t) then return 'optout'; end if;
  st := case when modo='auto' and not coalesce(forcar,false) then 'aguardando' else 'aprovar' end;
  insert into wa_fila(otica_id,cliente_id,cliente_nome,tipo,telefone,texto,ref,status,enviar_apos,expira_em)
  values (o,cid,nome,tp,t,wa_rodape(txt),rf,st,coalesce(apos,now()),expira)
  on conflict (otica_id,ref) do nothing;
  if not found then return 'dup'; end if;
  return 'ok';
end $function$;

create or replace function public.wa_orcamentos(o uuid, nome_o text, hoje date) returns void
 language plpgsql security definer set search_path to 'public' as $function$
declare v record; cli jsonb; otpl jsonb; venc date; dias int; tp text; tpl text; vars jsonb; itens text; ent numeric; valores text;
  def_val text := 'Olá, {cliente}! 👋 Aqui é da {otica}.

Passando para lembrar do seu orçamento: 📝

{itens}

{valores}

📅 Combinamos o pagamento para {data_pagamento}. Assim que você vier, já damos andamento ao seu óculos. Qualquer dúvida, é só responder por aqui! 😊';
  def_lem text := 'Olá, {cliente}! 😊 Aqui é da {otica}.

Só passando para lembrar que amanhã ({data_pagamento}) estamos aguardando a sua vinda para darmos prosseguimento ao seu óculos e enviarmos para o laboratório. 👓

Até amanhã! 🙏';
begin
  select data->'tpl' into otpl from docs where otica_id=o and col='config' and id='otica';
  for v in select d.id, d.data from docs d where d.otica_id=o and d.col='vendas' and d.data->>'aguardando'='true'
      and coalesce(d.data->>'pagarEm','') ~ '^\d{4}-\d{2}-\d{2}$' loop
    venc := (v.data->>'pagarEm')::date; dias := venc - hoje;
    tp := case when dias=3 then 'orc_valor' when dias=1 then 'orc_lembrete' else null end;
    if tp is null then continue; end if;
    select data into cli from docs where otica_id=o and col='clientes' and id=v.data->>'clienteId';
    if cli is null then continue; end if;
    select string_agg('• '||case when coalesce((i->>'qtd')::int,1)>1 then (i->>'qtd')||'x ' else '' end||coalesce(i->>'nome',''), E'\n')
      into itens from jsonb_array_elements(coalesce(v.data->'itens','[]'::jsonb)) i;
    ent := coalesce((v.data->>'entrada')::numeric,0);
    valores := '💰 Valor total: '||wa_brl(coalesce((v.data->>'total')::numeric,0))||case when ent>0 and ent<coalesce((v.data->>'total')::numeric,0) and coalesce(v.data->>'forma','')<>'Cartão de crédito' then E'\n💵 Entrada: '||wa_brl(ent) else '' end;
    tpl := coalesce(nullif(otpl->>tp,''), case when tp='orc_valor' then def_val else def_lem end);
    vars := jsonb_build_object('cliente', split_part(trim(cli->>'nome'),' ',1), 'otica', nome_o, 'itens', coalesce(itens,''),
      'total', wa_brl(coalesce((v.data->>'total')::numeric,0)), 'entrada', wa_brl(ent), 'valores', valores,
      'data_pagamento', to_char(venc,'DD/MM'));
    perform wa_ins(o, cli->>'id', cli->>'nome', tp, cli->>'whatsapp', wa_render(tpl, vars),
      tp||':'||v.id||':'||venc, greatest(now(), (hoje::timestamp + time '09:00') at time zone 'America/Recife'),
      (venc::timestamp + interval '1 day') at time zone 'America/Recife', false);
  end loop;
  -- orçamento pago, excluído ou com outra data: tira da fila o que ainda não saiu
  update wa_fila f set status='cancelada', erro='orçamento pago ou alterado'
   where f.otica_id=o and f.tipo in ('orc_valor','orc_lembrete') and f.status in ('aguardando','aprovar')
     and not exists (select 1 from docs d where d.otica_id=o and d.col='vendas' and d.id=split_part(f.ref,':',2)
                     and d.data->>'aguardando'='true' and d.data->>'pagarEm'=split_part(f.ref,':',3));
end $function$;
revoke all on function public.wa_orcamentos(uuid,text,date) from public, anon, authenticated;
-- wa_gerar_fila chama: perform wa_orcamentos(o.id, nome_o, hoje); (logo depois das parcelas)
do $$ declare d text; begin
  d := pg_get_functiondef('public.wa_gerar_fila'::regproc);
  if position('wa_orcamentos' in d) = 0 then
    if position('    -- aniversários' in d) = 0 then raise exception 'ponto de inserção não encontrado'; end if;
    d := replace(d, '    -- aniversários', '    -- orçamentos: valor 3 dias antes e lembrete 1 dia antes da data combinada' || chr(10) || '    perform wa_orcamentos(o.id, nome_o, hoje);' || chr(10) || '    -- aniversários');
    execute d;
  end if;
end $$;
