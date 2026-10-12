// Conecta a conta Meta (Facebook/Instagram/anúncios) de uma ótica. Faz o login (OAuth) e guarda o token no banco.
import { admin, appCreds, CORS, G, GV, gget, json, SUPA_URL } from "./meta.ts";

const FUNC_URL = `${SUPA_URL}/functions/v1/meta-conectar`;
const SCOPES = ["ads_management", "ads_read", "business_management", "pages_show_list", "pages_read_engagement", "pages_manage_ads", "instagram_basic"].join(",");
const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function hmac(secret: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}
async function assinar(secret: string, p: Record<string, unknown>) { const body = b64u(new TextEncoder().encode(JSON.stringify(p))); return body + "." + await hmac(secret, body); }
async function ler(secret: string, s: string) {
  const [body, sig] = (s || "").split(".");
  if (!body || !sig || (await hmac(secret, body)) !== sig) return null;
  try { return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)))); } catch { return null; }
}
async function retornoOk(db: any, otica: string, url: string) {
  try {
    const u = new URL(url); if (u.protocol !== "https:" && u.hostname !== "localhost") return false;
    const { data: o } = await db.from("oticas").select("dominios").eq("id", otica).maybeSingle();
    const site = new URL(Deno.env.get("SITE_URL") || "https://oticas-cobranca.vercel.app").host;
    return u.host === site || (o?.dominios || []).includes(u.host) || u.hostname.endsWith(".vercel.app");
  } catch { return false; }
}
const volta = (r: string, ok: boolean) => new Response(null, { status: 302, headers: { Location: r + (r.includes("?") ? "&" : "?") + "ads=" + (ok ? "ok" : "erro") } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const db = admin(); const { id: appId, secret } = await appCreds(db);
  const url = new URL(req.url);

  // 2) retorno do Facebook
  if (req.method === "GET") {
    if (!appId || !secret) return new Response("Meta não configurada", { status: 400 });
    const st = await ler(secret, url.searchParams.get("state") || "");
    if (!st || Date.now() - st.t > 15 * 60e3) return new Response("Link expirado. Volte ao sistema e tente de novo.", { status: 400 });
    const back = st.r as string;
    if (url.searchParams.get("error") || !url.searchParams.get("code")) return volta(back, false);
    try {
      const curto = await gget("oauth/access_token", "", { client_id: appId, client_secret: secret, redirect_uri: FUNC_URL, code: url.searchParams.get("code")! });
      const longo = await gget("oauth/access_token", "", { grant_type: "fb_exchange_token", client_id: appId, client_secret: secret, fb_exchange_token: curto.access_token });
      const token = longo.access_token as string;
      const me = await gget("me", token, { fields: "id,name" });
      const pgs = await gget("me/accounts", token, { fields: "id,name,instagram_business_account{id,username}", limit: 100 }).catch(() => ({ data: [] }));
      const cts = await gget("me/adaccounts", token, { fields: "id,name,account_status,currency", limit: 50 }).catch(() => ({ data: [] }));
      const contas = [];
      for (const c of (cts.data || []).filter((x: any) => x.account_status === 1 || x.account_status === undefined).slice(0, 10)) {
        const px = await gget(`${c.id}/adspixels`, token, { fields: "id,name", limit: 25 }).catch(() => ({ data: [] }));
        contas.push({ id: c.id, nome: c.name || c.id, moeda: c.currency, pixels: (px.data || []).map((p: any) => ({ id: p.id, nome: p.name || p.id })) });
      }
      const paginas = (pgs.data || []).map((p: any) => ({ id: p.id, nome: p.name, ig_id: p.instagram_business_account?.id || null, ig_nome: p.instagram_business_account?.username ? "@" + p.instagram_business_account.username : null }));
      const exp = longo.expires_in ? new Date(Date.now() + longo.expires_in * 1000).toISOString() : null;
      const { data: atual } = await db.from("ads_conexao").select("config").eq("otica_id", st.o).maybeSingle();
      await db.from("ads_conexao").upsert({ otica_id: st.o, estado: "escolher", token, token_exp: exp, usuario_meta: me.name || me.id, opcoes: { paginas, contas }, config: atual?.config || {}, erro: null, atualizado_em: new Date().toISOString() });
      return volta(back, true);
    } catch (e) { console.error("meta-conectar", e); return volta(back, false); }
  }

  // 1) iniciar (chamado pelo sistema, usuário logado)
  try {
    if (!appId || !secret) return json({ erro: "meta_nao_configurada" }, 400);
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await db.auth.getUser(jwt);
    if (!u?.user) return json({ erro: "Entre no sistema de novo." }, 401);
    const b = await req.json();
    const { data: adm } = await db.from("administradores").select("user_id").eq("user_id", u.user.id).maybeSingle();
    const { data: m } = await db.from("membros").select("papel").eq("user_id", u.user.id).eq("otica_id", b.otica).eq("ativo", true).maybeSingle();
    if (!adm && m?.papel !== "dono") return json({ erro: "Só o dono da ótica pode conectar a conta da Meta." }, 403);
    if (!(await retornoOk(db, b.otica, b.retorno))) return json({ erro: "Endereço de retorno não permitido." }, 400);
    const state = await assinar(secret, { o: b.otica, u: u.user.id, r: b.retorno, t: Date.now() });
    const login = `https://www.facebook.com/${GV}/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(FUNC_URL)}&state=${encodeURIComponent(state)}&scope=${SCOPES}&response_type=code`;
    return json({ url: login });
  } catch (e) { console.error(e); return json({ erro: "Não foi possível iniciar a conexão." }, 500); }
});
