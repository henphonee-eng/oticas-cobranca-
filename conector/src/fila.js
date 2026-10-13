'use strict';
// Conversa com o sistema (Supabase) e controla o ritmo dos envios.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => Math.floor(a + Math.random() * (b - a + 1));

function criarApi(cfg, fetchFn) {
  const f = fetchFn || fetch;
  async function rpc(nome, corpo) {
    const r = await f(cfg.supabaseUrl + '/rest/v1/rpc/' + nome, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.supabaseKey, Authorization: 'Bearer ' + cfg.supabaseKey },
      body: JSON.stringify(corpo),
    });
    if (!r.ok) throw new Error('Sistema respondeu ' + r.status);
    return r.json();
  }
  // modo "prospeccao": o mesmo programa, ligado ao chip do CRM de prospecção (outras funções do sistema)
  if (cfg.modo === 'prospeccao') {
    return {
      puxar: () => rpc('prosp_wa_puxar', { p_token: cfg.token }),
      resultado: (id, ok, erro) => rpc('prosp_wa_resultado', { p_token: cfg.token, p_id: id, p_ok: ok, p_erro: erro || null }),
      ping: (estado, numero) => rpc('prosp_wa_ping', { p_token: cfg.token, p_estado: estado, p_numero: numero || null }),
      sair: (telefone) => rpc('prosp_wa_sair', { p_token: cfg.token, p_telefone: telefone }),
      receber: (telefone, texto, nome) => rpc('prosp_wa_receber', { p_token: cfg.token, p_telefone: telefone, p_texto: texto, p_nome: nome || null }),
      registrar: async () => ({ ok: true }),
    };
  }
  return {
    puxar: () => rpc('wa_puxar', { p_token: cfg.token }),
    puxarManual: () => rpc('wa_puxar_manual', { p_token: cfg.token }),
    // guarda a mensagem na conversa do sistema (WhatsApp dentro do sistema, função Premium)
    registrar: (m) => rpc('wa_registrar', { p_token: cfg.token, p_tel: m.telefone, p_nome: m.nome || null, p_de_mim: !!m.deMim, p_texto: m.texto, p_tipo: m.tipo || 'texto', p_wa_id: m.waId || null, p_origem: m.origem || null }),
    resultado: (id, ok, erro) => rpc('wa_resultado', { p_token: cfg.token, p_id: id, p_ok: ok, p_erro: erro || null }),
    ping: (estado, numero) => rpc('wa_ping', { p_token: cfg.token, p_estado: estado, p_numero: numero || null }),
    sair: (telefone) => rpc('wa_sair', { p_token: cfg.token, p_telefone: telefone }),
    receber: (telefone, texto, nome) => rpc('wa_receber', { p_token: cfg.token, p_telefone: telefone, p_texto: texto, p_nome: nome || null }),
  };
}

// "wa" = { conectado(): bool, existe(tel): Promise<bool>, enviar(tel, texto, tipo): Promise<void> }
// Avisos automáticos saem devagar (digitando + pausa). Mensagens da conversa (tipo "manual",
// escritas pela equipe no sistema) saem na hora, inclusive durante a pausa dos automáticos.
function criarRobo(api, wa, log, opc) {
  const o = Object.assign({ intervaloBusca: 5000, pausaMin: 30000, pausaMax: 90000, digitarMin: 3000, digitarMax: 9000, manualMin: 500, manualMax: 1500 }, opc || {});
  let parar = false;
  let ultimoMotivo = '';

  async function enviarUma(m) {
    const manual = m.tipo === 'manual';
    try {
      if (!(await wa.existe(m.telefone))) { await api.resultado(m.id, false, 'sem_whatsapp'); log('Número sem WhatsApp: ' + m.telefone); return 'sem_whatsapp'; }
      await sleep(manual ? rand(o.manualMin, o.manualMax) : rand(o.digitarMin, o.digitarMax));
      await wa.enviar(m.telefone, m.texto, m.tipo);
      await api.resultado(m.id, true);
      log((manual ? 'Mensagem da conversa enviada para ' : 'Enviada para ') + m.telefone);
      return 'enviada';
    } catch (e) {
      await api.resultado(m.id, false, String(e.message || e).slice(0, 150)).catch(() => {});
      log('Falha ao enviar: ' + (e.message || e));
      return 'falhou';
    }
  }

  // pausa entre avisos automáticos, olhando a cada poucos segundos se a equipe mandou mensagem
  async function pausa(ms) {
    const fim = Date.now() + ms;
    while (!parar && Date.now() < fim) {
      await sleep(Math.min(o.intervaloBusca, Math.max(0, fim - Date.now())));
      if (!wa.conectado() || !api.puxarManual) continue;
      try { const r = await api.puxarManual(); if (r && r.msg) await enviarUma(r.msg); } catch (e) { /* tenta de novo na próxima volta */ }
    }
  }

  async function umaVez() {
    if (!wa.conectado()) return 'desconectado';
    const r = await api.puxar();
    if (!r || r.ok === false) {
      if (r && r.erro === 'token_invalido') { try { require('fs').unlinkSync(require('path').join(__dirname, '..', 'config.json')); } catch (e) { /* ignora */ } throw Object.assign(new Error('Código inválido. O arquivo config.json foi apagado. Gere um código novo no sistema e abra o iniciar.bat de novo.'), { fatal: true }); }
      return 'erro';
    }
    if (!r.msg) { ultimoMotivo = r.motivo || ''; return 'vazio'; }
    const m = r.msg;
    const res = await enviarUma(m);
    if (res === 'enviada' && m.tipo !== 'manual') await pausa(rand(o.pausaMin, o.pausaMax));
    return res;
  }

  async function rodar() {
    while (!parar) {
      let r = 'erro';
      try { r = await umaVez(); } catch (e) { if (e.fatal) { log(e.message); parar = true; return; } log('Aguardando conexão com o sistema...'); }
      if (r !== 'enviada') await sleep(o.intervaloBusca);
    }
  }
  return { umaVez, rodar, parar: () => { parar = true; }, motivo: () => ultimoMotivo };
}

module.exports = { criarApi, criarRobo };
