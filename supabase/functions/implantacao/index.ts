// Implantação do Agente de IA depois do fechamento (Connecta AI).
// Fluxo: o Éder confirma no CRM (iniciar) -> a empresa recebe o cadastro -> envia -> recebe o contrato -> assina
//        -> recebe o teste real do agente com as informações dela e uma conversa de ajustes que atualiza a IA sozinha.
// Modos: iniciar (administrador), ler, salvar, enviar, assinar, chat, ajuste (página da empresa, pelo código do link).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPush } from "./webpush.js";

const URL_SB = Deno.env.get("SUPABASE_URL")!;
const db = createClient(URL_SB, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4.1-mini";
const OPENAI = Deno.env.get("OPENAI_API_KEY") || "";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const ok = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });
const s = (v: unknown, n = 600) => String(v ?? "").trim().slice(0, n);
const dig = (v: unknown) => String(v ?? "").replace(/\D/g, "");
const brl = (n: number) => "R$ " + Number(n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nomeCurto = (n: string) => { const x = String(n || "").trim(), c = x.split(/\s*(?::|\||\s[-–—]\s)\s*/)[0].trim(); return (c.length >= 3 ? c : x).slice(0, 40); };
const PRAZO = "até 7 (sete) dias corridos";

const RAMOS: Record<string, string> = {
  clinica: "clínica / consultório", odonto: "clínica odontológica", advocacia: "escritório de advocacia", restaurante: "restaurante / delivery",
  beleza: "barbearia, salão ou estética", academia: "academia / estúdio", pet: "pet shop / veterinária", outro: "outro tipo de empresa",
};
const DIAS = [["seg", "segunda"], ["ter", "terça"], ["qua", "quarta"], ["qui", "quinta"], ["sex", "sexta"], ["sab", "sábado"], ["dom", "domingo"]];

async function segredos(chaves: string[]) {
  const { data } = await db.from("app_segredos").select("chave,valor").in("chave", chaves);
  const k: Record<string, string> = {};
  (data || []).forEach((x: any) => { k[x.chave] = x.valor; });
  return k;
}
async function cfg() {
  const { data } = await db.from("prosp_config").select("chave,valor").in("chave", ["link_base_emp", "link_base", "seu_nome"]);
  const c: Record<string, string> = {};
  (data || []).forEach((x: any) => { c[x.chave] = String(x.valor || ""); });
  let base = (c.link_base_emp || c.link_base || "https://teste-agente-ia.vercel.app").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) base = "https://" + base;
  return { base, eder: (c.seu_nome || "Éder Henrique").split(" ")[0] };
}

