// Pós-venda da Connecta: tudo o que acontece depois que a empresa assina.
// - Cobrança automática: Pix copia e cola da entrada (50%), da entrega (50%) e das mensalidades, com lembretes pelo WhatsApp do CRM.
// - Vigia: avisa o Éder (e a empresa) quando o WhatsApp do agente desconecta, quando mensagens ficam sem resposta e quando o limite chega perto.
// - Relatório mensal: quantas pessoas o agente atendeu, quantas fora do horário e quantas vezes chamou a equipe.
// - Ações do ADM: ligar o agente no WhatsApp da empresa, dar baixa, cobrar agora, pausar, encerrar.
// - Área do cliente (link /cliente/CODIGO): pagamentos, relatório e o QR Code para conectar o WhatsApp.
// Chamadas: x-agente (banco e agendamentos), Authorization de administrador (ADM) ou o código do link (área do cliente).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPush } from "./webpush.js";

const URL_SB = Deno.env.get("SUPABASE_URL")!;
const db = createClient(URL_SB, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const ok = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });
const s = (v: unknown, n = 600) => String(v ?? "").trim().slice(0, n);
const dig = (v: unknown) => String(v ?? "").replace(/\D/g, "");
const brl = (n: number) => "R$ " + Number(n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nomeCurto = (n: string) => { const x = String(n || "").trim(), c = x.split(/\s*(?::|\||\s[-–—]\s)\s*/)[0].trim(); return (c.length >= 3 ? c : x).slice(0, 40); };
const recife = (d = new Date()) => new Date(d.getTime() - 3 * 3600e3); // campos UTC = hora de Recife
const hoje = () => recife().toISOString().slice(0, 10);
const addDias = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const addMeses = (d: string, n: number) => { const [y, m, dd] = d.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1, 12)); const fim = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0, 12)).getUTCDate(); t.setUTCDate(Math.min(dd, fim)); return t.toISOString().slice(0, 10); };
const dias = (a: string, b: string) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5); // b - a
const fmt = (d: string) => d.slice(8, 10) + "/" + d.slice(5, 7);
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const DESC: Record<string, string> = { entrada: "1ª parte da implantação (50%)", entrega: "2ª parte da implantação (50%)", mensal: "mensalidade" };
const descDe = (c: any) => c.tipo === "mensal" ? `mensalidade de ${MESES[Number(c.venc.slice(5, 7)) - 1]}` : DESC[c.tipo];

/* ---------- configuração e segredos ---------- */
async function segredos(chaves: string[]) {
  const { data } = await db.from("app_segredos").select("chave,valor").in("chave", chaves);
  const k: Record<string, string> = {};
  (data || []).forEach((x: any) => { k[x.chave] = x.valor; });
  return k;
}
let CFG: any = null;
async function cfg() {
  if (CFG) return CFG;
  const [{ data: pc }, { data: ac }, k] = await Promise.all([
    db.from("prosp_config").select("chave,valor").in("chave", ["link_base_emp", "link_base", "seu_nome"]),
    db.from("adm_config").select("chave,valor").in("chave", ["pix", "pix_nome", "pix_cidade"]),
    segredos(["contratada_nome"]),
  ]);
  const c: Record<string, string> = {};
  (pc || []).forEach((x: any) => { c[x.chave] = String(x.valor || ""); });
  const a: Record<string, any> = {};
  (ac || []).forEach((x: any) => { a[x.chave] = x.valor; });
  let base = (c.link_base_emp || c.link_base || "https://teste-agente-ia.vercel.app").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) base = "https://" + base;
  CFG = { base, eder: (c.seu_nome || "Éder Henrique").split(" ")[0], pix: String(a.pix || ""), pixNome: String(a.pix_nome || k.contratada_nome || "Eder Henrique"), pixCidade: String(a.pix_cidade || "Recife") };
  return CFG;
}

/* ---------- Pix copia e cola (BR Code estático, com valor) ---------- */
function crc(str: string) { let c = 0xFFFF; for (let i = 0; i < str.length; i++) { c ^= str.charCodeAt(i) << 8; for (let j = 0; j < 8; j++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF; } return c.toString(16).toUpperCase().padStart(4, "0"); }
const limpa = (t: string, n: number) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9 .\-]/g, "").toUpperCase().trim().slice(0, n);
function chave(k: string) { k = String(k || "").trim(); if (/@/.test(k)) return k.toLowerCase(); if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(k)) return k.toLowerCase(); const d = k.replace(/\D/g, ""); if (/^\+/.test(k)) return "+" + d; if (/^\(?\d{2}\)?\s?9?\d{4}-?\d{4}$/.test(k) && /[()\s-]/.test(k)) return "+55" + d; if (d.length === 11 || d.length === 14) return d; return k; }
function pix(c: any, valor: number, txid: string) {
  const ch = chave(c.pix); if (!ch) return "";
  const f = (id: string, v: string) => id + String(v.length).padStart(2, "0") + v;
  let p = f("00", "01") + f("26", f("00", "br.gov.bcb.pix") + f("01", ch)) + f("52", "0000") + f("53", "986");
  if (valor > 0) p += f("54", valor.toFixed(2));
  p += f("58", "BR") + f("59", limpa(c.pixNome, 25) || "RECEBEDOR") + f("60", limpa(c.pixCidade, 15) || "RECIFE") + f("62", f("05", txid.replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "***")) + "6304";
  return p + crc(p);
}
const txidDe = (c: any) => ("CNX" + String(c.id).replace(/-/g, "").slice(0, 16)).toUpperCase();

