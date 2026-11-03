-- Parcela em atraso: avisos com 1, 2, 4, 7, 10 e 15 dias (o de 15 dias espera aprovação).
-- A partir do aviso de 2 dias, avisa que o atraso pode gerar juros;
-- a partir do de 7 dias, avisa de multa, juros e negativação no SPC e Serasa.
create or replace function public.wa_aviso_atraso(tp text, dias int) returns text language sql immutable set search_path to 'public' as $$
  select case when tp<>'atraso' then ''
    when dias >= 7 then E'\n\n⚠️ Importante: parcelas em atraso estão sujeitas a multa e juros, e a falta de pagamento pode levar à negativação do nome nos órgãos de proteção ao crédito (SPC e Serasa). Regularize o quanto antes para evitar esses transtornos.'
    when dias >= 2 then E'\n\nLembrando que o atraso da parcela pode gerar juros sobre o valor. 📌'
    else '' end
$$;
do $$ declare d text; a1 text := 'when dias in (1,7,15) then ''atraso'''; a2 text := 'wa_render(tpl, vars),
          tp||'':''||v.id'; begin
  d := pg_get_functiondef('public.wa_gerar_fila()'::regprocedure);
  if position('wa_aviso_atraso' in d) = 0 then
    if position(a1 in d) = 0 or position(a2 in d) = 0 then raise exception 'trecho não encontrado'; end if;
    d := replace(d, a1, 'when dias in (1,2,4,7,10,15) then ''atraso''');
    d := replace(d, a2, 'wa_render(tpl, vars) || wa_aviso_atraso(tp, dias),
          tp||'':''||v.id');
    execute d;
  end if;
end $$;

-- Mais de 20 dias: aviso de negativação + crédito encerrado para novas compras no boleto (o cliente entra na Lista negra do sistema).
-- Aviso extra com 21 dias (espera aprovação, como o de 15). Juros lançados à mão aparecem junto do valor.
create or replace function public.wa_aviso_atraso(tp text, dias int) returns text language sql immutable set search_path to 'public' as $$
  select case when tp<>'atraso' then ''
    when dias > 20 then E'\n\n⚠️ Importante: parcelas em atraso estão sujeitas a multa e juros, e a falta de pagamento pode levar à negativação do nome nos órgãos de proteção ao crédito (SPC e Serasa).\n\n🚫 Com mais de 20 dias de atraso, o seu crédito na loja foi encerrado para novas compras no boleto. Pague a parcela e recupere o seu crédito na casa. 💙'
    when dias >= 7 then E'\n\n⚠️ Importante: parcelas em atraso estão sujeitas a multa e juros, e a falta de pagamento pode levar à negativação do nome nos órgãos de proteção ao crédito (SPC e Serasa). Regularize o quanto antes para evitar esses transtornos.'
    when dias >= 2 then E'\n\nLembrando que o atraso da parcela pode gerar juros sobre o valor. 📌'
    else '' end
$$;
do $$ declare d text; a1 text := 'when dias in (1,2,4,7,10,15) then ''atraso'''; a2 text := '''valor'', wa_brl((p->>''valor'')::numeric),'; begin
  d := pg_get_functiondef('public.wa_gerar_fila()'::regprocedure);
  if position('(1,2,4,7,10,15,21)' in d) = 0 then
    if position(a1 in d) = 0 or position(a2 in d) = 0 then raise exception 'trecho não encontrado'; end if;
    d := replace(d, a1, 'when dias in (1,2,4,7,10,15,21) then ''atraso''');
    d := replace(d, a2, '''valor'', wa_brl((p->>''valor'')::numeric) || case when coalesce((p->>''jurosAdd'')::numeric,0) > 0 then '' (já com ''||wa_brl((p->>''jurosAdd'')::numeric)||'' de juros)'' else '''' end,');
    execute d;
  end if;
end $$;
