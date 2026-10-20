// Recursos automáticos do agente das empresas da Connecta (o que vai além de responder):
// - Lembrete do horário marcado: na véspera e cerca de 2 horas antes (Profissional e Sob medida).
// - Follow-up: uma mensagem para quem perguntou e não fechou, cerca de 1 dia depois (todos os planos).
// - Parabéns no aniversário do cliente (Profissional e Sob medida).
// - Campanha da promoção do mês para os clientes, com SAIR (Profissional: 1 por mês; Sob medida: até 4).
// - Área do cliente (link /cliente/CODIGO): agenda, clientes, campanhas e o que fica ligado.
// Chamadas: x-agente (rotina a cada 5 minutos) ou o código do link da área do cliente.
import { createClient } from "jsr:@supabase/supabase-js@2";

const URL_SB = Deno.env.get("SUPABASE_URL")!;
const db = createClient(URL_SB, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const OPENAI = Deno.env.get("OPENAI_API_KEY") || "";
const MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4.1-mini";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const ok = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });
const s = (v: unknown, n = 600) => String(v ?? "").trim().slice(0, n);
const dig = (v: unknown) => String(v ?? "").replace(/\D/g, "");
const recife = (d = new Date()) => new Date(d.getTime() - 3 * 3600e3); // campos UTC = hora de Recife
const hojeR = () => recife().toISOString().slice(0, 10);
const DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const dataOk = (d: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""));
const horaOk = (h: unknown) => /^\d{2}:\d{2}$/.test(String(h || ""));
const primeiro = (n: unknown) => { const x = s(n, 60).split(/\s+/)[0] || ""; return x ? x.charAt(0).toUpperCase() + x.slice(1).toLowerCase() : ""; };

const PLANO_REC: Record<string, any> = {
  "Essencial": { followup: true, agenda: false, lembrete: false, aniversario: false, campanhas: 0 },
  "Profissional": { followup: true, agenda: true, lembrete: true, aniversario: true, campanhas: 1 },
  "Sob medida": { followup: true, agenda: true, lembrete: true, aniversario: true, campanhas: 4 },
};
// o que o plano permite (plano) e o que está ligado agora (ativo)
function recursos(impl: any, auto: any) {
  const P = { ...(PLANO_REC[String(impl?.plano || "")] || PLANO_REC["Essencial"]) };
  const au = auto || {};
  const usa = String(impl?.cadastro?.agenda?.usa || "agente");
  const A = {
    agenda: P.agenda && (au.agenda !== undefined ? au.agenda !== false : usa === "agente"),
    lembrete: false, aniversario: P.aniversario && au.aniversario !== false, followup: P.followup && au.followup !== false, campanhas: P.campanhas,
  };
  A.lembrete = P.lembrete && A.agenda && au.lembrete !== false;
  return { plano: P, ativo: A };
}

/* ---------- envio pelo WhatsApp da empresa (fila do conector dela) ---------- */
async function mandar(otica: string, tel: string, nome: string, texto: string, quando = new Date(), tipo = "agente", ref = "") {
  const r = await db.from("wa_fila").insert({ otica_id: otica, cliente_id: "agente", cliente_nome: s(nome, 40) || tel, tipo, telefone: tel, texto, ref: ref || "ag:" + crypto.randomUUID(), status: "aguardando", enviar_apos: quando.toISOString(), expira_em: new Date(quando.getTime() + (tipo === "agente" ? 6 : 48) * 3600e3).toISOString() });
  if (r.error) { console.error("wa_fila", r.error.message); return false; }
  if (tipo === "agente") await db.from("wa_conversa").insert({ otica_id: otica, telefone: tel, papel: "agente", texto });
  return true;
}

async function empresas() {
  const { data } = await db.from("prosp_impl").select("id,plano,cadastro,config,otica_id,conectado_em,status").eq("status", "ativa").is("encerrada_em", null).not("otica_id", "is", null);
  const out: any[] = [];
  for (const impl of data || []) {
    const { data: ag } = await db.from("agente_config").select("ativo,cfg").eq("otica_id", impl.otica_id).maybeSingle();
    if (!ag?.ativo || ag.cfg?.tipo !== "empresa") continue;
    out.push({ impl, cfg: ag.cfg, R: recursos(impl, ag.cfg?.auto).ativo, nome: s(impl.config?.empresa || impl.cadastro?.empresa?.nome, 60) || "a empresa" });
  }
  return out;
}