/* ---------- avisos para o Éder ---------- */
async function avisar(title: string, body: string, urgente: boolean, lead?: string | null, tab = "impl") {
  if (!urgente) { await db.from("prosp_avisos").insert({ tipo: "outro", lead_id: lead || null, titulo: s(title, 120), texto: s(body, 300) }); return; }
  try {
    const [{ data: subs }, k] = await Promise.all([db.from("prosp_push").select("endpoint,sub"), segredos(["vapid_public", "vapid_private", "vapid_subject"])]);
    if (!subs?.length || !k.vapid_private) return;
    const payload = JSON.stringify({ title: s(title, 120), body: s(body, 300), url: "/prospectar?tab=" + tab, tag: "pos-" + (lead || title) });
    const vapid = { publicKey: k.vapid_public, privateKey: k.vapid_private, subject: k.vapid_subject || "mailto:admin@example.com" };
    await Promise.all(subs.map(async (x: any) => { try { const st = await sendPush(x.sub, payload, vapid); if (st === 404 || st === 410) await db.from("prosp_push").delete().eq("endpoint", x.endpoint); } catch (_) { /* segue */ } }));
  } catch (_) { /* opcional */ }
}
async function historico(lead: string | null, txt: string, extra: Record<string, unknown> = {}) {
  if (!lead) return;
  const { data: l } = await db.from("prosp_leads").select("historico").eq("id", lead).maybeSingle();
  const h = Array.isArray(l?.historico) ? l!.historico : [];
  h.push({ em: new Date().toISOString(), txt: s(txt, 400) });
  await db.from("prosp_leads").update({ historico: h, atualizado_em: new Date().toISOString(), ...extra }).eq("id", lead);
}

/* ---------- WhatsApp do CRM (o mesmo número em que a venda aconteceu) ---------- */
async function telefoneDo(lead: any) {
  const { data: um } = await db.from("prosp_wa_msg").select("telefone").eq("lead_id", lead.id).eq("de_mim", false).order("criado_em", { ascending: false }).limit(1).maybeSingle();
  return dig(um?.telefone || lead.whatsapp || lead.telefone);
}
async function whatsapp(lead: any, partes: string[], atrasoMs = 2500) {
  if (!lead) return false;
  const tel = await telefoneDo(lead);
  if (tel.length < 10) return false;
  let t = Date.now() + atrasoMs;
  const rows = partes.filter(Boolean).map((p, i) => {
    if (i) t += 2500 + Math.min(10000, p.length * 30);
    return { lead_id: lead.id, tipo: "manual", telefone: tel, texto: p, status: "aguardando", enviar_apos: new Date(t).toISOString(), criado_em: new Date(Date.now() + i).toISOString(), origem: "agente" };
  });
  const r = await db.from("prosp_wa_fila").insert(rows);
  return !r.error;
}

/* ---------- dados ---------- */
async function implDe(id: unknown) {
  if (!/^[0-9a-f-]{36}$/.test(String(id || ""))) return null;
  const { data } = await db.from("prosp_impl").select("*").eq("id", String(id)).maybeSingle();
  return data;
}
async function implToken(t: unknown) {
  if (!/^[0-9a-f]{24}$/.test(String(t || ""))) return null;
  const { data } = await db.from("prosp_impl").select("*").eq("token", String(t)).maybeSingle();
  return data;
}
async function leadDe(id: string | null) {
  if (!id) return null;
  const { data } = await db.from("prosp_leads").select("*").eq("id", id).maybeSingle();
  return data;
}
const empresaDe = (impl: any, lead?: any) => s(impl?.cadastro?.empresa?.nome, 60) || nomeCurto(lead?.nome || "") || "a empresa";
const linkCliente = (c: any, impl: any) => `${c.base}/cliente/${impl.token}`;