/* ---------- avisos e WhatsApp ---------- */
async function avisar(title: string, body: string, urgente: boolean, lead?: string | null) {
  if (!urgente) { await db.from("prosp_avisos").insert({ tipo: "outro", lead_id: lead || null, titulo: s(title, 120), texto: s(body, 300) }); return; }
  try {
    const [{ data: subs }, k] = await Promise.all([db.from("prosp_push").select("endpoint,sub"), segredos(["vapid_public", "vapid_private", "vapid_subject"])]);
    if (!subs?.length || !k.vapid_private) return;
    const payload = JSON.stringify({ title: s(title, 120), body: s(body, 300), url: "/prospectar?tab=impl", tag: "impl-" + (lead || "") });
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
async function telefoneDo(lead: any) {
  const { data: um } = await db.from("prosp_wa_msg").select("telefone").eq("lead_id", lead.id).eq("de_mim", false).order("criado_em", { ascending: false }).limit(1).maybeSingle();
  return dig(um?.telefone || lead.whatsapp || lead.telefone);
}
// manda em partes, como uma pessoa digitando
async function whatsapp(lead: any, partes: string[]) {
  const tel = await telefoneDo(lead);
  if (tel.length < 10) return false;
  let t = Date.now();
  const rows = partes.filter(Boolean).map((p, i) => {
    t += (i === 0 ? 2500 : 2500) + Math.min(12000, p.length * 40);
    return { lead_id: lead.id, tipo: "manual", telefone: tel, texto: p, status: "aguardando", enviar_apos: new Date(t).toISOString(), criado_em: new Date(Date.now() + i).toISOString(), origem: "agente" };
  });
  const r = await db.from("prosp_wa_fila").insert(rows);
  return !r.error;
}

// função de pós-venda (cobranças, vigia, relatório)
async function posVenda(body: Record<string, unknown>) {
  try {
    const k = await segredos(["agente_secret"]);
    await fetch(`${URL_SB}/functions/v1/connecta-pos`, { method: "POST", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json", "x-agente": k.agente_secret || "" }, body: JSON.stringify(body) });
  } catch (e: any) { console.error("pos-venda", e.message); }
}

/* ---------- OpenAI ---------- */
async function chat(body: any) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", signal: AbortSignal.timeout(45000),
    headers: { Authorization: `Bearer ${OPENAI}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, ...body }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || `OpenAI ${r.status}`);
  return j;
}
async function sha256(t: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function usar(impl: string, campo: "chat" | "ajuste", limite: number) {
  const { data } = await db.from("prosp_impl_uso").select("chat,ajuste").eq("impl_id", impl).eq("dia", new Date().toISOString().slice(0, 10)).maybeSingle();
  const atual = Number((data as any)?.[campo] || 0);
  if (atual >= limite) return false;
  await db.from("prosp_impl_uso").upsert({ impl_id: impl, dia: new Date().toISOString().slice(0, 10), chat: campo === "chat" ? atual + 1 : Number(data?.chat || 0), ajuste: campo === "ajuste" ? atual + 1 : Number(data?.ajuste || 0) });
  return true;
}

/* ---------- cadastro -> configuração da IA ---------- */
function limparCadastro(c: any) {
  const txt = (v: unknown, n = 300) => s(v, n);
  const arr = (v: unknown, n = 30) => (Array.isArray(v) ? v.slice(0, n).map((x) => s(x, 60)).filter(Boolean) : []);
  const o: any = {};
  o.ramo = RAMOS[c?.ramo] ? c.ramo : "outro";
  o.empresa = { nome: txt(c?.empresa?.nome, 80), razao: txt(c?.empresa?.razao, 120), doc: txt(c?.empresa?.doc, 20), endereco: txt(c?.empresa?.endereco, 200), cidade: txt(c?.empresa?.cidade, 60), instagram: txt(c?.empresa?.instagram, 60), descricao: txt(c?.empresa?.descricao, 400) };
  o.dono = { nome: txt(c?.dono?.nome, 100), cpf: txt(c?.dono?.cpf, 14), email: txt(c?.dono?.email, 100), whatsapp: txt(c?.dono?.whatsapp, 20), cargo: txt(c?.dono?.cargo, 40) };
  const at = c?.atendimento || {};
  o.atendimento = { assistente: txt(at.assistente, 40), tom: ["formal", "proximo", "descontraido"].includes(at.tom) ? at.tom : "proximo", emojis: at.emojis === "nao" ? "nao" : "sim", fora_horario: at.fora_horario === "avisa" ? "avisa" : "responde", alerta: txt(at.alerta, 20) };
  o.horarios = {};
  DIAS.forEach(([k]) => { const h = c?.horarios?.[k] || {}; o.horarios[k] = { aberto: !!h.aberto, abre: txt(h.abre, 5), fecha: txt(h.fecha, 5) }; });
  o.servicos = (Array.isArray(c?.servicos) ? c.servicos : []).slice(0, 60).map((x: any) => ({ nome: txt(x?.nome, 80), preco: txt(x?.preco, 40), obs: txt(x?.obs, 160) })).filter((x: any) => x.nome);
  o.pagamentos = arr(c?.pagamentos, 10);
  o.parcela = txt(c?.parcela, 80);
  o.agenda = { usa: ["agente", "pre", "nao"].includes(c?.agenda?.usa) ? c.agenda.usa : "nao", duracao: txt(c?.agenda?.duracao, 30), antecedencia: txt(c?.agenda?.antecedencia, 40) };
  o.especificas = {};
  Object.entries(c?.especificas || {}).slice(0, 30).forEach(([k, v]) => { o.especificas[s(k, 40)] = Array.isArray(v) ? arr(v) : txt(v, 300); });
  o.chamar = arr(c?.chamar, 10);
  o.nao_falar = txt(c?.nao_falar, 600);
  o.faq = txt(c?.faq, 1500);
  o.extras = txt(c?.extras, 1000);
  return o;
}
const ROT_PAG: Record<string, string> = { pix: "Pix", credito: "cartão de crédito", debito: "cartão de débito", dinheiro: "dinheiro", boleto: "boleto", convenio: "convênio", transferencia: "transferência" };
const ROT_CHAMAR: Record<string, string> = { fechar: "quando o cliente quiser fechar ou pagar", reclamacao: "reclamação ou cliente insatisfeito", urgencia: "urgência", negociacao: "pedido de desconto ou negociação", pessoa: "quando o cliente pedir para falar com uma pessoa", fora: "assunto que não está nas informações" };
function horariosTexto(h: any) {
  return DIAS.map(([k, n]) => { const d = h?.[k]; return d?.aberto ? `${n}: ${d.abre || "?"} às ${d.fecha || "?"}` : `${n}: fechado`; }).join("; ");
}
function configDe(cad: any) {
  const e = cad.especificas || {};
  const espec = Object.entries(e).filter(([, v]) => (Array.isArray(v) ? v.length : String(v || "").trim())).map(([k, v]) => `${k.replace(/_/g, " ")}: ${Array.isArray(v) ? v.join(", ") : v}`);
  return {
    empresa: cad.empresa.nome, ramo: RAMOS[cad.ramo], descricao: cad.empresa.descricao,
    endereco: [cad.empresa.endereco, cad.empresa.cidade].filter(Boolean).join(" - "), instagram: cad.empresa.instagram,
    assistente: cad.atendimento.assistente || "", tom: cad.atendimento.tom, emojis: cad.atendimento.emojis === "sim",
    horarios: horariosTexto(cad.horarios), fora_horario: cad.atendimento.fora_horario === "avisa" ? "Fora do horário: responda e avise que a equipe confirma quando abrir." : "Fora do horário: responda normalmente; agende e anote pedidos para o próximo horário de funcionamento.",
    servicos: cad.servicos, pagamentos: cad.pagamentos.map((p: string) => ROT_PAG[p] || p), parcela: cad.parcela,
    agenda: cad.agenda.usa === "agente" ? `O agente marca os horários${cad.agenda.duracao ? " (cada atendimento dura " + cad.agenda.duracao + ")" : ""}${cad.agenda.antecedencia ? "; antecedência mínima: " + cad.agenda.antecedencia : ""}.` : cad.agenda.usa === "pre" ? "O agente faz um pré-agendamento (anota dia e horário preferidos) e a equipe confirma." : "Não faz agendamento; tira dúvidas e passa para a equipe.",
    especificas: espec, chamar: cad.chamar.map((c: string) => ROT_CHAMAR[c] || c), nao_falar: cad.nao_falar, faq: cad.faq, regras_extras: cad.extras ? [cad.extras] : [],
  };
}
function promptEmpresa(cf: any) {
  const L: string[] = [];
  L.push(`Você é ${cf.assistente ? cf.assistente + ", " : ""}o atendente virtual da ${cf.empresa} (${cf.ramo}) no WhatsApp. Atenda os clientes como uma pessoa da equipe: ${cf.tom === "formal" ? "educado e formal, tratando por senhor/senhora" : cf.tom === "descontraido" ? "leve e descontraído, bem próximo" : "simpático, próximo e objetivo"}. Mensagens curtas, separadas por uma linha em branco quando forem mais de uma, no máximo uma pergunta por resposta${cf.emojis ? ", com no máximo um emoji" : ", sem emojis"}. Português do Brasil.`);
  if (cf.descricao) L.push(`Sobre a empresa: ${cf.descricao}`);
  if (cf.endereco) L.push(`Endereço: ${cf.endereco}`);
  if (cf.instagram) L.push(`Instagram: ${cf.instagram}`);
  L.push(`Horários: ${cf.horarios}. ${cf.fora_horario}`);
  if (cf.servicos?.length) L.push("Serviços e preços:\n" + cf.servicos.map((x: any) => `- ${x.nome}${x.preco ? ": " + x.preco : ""}${x.obs ? " (" + x.obs + ")" : ""}`).join("\n"));
  if (cf.pagamentos?.length) L.push(`Formas de pagamento: ${cf.pagamentos.join(", ")}${cf.parcela ? ". " + cf.parcela : ""}.`);
  if (cf.agenda) L.push(`Agendamento: ${cf.agenda}`);
  if (cf.especificas?.length) L.push("Informações do ramo:\n" + cf.especificas.map((x: string) => "- " + x).join("\n"));
  if (cf.chamar?.length) L.push(`Chame a equipe (diga que vai passar para uma pessoa da equipe) quando: ${cf.chamar.join("; ")}.`);
  if (cf.nao_falar) L.push(`Nunca fale sobre: ${cf.nao_falar}`);
  if (cf.faq) L.push(`Perguntas frequentes e respostas da empresa:\n${cf.faq}`);
  if (cf.regras_extras?.length) L.push("Regras pedidas pela empresa:\n" + cf.regras_extras.map((x: string) => "- " + x).join("\n"));
  L.push("Use só estas informações. Se não souber algo (preço não informado, disponibilidade exata, assunto fora disto), diga que vai confirmar com a equipe, sem inventar. Não diga que é uma IA, a não ser que perguntem diretamente; nesse caso diga que é o assistente virtual da empresa. Isto é um ambiente de teste: quando marcar um horário ou anotar um pedido, confirme normalmente como se fosse de verdade.");
  return L.join("\n\n");
}

/* ---------- contrato ---------- */
const FUNCOES: Record<string, string> = {
  "Essencial": "atendimento 24 horas no WhatsApp, entende áudio e foto, tira dúvidas de preços e horários, follow-up automático de quem perguntou e não fechou, chama a equipe quando precisa e CRM com os clientes e as conversas",
  "Profissional": "tudo do Essencial, mais agenda própria (o agente marca, remarca e cancela os horários), lembrete do horário na véspera e no dia, mensagem de parabéns no aniversário do cliente, 1 (uma) campanha da promoção do mês para os clientes e CRM completo do ramo",
  "Sob medida": "tudo do Profissional, mais até 4 (quatro) campanhas por mês e um CRM desenvolvido do zero para a rotina da CONTRATANTE, conforme o que for combinado por escrito",
};
async function contratoDe(impl: any, cad: any) {
  const k = await segredos(["contratada_nome", "contratada_doc", "contratada_endereco"]);
  const metade = Number(impl.valor_implantacao) / 2;
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10).split("-").reverse().join("/");
  const contratante = `${cad.empresa.razao || cad.empresa.nome}${cad.empresa.doc ? ", inscrita no CPF/CNPJ sob o nº " + cad.empresa.doc : ""}${cad.empresa.endereco ? ", com endereço em " + cad.empresa.endereco + (cad.empresa.cidade ? " - " + cad.empresa.cidade : "") : ""}, neste ato representada por ${cad.dono.nome}, CPF nº ${cad.dono.cpf}${cad.dono.email ? ", e-mail " + cad.dono.email : ""}`;
  return `CONTRATO DE PRESTAÇÃO DE SERVIÇOS
Implantação de Agente de Inteligência Artificial para WhatsApp e CRM personalizado

CONTRATADA: ${k.contratada_nome || "Éder Henrique"}, CPF nº ${k.contratada_doc || ""}, com endereço em ${k.contratada_endereco || "Recife/PE"}, que atua sob o nome Connecta AI.

CONTRATANTE: ${contratante}.

As partes acima identificadas celebram este contrato, que se rege pelas cláusulas a seguir.

CLÁUSULA 1 – OBJETO
1.1. A CONTRATADA prestará à CONTRATANTE os serviços do plano ${impl.plano}: configuração e implantação de um agente de inteligência artificial que atende o WhatsApp da CONTRATANTE, com base nas informações fornecidas por ela no cadastro, e o acesso a um CRM de gestão com a marca da CONTRATANTE, conforme o plano contratado.
1.2. O agente responde com as informações cadastradas pela CONTRATANTE (serviços, preços, horários, regras e perguntas frequentes) e encaminha para a equipe da CONTRATANTE os assuntos definidos por ela.
1.3. Funções incluídas no plano ${impl.plano}: ${FUNCOES[impl.plano] || FUNCOES["Profissional"]}.
1.4. As mensagens automáticas para os clientes da CONTRATANTE (lembretes, follow-up, aniversário e campanhas) só vão para contatos que conversaram com a CONTRATANTE ou foram cadastrados por ela, sempre com a opção de sair respondendo SAIR. O conteúdo das campanhas é escrito e aprovado pela CONTRATANTE, que responde por ele.

CLÁUSULA 2 – PRAZO DE IMPLANTAÇÃO
2.1. A implantação será concluída em ${PRAZO}, contados a partir do último destes eventos: assinatura deste contrato, envio completo das informações pela CONTRATANTE e pagamento da primeira parcela da implantação.
2.2. Antes de o agente começar a atender, a CONTRATANTE recebe um link de teste para conversar com o agente e pedir ajustes.

CLÁUSULA 3 – VALORES E PAGAMENTO
3.1. Implantação: ${brl(impl.valor_implantacao)}, pagos em duas partes: ${brl(metade)} (50%) no início da implantação e ${brl(metade)} (50%) na entrega.
3.2. Mensalidade: ${brl(impl.valor_mensal)} por mês. A primeira mensalidade vence 30 (trinta) dias depois que o agente começar a atender no WhatsApp da CONTRATANTE, e as seguintes no mesmo dia dos meses seguintes.
3.3. Os pagamentos serão feitos por Pix ou transferência para a conta indicada pela CONTRATADA.
3.4. O atraso no pagamento da mensalidade por mais de 10 (dez) dias permite à CONTRATADA suspender o agente até a regularização.

CLÁUSULA 4 – OBRIGAÇÕES DA CONTRATADA
4.1. Configurar o agente com as informações fornecidas e fazer os ajustes pedidos durante o período de teste.
4.2. Manter o agente e o CRM funcionando, com suporte para dúvidas e correções durante a vigência do contrato.
4.3. Tratar os dados da CONTRATANTE e dos clientes dela apenas para a prestação deste serviço.

CLÁUSULA 5 – OBRIGAÇÕES DA CONTRATANTE
5.1. Fornecer informações corretas e atualizadas e avisar a CONTRATADA quando preços, horários ou regras mudarem.
5.2. Manter ativo o número de WhatsApp usado pelo agente e cumprir as regras de uso do WhatsApp.
5.3. Efetuar os pagamentos nas datas combinadas.

CLÁUSULA 6 – LIMITES DO SERVIÇO
6.1. O agente responde com base nas informações cadastradas e pode cometer erros; a CONTRATANTE deve acompanhar as conversas e avisar a CONTRATADA para correção.
6.2. A CONTRATADA não responde por bloqueios ou mudanças feitas pelo WhatsApp/Meta, por falta de internet ou por informações incorretas fornecidas pela CONTRATANTE.

CLÁUSULA 7 – PROTEÇÃO DE DADOS
7.1. As partes cumprirão a Lei Geral de Proteção de Dados (Lei nº 13.709/2018). Os dados dos clientes da CONTRATANTE são usados somente para o atendimento e não são vendidos ou repassados a terceiros.

CLÁUSULA 8 – VIGÊNCIA E CANCELAMENTO
8.1. Este contrato vale por prazo indeterminado a partir da assinatura.
8.2. Qualquer das partes pode cancelar com aviso de 30 (trinta) dias, sem multa. Valores de implantação já pagos referentes a etapas concluídas não são devolvidos.

CLÁUSULA 9 – ASSINATURA ELETRÔNICA
9.1. As partes reconhecem a validade da assinatura eletrônica deste contrato (Lei nº 14.063/2020 e MP nº 2.200-2/2001, art. 10, § 2º), registrada com nome, CPF, data, hora e endereço IP do aceite.

CLÁUSULA 10 – FORO
10.1. Fica eleito o foro da comarca de Recife/PE para resolver qualquer questão deste contrato.

Recife/PE, ${hoje}.`;
}

/* ---------- leitura pública pelo código ---------- */
async function porToken(t: unknown) {
  const token = String(t || "");
  if (!/^[0-9a-f]{24}$/.test(token)) return null;
  const { data } = await db.from("prosp_impl").select("*").eq("token", token).maybeSingle();
  return data;
}
async function leadDe(id: string | null) {
  if (!id) return null;
  const { data } = await db.from("prosp_leads").select("*").eq("id", id).maybeSingle();
  return data;
}
function publico(impl: any, lead: any, ajustes: any[] = []) {
  return {
    status: impl.status, plano: impl.plano, valor_implantacao: Number(impl.valor_implantacao), valor_mensal: Number(impl.valor_mensal),
    empresa: impl.cadastro?.empresa?.nome || nomeCurto(lead?.nome || ""), segmento: impl.segmento || lead?.segmento || "",
    cadastro: impl.status === "cadastro" ? impl.cadastro : undefined,
    contrato: ["contrato", "teste", "ativa"].includes(impl.status) ? impl.contrato_texto : undefined,
    assinado_em: impl.assinado_em, assinatura: impl.assinatura ? { nome: impl.assinatura.nome, em: impl.assinatura.em } : null,
    assistente: impl.config?.assistente || "", ajustes: ajustes.map((a) => ({ de: a.de, texto: a.texto, em: a.em, mudancas: a.mudancas || null })),
  };
}

/* ---------- modos ---------- */
async function iniciar(req: Request, b: any) {
  const auth = req.headers.get("Authorization") || "";
  const u = createClient(URL_SB, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: adm } = await u.rpc("sou_admin");
  if (adm !== true) return ok({ error: "Entre como administrador." }, 401);
  const lead = await leadDe(String(b.lead || ""));
  if (!lead) return ok({ error: "Empresa não encontrada." }, 404);
  const plano = ["Essencial", "Profissional", "Sob medida"].includes(b.plano) ? b.plano : "Profissional";
  const vi = Math.max(0, Number(b.valor_implantacao) || 0), vm = Math.max(0, Number(b.valor_mensal) || 0);
  if (!vi || !vm) return ok({ error: "Informe os valores." }, 400);
  const { data: ja } = await db.from("prosp_impl").select("id,token,status").eq("lead_id", lead.id).neq("status", "cancelada").maybeSingle();
  if (ja) return ok({ error: "Esta empresa já tem uma implantação em andamento.", token: ja.token }, 409);
  const token = [...crypto.getRandomValues(new Uint8Array(12))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const { error } = await db.from("prosp_impl").insert({ lead_id: lead.id, token, plano, valor_implantacao: vi, valor_mensal: vm, segmento: lead.segmento || null, cadastro: { empresa: { nome: nomeCurto(lead.nome), endereco: lead.endereco || "", cidade: lead.cidade || "" } } });
  if (error) return ok({ error: error.message }, 500);
  const c = await cfg();
  const link = `${c.base}/cadastro/${token}`;
  const enviado = b.enviar === false ? false : await whatsapp(lead, [
    `Que bom ter vocês com a gente! 🎉 Já comecei a implantação do plano *${plano}*.`,
    `Para eu deixar o agente atendendo do jeito de vocês, preencham este cadastro rapidinho (leva uns 5 minutos, quase tudo é só tocar nas opções):\n${link}`,
    `Assim que vocês enviarem, eu já libero o contrato para assinar aqui mesmo. Se tiver qualquer dúvida no preenchimento, é só me chamar.`,
  ]);
  await historico(lead.id, `🚀 Implantação iniciada (plano ${plano}, ${brl(vi)} + ${brl(vm)}/mês). Link do cadastro enviado.`, { ag_estado: "implantacao", ag_em: new Date().toISOString(), status: "interessada" });
  return ok({ ok: true, token, link, enviado });
}

async function salvar(b: any, finalizar: boolean) {
  const impl = await porToken(b.token);
  if (!impl) return ok({ error: "Link inválido." }, 404);
  if (impl.status !== "cadastro") return ok({ error: "Este cadastro já foi enviado." }, 409);
  if (JSON.stringify(b.cadastro || {}).length > 40000) return ok({ error: "Cadastro grande demais." }, 400);
  const cad = limparCadastro(b.cadastro || {});
  if (!finalizar) {
    await db.from("prosp_impl").update({ cadastro: cad, atualizado_em: new Date().toISOString() }).eq("id", impl.id);
    return ok({ ok: true });
  }
  const falta: string[] = [];
  if (!cad.empresa.nome) falta.push("nome da empresa");
  if (!cad.dono.nome) falta.push("nome do responsável");
  if (dig(cad.dono.cpf).length !== 11) falta.push("CPF do responsável");
  if (dig(cad.dono.whatsapp).length < 10) falta.push("WhatsApp do responsável");
  if (!Object.values(cad.horarios).some((h: any) => h.aberto)) falta.push("horário de funcionamento");
  if (falta.length) return ok({ error: "Falta preencher: " + falta.join(", ") + "." }, 400);
  const contrato = await contratoDe(impl, cad);
  const config = configDe(cad);
  await db.from("prosp_impl").update({ cadastro: cad, cadastro_em: new Date().toISOString(), contrato_texto: contrato, config, status: "contrato", segmento: RAMOS[cad.ramo], atualizado_em: new Date().toISOString() }).eq("id", impl.id);
  const lead = await leadDe(impl.lead_id);
  const c = await cfg();
  if (lead) {
    await whatsapp(lead, [
      `Recebi o cadastro, obrigado! Ficou tudo certinho.`,
      `Aqui está o contrato com o plano, os valores e o prazo de implantação (${PRAZO}). É só ler e assinar pelo celular:\n${c.base}/contrato/${impl.token}`,
    ]);
    await historico(lead.id, "📋 Cadastro da implantação enviado. Contrato liberado para assinar.");
  }
  await avisar(`📋 ${cad.empresa.nome} enviou o cadastro`, "O contrato foi liberado para assinatura.", false, impl.lead_id);
  return ok({ ok: true, status: "contrato" });
}

async function assinar(req: Request, b: any) {
  const impl = await porToken(b.token);
  if (!impl) return ok({ error: "Link inválido." }, 404);
  if (impl.status !== "contrato") return ok({ error: impl.assinado_em ? "Este contrato já foi assinado." : "O contrato ainda não foi liberado." }, 409);
  const nome = s(b.nome, 100), cpf = dig(b.cpf);
  if (!b.aceite) return ok({ error: "Marque que leu e concorda com o contrato." }, 400);
  if (nome.split(/\s+/).length < 2) return ok({ error: "Escreva o nome completo." }, 400);
  if (cpf !== dig(impl.cadastro?.dono?.cpf)) return ok({ error: "O CPF precisa ser o mesmo do responsável informado no cadastro." }, 400);
  const ip = (req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "").split(",")[0].trim();
  const assinatura = { nome, cpf: impl.cadastro.dono.cpf, ip, aparelho: s(req.headers.get("user-agent"), 200), em: new Date().toISOString() };
  const hash = await sha256(impl.contrato_texto || "");
  await db.from("prosp_impl").update({ status: "teste", assinado_em: assinatura.em, assinatura, contrato_hash: hash, atualizado_em: new Date().toISOString() }).eq("id", impl.id);
  await db.from("prosp_impl_ajustes").insert({ impl_id: impl.id, de: "ia", texto: `Oi! Aqui vocês pedem qualquer ajuste no agente: acrescentar um serviço, mudar um preço, um horário ou o jeito de falar. Eu atualizo na hora e vocês já podem testar de novo ao lado.` });
  const lead = await leadDe(impl.lead_id);
  const c = await cfg();
  const empresa = impl.cadastro?.empresa?.nome || nomeCurto(lead?.nome || "");
  if (lead) {
    await whatsapp(lead, [
      `Contrato assinado ✅ Muito obrigado pela confiança!`,
      `Antes de colocar o agente para atender no WhatsApp de vocês, testem ele com as informações que vocês mandaram. Conversem como se fossem um cliente:\n${c.base}/teste/${impl.token}`,
      `Na mesma página tem a área *Pedir ajustes*: é só escrever o que querem acrescentar ou mudar que eu já atualizo. A implantação fica pronta em ${PRAZO}, e daqui para frente o ${c.eder} acompanha tudo com vocês.`,
    ]);
    // cobrança da 1ª parte (50%) com o Pix copia e cola, logo depois destas mensagens
    await posVenda({ modo: "assinou", impl: impl.id });
    await historico(lead.id, `📝 Contrato assinado por ${nome}. Link de teste real enviado. Daqui para frente é com você.`, { ag_estado: "passado", ag_em: new Date().toISOString() });
  }
  await avisar(`📝 ${empresa} assinou o contrato`, `Assinado por ${nome}. O teste real foi enviado para a empresa.`, true, impl.lead_id);
  return ok({ ok: true, status: "teste" });
}

async function conversar(b: any) {
  const impl = await porToken(b.token);
  if (!impl || !["teste", "ativa"].includes(impl.status)) return ok({ error: "O teste ainda não está liberado." }, 404);
  if (!OPENAI) return ok({ error: "A IA ainda não foi configurada." }, 500);
  if (!(await usar(impl.id, "chat", 150))) return ok({ error: "Chegaram ao limite de mensagens de teste de hoje. Amanhã libera de novo." }, 429);
  const msgs = (Array.isArray(b.mensagens) ? b.mensagens : []).slice(-20).filter((m: any) => m && m.texto).map((m: any) => ({ role: m.eu ? "user" : "assistant", content: s(m.texto, 1200) }));
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return ok({ error: "Escreva uma mensagem." }, 400);
  const h = new Date(Date.now() - 3 * 3600e3);
  const sys = promptEmpresa(impl.config || {}) + `\n\nAgora é ${["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"][h.getUTCDay()]}, ${h.toISOString().slice(0, 10).split("-").reverse().join("/")}, ${h.toISOString().slice(11, 16)}.`;
  const j = await chat({ messages: [{ role: "system", content: sys }, ...msgs], temperature: 0.4, max_tokens: 400 });
  const resposta = s(j.choices?.[0]?.message?.content, 1500);
  return ok({ ok: true, partes: resposta.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean).slice(0, 4) });
}

async function ajustar(b: any) {
  const impl = await porToken(b.token);
  if (!impl || !["teste", "ativa"].includes(impl.status)) return ok({ error: "Os ajustes ainda não estão liberados." }, 404);
  const texto = s(b.texto, 1200);
  if (texto.length < 2) return ok({ error: "Escreva o ajuste." }, 400);
  if (!(await usar(impl.id, "ajuste", 60))) return ok({ error: "Chegaram ao limite de ajustes de hoje. Amanhã libera de novo." }, 429);
  await db.from("prosp_impl_ajustes").insert({ impl_id: impl.id, de: "empresa", texto });
  const { data: hist } = await db.from("prosp_impl_ajustes").select("de,texto").eq("impl_id", impl.id).order("em", { ascending: false }).limit(10);
  // a agenda (grade) também pode ser ajustada por aqui: horários, duração, feriados
  const atual: any = { ...(impl.config || {}) };
  if (!atual.grade || typeof atual.grade !== "object") { const { data: g } = await db.rpc("emp_grade_de", { p_cad: impl.cadastro || {} }); if (g) atual.grade = g; }
  const j = await chat({
    temperature: 0, max_tokens: 2500, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `Você ajusta a configuração do agente de atendimento de uma empresa. A empresa escreve o que quer mudar; você aplica a mudança na configuração (JSON) e responde para ela.
Regras:
- Mude só o que foi pedido. Mantenha todos os outros campos exatamente iguais.
- Campos: empresa, ramo, descricao, endereco, instagram, assistente (nome do atendente), tom ("formal" | "proximo" | "descontraido"), emojis (true/false), horarios (texto), fora_horario (texto), servicos (lista de {nome, preco, obs}), pagamentos (lista), parcela, agenda (texto), especificas (lista de textos), chamar (lista de situações em que chama a equipe), nao_falar, faq (texto com perguntas e respostas), regras_extras (lista de regras pedidas), grade (a agenda que o agente usa para marcar: {dias: {seg|ter|qua|qui|sex|sab|dom: {aberto, abre "HH:MM", fecha "HH:MM"}}, dur: minutos de cada atendimento, antec_h: antecedência mínima em horas, vagas: atendimentos ao mesmo tempo, almoco: {ini, fim} opcional, bloqueios: lista de datas "AAAA-MM-DD" sem atendimento}).
- Quando mudar horário de funcionamento, feriado, folga ou duração do atendimento, atualize o texto de horarios E a grade.
- Pedidos de comportamento ("fale mais curto", "sempre ofereça a avaliação") viram itens em regras_extras.
- Se o pedido for algo que a configuração não resolve (integração com outro sistema, mudar número de WhatsApp, cobrança, contrato), não mude nada, diga com gentileza que o Éder vai ver isso pessoalmente e marque para_eder = true.
- Se o pedido estiver confuso, não mude nada e pergunte o que a empresa quis dizer.
- resposta: em português, curta e simpática, dizendo exatamente o que mudou e convidando a testar de novo${impl.otica_id ? " (o agente já está atendendo no WhatsApp: diga que a mudança já vale para os clientes)" : ""}. Escreva como a equipe da Connecta.
Responda só JSON: {"config": {...configuração completa...}, "mudancas": ["frase curta por mudança"], "resposta": "...", "para_eder": false}` },
      { role: "user", content: `Configuração atual:\n${JSON.stringify(atual)}\n\nConversa recente de ajustes (mais nova primeiro):\n${(hist || []).map((x: any) => x.de + ": " + x.texto).join("\n")}\n\nPedido novo da empresa: ${texto}` },
    ],
  });
  let o: any = {};
  try { o = JSON.parse(j.choices?.[0]?.message?.content || "{}"); } catch { o = {}; }
  const mudancas = Array.isArray(o.mudancas) ? o.mudancas.slice(0, 10).map((x: any) => s(x, 200)).filter(Boolean) : [];
  let resposta = s(o.resposta, 800) || "Anotei! Vou conferir e já te retorno.";
  const novo = o.config && typeof o.config === "object" && !Array.isArray(o.config) && o.config.empresa ? o.config : null;
  if (novo && mudancas.length && !o.para_eder) {
    await db.from("prosp_impl").update({ config: novo, atualizado_em: new Date().toISOString() }).eq("id", impl.id);
    // agente já ligado no WhatsApp da empresa: o ajuste vale na hora para os clientes também
    if (impl.otica_id) {
      const { data: ag } = await db.from("agente_config").select("cfg").eq("otica_id", impl.otica_id).maybeSingle();
      if (ag) await db.from("agente_config").update({ cfg: { ...(ag.cfg || {}), tipo: "empresa", empresa: novo }, atualizado_em: new Date().toISOString() }).eq("otica_id", impl.otica_id);
    }
  } else if (!o.para_eder && mudancas.length && !novo) {
    resposta = "Não consegui aplicar esse ajuste agora. Pode escrever de outro jeito?";
  }
  await db.from("prosp_impl_ajustes").insert({ impl_id: impl.id, de: "ia", texto: resposta, mudancas: { itens: novo && !o.para_eder ? mudancas : [], para_eder: !!o.para_eder } });
  if (o.para_eder) await avisar(`🛠️ ${impl.cadastro?.empresa?.nome || "Uma empresa"} pediu algo para você ver`, s(texto, 200), true, impl.lead_id);
  return ok({ ok: true, resposta, mudancas: novo && !o.para_eder ? mudancas : [], para_eder: !!o.para_eder });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json().catch(() => ({}));
    switch (b.modo) {
      case "iniciar": return await iniciar(req, b);
      case "ler": {
        const impl = await porToken(b.token);
        if (!impl || impl.status === "cancelada") return ok({ error: "Link inválido." }, 404);
        const [lead, aj] = await Promise.all([leadDe(impl.lead_id), ["teste", "ativa"].includes(impl.status) ? db.from("prosp_impl_ajustes").select("de,texto,em,mudancas").eq("impl_id", impl.id).order("em").limit(200) : Promise.resolve({ data: [] })]);
        return ok({ ok: true, ...publico(impl, lead, (aj as any).data || []) });
      }
      case "salvar": return await salvar(b, false);
      case "enviar": return await salvar(b, true);
      case "assinar": return await assinar(req, b);
      case "chat": return await conversar(b);
      case "ajuste": return await ajustar(b);
      default: return ok({ error: "modo" }, 400);
    }
  } catch (e: any) {
    console.error("implantacao", e.message);
    return ok({ error: "Não deu certo agora. Tente de novo em instantes." }, 500);
  }
});