/* ---------- lembretes do horário marcado ---------- */
async function rotinaLembretes(e: any) {
  if (!e.R.lembrete) return 0;
  const o = e.impl.otica_id, r = recife(), hh = r.getUTCHours();
  const { data: ags } = await db.from("emp_agenda").select("*").eq("otica_id", o).in("status", ["marcado", "confirmado"]).not("telefone", "is", null)
    .gte("inicio", new Date().toISOString()).lte("inicio", new Date(Date.now() + 40 * 3600e3).toISOString()).limit(200);
  const end = s(e.impl.config?.endereco, 160);
  let n = 0;
  for (const a of ags || []) {
    const ini = recife(new Date(a.inicio)), dia = ini.toISOString().slice(0, 10), hora = ini.toISOString().slice(11, 16);
    const amanha = new Date(Date.parse(hojeR() + "T12:00:00Z") + 864e5).toISOString().slice(0, 10);
    const falta = (Date.parse(a.inicio) - Date.now()) / 60e3;
    const sv = a.servico ? `*${s(a.servico, 60)}*` : "seu horário";
    const nm = primeiro(a.nome);
    // véspera: das 10h às 20h do dia anterior
    if (!a.lembrete_v && dia === amanha && hh >= 10 && hh < 20 && Date.parse(a.criado_em) < Date.now() - 2 * 3600e3) {
      const t = a.status === "confirmado"
        ? `Oi${nm ? ", " + nm : ""}! 😊 Passando para lembrar: ${sv} na ${e.nome} é amanhã, ${DIAS[ini.getUTCDay()]} (${dia.slice(8, 10)}/${dia.slice(5, 7)}), às ${hora}. Te esperamos!`
        : `Oi${nm ? ", " + nm : ""}! 😊 Passando para lembrar: ${sv} na ${e.nome} é amanhã, ${DIAS[ini.getUTCDay()]} (${dia.slice(8, 10)}/${dia.slice(5, 7)}), às ${hora}.\n\nPode confirmar? Se precisar remarcar, é só me dizer por aqui.`;
      if (await mandar(o, a.telefone, a.nome, t)) { await db.from("emp_agenda").update({ lembrete_v: new Date().toISOString() }).eq("id", a.id); n++; }
      continue;
    }
    // no dia: umas 2 horas antes (só se foi marcado com antecedência)
    if (!a.lembrete_d && dia === hojeR() && falta <= 135 && falta >= 30 && hh >= 7 && Date.parse(a.criado_em) < Date.now() - 4 * 3600e3) {
      const t = `Oi${nm ? ", " + nm : ""}! Hoje às ${hora} é ${sv} na ${e.nome}.${end ? ` Endereço: ${end}.` : ""} Até já! 😊`;
      if (await mandar(o, a.telefone, a.nome, t)) { await db.from("emp_agenda").update({ lembrete_d: new Date().toISOString() }).eq("id", a.id); n++; }
    }
  }
  return n;
}