/* ---------- cobranças ---------- */
async function criarCobr(impl: any, tipo: string, parcela: number, venc: string, valor: number) {
  const { data, error } = await db.from("prosp_cobr").upsert({ impl_id: impl.id, tipo, parcela, venc, valor: Math.round(valor * 100) / 100 }, { onConflict: "impl_id,tipo,parcela", ignoreDuplicates: true }).select("*");
  if (error) throw new Error(error.message);
  if (data?.length) return data[0];
  const { data: ja } = await db.from("prosp_cobr").select("*").eq("impl_id", impl.id).eq("tipo", tipo).eq("parcela", parcela).maybeSingle();
  return ja ? { ...ja, _ja: true } : null;
}
// mensagem de cobrança: texto + Pix copia e cola numa mensagem separada (fica fácil de copiar)
function textoCobr(c: any, cob: any, impl: any, lead: any, etapa: string) {
  const emp = empresaDe(impl, lead), v = brl(Number(cob.valor)), d = descDe(cob);
  const atraso = dias(cob.venc, hoje());
  let t = "";
  if (etapa === "nova" && cob.tipo === "entrada") t = `Para começarmos a implantação, segue o Pix da *${d}*: *${v}*.`;
  else if (etapa === "nova" && cob.tipo === "entrega") t = `O agente da ${emp} já está atendendo 🎉 Segue o Pix da *${d}*: *${v}*.`;
  else if (etapa === "nova") t = `Olá! A *${d}* do agente da ${emp} (${v}) vence em ${fmt(cob.venc)}.`;
  else if (atraso < 0) t = `Olá! Passando para lembrar que a *${d}* do agente da ${emp} (${v}) vence em ${fmt(cob.venc)}.`;
  else if (atraso === 0) t = `Olá! A *${d}* do agente da ${emp} (${v}) vence hoje.`;
  else t = `Olá! A *${d}* do agente da ${emp} (${v}) venceu em ${fmt(cob.venc)}. Se já pagou, é só mandar o comprovante aqui.`;
  const code = pix(c, Number(cob.valor), txidDe(cob));
  return [t, code ? `Pix copia e cola (já com o valor):\n${code}` : `Chave Pix: ${c.pix}`, `Também dá para ver os pagamentos e o QR Code do Pix aqui: ${linkCliente(c, impl)}`];
}
async function enviarCobr(cob: any, etapa: string, atraso = 2500) {
  const impl = await implDe(cob.impl_id);
  if (!impl) return false;
  const [lead, c] = await Promise.all([leadDe(impl.lead_id), cfg()]);
  const okw = await whatsapp(lead, textoCobr(c, cob, impl, lead, etapa), atraso);
  if (okw) await db.from("prosp_cobr").update({ ultimo_aviso: hoje() }).eq("id", cob.id);
  return okw;
}

/* ---------- eventos ---------- */
// contrato assinado: cria a 1ª parte (50%) e manda o Pix depois das mensagens do teste
async function eventoAssinou(impl: any) {
  if (!impl) return { ok: false };
  const cob = await criarCobr(impl, "entrada", 1, hoje(), Number(impl.valor_implantacao) / 2);
  if (cob && !cob._ja) await enviarCobr(cob, "nova", 45000);
  return { ok: true };
}
// o WhatsApp da empresa conectou pela 1ª vez: entrega feita -> 2ª parte + calendário das mensalidades
async function eventoConectou(impl: any) {
  const quando = new Date().toISOString();
  await db.from("prosp_impl").update({ conectado_em: quando, atualizado_em: quando }).eq("id", impl.id);
  impl.conectado_em = quando;
  const lead = await leadDe(impl.lead_id);
  const entrega = await criarCobr(impl, "entrega", 1, hoje(), Number(impl.valor_implantacao) / 2);
  await criarCobr(impl, "mensal", 1, addDias(hoje(), 30), Number(impl.valor_mensal));
  if (entrega && !entrega._ja) await enviarCobr(entrega, "nova");
  await historico(impl.lead_id, "✅ WhatsApp conectado: o agente começou a atender. Cobrança da 2ª parte enviada; 1ª mensalidade em 30 dias.", { status: "fechou" });
  await avisar(`✅ ${empresaDe(impl, lead)}: agente atendendo`, "O WhatsApp conectou. A 2ª parte da implantação foi cobrada e a 1ª mensalidade vence em 30 dias.", true, impl.lead_id);
}

