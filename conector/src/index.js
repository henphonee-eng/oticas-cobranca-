'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { criarApi, criarRobo } = require('./fila');

const RAIZ = path.join(__dirname, '..');
const ARQ_CFG = path.join(RAIZ, 'config.json');
// Modo nuvem: o servidor (src/servidor.js) passa tudo por variáveis de ambiente, sem config.json nem painel local.
const NUVEM = process.env.CONECTOR_NUVEM === '1';
const PASTA_SESSAO = process.env.CONECTOR_SESSAO || path.join(RAIZ, 'sessao');
let PORTA = 3939;

function log(t) {
  const linha = '[' + new Date().toLocaleString('pt-BR') + '] ' + (NUVEM ? '[' + (process.env.CONECTOR_NOME || process.env.CONECTOR_ID || '') + '] ' : '') + t;
  console.log(linha);
  if (!NUVEM) { try { fs.appendFileSync(path.join(RAIZ, 'conector.log'), linha + '\n'); } catch (e) { /* ignora */ } }
}
// Conteúdo de uma mensagem do WhatsApp em texto simples (fotos, áudios etc. viram uma descrição curta).
function conteudo(msg) {
  let m = msg;
  for (let i = 0; i < 4 && m; i++) {
    const w = m.ephemeralMessage || m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension || m.documentWithCaptionMessage;
    if (w && w.message) m = w.message; else break;
  }
  if (!m) return null;
  const leg = (x) => (x && x.caption ? ': ' + x.caption : '');
  if (m.conversation) return { tipo: 'texto', texto: m.conversation };
  if (m.extendedTextMessage && m.extendedTextMessage.text) return { tipo: 'texto', texto: m.extendedTextMessage.text };
  if (m.imageMessage) return { tipo: 'foto', texto: '📷 Foto' + leg(m.imageMessage) };
  if (m.videoMessage) return { tipo: 'video', texto: '🎬 Vídeo' + leg(m.videoMessage) };
  if (m.audioMessage) return { tipo: 'audio', texto: '🎤 Áudio' };
  if (m.documentMessage) return { tipo: 'documento', texto: '📄 Documento' + (m.documentMessage.fileName ? ': ' + m.documentMessage.fileName : '') + leg(m.documentMessage) };
  if (m.stickerMessage) return { tipo: 'figurinha', texto: '🙂 Figurinha' };
  if (m.contactMessage) return { tipo: 'outro', texto: '👤 Contato: ' + (m.contactMessage.displayName || '') };
  if (m.locationMessage || m.liveLocationMessage) return { tipo: 'outro', texto: '📍 Localização' };
  return null; // reações, edições, avisos do sistema etc.
}
// Número (só dígitos) de uma conversa privada, ou '' se for grupo, status, canal ou não der para saber.
function numeroDaConversa(key) {
  const rj = String(key.remoteJid || '');
  if (!rj || rj.endsWith('@g.us') || rj === 'status@broadcast' || rj.endsWith('@broadcast') || rj.endsWith('@newsletter')) return '';
  const jid = rj.endsWith('@s.whatsapp.net') ? rj : String(key.remoteJidAlt || key.senderPn || '');
  if (!jid.endsWith('@s.whatsapp.net')) return '';
  return jid.split('@')[0].split(':')[0].replace(/\D/g, '');
}

const perguntar = (q) => new Promise((res) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (a) => { rl.close(); res(a.trim()); }); });

async function lerConfig() {
  if (NUVEM) {
    const ex = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config.exemplo.json'), 'utf8'));
    return { supabaseUrl: process.env.SUPABASE_URL || ex.supabaseUrl, supabaseKey: process.env.SUPABASE_KEY || ex.supabaseKey,
      token: String(process.env.CONECTOR_TOKEN || ''), modo: process.env.CONECTOR_MODO || '' };
  }
  let cfg = {};
  if (fs.existsSync(ARQ_CFG)) cfg = JSON.parse(fs.readFileSync(ARQ_CFG, 'utf8'));
  else cfg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config.exemplo.json'), 'utf8'));
  cfg.token = String(cfg.token || '').replace(/\s+/g, '');
  while (!/^wa_[0-9a-f]{48}$/.test(cfg.token)) {
    if (cfg.token) console.log('O código está incompleto ou errado (precisa ter 51 caracteres e começar com wa_). Copie de novo, inteiro.');
    cfg.token = (await perguntar('Cole aqui o código do conector (gerado no sistema, no menu WhatsApp automático): ')).replace(/\s+/g, '');
    if (/^wa_[0-9a-f]{48}$/.test(cfg.token)) fs.writeFileSync(ARQ_CFG, JSON.stringify(cfg, null, 2));
  }
  if (Number(cfg.porta) > 1024 && Number(cfg.porta) < 65535) PORTA = Number(cfg.porta);
  else if (cfg.modo === 'prospeccao') PORTA = 3940;
  return cfg;
}