/* ---------- follow-up de quem perguntou e não fechou ---------- */
async function ia(otica: string, messages: any[], max = 220) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", signal: AbortSignal.timeout(40000), headers: { Authorization: `Bearer ${OPENAI}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL, messages, temperature: 0.4, max_tokens: max }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || "IA " + r.status);
  await db.rpc("ag_uso_add", { p_otica: otica, p_resp: 0, p_in: Number(j?.usage?.prompt_tokens || 0), p_out: Number(j?.usage?.completion_tokens || 0), p_aud: 0, p_aud_seg: 0, p_fotos: 0, p_testes: 0 }).then(() => {}, () => {});
  return s(j.choices?.[0]?.message?.content, 900);
}
async function rotinaFollowup(e: any) {
  if (!e.R.followup || !OPENAI) return 0;
  const r = recife(), hh = r.getUTCHours();
  if (r.getUTCDay() === 0 || hh < 9 || hh >= 19) return 0;
  const o = e.impl.otica_id;
  const { data: rows } = await db.from("wa_conversa").select("telefone,papel,texto,criado_em").eq("otica_id", o).gte("criado_em", new Date(Date.now() - 3 * 864e5).toISOString()).order("criado_em").limit(5000);
  const por: Record<string, any[]> = {};
  for (const m of rows || []) (por[m.telefone] = por[m.telefone] || []).push(m);
  const dono8 = dig(e.impl.cadastro?.dono?.whatsapp).slice(-8);
  let n = 0;
  for (const [tel, L] of Object.entries(por)) {
    if (n >= 15) break;
    if (dono8 && tel.slice(-8) === dono8) continue;
    const conv = L.filter((m) => m.papel === "cliente" || m.papel === "agente");
    const ult = conv[conv.length - 1];
    if (!ult || ult.papel !== "agente") continue;
    const idade = (Date.now() - Date.parse(ult.criado_em)) / 3600e3;
    if (idade < 20 || idade > 48) continue;
    if (!conv.some((m) => m.papel === "cliente")) continue;
    if (L.some((m) => m.papel === "sistema" && /^(Atendente chamado|Contato pediu para sair|Follow-up)/.test(m.texto || ""))) continue;
    const [{ data: ct }, { count: ag }] = await Promise.all([
      db.from("emp_contatos").select("nome,optout,followup_em").eq("otica_id", o).eq("telefone", tel).maybeSingle(),
      db.from("emp_agenda").select("id", { count: "exact", head: true }).eq("otica_id", o).eq("telefone", tel).gte("criado_em", new Date(Date.now() - 4 * 864e5).toISOString()),
    ]);
    if (ct?.optout || (ag || 0) > 0) continue;
    if (ct?.followup_em && Date.now() - Date.parse(ct.followup_em) < 7 * 864e5) continue;
    const cf = e.impl.config || {};
    const hist = conv.slice(-12).map((m) => `${m.papel === "cliente" ? "Cliente" : "Atendente"}: ${s(m.texto, 400)}`).join("\n");
    let t = "";
    try {
      t = await ia(o, [{ role: "system", content: `Você é ${cf.assistente ? cf.assistente + ", " : ""}o atendente da ${s(cf.empresa, 80) || e.nome}${cf.ramo ? " (" + s(cf.ramo, 60) + ")" : ""} no WhatsApp. Leia a conversa de ontem e escreva UMA mensagem curta de follow-up (no máximo 2 frases, tom ${cf.tom === "formal" ? "educado e formal" : "simpático e próximo"}${cf.emojis ? ", até um emoji" : ", sem emojis"}) retomando o que o cliente queria e convidando a continuar (ex.: perguntar se ficou alguma dúvida ou se quer que já veja um horário). Não invente preço, promoção nem disponibilidade. Não diga que é uma IA.
Se a conversa já terminou bem (o cliente já resolveu, agradeceu e encerrou, disse que não quer, pediu para não mandar mensagem, foi um assunto que não é venda, ou é outra empresa/robô), responda exatamente: PULAR` }, { role: "user", content: hist }]);
    } catch (x: any) { console.error("followup", x.message); continue; }
    if (!t || /^PULAR\b/i.test(t)) { await db.from("emp_contatos").upsert({ otica_id: o, telefone: tel, followup_em: new Date().toISOString() }, { onConflict: "otica_id,telefone" }); continue; }
    if (await mandar(o, tel, ct?.nome || "", t)) {
      await db.from("emp_contatos").upsert({ otica_id: o, telefone: tel, followup_em: new Date().toISOString() }, { onConflict: "otica_id,telefone" });
      await db.from("wa_conversa").insert({ otica_id: o, telefone: tel, papel: "sistema", texto: "Follow-up automático enviado" });
      n++;
    }
  }
  return n;
}

