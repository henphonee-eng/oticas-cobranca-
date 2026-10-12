// Ações do dono da ótica sobre os anúncios: publicar, pausar/ativar, atualizar resultados e aplicar sugestões.
import { admin, CORS, gform, gget, gpost, json, landing, otimizar, setAdStatus, setBudget, syncOtica, marcarErroToken } from "./meta.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const URL_TAGS = "utm_source=meta&utm_medium=paid&utm_campaign={{campaign.id}}&utm_content={{ad.id}}";

async function imagemHash(c: any, url: string) {
  const r = await fetch(url); if (!r.ok) throw new Error("Não foi possível ler a imagem.");
  const buf = new Uint8Array(await r.arrayBuffer()); let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const f = new FormData(); f.set("bytes", btoa(s));
  const j = await gform(`${c.ad_account_id}/adimages`, c.token, f);
  const h = Object.values(j.images || {})[0] as any; if (!h?.hash) throw new Error("A Meta não aceitou a imagem.");
  return h.hash as string;
}
async function videoId(c: any, url: string) {
  const j = await gpost(`${c.ad_account_id}/advideos`, c.token, { file_url: url, name: "Exame de vista" });
  for (let i = 0; i < 9; i++) {
    const s = await gget(j.id, c.token, { fields: "status" }).catch(() => null);
    const st = s?.status?.video_status; if (st === "ready") return j.id as string;
    if (st === "error") throw new Error("A Meta não conseguiu processar o vídeo.");
    await sleep(5000);
  }
  throw new Error("O vídeo ainda está sendo processado pela Meta. Tente publicar de novo em alguns minutos.");
}

