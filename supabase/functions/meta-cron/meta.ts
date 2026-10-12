// Funções compartilhadas com a Meta (Graph / Marketing API). Cópia idêntica em meta-ads e meta-cron.
import { createClient } from "jsr:@supabase/supabase-js@2";

export const GV = Deno.env.get("GRAPH_VER") || "v25.0";
export const G = `https://graph.facebook.com/${GV}`;
export const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
export const admin = () => createClient(SUPA_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
export const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

export async function appCreds(db: any) {
  let id = Deno.env.get("META_APP_ID") || "", secret = Deno.env.get("META_APP_SECRET") || "";
  if (!id || !secret) {
    const { data } = await db.from("app_segredos").select("chave,valor").in("chave", ["meta_app_id", "meta_app_secret"]);
    for (const r of data || []) { if (r.chave === "meta_app_id") id = id || r.valor; if (r.chave === "meta_app_secret") secret = secret || r.valor; }
  }
  return { id: id.trim(), secret: secret.trim() };
}

async function req(method: string, path: string, token: string, params: Record<string, unknown> = {}, form?: FormData) {
  const url = new URL(path.startsWith("http") ? path : `${G}/${path.replace(/^\//, "")}`);
  const init: RequestInit = { method, signal: AbortSignal.timeout(50000) };
  if (method === "GET") {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
    if (token) url.searchParams.set("access_token", token);
  } else if (form) {
    if (token) form.set("access_token", token);
    init.body = form;
  } else {
    const b = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) b.set(k, typeof v === "string" ? v : JSON.stringify(v));
    if (token) b.set("access_token", token);
    init.body = b;
  }
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    const err: any = new Error(e.error_user_msg || e.message || `Meta HTTP ${r.status}`);
    err.code = e.code; err.sub = e.error_subcode; err.raw = e;
    throw err;
  }
  return j;
}
export const gget = (path: string, token: string, params: Record<string, unknown> = {}) => req("GET", path, token, params);
export const gpost = (path: string, token: string, body: Record<string, unknown> = {}) => req("POST", path, token, body);
export const gform = (path: string, token: string, form: FormData) => req("POST", path, token, {}, form);