let MODO = '';
const estado = { estado: 'desconectado', qr: '', numero: '', msg: 'Iniciando...' };

function paginaLocal() {
  const QRCode = require('qrcode');
  http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    let img = '';
    if (estado.estado === 'qr' && estado.qr) img = '<img alt="QR Code" width="280" height="280" src="' + (await QRCode.toDataURL(estado.qr, { width: 280, margin: 1 })) + '">';
    res.end('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conector WhatsApp</title><body style="font-family:system-ui;max-width:420px;margin:40px auto;padding:0 16px"><h2>' + (MODO === 'prospeccao' ? 'Conector WhatsApp da prospecção (CRM)' : 'Conector WhatsApp da ótica') + '</h2><p><b>' +
      (estado.estado === 'conectado' ? 'Conectado' + (estado.numero ? ' no número ' + estado.numero : '') : estado.estado === 'qr' ? 'Leia o QR Code com o WhatsApp da ótica' : 'Desconectado') + '</b></p>' + img +
      (estado.estado === 'qr' ? '<p>No celular: WhatsApp > Configurações > Aparelhos conectados > Conectar um aparelho.</p>' : '') + '<p style="color:#666">' + estado.msg + '</p></body>');
  }).listen(PORTA, '127.0.0.1', () => log('Painel local: http://localhost:' + PORTA));
}

