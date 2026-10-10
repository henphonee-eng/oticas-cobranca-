'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { criarApi, criarRobo } = require('./fila');

const RAIZ = path.join(__dirname, '..');
const ARQ_CFG = path.join(RAIZ, 'config.json');
const PASTA_SESSAO = path.join(RAIZ, 'sessao');
const PORTA = 3939;

function log(t) {
  const linha = '[' + new Date().toLocaleString('pt-BR') + '] ' + t;
  console.log(linha);
  try { fs.appendFileSync(path.join(RAIZ, 'conector.log'), linha + '\n'); } catch (e) { /* ignora */ }
}
const perguntar = (q) => new Promise((res) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (a) => { rl.close(); res(a.trim()); }); });

async function lerConfig() {
  let cfg = {};
  if (fs.existsSync(ARQ_CFG)) cfg = JSON.parse(fs.readFileSync(ARQ_CFG, 'utf8'));
  else cfg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config.exemplo.json'), 'utf8'));
  cfg.token = String(cfg.token || '').replace(/\s+/g, '');
  while (!/^wa_[0-9a-f]{48}$/.test(cfg.token)) {
    if (cfg.token) console.log('O código está incompleto ou errado (precisa ter 51 caracteres e começar com wa_). Copie de novo, inteiro.');
    cfg.token = (await perguntar('Cole aqui o código do conector (gerado no sistema, no menu WhatsApp automático): ')).replace(/\s+/g, '');
    if (/^wa_[0-9a-f]{48}$/.test(cfg.token)) fs.writeFileSync(ARQ_CFG, JSON.stringify(cfg, null, 2));
  }
  return cfg;
}

const estado = { estado: 'desconectado', qr: '', numero: '', msg: 'Iniciando...' };

function paginaLocal() {
  const QRCode = require('qrcode');
  http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    let img = '';
    if (estado.estado === 'qr' && estado.qr) img = '<img alt="QR Code" width="280" height="280" src="' + (await QRCode.toDataURL(estado.qr, { width: 280, margin: 1 })) + '">';
    res.end('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conector WhatsApp</title><body style="font-family:system-ui;max-width:420px;margin:40px auto;padding:0 16px"><h2>Conector WhatsApp da ótica</h2><p><b>' +
      (estado.estado === 'conectado' ? 'Conectado' + (estado.numero ? ' no número ' + estado.numero : '') : estado.estado === 'qr' ? 'Leia o QR Code com o WhatsApp da ótica' : 'Desconectado') + '</b></p>' + img +
      (estado.estado === 'qr' ? '<p>No celular: WhatsApp > Configurações > Aparelhos conectados > Conectar um aparelho.</p>' : '') + '<p style="color:#666">' + estado.msg + '</p></body>');
  }).listen(PORTA, '127.0.0.1', () => log('Painel local: http://localhost:' + PORTA));
}

async function main() {
  const cfg = await lerConfig();
  const api = criarApi(cfg);
  paginaLocal();
  const baileys = require('@whiskeysockets/baileys');
  const makeWASocket = baileys.default || baileys.makeWASocket;
  const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;
  const pino = require('pino');
  let sock = null;
  let aberto = false;

  async function conectar() {
    const { state, saveCreds } = await useMultiFileAuthState(PASTA_SESSAO);
    let version;
    try { version = (await fetchLatestBaileysVersion()).version; } catch (e) { /* usa a padrão */ }
    sock = makeWASocket({ auth: state, version, logger: pino({ level: 'silent' }), browser: ['Otica', 'Chrome', '1.0'], markOnlineOnConnect: false, syncFullHistory: false });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (u) => {
      if (u.qr) { estado.estado = 'qr'; estado.qr = u.qr; estado.msg = 'Aguardando a leitura do QR Code.'; api.ping('qr').catch(() => {}); log('QR Code pronto: abra http://localhost:' + PORTA); }
      if (u.connection === 'open') {
        aberto = true; estado.estado = 'conectado'; estado.qr = '';
        estado.numero = String((sock.user && sock.user.id) || '').split(':')[0].split('@')[0];
        estado.msg = 'Tudo certo. Pode deixar esta janela minimizada.';
        log('WhatsApp conectado: ' + estado.numero);
        api.ping('conectado', estado.numero).catch(() => {});
      }
      if (u.connection === 'close') {
        aberto = false; estado.estado = 'desconectado';
        const codigo = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
        api.ping('desconectado').catch(() => {});
        if (codigo === DisconnectReason.loggedOut) {
          log('O WhatsApp foi desconectado pelo celular. Apagando a sessão e pedindo novo QR Code.');
          try { fs.rmSync(PASTA_SESSAO, { recursive: true, force: true }); } catch (e) { /* ignora */ }
        } else log('Conexão caiu (' + codigo + '). Tentando de novo em 8 segundos.');
        setTimeout(() => conectar().catch((e) => log('Erro: ' + e.message)), 8000);
      }
    });
    // Quem responder SAIR deixa de receber avisos
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        try {
          if (!m.message || m.key.fromMe || String(m.key.remoteJid || '').endsWith('@g.us')) continue;
          const txt = ((m.message.conversation || (m.message.extendedTextMessage && m.message.extendedTextMessage.text)) || '').trim();
          if (!/^(sair|parar|cancelar|remover)[.! ]*$/i.test(txt)) continue;
          const jid = m.key.remoteJidAlt || m.key.senderPn || m.key.remoteJid || '';
          const tel = String(jid).split('@')[0].replace(/\D/g, '');
          if (!tel) continue;
          await api.sair(tel);
          log('Pediu para sair: ' + tel);
          await sock.sendMessage(m.key.remoteJid, { text: 'Tudo certo, você não vai mais receber avisos por aqui.' });
        } catch (e) { log('Erro ao tratar SAIR: ' + e.message); }
      }
    });
  }

  const jids = {};
  const wa = {
    conectado: () => aberto,
    // usa o endereço que o próprio WhatsApp devolve (resolve o 9 a mais ou a menos nos números do Brasil)
    existe: async (tel) => { const r = await sock.onWhatsApp(tel + '@s.whatsapp.net'); const ok = !!(r && r[0] && r[0].exists); if (ok) jids[tel] = r[0].jid; return ok; },
    enviar: async (tel, texto) => {
      const jid = jids[tel] || (tel + '@s.whatsapp.net');
      try { await sock.presenceSubscribe(jid); await sock.sendPresenceUpdate('composing', jid); } catch (e) { /* ignora */ }
      const r = await sock.sendMessage(jid, { text: texto });
      log('Entregue ao WhatsApp: ' + jid + ' (id ' + ((r && r.key && r.key.id) || '?') + ')');
      try { await sock.sendPresenceUpdate('paused', jid); } catch (e) { /* ignora */ }
    },
  };
  await conectar();
  setInterval(() => { if (aberto) api.ping('conectado', estado.numero).catch(() => {}); }, 60000);
  const robo = criarRobo(api, wa, log);
  await robo.rodar();
  log('Encerrado. Feche esta janela e gere um novo código no sistema.');
}

main().catch((e) => { console.error(e); setTimeout(() => process.exit(1), 15000); });