/* ---------- rotina diária de cobrança ---------- */
// etapas por tipo: dias em relação ao vencimento em que manda lembrete (a "nova" já foi enviada ao criar)
const ETAPAS: Record<string, number[]> = { mensal: [-3, 0, 3, 7], entrada: [2, 5], entrega: [3, 7] };
async function rotinaCobranca() {
  const h = hoje();
  // gera as próximas mensalidades (7 dias antes do vencimento)
  const { data: ativas } = await db.from("prosp_impl").select("*").eq("status", "ativa").is("encerrada_em", null).not("conectado_em", "is", null);
  for (const impl of ativas || []) {
    const { data: ms } = await db.from("prosp_cobr").select("parcela,venc").eq("impl_id", impl.id).eq("tipo", "mensal").order("parcela", { ascending: false }).limit(1);
    const ult = ms?.[0];
    const base = addDias(recife(new Date(impl.conectado_em)).toISOString().slice(0, 10), 30);
    // parcela k vence em base + (k-1) meses; cria quando faltar até 7 dias
    for (let n = ult ? ult.parcela : 0; n < 120; n++) {
      const venc = addMeses(base, n);
      if (dias(h, venc) > 7) break;
      await criarCobr(impl, "mensal", n + 1, venc, Number(impl.valor_mensal));
    }
  }
  // lembretes
  const { data: abertas } = await db.from("prosp_cobr").select("*, prosp_impl!inner(status,encerrada_em,lead_id,cadastro,saude)").eq("pago", false).eq("cancelada", false).lte("venc", addDias(h, 3));
  let enviados = 0;
  for (const cob of abertas || []) {
    const impl = (cob as any).prosp_impl;
    if (impl.status === "cancelada") continue;
    const d = dias(cob.venc, h); // >0 = dias de atraso
    const et = ETAPAS[cob.tipo] || [];
    const idx = et.filter((x) => d >= x).length; // quantos lembretes já deveriam ter saído (avisos = quantos saíram)
    if (idx > Number(cob.avisos || 0) && cob.ultimo_aviso !== h && d <= 10) {
      if (await enviarCobr(cob, "lembrete")) { enviados++; await db.from("prosp_cobr").update({ avisos: idx }).eq("id", cob.id); }
    }
    // 10 dias de atraso na mensalidade: o contrato permite suspender -> decisão do Éder
    if (cob.tipo === "mensal" && d >= 10 && !(impl.saude?.atraso10 === cob.id)) {
      await avisar(`⚠️ ${s(impl.cadastro?.empresa?.nome, 60) || "Empresa"}: 10 dias de atraso`, `A ${descDe(cob)} (${brl(Number(cob.valor))}) está atrasada desde ${fmt(cob.venc)}. Pelo contrato você pode pausar o agente.`, true, impl.lead_id, "fin");
      await db.from("prosp_impl").update({ saude: { ...(impl.saude || {}), atraso10: cob.id } }).eq("id", cob.impl_id);
    }
  }
  return { ok: true, enviados };
}

/* ---------- números do agente (relatório e área do cliente) ---------- */
const DK = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];
function foraDoHorario(horarios: any, iso: string) {
  const r = recife(new Date(iso)), k = DK[r.getUTCDay()], hm = r.toISOString().slice(11, 16);
  const d = horarios?.[k];
  if (!d || !d.aberto) return true;
  return hm < (d.abre || "00:00") || hm >= (d.fecha || "23:59");
}
async function numeros(impl: any, de: string, ate: string) {
  if (!impl.otica_id) return null;
  const ini = new Date(Date.parse(de + "T03:00:00Z")).toISOString(), fim = new Date(Date.parse(ate + "T03:00:00Z")).toISOString();
  const { data: rows } = await db.from("wa_conversa").select("telefone,papel,texto,criado_em").eq("otica_id", impl.otica_id).gte("criado_em", ini).lt("criado_em", fim).order("criado_em").limit(10000);
  const pessoas = new Set<string>(), fora = new Set<string>();
  let msgs = 0, resp = 0, equipe = 0, foraMsgs = 0;
  for (const m of rows || []) {
    if (m.papel === "cliente") { msgs++; pessoas.add(m.telefone); if (foraDoHorario(impl.cadastro?.horarios, m.criado_em)) { foraMsgs++; fora.add(m.telefone); } }
    else if (m.papel === "agente") resp++;
    else if (m.papel === "sistema" && /^Atendente chamado/.test(m.texto || "")) equipe++;
  }
  return { pessoas: pessoas.size, mensagens: msgs, respostas: resp, fora_horario: fora.size, fora_msgs: foraMsgs, chamou_equipe: equipe, de, ate };
}