async function publicar(db: any, c: any, o: any) {
  const cfg = c.config || {};
  if (!c.page_id) throw new Error("Escolha a página do Facebook primeiro.");
  if (!cfg.lat || !cfg.lng) throw new Error("Defina a localização da ótica.");
  const orc = Math.max(500, Math.min(cfg.orcamento_dia || 2000, cfg.teto_dia || cfg.orcamento_dia || 2000));
  const comPixel = !!c.pixel_id;
  const alvo = {
    geo_locations: { custom_locations: [{ latitude: +cfg.lat, longitude: +cfg.lng, radius: Math.max(1, Math.min(50, +cfg.raio_km || 5)), distance_unit: "kilometer" }], location_types: ["home", "recent"] },
    age_min: Math.max(18, +cfg.idade_min || 18), targeting_automation: { advantage_audience: 1 },
  };
  if (!c.campanha_id) {
    const j = await gpost(`${c.ad_account_id}/campaigns`, c.token, { name: `Exame de vista - ${o.nome}`, objective: comPixel ? "OUTCOME_LEADS" : "OUTCOME_TRAFFIC", status: "PAUSED", special_ad_categories: [], is_adset_budget_sharing_enabled: false });
    c.campanha_id = j.id;
    await db.from("ads_conexao").update({ campanha_id: j.id }).eq("otica_id", c.otica_id);
  }
  if (!c.adset_id) {
    const p: Record<string, unknown> = {
      name: "Moradores perto da ótica", campaign_id: c.campanha_id, daily_budget: orc, billing_event: "IMPRESSIONS", bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      optimization_goal: comPixel ? "OFFSITE_CONVERSIONS" : "LANDING_PAGE_VIEWS", destination_type: "WEBSITE", targeting: alvo, status: "PAUSED",
    };
    if (comPixel) p.promoted_object = { pixel_id: c.pixel_id, custom_event_type: "LEAD" };
    const j = await gpost(`${c.ad_account_id}/adsets`, c.token, p);
    c.adset_id = j.id;
    await db.from("ads_conexao").update({ adset_id: j.id }).eq("otica_id", c.otica_id);
  } else {
    await gpost(c.adset_id, c.token, { daily_budget: orc, targeting: alvo });
  }
  const link = landing(o);
  const { data: lista } = await db.from("ads_criativos").select("*").eq("otica_id", c.otica_id).in("status", ["pronto"]);
  let ok = 0; const erros: string[] = [];
  for (const k of lista || []) {
    try {
      const cta = { type: "BOOK_TRAVEL", value: { link } };
      const spec: Record<string, unknown> = { page_id: c.page_id };
      if (c.ig_id) spec.instagram_user_id = c.ig_id;
      if (k.tipo === "video") {
        const vid = await videoId(c, k.midia_url);
        const th = k.thumb_url ? await imagemHash(c, k.thumb_url) : null;
        spec.video_data = { video_id: vid, message: k.texto, title: k.titulo, call_to_action: cta, ...(th ? { image_hash: th } : {}) };
      } else {
        spec.link_data = { image_hash: await imagemHash(c, k.midia_url), link, message: k.texto, name: k.titulo, call_to_action: cta };
      }
      const cr = await gpost(`${c.ad_account_id}/adcreatives`, c.token, { name: (k.nome || k.titulo).slice(0, 80), object_story_spec: spec, url_tags: URL_TAGS });
      const ad = await gpost(`${c.ad_account_id}/ads`, c.token, { name: (k.nome || k.titulo).slice(0, 80), adset_id: c.adset_id, creative: { creative_id: cr.id }, status: cfg.ativo === false ? "PAUSED" : "ACTIVE" });
      await db.from("ads_criativos").update({ meta_creative_id: cr.id, meta_ad_id: ad.id, status: cfg.ativo === false ? "pausado" : "ativo", erro: null }).eq("id", k.id);
      ok++;
    } catch (e: any) {
      if (await marcarErroToken(db, c.otica_id, e)) throw new Error("A conexão com a Meta expirou. Conecte de novo.");
      erros.push(String(e.message).slice(0, 160));
      await db.from("ads_criativos").update({ erro: String(e.message).slice(0, 200) }).eq("id", k.id);
    }
  }
  if (ok && cfg.ativo !== false) { await gpost(c.adset_id, c.token, { status: "ACTIVE" }); await gpost(c.campanha_id, c.token, { status: "ACTIVE" }); }
  if (!ok && erros.length) throw new Error(erros[0]);
  return `${ok} ${ok === 1 ? "anúncio enviado" : "anúncios enviados"} para análise da Meta${erros.length ? ` (${erros.length} com erro)` : ""}.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const db = admin();
  try {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await db.auth.getUser(jwt);
    if (!u?.user) return json({ erro: "Entre no sistema de novo." }, 401);
    const b = await req.json();
    const { data: adm } = await db.from("administradores").select("user_id").eq("user_id", u.user.id).maybeSingle();
    const { data: m } = await db.from("membros").select("papel").eq("user_id", u.user.id).eq("otica_id", b.otica).eq("ativo", true).maybeSingle();
    if (!adm && m?.papel !== "dono") return json({ erro: "Só o dono da ótica pode fazer isso." }, 403);
    const { data: o } = await db.from("oticas").select("id,nome,slug,dominios,modulos,ativa").eq("id", b.otica).maybeSingle();
    if (!o || !o.ativa || o.modulos?.exames !== true) return json({ erro: "Função não liberada para esta ótica." }, 403);
    const { data: c } = await db.from("ads_conexao").select("*").eq("otica_id", b.otica).maybeSingle();
    if (!c || c.estado !== "conectado" || !c.token) return json({ erro: "Conecte a conta da Meta primeiro." }, 400);

    if (b.acao === "publicar") return json({ msg: await publicar(db, c, o) });
    if (b.acao === "sync") { const s = await syncOtica(db, c); if (!s.ok) return json({ erro: s.erro || "Não foi possível atualizar agora." }, 502); await otimizar(db, c); return json({ ok: true }); }
    if (b.acao === "status") {
      const { data: k } = await db.from("ads_criativos").select("id,meta_ad_id").eq("id", b.criativo).eq("otica_id", b.otica).maybeSingle();
      if (!k?.meta_ad_id) return json({ erro: "Arte não publicada." }, 400);
      const ativo = b.status === "ativo"; await setAdStatus(c.token, k.meta_ad_id, ativo ? "ACTIVE" : "PAUSED");
      await db.from("ads_criativos").update({ status: ativo ? "ativo" : "pausado" }).eq("id", k.id); return json({ ok: true });
    }
    if (b.acao === "aplicar") {
      const { data: s } = await db.from("ads_sugestoes").select("*").eq("id", b.sugestao).eq("otica_id", b.otica).eq("status", "pendente").maybeSingle();
      if (!s) return json({ erro: "Sugestão não encontrada." }, 404);
      if (s.tipo === "pausar" && s.ad_id) { await setAdStatus(c.token, s.ad_id, "PAUSED"); await db.from("ads_criativos").update({ status: "pausado" }).eq("meta_ad_id", s.ad_id).eq("otica_id", b.otica); }
      else if ((s.tipo === "escalar" || s.tipo === "orcamento") && s.valor) await setBudget(db, c, +s.valor);
      await db.from("ads_sugestoes").update({ status: "aplicada" }).eq("id", s.id); return json({ ok: true });
    }
    return json({ erro: "Ação inválida." }, 400);
  } catch (e: any) {
    console.error("meta-ads", e.message, e.raw ? JSON.stringify(e.raw).slice(0, 400) : "");
    return json({ erro: String(e.message || "Falha ao falar com a Meta.").slice(0, 300) }, 500);
  }
});
