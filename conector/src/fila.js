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
  return {
    puxar: () => rpc('wa_puxar', { p_token: cfg.token }),
    resultado: (id, ok, erro) => rpc('wa_resultado', { p_token: cfg.token, p_id: id, p_ok: ok, p_erro: erro || null }),
    ping: (estado, numero) => rpc('wa_ping', { p_token: cfg.token, p_estado: estado, p_numero: numero || null }),
    sair: (telefone) => rpc('wa_sair', { p_token: cfg.token, p_telefone: telefone }),
  };
}

// "wa" = { conectado(): bool, existe(tel): Promise<bool>, enviar(tel, texto): Promise<void> }
function criarRobo(api, wa, log, opc) {
  const o = Object.assign({ intervaloBusca: 15000, pausaMin: 30000, pausaMax: 90000, digitarMin: 3000, digitarMax: 9000 }, opc || {});
  let parar = false;
  let ultimoMotivo = '';

  async function umaVez() {
    if (!wa.conectado()) return 'desconectado';
    const r = await api.puxar();
    if (!r || r.ok === false) {
      if (r && r.erro === 'token_invalido') throw Object.assign(new Error('Código inválido. Gere um novo no sistema (Ajustes > WhatsApp automático).'), { fatal: true });
      return 'erro';
    }
    if (!r.msg) { ultimoMotivo = r.motivo || ''; return 'vazio'; }
    const m = r.msg;
    try {
      if (!(await wa.existe(m.telefone))) { await api.resultado(m.id, false, 'sem_whatsapp'); log('Número sem WhatsApp: ' + m.telefone); return 'sem_whatsapp'; }
      await sleep(rand(o.digitarMin, o.digitarMax));
      await wa.enviar(m.telefone, m.texto);
      await api.resultado(m.id, true);
      log('Enviada para ' + m.telefone);
      await sleep(rand(o.pausaMin, o.pausaMax));
      return 'enviada';
    } catch (e) {
      await api.resultado(m.id, false, String(e.message || e).slice(0, 150));
      log('Falha ao enviar: ' + (e.message || e));
      return 'falhou';
    }
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
