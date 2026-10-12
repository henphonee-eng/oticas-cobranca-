// Rotina automática (a cada 6 horas): atualiza os resultados dos anúncios e gera sugestões.
import { admin, CORS, json, otimizar, syncOtica } from "./meta.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const db = admin();
  const { data: seg } = await db.from("app_segredos").select("valor").eq("chave", "cron_secret").maybeSingle();
  if (!seg || req.headers.get("x-cron") !== seg.valor) return json({ erro: "negado" }, 401);
  const { data: lista } = await db.from("ads_conexao").select("*").eq("estado", "conectado").not("token", "is", null);
  const out: unknown[] = [];
  for (const c of lista || []) {
    try {
      const s = await syncOtica(db, c);
      const n = s.ok ? await otimizar(db, c) : 0;
      out.push({ otica: c.otica_id, sync: s.ok, sugestoes: n });
    } catch (e: any) { out.push({ otica: c.otica_id, erro: String(e.message).slice(0, 120) }); }
  }
  return json({ ok: true, oticas: out });
});