/* ---------- relatório mensal (dia 1) ---------- */
async function rotinaRelatorio(soImpl?: string) {
  const h = hoje();
  const mesAnt = addMeses(h.slice(0, 7) + "-01", -1).slice(0, 7);
  const de = mesAnt + "-01", ate = h.slice(0, 7) + "-01";
  let q = db.from("prosp_impl").select("*").not("otica_id", "is", null).not("conectado_em", "is", null).is("encerrada_em", null);
  if (soImpl) q = q.eq("id", soImpl);
  const { data: lista } = await q;
  const c = await cfg();
  let n = 0;
  for (const impl of lista || []) {
    const { data: ja } = await db.from("prosp_relatorios").select("enviado_em").eq("impl_id", impl.id).eq("mes", mesAnt).maybeSingle();
    if (ja?.enviado_em && !soImpl) continue;
    const x = await numeros(impl, de, ate);
    if (!x) continue;
    const lead = await leadDe(impl.lead_id);
    const nomeMes = MESES[Number(mesAnt.slice(5, 7)) - 1];
    const parcial = Date.parse(impl.conectado_em) > Date.parse(de + "T03:00:00Z");
    const partes = [
      `📊 *Relatório de ${nomeMes}* do Agente de IA da ${empresaDe(impl, lead)}${parcial ? ` (desde ${fmt(recife(new Date(impl.conectado_em)).toISOString().slice(0, 10))}, quando ele começou)` : ""}:`,
      [`• *${x.pessoas}* ${x.pessoas === 1 ? "pessoa atendida" : "pessoas atendidas"}`, `• *${x.respostas}* respostas enviadas`, `• *${x.fora_horario}* ${x.fora_horario === 1 ? "pessoa escreveu" : "pessoas escreveram"} fora do horário de funcionamento e foram respondidas na hora`, `• *${x.chamou_equipe}* ${x.chamou_equipe === 1 ? "vez" : "vezes"} o agente chamou a equipe`].join("\n"),
      `Os detalhes e os pagamentos ficam aqui: ${linkCliente(c, impl)}\nSe quiser mudar alguma coisa no agente, é só pedir na área de ajustes.`,
    ];
    const enviado = x.mensagens > 0 ? await whatsapp(lead, partes) : false;
    await db.from("prosp_relatorios").upsert({ impl_id: impl.id, mes: mesAnt, dados: x, enviado_em: enviado ? new Date().toISOString() : null });
    n++;
  }
  return { ok: true, relatorios: n };
}

