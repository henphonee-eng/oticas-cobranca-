// Aviso no celular do Éder (Web Push) chamado pelo banco: { title, body, url, tag } com o cabeçalho x-agente.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPush } from "./webpush.js";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const s = (v: unknown, n = 300) => String(v ?? "").trim().slice(0, n);
const ok = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  try {
    const b = await req.json().catch(() => ({}));
    const { data: k0 } = await db.from("app_segredos").select("chave,valor").in("chave", ["agente_secret", "vapid_public", "vapid_private", "vapid_subject"]);
    const k: Record<string, string> = {};
    (k0 || []).forEach((x: any) => { k[x.chave] = x.valor; });
    if (!k.agente_secret || req.headers.get("x-agente") !== k.agente_secret) return ok({ erro: "negado" }, 401);
    const { data: subs } = await db.from("prosp_push").select("endpoint,sub");
    if (!subs?.length || !k.vapid_private) return ok({ ok: true, enviados: 0 });
    const payload = JSON.stringify({ title: s(b.title, 120), body: s(b.body, 300), url: s(b.url, 200) || "/prospectar", tag: s(b.tag, 80) || "aviso" });
    const vapid = { publicKey: k.vapid_public, privateKey: k.vapid_private, subject: k.vapid_subject || "mailto:admin@example.com" };
    let n = 0;
    await Promise.all(subs.map(async (x: any) => { try { const st = await sendPush(x.sub, payload, vapid); if (st === 404 || st === 410) await db.from("prosp_push").delete().eq("endpoint", x.endpoint); else n++; } catch (_) { /* segue */ } }));
    return ok({ ok: true, enviados: n });
  } catch (e: any) {
    console.error("aviso-push", e.message);
    return ok({ erro: "falhou" }, 500);
  }
});