/* ---------- parabéns no aniversário ---------- */
const PARABENS = "Feliz aniversário, {nome}! 🎉 Toda a equipe da {empresa} deseja um dia muito especial para você.";
async function rotinaAniversario(e: any) {
  if (!e.R.aniversario) return 0;
  const r = recife(), hh = r.getUTCHours();
  if (hh < 9 || hh >= 13) return 0;
  const o = e.impl.otica_id, ano = r.getUTCFullYear();
  const { data: L } = await db.from("emp_contatos").select("telefone,nome,parabens_ano").eq("otica_id", o).eq("aniv_dia", r.getUTCDate()).eq("aniv_mes", r.getUTCMonth() + 1).eq("optout", false).limit(80);
  const au = e.cfg?.auto || {};
  let n = 0;
  for (const c of L || []) {
    if (Number(c.parabens_ano) === ano) continue;
    let t = s(au.aniversario_texto, 600) || PARABENS;
    t = t.replace(/\{nome\}/g, primeiro(c.nome) || "").replace(/\{empresa\}/g, e.nome).replace(/,\s*!/g, "!").replace(/\s{2,}/g, " ");
    if (au.aniversario_presente) t += "\n\n" + s(au.aniversario_presente, 300);
    if (await mandar(o, c.telefone, c.nome, t, new Date(Date.now() + n * 40e3))) { await db.from("emp_contatos").update({ parabens_ano: ano }).eq("otica_id", o).eq("telefone", c.telefone); n++; }
  }
  return n;
}

/* ---------- campanha do mês ---------- */
// próximo horário bom para mandar (9h às 19h, segunda a sábado), a partir de t
function horarioBom(t: number) {
  for (let i = 0; i < 20; i++) {
    const r = recife(new Date(t)), hh = r.getUTCHours(), dow = r.getUTCDay();
    if (dow !== 0 && hh >= 9 && hh < 19) return t;
    const base = Date.parse(r.toISOString().slice(0, 10) + "T12:00:00Z") + (hh >= 9 || dow === 0 ? 864e5 : 0); // 9h de Recife = 12h UTC
    t = base; // 09:00 do próximo dia (ou de hoje)
  }
  return t;
}
async function destinatarios(o: string, mes: string) {
  const { data } = await db.from("emp_contatos").select("telefone,nome,campanha_mes").eq("otica_id", o).eq("optout", false).gte("ultimo_em", new Date(Date.now() - 365 * 864e5).toISOString()).limit(2000);
  return (data || []).filter((c: any) => dig(c.telefone).length >= 10);
}
async function rotinaCampanhas(e: any) {
  const o = e.impl.otica_id;
  const { data: cs } = await db.from("emp_campanhas").select("*").eq("otica_id", o).eq("status", "agendada").lte("enviar_em", new Date().toISOString()).order("enviar_em").limit(2);
  let n = 0;
  for (const c of cs || []) {
    if (!e.R.campanhas) { await db.from("emp_campanhas").update({ status: "cancelada" }).eq("id", c.id); continue; }
    const L = await destinatarios(o, c.mes);
    let t = horarioBom(Date.now() + 30e3);
    const rows: any[] = [];
    for (const d of L) {
      const txt = s(c.texto, 1500).replace(/\{nome\}/g, primeiro(d.nome) || "").replace(/,\s*!/g, "!").replace(/Oi\s*,/g, "Oi,").replace(/\s+([!?.,])/g, "$1") + "\n\nSe não quiser receber nossas promoções, responda SAIR.";
      rows.push({ otica_id: o, cliente_id: "campanha", cliente_nome: s(d.nome, 40) || d.telefone, tipo: "emp_campanha", telefone: d.telefone, texto: txt, ref: `camp:${c.id}:${d.telefone}`, status: "aguardando", enviar_apos: new Date(t).toISOString(), expira_em: new Date(t + 3 * 864e5).toISOString() });
      t = horarioBom(t + 45e3 + Math.floor(Math.random() * 30e3));
    }
    for (let i = 0; i < rows.length; i += 200) { const r = await db.from("wa_fila").upsert(rows.slice(i, i + 200), { onConflict: "otica_id,ref", ignoreDuplicates: true }); if (r.error) console.error("campanha", r.error.message); }
    if (rows.length) await db.from("emp_contatos").update({ campanha_mes: c.mes }).eq("otica_id", o).in("telefone", rows.map((x) => x.telefone));
    await db.from("emp_campanhas").update({ status: rows.length ? "enviando" : "enviada", total: rows.length, iniciada_em: new Date().toISOString() }).eq("id", c.id);
    // envio de campanha pelo conector da empresa: até 200 por dia, só em horário comercial
    await db.from("docs").update({ data: { on: true, ini: "09:00", fim: "19:00", limite: 200 } }).eq("otica_id", o).eq("col", "config").eq("id", "wa");
    await db.rpc("ex_avisar_donos", { p_otica: o, p_txt: `📣 A campanha da ${e.nome} começou: ${rows.length} ${rows.length === 1 ? "cliente vai" : "clientes vão"} receber, aos poucos, das 9h às 19h.` }).then(() => {}, () => {});
    n++;
  }
  // campanhas que terminaram
  const { data: env } = await db.from("emp_campanhas").select("id").eq("otica_id", o).eq("status", "enviando");
  for (const c of env || []) {
    const { count } = await db.from("wa_fila").select("id", { count: "exact", head: true }).eq("otica_id", o).like("ref", `camp:${c.id}:%`).in("status", ["aguardando", "enviando"]);
    if (!count) await db.from("emp_campanhas").update({ status: "enviada" }).eq("id", c.id);
  }
  return n;
}