/* ---------- vigia (a cada 10 minutos) ---------- */
async function rotinaVigia() {
  const { data: lista } = await db.from("prosp_impl").select("*").eq("status", "ativa").is("encerrada_em", null).not("otica_id", "is", null);
  const c = await cfg();
  const out: any[] = [];
  for (const impl of lista || []) {
    const [{ data: con }, { data: ag }, lead] = await Promise.all([
      db.from("wa_conector").select("estado,ultimo_contato,numero").eq("otica_id", impl.otica_id).maybeSingle(),
      db.from("agente_config").select("ativo,limite_mes").eq("otica_id", impl.otica_id).maybeSingle(),
      leadDe(impl.lead_id),
    ]);
    const sd: any = { ...(impl.saude || {}) };
    const antes = JSON.stringify(sd);
    const emp = empresaDe(impl, lead);
    const online = !!con && con.estado === "conectado" && !!con.ultimo_contato && Date.parse(con.ultimo_contato) > Date.now() - 5 * 60e3;
    if (online && !impl.conectado_em) await eventoConectou(impl);
    // ligado no ADM mas a empresa ainda não leu o QR Code: lembra uma vez por dia (até 3 vezes)
    if (!impl.conectado_em && !online && impl.ativa_em && Date.now() - Date.parse(impl.ativa_em) > 24 * 3600e3 && Number(sd.lembrete_qr || 0) < 3 && (!sd.lembrete_qr_em || Date.now() - Date.parse(sd.lembrete_qr_em) > 24 * 3600e3)) {
      await whatsapp(lead, [`Oi! O agente da ${emp} já está pronto, só falta conectar o WhatsApp 😊`, `É só abrir este link no computador e ler o QR Code com o celular da empresa:\n${linkCliente(c, impl)}`]);
      sd.lembrete_qr = Number(sd.lembrete_qr || 0) + 1; sd.lembrete_qr_em = new Date().toISOString();
      if (sd.lembrete_qr === 2) await avisar(`⏳ ${emp} ainda não conectou o WhatsApp`, "O agente está pronto há mais de 2 dias. Vale ligar para ajudar com o QR Code.", true, impl.lead_id);
    }
    if (impl.conectado_em || online) {
      if (!online) {
        if (!sd.wa_off_desde) sd.wa_off_desde = new Date().toISOString();
        const min = (Date.now() - Date.parse(sd.wa_off_desde)) / 60e3;
        if (min >= 15 && !sd.wa_off_avisado) { await avisar(`🔴 ${emp}: WhatsApp desconectou`, "O agente parou de atender. A empresa precisa ler o QR Code de novo (área do cliente).", true, impl.lead_id); sd.wa_off_avisado = new Date().toISOString(); }
        if (min >= 30 && (!sd.wa_off_empresa || Date.now() - Date.parse(sd.wa_off_empresa) > 24 * 3600e3)) {
          await whatsapp(lead, [`Olá! O WhatsApp da ${emp} desconectou do agente, então ele parou de responder os clientes por enquanto.`, `Para religar é rapidinho: abra este link no computador e leia o QR Code com o celular da empresa (WhatsApp › Aparelhos conectados › Conectar um aparelho):\n${linkCliente(c, impl)}`]);
          sd.wa_off_empresa = new Date().toISOString();
        }
      } else if (sd.wa_off_desde) {
        if (sd.wa_off_avisado) await avisar(`🟢 ${emp}: WhatsApp conectado de novo`, "O agente voltou a atender.", false, impl.lead_id);
        delete sd.wa_off_desde; delete sd.wa_off_avisado; delete sd.wa_off_empresa;
      }
    }
    // mensagens de clientes sem resposta (o agente está ligado, online e ninguém da equipe respondeu)
    if (online && ag?.ativo) {
      const desde = new Date(Date.now() - 2 * 3600e3).toISOString();
      const { data: conv } = await db.from("wa_conversa").select("telefone,papel,criado_em").eq("otica_id", impl.otica_id).gte("criado_em", desde).order("criado_em");
      const ult: Record<string, any> = {};
      for (const m of conv || []) ult[m.telefone] = m;
      // quem o agente passou para a equipe fica com a equipe (o agente se cala de propósito)
      const { data: cham12 } = await db.from("wa_conversa").select("telefone").eq("otica_id", impl.otica_id).eq("papel", "sistema").like("texto", "Atendente chamado%").gte("criado_em", new Date(Date.now() - 12 * 3600e3).toISOString());
      const comEquipe = new Set((cham12 || []).map((x: any) => x.telefone));
      const dono8 = dig(impl.cadastro?.dono?.whatsapp).slice(-8);
      const pend = Object.values(ult).filter((m: any) => m.papel === "cliente" && !comEquipe.has(m.telefone) && !(dono8 && String(m.telefone).slice(-8) === dono8) && Date.parse(m.criado_em) < Date.now() - 10 * 60e3);
      let semResp = 0;
      for (const m of pend as any[]) {
        const { count } = await db.from("wa_msg").select("id", { count: "exact", head: true }).eq("otica_id", impl.otica_id).eq("telefone", m.telefone).eq("de_mim", true).gte("criado_em", m.criado_em);
        if (!count) semResp++;
      }
      if (semResp >= 2 && (!sd.sem_resp || Date.now() - Date.parse(sd.sem_resp) > 6 * 3600e3)) {
        await avisar(`⚠️ ${emp}: ${semResp} clientes sem resposta`, "Mensagens das últimas 2 horas ficaram sem resposta do agente. Confira as conversas e o WhatsApp.", true, impl.lead_id);
        sd.sem_resp = new Date().toISOString();
      }
    }
    // perto do limite do mês
    const lim = Number(ag?.limite_mes ?? 1500);
    if (lim > 0) {
      const { data: usadas } = await db.rpc("ag_uso_mes", { p_otica: impl.otica_id });
      const mes = hoje().slice(0, 7);
      if (Number(usadas || 0) >= lim * 0.9 && sd.limite_mes !== mes) { await avisar(`📈 ${emp}: perto do limite do mês`, `${usadas} de ${lim} respostas usadas. Aumente o limite na aba Agente de IA do ADM se quiser.`, false, impl.lead_id); sd.limite_mes = mes; }
    }
    // muitas vezes chamou a equipe hoje: pode faltar informação no agente
    const ini = new Date(Date.parse(hoje() + "T03:00:00Z")).toISOString();
    const { count: cham } = await db.from("wa_conversa").select("id", { count: "exact", head: true }).eq("otica_id", impl.otica_id).eq("papel", "sistema").like("texto", "Atendente chamado pelo agente%").gte("criado_em", ini);
    if ((cham || 0) >= 8 && sd.muitas_chamadas !== hoje()) { await avisar(`🙋 ${emp}: o agente chamou a equipe ${cham} vezes hoje`, "Pode estar faltando informação no agente. Veja as conversas e, se precisar, ajuste na área do cliente.", false, impl.lead_id); sd.muitas_chamadas = hoje(); }
    if (JSON.stringify(sd) !== antes) await db.from("prosp_impl").update({ saude: sd }).eq("id", impl.id);
    out.push({ impl: impl.id, online });
  }
  return { ok: true, n: out.length };
}