async function main() {
  const cfg = await lerConfig();
  MODO = cfg.modo || '';
  if (MODO === 'prospeccao') log('Modo prospecção (CRM): mensagens do chip de prospecção.');
  const api = criarApi(cfg);
  if (!NUVEM) paginaLocal();
  // A biblioteca do WhatsApp (Baileys 7) é um módulo ESM, então é carregada com import().
  let baileys;
  try { baileys = await import('@whiskeysockets/baileys'); }
  catch (e) { log('Não consegui carregar a biblioteca do WhatsApp (' + e.message + '). Confira se o Node.js é a versão 20 ou mais nova e rode o instalar.bat de novo.'); throw e; }
  const makeWASocket = typeof baileys.default === 'function' ? baileys.default : (baileys.makeWASocket || (baileys.default && baileys.default.default));
  const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = baileys;
  try { log('Biblioteca do WhatsApp: ' + JSON.parse(fs.readFileSync(path.join(RAIZ, 'node_modules', '@whiskeysockets', 'baileys', 'package.json'), 'utf8')).version + ' · Node ' + process.versions.node); } catch (e) { /* ignora */ }
  const pino = require('pino');
  const logger = pino({ level: 'silent' });
  let sock = null;
  // Guarda as últimas mensagens enviadas. Quando o celular de quem recebe não consegue abrir
  // a mensagem de primeira ("Aguardando mensagem"), ele pede para reenviar e o WhatsApp
  // busca a mensagem aqui. Sem isso ela fica presa para sempre.
  const enviadas = new Map();
  function guardar(r) {
    if (!r || !r.key || !r.key.id || !r.message) return;
    enviadas.set(r.key.id, r.message);
    if (enviadas.size > 1000) enviadas.delete(enviadas.keys().next().value);
  }
  let aberto = false;
  // ids das mensagens que o próprio conector enviou (já guardadas na conversa com a origem certa)
  const saindo = new Set();
  const marcarSaindo = (id) => { if (!id) return; saindo.add(id); if (saindo.size > 500) saindo.delete(saindo.values().next().value); };

  async function conectar() {
    const { state, saveCreds } = await useMultiFileAuthState(PASTA_SESSAO);
    let version;
    try { version = (await fetchLatestBaileysVersion()).version; } catch (e) { /* usa a padrão */ }
    const auth = makeCacheableSignalKeyStore ? { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) } : state;
    sock = makeWASocket({ auth, version, logger, browser: ['Otica', 'Chrome', '1.0'], markOnlineOnConnect: false, syncFullHistory: false, getMessage: async (key) => enviadas.get(key.id) });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (u) => {
      if (u.qr) { estado.estado = 'qr'; estado.qr = u.qr; estado.msg = 'Aguardando a leitura do QR Code.'; api.ping('qr').catch(() => {});
        if (NUVEM) {
          // o QR vai para o sistema, que mostra a imagem no menu do WhatsApp
          require('qrcode').toDataURL(u.qr, { width: 300, margin: 1 }).then((img) => api.qr(img)).catch((e) => log('Não consegui mandar o QR Code: ' + e.message));
          log('QR Code enviado para o sistema.');
        } else log('QR Code pronto: abra http://localhost:' + PORTA); }
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
    // Mensagens recebidas: SAIR tira o número dos avisos; o resto vai para o sistema,
    // que confirma/cancela/remarca o exame ou avisa os donos (e, se ligado, chama o agente de IA).
    // Toda conversa privada (recebida ou enviada pelo celular) também é guardada no sistema,
    // para a equipe ver e responder pela aba Conversas (função Premium; sem ela o sistema ignora).
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const m of messages) {
        try {
          if (!m.message || !m.key) continue;
          const ts = Number(m.messageTimestamp || 0) * 1000;
          if (type !== 'notify' && (!ts || Date.now() - ts > 15 * 60000)) continue; // histórico antigo: ignora
          const tel = numeroDaConversa(m.key);
          const c = tel ? conteudo(m.message) : null;
          if (c && !(m.key.fromMe && saindo.has(m.key.id))) {
            api.registrar({ telefone: tel, nome: m.key.fromMe ? '' : m.pushName, deMim: !!m.key.fromMe, texto: c.texto, tipo: c.tipo, waId: m.key.id, origem: m.key.fromMe ? 'celular' : 'cliente' })
              .catch((e) => log('Não consegui guardar a conversa: ' + e.message));
          }
        } catch (e) { log('Erro ao guardar mensagem: ' + e.message); }
      }
      if (type !== 'notify') return;
      for (const m of messages) {
        try {
          if (!m.message || m.key.fromMe || String(m.key.remoteJid || '').endsWith('@g.us') || String(m.key.remoteJid || '') === 'status@broadcast') continue;
          const txt = ((m.message.conversation || (m.message.extendedTextMessage && m.message.extendedTextMessage.text)) || '').trim();
          if (!txt) { await midiaRecebida(m); continue; }
          const jid = m.key.remoteJidAlt || m.key.senderPn || m.key.remoteJid || '';
          const tel = String(jid).split('@')[0].replace(/\D/g, '');
          if (!tel) continue;
          if (/^(sair|parar|remover)[.! ]*$/i.test(txt)) {
            await api.sair(tel);
            log('Pediu para sair: ' + tel);
            guardar(await sock.sendMessage(m.key.remoteJid, { text: MODO === 'prospeccao' ? 'Tudo certo, não vou mais mandar mensagens por aqui. Obrigado!' : 'Tudo certo, você não vai mais receber avisos por aqui.' }));
            continue;
          }
          const r = await api.receber(tel, txt, m.pushName);
          if (r && r.acao) log('Resposta de ' + tel + ' tratada pelo sistema: ' + r.acao);
        } catch (e) { log('Erro ao tratar mensagem recebida: ' + e.message); }
      }
    });
  }

  // O WhatsApp pode ter o número com ou sem o 9 (ex.: 5581987658981 x 558187658981).
  // Mandar para o formato errado faz a mensagem ser aceita e nunca chegar, então usamos
  // o endereço exato que o WhatsApp devolve e, se ele não achar, tentamos o outro formato.
  const jids = {};
  async function acharJid(tel) {
    if (jids[tel]) return jids[tel];
    const formatos = [tel];
    if (/^55\d{2}9\d{8}$/.test(tel)) formatos.push(tel.slice(0, 4) + tel.slice(5)); // sem o 9
    else if (/^55\d{2}[6-9]\d{7}$/.test(tel)) formatos.push(tel.slice(0, 4) + '9' + tel.slice(4)); // com o 9
    for (const t of formatos) {
      const r = await sock.onWhatsApp(t + '@s.whatsapp.net');
      const achado = r && r.find((x) => x && x.exists);
      if (achado) { jids[tel] = achado.jid || (t + '@s.whatsapp.net'); return jids[tel]; }
    }
    return null;
  }
  // Áudio e foto que o cliente manda: se o Agente de IA estiver ligado, vão para o sistema virar texto.
  let agenteOffAte = 0;
  async function midiaRecebida(m) {
    if (MODO === 'prospeccao' || !api.midia || Date.now() < agenteOffAte) return;
    let x = m.message;
    for (let i = 0; i < 4 && x; i++) {
      const w = x.ephemeralMessage || x.viewOnceMessage || x.viewOnceMessageV2 || x.viewOnceMessageV2Extension;
      if (w && w.message) x = w.message; else break;
    }
    if (!x) return;
    const au = x.audioMessage, im = x.imageMessage;
    if (!au && !im) return;
    if (au && Number(au.seconds || 0) > 300) return;
    if (im && Number(im.fileLength || 0) > 6 * 1024 * 1024) return;
    const tel = numeroDaConversa(m.key);
    if (!tel) return;
    try {
      const buf = await baileys.downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      const r = await api.midia({ telefone: tel, nome: m.pushName || '', tipo: au ? 'audio' : 'imagem', mime: (au || im).mimetype || '', legenda: (im && im.caption) || '', waId: m.key.id, base64: Buffer.from(buf).toString('base64') });
      if (r && r.off) agenteOffAte = Date.now() + 10 * 60000; // agente desligado: não baixa mídia por 10 minutos
      else log((au ? 'Áudio' : 'Foto') + ' de ' + tel + ' enviado ao Agente de IA');
    } catch (e) { log('Não consegui ler a mídia recebida: ' + e.message); }
  }
  const wa = {
    conectado: () => aberto,
    existe: async (tel) => !!(await acharJid(tel)),
    enviar: async (tel, texto, tipo, midia) => {
      const jid = (await acharJid(tel)) || (tel + '@s.whatsapp.net');
      const manual = tipo === 'manual';
      if (!manual) { try { await sock.presenceSubscribe(jid); await sock.sendPresenceUpdate('composing', jid); } catch (e) { /* ignora */ } }
      // o id é criado aqui para o eco da própria mensagem não ser guardado como "enviada pelo celular"
      const id = baileys.generateMessageIDV2 ? baileys.generateMessageIDV2(sock.user && sock.user.id) : (baileys.generateMessageID ? baileys.generateMessageID() : undefined);
      marcarSaindo(id);
      const conteudoMsg = midia ? { image: { url: midia }, caption: texto || undefined } : { text: texto };
      const r = await sock.sendMessage(jid, conteudoMsg, id ? { messageId: id } : undefined);
      guardar(r);
      const wid = (r && r.key && r.key.id) || id;
      marcarSaindo(wid);
      log('Entregue ao WhatsApp: ' + jid + ' (id ' + (wid || '?') + ')');
      if (!manual) { try { await sock.sendPresenceUpdate('paused', jid); } catch (e) { /* ignora */ } }
      api.registrar({ telefone: tel, deMim: true, texto: midia ? '📷 Foto' + (texto ? ': ' + texto : '') : texto, tipo: midia ? 'foto' : 'texto', waId: wid, origem: manual ? 'sistema' : 'automatico' })
        .catch((e) => log('Não consegui guardar a conversa: ' + e.message));
    },
  };
  await conectar();
  setInterval(() => { if (aberto) api.ping('conectado', estado.numero).catch(() => {}); }, 60000);
  const robo = criarRobo(api, wa, log);
  await robo.rodar();
  log('Encerrado. Feche esta janela e gere um novo código no sistema.');
  if (NUVEM) process.exit(3);
}

main().catch((e) => { console.error(e); setTimeout(() => process.exit(1), 15000); });
