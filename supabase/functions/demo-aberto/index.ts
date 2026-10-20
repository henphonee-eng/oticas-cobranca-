// Chamado pela página do demo (sem login). Registra o acesso real; o aviso vai para o resumo do CRM (12h e 18h).
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const ok = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { lead, aparelho } = await req.json();
    if (!/^[0-9a-f-]{36}$/i.test(String(lead || ''))) return ok({ ok: false }, 400);
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const r = await sb.rpc('prosp_demo_registrar', { p_lead: lead, p_aparelho: String(aparelho || '').slice(0, 60) || null });
    if (r.error || r.data !== true) return ok({ ok: true, novo: false });
    const [{ data: l }, { count }] = await Promise.all([
      sb.from('prosp_leads').select('nome').eq('id', lead).single(),
      sb.from('prosp_acessos').select('id', { count: 'exact', head: true }).eq('lead_id', lead),
    ]);
    await sb.from('prosp_avisos').insert({
      tipo: 'demo', lead_id: lead,
      titulo: '👀 ' + (l?.nome || 'Uma ótica') + ' abriu o demo',
      texto: (count && count > 1 ? count + 'º acesso' : 'Primeiro acesso') + (aparelho ? ' · ' + String(aparelho).slice(0, 60) : ''),
    });
    return ok({ ok: true, novo: true });
  } catch (e) {
    return ok({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