/* ---------- estado do WhatsApp/agente de uma implantação ---------- */
async function estadoWa(impl: any) {
  if (!impl.otica_id) return { estado: "sem_agente", online: false };
  const [{ data: con }, { data: ag }, { data: usadas }] = await Promise.all([
    db.from("wa_conector").select("estado,ultimo_contato,numero,qr,qr_em").eq("otica_id", impl.otica_id).maybeSingle(),
    db.from("agente_config").select("ativo,limite_mes").eq("otica_id", impl.otica_id).maybeSingle(),
    db.rpc("ag_uso_mes", { p_otica: impl.otica_id }),
  ]);
  const vivo = !!con?.ultimo_contato && Date.parse(con.ultimo_contato) > Date.now() - 5 * 60e3;
  const online = vivo && con?.estado === "conectado";
  const qr = vivo && con?.estado === "qr" && con.qr && con.qr_em && Date.parse(con.qr_em) > Date.now() - 2 * 60e3 ? con.qr : null;
  return { estado: online ? "conectado" : qr ? "qr" : vivo ? "aguardando" : "offline", online, qr, numero: con?.numero || null, ultimo_contato: con?.ultimo_contato || null, agente_ativo: !!ag?.ativo, respostas_mes: Number(usadas || 0), limite_mes: Number(ag?.limite_mes ?? 0) };
}

/* ---------- ações do ADM ---------- */
async function souAdmin(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  const u = createClient(URL_SB, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data } = await u.rpc("sou_admin");
  return data === true;
}
async function admin(b: any) {
  const c = await cfg();
  if (b.acao === "saude") {
    const { data: lista } = await db.from("prosp_impl").select("*").in("status", ["ativa", "teste"]).not("otica_id", "is", null);
    const out: Record<string, unknown> = {};
    for (const impl of lista || []) out[impl.id] = await estadoWa(impl);
    return ok({ ok: true, saude: out });
  }
  if (b.acao === "baixa" || b.acao === "desfazer" || b.acao === "cobrar") {
    const { data: cob } = await db.from("prosp_cobr").select("*").eq("id", String(b.cobr || "")).maybeSingle();
    if (!cob) return ok({ error: "Cobrança não encontrada." }, 404);
    if (b.acao === "cobrar") { const r = await enviarCobr(cob, "lembrete"); return ok(r ? { ok: true } : { error: "Não deu para enviar pelo WhatsApp do CRM." }, r ? 200 : 400); }
    const pago = b.acao === "baixa";
    await db.from("prosp_cobr").update({ pago, pago_em: pago ? hoje() : null }).eq("id", cob.id);
    const impl = await implDe(cob.impl_id);
    if (pago && impl) {
      const lead = await leadDe(impl.lead_id);
      if (b.agradecer !== false) await whatsapp(lead, [`Recebi o pagamento da *${descDe(cob)}* (${brl(Number(cob.valor))}). Obrigado! ✅`]);
      await historico(impl.lead_id, `💰 Pagamento recebido: ${descDe(cob)} (${brl(Number(cob.valor))})`);
    }
    return ok({ ok: true });
  }
  const impl = await implDe(b.impl);
  if (!impl) return ok({ error: "Implantação não encontrada." }, 404);
  const lead = await leadDe(impl.lead_id);
  const emp = empresaDe(impl, lead);
  if (b.acao === "ligar") {
    if (!["teste", "ativa"].includes(impl.status)) return ok({ error: "A empresa ainda não assinou o contrato." }, 409);
    const { data: oid, error } = await db.rpc("prosp_impl_tenant", { p_impl: impl.id });
    if (error) return ok({ error: "Não deu para criar o agente: " + error.message }, 500);
    const primeira = impl.status !== "ativa";
    await db.from("prosp_impl").update({ status: "ativa", ativa_em: impl.ativa_em || new Date().toISOString(), atualizado_em: new Date().toISOString() }).eq("id", impl.id);
    if (primeira && b.avisar !== false) {
      await whatsapp(lead, [
        `Tudo pronto para ligar o agente da ${emp} no WhatsApp! 🚀`,
        `Abra este link *no computador* e leia o QR Code com o celular da empresa (WhatsApp › Configurações › Aparelhos conectados › Conectar um aparelho):\n${linkCliente(c, impl)}`,
        `Assim que conectar, o agente começa a responder os clientes. Nesse mesmo link vocês continuam pedindo ajustes, veem o relatório e os pagamentos.`,
      ]);
      await historico(impl.lead_id, "🚀 Agente criado. Link para conectar o WhatsApp enviado para a empresa.");
    }
    return ok({ ok: true, otica: oid, wa: await estadoWa({ ...impl, otica_id: oid }) });
  }
  if (b.acao === "pausar" || b.acao === "retomar") {
    if (!impl.otica_id) return ok({ error: "O agente ainda não foi ligado." }, 409);
    const on = b.acao === "retomar";
    await db.from("agente_config").update({ ativo: on, atualizado_em: new Date().toISOString() }).eq("otica_id", impl.otica_id);
    await historico(impl.lead_id, on ? "▶ Agente da empresa religado" : "⏸ Agente da empresa pausado");
    return ok({ ok: true, ativo: on });
  }
  if (b.acao === "encerrar") {
    const quando = new Date().toISOString();
    await db.from("prosp_impl").update({ status: "encerrada", encerrada_em: quando, atualizado_em: quando }).eq("id", impl.id);
    await db.from("prosp_cobr").update({ cancelada: true }).eq("impl_id", impl.id).eq("pago", false).gt("venc", hoje());
    if (impl.otica_id) {
      await db.from("agente_config").update({ ativo: false }).eq("otica_id", impl.otica_id);
      await db.from("wa_nuvem").update({ ativo: false }).eq("otica_id", impl.otica_id);
      await db.from("oticas").update({ ativa: false }).eq("id", impl.otica_id);
    }
    await historico(impl.lead_id, `🛑 Cliente encerrado${b.motivo ? ": " + s(b.motivo, 200) : ""}. Cobranças futuras canceladas.`);
    return ok({ ok: true });
  }
  if (b.acao === "relatorio") return ok(await rotinaRelatorio(impl.id));
  if (b.acao === "numeros") { const h = hoje(); return ok({ ok: true, mes: await numeros(impl, h.slice(0, 7) + "-01", addDias(h, 1)) }); }
  return ok({ error: "ação" }, 400);
}