async function rotina() {
  const L = await empresas();
  const out: any[] = [];
  for (const e of L) {
    const x: any = { impl: e.impl.id };
    for (const [k, f] of [["lembretes", rotinaLembretes], ["campanhas", rotinaCampanhas], ["aniversarios", rotinaAniversario], ["followups", rotinaFollowup]] as const) {
      try { x[k] = await (f as any)(e); } catch (err: any) { console.error(k, e.impl.id, err.message); x[k] = "erro"; }
    }
    out.push(x);
  }
  return { ok: true, empresas: out };
}

/* ---------- área do cliente ---------- */
async function implToken(t: unknown) {
  if (!/^[0-9a-f]{24}$/.test(String(t || ""))) return null;
  const { data } = await db.from("prosp_impl").select("*").eq("token", String(t)).maybeSingle();
  return data;
}
const fmtAg = (a: any) => { const r = recife(new Date(a.inicio)); return { id: a.id, nome: a.nome, telefone: a.telefone, servico: a.servico, status: a.status, origem: a.origem, obs: a.obs, data: r.toISOString().slice(0, 10), hora: r.toISOString().slice(11, 16), fim: recife(new Date(a.fim)).toISOString().slice(11, 16), lembrete: !!(a.lembrete_v || a.lembrete_d) }; };
async function resumo(impl: any, ag: any) {
  const o = impl.otica_id, mes = hojeR().slice(0, 7), rc = recursos(impl, ag?.cfg?.auto);
  const ini = new Date(Date.parse(hojeR() + "T03:00:00Z") - 7 * 864e5).toISOString();
  const [{ data: ags }, { data: cts }, { data: camps }, grade] = await Promise.all([
    db.from("emp_agenda").select("*").eq("otica_id", o).gte("inicio", ini).lte("inicio", new Date(Date.now() + 60 * 864e5).toISOString()).order("inicio").limit(600),
    db.from("emp_contatos").select("telefone,nome,aniv_dia,aniv_mes,optout,origem,ultimo_em").eq("otica_id", o).order("ultimo_em", { ascending: false }).limit(1000),
    db.from("emp_campanhas").select("*").eq("otica_id", o).order("criado_em", { ascending: false }).limit(12),
    db.rpc("emp_grade", { p_otica: o }),
  ]);
  const enviadas: Record<string, number> = {};
  for (const c of (camps || []).filter((x: any) => x.status !== "agendada" && x.status !== "cancelada").slice(0, 4)) {
    const { count } = await db.from("wa_fila").select("id", { count: "exact", head: true }).eq("otica_id", o).like("ref", `camp:${c.id}:%`).eq("status", "enviada");
    enviadas[c.id] = count || 0;
  }
  const usadasMes = (camps || []).filter((c: any) => c.mes === mes && c.status !== "cancelada").length;
  const au = ag?.cfg?.auto || {};
  return {
    ok: true, plano: impl.plano, recursos: rc.plano, ativo: rc.ativo,
    auto: { aniversario_texto: s(au.aniversario_texto, 600) || PARABENS, aniversario_presente: s(au.aniversario_presente, 300) },
    grade: grade.data || {}, servicos: (impl.config?.servicos || []).map((x: any) => s(x.nome, 80)).filter(Boolean),
    agenda: (ags || []).map(fmtAg),
    contatos: (cts || []).map((c: any) => ({ telefone: c.telefone, nome: c.nome, aniv: c.aniv_dia ? String(c.aniv_dia).padStart(2, "0") + "/" + String(c.aniv_mes).padStart(2, "0") : "", optout: c.optout, origem: c.origem, ultimo: c.ultimo_em })),
    campanhas: (camps || []).map((c: any) => ({ id: c.id, mes: c.mes, texto: c.texto, status: c.status, enviar_em: c.enviar_em, total: c.total, enviadas: enviadas[c.id] ?? (c.status === "enviada" ? c.total : 0) })),
    campanhas_mes: { usadas: usadasMes, limite: rc.plano.campanhas }, destinatarios: (cts || []).filter((c: any) => !c.optout && dig(c.telefone).length >= 10).length,
  };
}
async function painel(b: any) {
  const impl = await implToken(b.token);
  if (!impl || impl.status !== "ativa" || !impl.otica_id) return ok({ error: "Estas funções aparecem quando o agente estiver ligado no WhatsApp." }, 404);
  const o = impl.otica_id;
  const { data: ag } = await db.from("agente_config").select("cfg").eq("otica_id", o).maybeSingle();
  const cfg = ag?.cfg || {};
  const rc = recursos(impl, cfg.auto);
  const salvarCfg = async (novo: any) => { await db.from("agente_config").update({ cfg: novo, atualizado_em: new Date().toISOString() }).eq("otica_id", o); };
  const a = String(b.acao || "resumo");
  if (a === "resumo") return ok(await resumo(impl, ag));
  if (a === "auto") {
    const au = { ...(cfg.auto || {}) };
    for (const k of ["agenda", "lembrete", "aniversario", "followup"]) if (typeof b[k] === "boolean") au[k] = b[k];
    if (b.aniversario_texto !== undefined) au.aniversario_texto = s(b.aniversario_texto, 600);
    if (b.aniversario_presente !== undefined) au.aniversario_presente = s(b.aniversario_presente, 300);
    await salvarCfg({ ...cfg, auto: au });
    return ok({ ok: true });
  }
  if (a === "grade") {
    if (!rc.plano.agenda) return ok({ error: "A agenda faz parte do plano Profissional." }, 403);
    const g = b.grade || {}, dias: any = {};
    for (const k of ["dom", "seg", "ter", "qua", "qui", "sex", "sab"]) { const d = g.dias?.[k] || {}; dias[k] = { aberto: !!d.aberto, abre: horaOk(d.abre) ? d.abre : "08:00", fecha: horaOk(d.fecha) ? d.fecha : "18:00" }; }
    const ng: any = { dias, dur: Math.max(10, Math.min(480, Math.round(Number(g.dur) || 60))), antec_h: Math.max(0, Math.min(168, Math.round(Number(g.antec_h ?? 2)))), vagas: Math.max(1, Math.min(20, Math.round(Number(g.vagas) || 1))) };
    if (horaOk(g.almoco?.ini) && horaOk(g.almoco?.fim) && g.almoco.ini < g.almoco.fim) ng.almoco = { ini: g.almoco.ini, fim: g.almoco.fim };
    if (Array.isArray(g.bloqueios)) ng.bloqueios = g.bloqueios.filter(dataOk).slice(0, 60);
    const conf = { ...(impl.config || {}), grade: ng };
    await db.from("prosp_impl").update({ config: conf, atualizado_em: new Date().toISOString() }).eq("id", impl.id);
    await salvarCfg({ ...cfg, empresa: { ...(cfg.empresa || {}), grade: ng } });
    return ok({ ok: true });
  }
  if (a === "agendar") {
    if (!rc.plano.agenda) return ok({ error: "A agenda faz parte do plano Profissional." }, 403);
    if (!dataOk(b.data) || !horaOk(b.hora) || !s(b.nome)) return ok({ error: "Preencha nome, dia e hora." }, 400);
    const { data, error } = await db.rpc("emp_agendar", { p_otica: o, p_tel: dig(b.telefone) ? (dig(b.telefone).length <= 11 ? "55" + dig(b.telefone) : dig(b.telefone)) : null, p_nome: s(b.nome, 80), p_servico: s(b.servico, 80), p_data: b.data, p_hora: b.hora, p_origem: "painel", p_obs: s(b.obs, 300), p_livre: true });
    if (error) return ok({ error: "Não deu para marcar agora." }, 500);
    return ok(data);
  }
  if (a === "agenda_status") {
    const st = String(b.status || "");
    if (!["marcado", "confirmado", "cancelado", "concluido", "faltou"].includes(st)) return ok({ error: "status" }, 400);
    const { error } = await db.from("emp_agenda").update({ status: st, atualizado_em: new Date().toISOString() }).eq("id", String(b.id || "")).eq("otica_id", o);
    return ok(error ? { error: "Não deu certo." } : { ok: true });
  }
  if (a === "contato") {
    let tel = dig(b.telefone); if (tel.length === 10 || tel.length === 11) tel = "55" + tel;
    if (tel.length < 12) return ok({ error: "Escreva o WhatsApp com DDD." }, 400);
    const row: any = { otica_id: o, telefone: tel };
    if (b.nome !== undefined) row.nome = s(b.nome, 80) || null;
    if (b.aniv !== undefined) { const m = String(b.aniv || "").match(/^(\d{1,2})\/(\d{1,2})$/); if (b.aniv && !m) return ok({ error: "Aniversário no formato dia/mês, ex.: 25/12" }, 400); row.aniv_dia = m ? Math.min(31, +m[1]) : null; row.aniv_mes = m ? Math.min(12, +m[2]) : null; }
    if (typeof b.optout === "boolean") row.optout = b.optout;
    const { data: ja } = await db.from("emp_contatos").select("telefone").eq("otica_id", o).eq("telefone", tel).maybeSingle();
    const r = ja ? await db.from("emp_contatos").update(row).eq("otica_id", o).eq("telefone", tel) : await db.from("emp_contatos").insert({ ...row, origem: "painel" });
    return ok(r.error ? { error: "Não salvou: " + r.error.message } : { ok: true });
  }
  if (a === "campanha") {
    if (!rc.plano.campanhas) return ok({ error: "A campanha do mês faz parte do plano Profissional." }, 403);
    const texto = s(b.texto, 1500);
    if (texto.length < 10) return ok({ error: "Escreva a mensagem da promoção." }, 400);
    let quando = b.enviar_em ? new Date(String(b.enviar_em)) : new Date();
    if (isNaN(quando.getTime()) || quando.getTime() < Date.now()) quando = new Date();
    const mes = recife(quando).toISOString().slice(0, 7);
    const { count } = await db.from("emp_campanhas").select("id", { count: "exact", head: true }).eq("otica_id", o).eq("mes", mes).neq("status", "cancelada");
    if ((count || 0) >= rc.plano.campanhas) return ok({ error: rc.plano.campanhas === 1 ? "O seu plano tem 1 campanha por mês, e a deste mês já foi usada." : `O seu plano tem ${rc.plano.campanhas} campanhas por mês, e elas já foram usadas.` }, 409);
    const { error } = await db.from("emp_campanhas").insert({ otica_id: o, mes, texto, enviar_em: quando.toISOString() });
    return ok(error ? { error: "Não salvou agora." } : { ok: true });
  }
  if (a === "campanha_cancelar") {
    const { data: c } = await db.from("emp_campanhas").select("*").eq("id", String(b.id || "")).eq("otica_id", o).maybeSingle();
    if (!c) return ok({ error: "Campanha não encontrada." }, 404);
    if (c.status === "agendada") await db.from("emp_campanhas").update({ status: "cancelada" }).eq("id", c.id);
    else if (c.status === "enviando") { await db.from("wa_fila").update({ status: "cancelada" }).eq("otica_id", o).like("ref", `camp:${c.id}:%`).eq("status", "aguardando"); await db.from("emp_campanhas").update({ status: "enviada" }).eq("id", c.id); }
    return ok({ ok: true });
  }
  return ok({ error: "ação" }, 400);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json().catch(() => ({}));
    const seg = req.headers.get("x-agente");
    if (seg) {
      const { data } = await db.from("app_segredos").select("valor").eq("chave", "agente_secret").maybeSingle();
      if (!data || seg !== data.valor) return ok({ erro: "negado" }, 401);
      if (b.modo === "rotina") return ok(await rotina());
      return ok({ erro: "modo" }, 400);
    }
    if (b.modo === "painel") return await painel(b);
    return ok({ error: "modo" }, 400);
  } catch (e: any) {
    console.error("emp-recursos", e.message);
    return ok({ error: "Não deu certo agora. Tente de novo em instantes." }, 500);
  }
});