export const hoje = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10); // America/Recife (UTC-3)
export const somaDias = (d: string, n: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

export function siteBase(o: any): string {
  const dom = (o.dominios || []).find((d: string) => d && !/localhost/.test(d));
  return dom ? `https://${dom}` : (Deno.env.get("SITE_URL") || "https://oticas-cobranca.vercel.app");
}
export const landing = (o: any) => `${siteBase(o)}/agendar/${o.slug}`;

export async function marcarErroToken(db: any, otica: string, e: any) {
  if (e && (e.code === 190 || e.code === 102)) {
    await db.from("ads_conexao").update({ estado: "erro", erro: "A conexão com a Meta expirou. Conecte de novo na aba Anúncios.", atualizado_em: new Date().toISOString() }).eq("otica_id", otica);
    return true;
  }
  return false;
}

export async function setAdStatus(token: string, adId: string, status: "ACTIVE" | "PAUSED") { return gpost(adId, token, { status }); }

export async function setBudget(db: any, c: any, centavos: number) {
  const teto = c.config?.teto_dia || centavos;
  const v = Math.max(500, Math.min(Math.round(centavos), teto));
  if (c.adset_id) await gpost(c.adset_id, c.token, { daily_budget: v });
  await db.from("ads_conexao").update({ config: { ...(c.config || {}), orcamento_dia: v }, atualizado_em: new Date().toISOString() }).eq("otica_id", c.otica_id);
  return v;
}

const LEAD_TIPOS = ["lead", "offsite_conversion.fb_pixel_lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_custom"];

export async function syncOtica(db: any, c: any) {
  if (!c.token || !c.ad_account_id) return { ok: false };
  const ate = hoje(), desde = somaDias(ate, -6);
  try {
    const ins = await gget(`${c.ad_account_id}/insights`, c.token, {
      level: "ad", fields: "ad_id,ad_name,spend,impressions,reach,clicks,actions", time_increment: 1,
      time_range: { since: desde, until: ate }, limit: 500,
    });
    const linhas = (ins.data || []).map((x: any) => ({
      otica_id: c.otica_id, dia: x.date_start, ad_id: x.ad_id, gasto: +x.spend || 0, impressoes: +x.impressions || 0, alcance: +x.reach || 0, cliques: +x.clicks || 0,
      leads: (x.actions || []).filter((a: any) => LEAD_TIPOS.includes(a.action_type)).reduce((s: number, a: any) => s + (+a.value || 0), 0),
    }));
    if (linhas.length) await db.from("ads_metricas").upsert(linhas, { onConflict: "otica_id,dia,ad_id" });
    if (c.adset_id) {
      const ads = await gget(`${c.adset_id}/ads`, c.token, { fields: "id,effective_status,configured_status", limit: 100 });
      for (const a of ads.data || []) {
        const st = a.effective_status === "DISAPPROVED" ? "reprovado" : a.effective_status === "ACTIVE" ? "ativo" : (a.configured_status === "PAUSED" || /PAUSED/.test(a.effective_status)) ? "pausado" : null;
        if (st) await db.from("ads_criativos").update({ status: st }).eq("otica_id", c.otica_id).eq("meta_ad_id", a.id);
      }
    }
    await db.from("ads_conexao").update({ ultima_sync: new Date().toISOString(), erro: null }).eq("otica_id", c.otica_id).eq("estado", "conectado");
    return { ok: true, linhas: linhas.length };
  } catch (e: any) {
    if (!(await marcarErroToken(db, c.otica_id, e))) await db.from("ads_conexao").update({ erro: String(e.message).slice(0, 300) }).eq("otica_id", c.otica_id);
    return { ok: false, erro: e.message };
  }
}

async function jaTem(db: any, otica: string, tipo: string, adId: string | null) {
  let q = db.from("ads_sugestoes").select("id").eq("otica_id", otica).eq("tipo", tipo).eq("status", "pendente");
  q = adId ? q.eq("ad_id", adId) : q.is("ad_id", null);
  const { data } = await q.limit(1);
  return !!(data && data.length);
}

export async function otimizar(db: any, c: any) {
  const cfg = c.config || {};
  const alvo = (cfg.cpa_alvo || 2500) / 100, automatico = cfg.modo === "automatico";
  const desde = somaDias(hoje(), -6);
  const [{ data: met }, { data: cri }, { data: ag }] = await Promise.all([
    db.from("ads_metricas").select("*").eq("otica_id", c.otica_id).gte("dia", desde),
    db.from("ads_criativos").select("*").eq("otica_id", c.otica_id).not("meta_ad_id", "is", null).neq("status", "arquivado"),
    db.from("ex_agend").select("anuncio,status,criado_em").eq("otica_id", c.otica_id).gte("criado_em", desde + "T00:00:00-03:00"),
  ]);
  const novas: any[] = [];
  const ativos = (cri || []).filter((x: any) => x.status === "ativo");
  let melhor: any = null;
  for (const k of ativos) {
    const m = (met || []).filter((x: any) => x.ad_id === k.meta_ad_id);
    const g = m.reduce((s: number, x: any) => s + +x.gasto, 0), im = m.reduce((s: number, x: any) => s + x.impressoes, 0), al = m.reduce((s: number, x: any) => s + x.alcance, 0), cl = m.reduce((s: number, x: any) => s + x.cliques, 0);
    const a = (ag || []).filter((x: any) => x.anuncio === k.meta_ad_id && x.status !== "cancelado").length;
    const dias = new Set(m.map((x: any) => x.dia)).size;
    const nome = k.nome || k.titulo;
    if (a === 0 && dias >= 2 && g >= alvo * 2) novas.push({ tipo: "pausar", criativo_id: k.id, ad_id: k.meta_ad_id, titulo: `Pausar a arte "${nome}"`, detalhe: `Gastou R$ ${g.toFixed(2).replace(".", ",")} e não trouxe agendamentos. O objetivo é até R$ ${alvo.toFixed(2).replace(".", ",")} por agendamento.` });
    else if (a === 0 && im >= 3000 && cl / im < 0.005) novas.push({ tipo: "pausar", criativo_id: k.id, ad_id: k.meta_ad_id, titulo: `Pausar a arte "${nome}"`, detalhe: `Foi vista ${im} vezes, mas poucas pessoas clicaram (${(cl / im * 100).toFixed(1).replace(".", ",")}%).` });
    if (al > 0 && im / al > 3.5) novas.push({ tipo: "novo_criativo", criativo_id: k.id, ad_id: k.meta_ad_id, titulo: `A arte "${nome}" está cansando`, detalhe: "As mesmas pessoas já viram esta arte mais de 3 vezes. Crie ou envie uma arte nova para renovar." });
    if (a >= 2 && g / a <= alvo && (!melhor || g / a < melhor.cpa)) melhor = { k, cpa: g / a, a };
  }
  if (melhor && cfg.orcamento_dia && cfg.teto_dia && cfg.orcamento_dia < cfg.teto_dia) {
    const v = Math.min(Math.round(cfg.orcamento_dia * 1.2), cfg.teto_dia);
    novas.push({ tipo: "escalar", criativo_id: melhor.k.id, ad_id: null, valor: v, titulo: "Aumentar o investimento diário em 20%", detalhe: `A arte "${melhor.k.nome || melhor.k.titulo}" está trazendo agendamentos a R$ ${melhor.cpa.toFixed(2).replace(".", ",")} cada, abaixo do seu objetivo. Novo valor: R$ ${(v / 100).toFixed(2).replace(".", ",")} por dia.` });
  }
  if (c.campanha_id && ativos.length < 2) novas.push({ tipo: "novo_criativo", criativo_id: null, ad_id: null, titulo: "Teste pelo menos 2 artes diferentes", detalhe: "Com mais de uma arte rodando, o sistema descobre qual mensagem traz mais agendamentos. Crie ou envie mais uma arte." });
  let n = 0;
  for (const s of novas) {
    if (await jaTem(db, c.otica_id, s.tipo, s.ad_id ?? null)) continue;
    let status = "pendente";
    try {
      if (automatico && s.tipo === "pausar" && s.ad_id) { await setAdStatus(c.token, s.ad_id, "PAUSED"); await db.from("ads_criativos").update({ status: "pausado" }).eq("id", s.criativo_id); status = "automatica"; }
      else if (automatico && s.tipo === "escalar") {
        const { data: rec } = await db.from("ads_sugestoes").select("id").eq("otica_id", c.otica_id).eq("tipo", "escalar").in("status", ["aplicada", "automatica"]).gte("criada_em", new Date(Date.now() - 3 * 864e5).toISOString()).limit(1);
        if (!rec?.length) { await setBudget(db, c, s.valor); status = "automatica"; }
      }
    } catch (_e) { status = "pendente"; }
    await db.from("ads_sugestoes").insert({ otica_id: c.otica_id, tipo: s.tipo, titulo: s.titulo, detalhe: s.detalhe, criativo_id: s.criativo_id ?? null, ad_id: s.ad_id ?? null, valor: s.valor ?? null, status });
    n++;
  }
  n += await analiseSemanal(db, c, met || [], cri || [], ag || []);
  return n;
}

async function analiseSemanal(db: any, c: any, met: any[], cri: any[], ag: any[]) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key || !cri.length || !met.length) return 0;
  const { data: rec } = await db.from("ads_sugestoes").select("id").eq("otica_id", c.otica_id).eq("tipo", "analise").gte("criada_em", new Date(Date.now() - 6 * 864e5).toISOString()).limit(1);
  if (rec?.length) return 0;
  const resumo = cri.map((k: any) => {
    const m = met.filter((x) => x.ad_id === k.meta_ad_id);
    return { arte: k.nome || k.titulo, tipo: k.tipo, mensagem: k.titulo, gasto: +m.reduce((s, x) => s + +x.gasto, 0).toFixed(2), impressoes: m.reduce((s, x) => s + x.impressoes, 0), cliques: m.reduce((s, x) => s + x.cliques, 0), agendamentos: ag.filter((x) => x.anuncio === k.meta_ad_id && x.status !== "cancelado").length };
  });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: AbortSignal.timeout(40000),
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5", max_tokens: 500,
        messages: [{ role: "user", content: `Você cuida de anúncios de uma ótica pequena, para agendar exame de vista. Resultados dos últimos 7 dias (valores em R$): ${JSON.stringify(resumo)}. O objetivo é até R$ ${((c.config?.cpa_alvo || 2500) / 100).toFixed(2)} por agendamento. Escreva em português simples, em no máximo 4 frases curtas, o que está funcionando, o que não está e uma ideia concreta de nova mensagem ou imagem para testar. Não prometa resultado de saúde, não fale de problemas de vista de quem vê o anúncio e não invente números.` }],
      }),
    });
    const j = await r.json();
    const txt = j?.content?.[0]?.text?.trim();
    if (txt) { await db.from("ads_sugestoes").insert({ otica_id: c.otica_id, tipo: "analise", titulo: "Análise da semana", detalhe: txt.slice(0, 1200), status: "pendente" }); return 1; }
  } catch (_e) { /* análise é opcional */ }
  return 0;
}