/* ---------- área do cliente (pelo código do link) ---------- */
async function painel(b: any) {
  const impl = await implToken(b.token);
  if (!impl || !["teste", "ativa", "encerrada"].includes(impl.status)) return ok({ error: "Link inválido." }, 404);
  const c = await cfg();
  const h = hoje();
  const [{ data: cobs }, wa, { data: rels }] = await Promise.all([
    db.from("prosp_cobr").select("*").eq("impl_id", impl.id).eq("cancelada", false).lte("venc", addDias(h, 40)).order("venc"),
    estadoWa(impl),
    db.from("prosp_relatorios").select("mes,dados").eq("impl_id", impl.id).order("mes", { ascending: false }).limit(6),
  ]);
  const mes = impl.otica_id && impl.conectado_em ? await numeros(impl, h.slice(0, 7) + "-01", addDias(h, 1)) : null;
  return ok({
    ok: true, status: impl.status, empresa: empresaDe(impl), plano: impl.plano, conectado_em: impl.conectado_em,
    wa: { estado: wa.estado, online: wa.online, qr: wa.qr || null, numero: wa.numero ? String(wa.numero).replace(/\d(?=\d{4})/g, "•") : null, agente_ativo: (wa as any).agente_ativo ?? false },
    pagamentos: (cobs || []).map((x: any) => ({ id: x.id, descricao: descDe(x), venc: x.venc, valor: Number(x.valor), pago: x.pago, pago_em: x.pago_em, atraso: x.pago ? 0 : Math.max(0, dias(x.venc, h)), pix: x.pago ? null : pix(c, Number(x.valor), txidDe(x)) })),
    pix_chave: c.pix ? "CPF •••" + c.pix.replace(/\D/g, "").slice(-4) : "", pix_nome: c.pixNome,
    mes_atual: mes, relatorios: (rels || []).map((r: any) => ({ mes: r.mes, ...r.dados })),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json().catch(() => ({}));
    const seg = req.headers.get("x-agente");
    if (seg) {
      const { data } = await db.from("app_segredos").select("valor").eq("chave", "agente_secret").maybeSingle();
      if (!data || seg !== data.valor) return ok({ erro: "negado" }, 401);
      if (b.modo === "rotina" && b.tipo === "vigia") return ok(await rotinaVigia());
      if (b.modo === "rotina" && b.tipo === "cobranca") return ok(await rotinaCobranca());
      if (b.modo === "rotina" && b.tipo === "relatorio") return ok(await rotinaRelatorio());
      if (b.modo === "assinou") return ok(await eventoAssinou(await implDe(b.impl)));
      if (b.modo === "comprovante") {
        const { data: cob } = await db.from("prosp_cobr").select("*").eq("id", String(b.cobr || "")).maybeSingle();
        if (!cob) return ok({ ok: false });
        const impl = await implDe(cob.impl_id);
        const lead = impl ? await leadDe(impl.lead_id) : null;
        await avisar(`💸 ${empresaDe(impl, lead)} mandou comprovante`, `${descDe(cob)} (${brl(Number(cob.valor))}): «${s(b.texto, 140)}». Confira e toque em Recebi na aba Financeiro.`, true, impl?.lead_id, "fin");
        return ok({ ok: true });
      }
      return ok({ erro: "modo" }, 400);
    }
    if (b.modo === "painel") return await painel(b);
    if (b.modo === "admin") { if (!(await souAdmin(req))) return ok({ error: "Entre como administrador." }, 401); return await admin(b); }
    return ok({ error: "modo" }, 400);
  } catch (e: any) {
    console.error("connecta-pos", e.message);
    return ok({ error: "Não deu certo agora. Tente de novo em instantes." }, 500);
  }
});
