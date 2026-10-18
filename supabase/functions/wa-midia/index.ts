// Guarda áudio, foto, vídeo e figurinha das conversas do WhatsApp para ouvir e ver no sistema
// (aba Conversas do WhatsApp da ótica e aba WhatsApp do CRM). Chamado pelo conector com o código dele.
// O arquivo vai para o bucket privado wa-midia; só quem é da ótica (ou o administrador) consegue abrir.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const ok = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const EXT: Record<string, string> = { "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/webm": "webm", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/3gpp": "3gp", "video/quicktime": "mov" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json().catch(() => ({}));
    const token = String(b.token || ""), waId = String(b.waId || "").slice(0, 80);
    if (!/^wa_[0-9a-f]{48}$/.test(token) || !/^[A-Za-z0-9_-]{6,80}$/.test(waId)) return ok({ erro: "dados" }, 400);
    const tipo = ["audio", "foto", "video", "figurinha"].includes(b.tipo) ? b.tipo : "";
    if (!tipo) return ok({ erro: "tipo" }, 400);
    const mime = String(b.mime || "").split(";")[0].trim().toLowerCase();
    const b64 = String(b.base64 || "").replace(/^data:[^,]+,/, "");
    if (!b64 || b64.length > 22_000_000) return ok({ ok: true, ignorado: "grande" });

    // de quem é o conector: de uma ótica ou do chip do CRM
    const { data: otica } = await db.rpc("wa_conector_otica", { p_token: token });
    let tabela = "", pasta = "";
    if (otica) { tabela = "wa_msg"; pasta = `otica/${otica}`; }
    else {
      const { data: crm } = await db.rpc("prosp_wa_ok", { p_token: token });
      if (crm !== true) return ok({ erro: "token_invalido" }, 401);
      tabela = "prosp_wa_msg"; pasta = "crm";
    }
    // a mensagem precisa estar guardada (sem a função Conversas, a ótica não guarda e o arquivo não sobe)
    let achou = false;
    for (let i = 0; i < 5 && !achou; i++) {
      let q = db.from(tabela).select("id", { count: "exact", head: true }).eq("wa_id", waId);
      if (otica) q = q.eq("otica_id", otica);
      const { count } = await q;
      achou = (count || 0) > 0;
      if (!achou) await sleep(1500);
    }
    if (!achou) return ok({ ok: true, ignorado: "sem_mensagem" });

    const ext = EXT[mime] || (tipo === "audio" ? "ogg" : tipo === "video" ? "mp4" : tipo === "figurinha" ? "webp" : "jpg");
    const mes = new Date().toISOString().slice(0, 7);
    const caminho = `${pasta}/${mes}/${waId}.${ext}`;
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const up = await db.storage.from("wa-midia").upload(caminho, bin, { contentType: mime || (tipo === "audio" ? "audio/ogg" : tipo === "video" ? "video/mp4" : "image/jpeg"), upsert: true });
    if (up.error) return ok({ erro: up.error.message }, 500);
    let u = db.from(tabela).update({ midia: caminho }).eq("wa_id", waId);
    if (otica) u = u.eq("otica_id", otica);
    await u;
    return ok({ ok: true, caminho });
  } catch (e: any) {
    console.error("wa-midia", e.message);
    return ok({ erro: String(e.message || e).slice(0, 200) }, 500);
  }
});
