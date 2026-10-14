'use strict';
// Gerenciador da nuvem: roda num servidor (VPS) e mantém um conector de WhatsApp para cada
// ótica (e para o chip do CRM) que ligou o "WhatsApp na nuvem" no sistema.
// A cada 30 segundos pergunta ao sistema quais conectores devem estar ligados:
// liga os novos, religa os que caírem e desliga os que foram removidos.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const ex = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config.exemplo.json'), 'utf8'));
const SUPABASE_URL = process.env.SUPABASE_URL || ex.supabaseUrl;
const SUPABASE_KEY = process.env.SUPABASE_KEY || ex.supabaseKey;
const CHAVE = String(process.env.SERVER_KEY || '').trim();
const PASTA = process.env.PASTA_SESSOES || path.join(RAIZ, 'sessoes');
const INTERVALO = Number(process.env.INTERVALO_MS) || 30000;

const log = (t) => console.log('[' + new Date().toLocaleString('pt-BR', { timeZone: 'America/Recife' }) + '] [servidor] ' + t);

async function lista() {
  const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/srv_conectores', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
    body: JSON.stringify({ p_key: CHAVE }),
  });
  if (!r.ok) throw new Error('Sistema respondeu ' + r.status);
  const d = await r.json();
  if (!d || !d.ok) throw new Error(d && d.erro ? d.erro : 'resposta inválida');
  return d.conectores || [];
}

// id -> { filho, token, modo, nome, falhas, proxima }
const rodando = new Map();

function ligar(c) {
  const atual = rodando.get(c.id) || { falhas: 0, proxima: 0 };
  if (Date.now() < atual.proxima) return;
  const pasta = path.join(PASTA, String(c.id).replace(/[^\w-]/g, ''));
  fs.mkdirSync(pasta, { recursive: true });
  const filho = spawn(process.execPath, [process.env.CONECTOR_SCRIPT || path.join(__dirname, 'index.js')], {
    cwd: RAIZ,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: Object.assign({}, process.env, {
      CONECTOR_NUVEM: '1', CONECTOR_ID: String(c.id), CONECTOR_NOME: String(c.nome || c.id).slice(0, 40),
      CONECTOR_TOKEN: c.token, CONECTOR_MODO: c.modo === 'prospeccao' ? 'prospeccao' : '', CONECTOR_SESSAO: pasta,
      SUPABASE_URL, SUPABASE_KEY, SERVER_KEY: '',
    }),
  });
  const reg = { filho, token: c.token, modo: c.modo, nome: c.nome, falhas: atual.falhas, proxima: 0, inicio: Date.now() };
  rodando.set(c.id, reg);
  log('Ligado: ' + (c.nome || c.id) + (c.modo === 'prospeccao' ? ' (CRM)' : ''));
  filho.on('exit', (codigo) => {
    if (rodando.get(c.id) !== reg) return; // já foi trocado/desligado
    // se caiu logo depois de ligar, espera mais antes de tentar de novo (até 5 minutos)
    reg.falhas = Date.now() - reg.inicio < 120000 ? reg.falhas + 1 : 0;
    reg.proxima = Date.now() + Math.min(300000, 5000 * 2 ** reg.falhas);
    reg.filho = null;
    log('Parou: ' + (c.nome || c.id) + ' (código ' + codigo + '). Religa na próxima volta.');
  });
}

function desligar(id, motivo) {
  const r = rodando.get(id);
  rodando.delete(id);
  if (r && r.filho) { try { r.filho.kill('SIGTERM'); } catch (e) { /* ignora */ } }
  log('Desligado: ' + ((r && r.nome) || id) + ' (' + motivo + ')');
}

async function volta() {
  let cs;
  try { cs = await lista(); } catch (e) { log('Não consegui falar com o sistema: ' + e.message); return; }
  const ids = new Set(cs.map((c) => c.id));
  for (const id of [...rodando.keys()]) if (!ids.has(id)) desligar(id, 'removido no sistema');
  for (const c of cs) {
    const r = rodando.get(c.id);
    if (r && r.token !== c.token) desligar(c.id, 'código novo');
    const r2 = rodando.get(c.id);
    if (!r2 || !r2.filho) ligar(c);
  }
}

// Atualização automática: quando sai uma versão nova do conector no site, o servidor se atualiza sozinho.
const SITE = process.env.SITE || 'https://oticas-cobranca.vercel.app';
const VERSAO = (() => { try { return JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8')).version; } catch (e) { return ''; } })();
async function verAtualizacao() {
  if (process.env.SEM_ATUALIZAR === '1') return;
  try {
    const r = await fetch(SITE + '/servidor/versao.json?t=' + Date.now(), { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return;
    const v = String((await r.json()).versao || '');
    if (!v || v === VERSAO) return;
    const marca = path.join(RAIZ, '.atualizando');
    try { const ant = JSON.parse(fs.readFileSync(marca, 'utf8')); if (ant.v === v && Date.now() - ant.em < 6 * 3600e3) return; } catch (e) { /* primeira vez */ }
    fs.writeFileSync(marca, JSON.stringify({ v, em: Date.now() }));
    log('Versão nova do conector (' + VERSAO + ' -> ' + v + '). Atualizando...');
    // roda fora do serviço, porque a atualização reinicia o próprio serviço
    spawn('systemd-run', ['--unit=adm-conector-atualizar-' + Date.now(), '--collect', 'bash', '-c', 'curl -fsSL ' + SITE + '/servidor/instalar.sh | bash'], { stdio: 'ignore', detached: true }).unref();
  } catch (e) { log('Não consegui ver se há atualização: ' + e.message); }
}

if (require.main === module) {
  if (!/^srv_[0-9a-f]{48}$/.test(CHAVE)) { log('Falta a chave do servidor (SERVER_KEY).'); process.exit(1); }
  log('Gerenciador da nuvem iniciado. Sessões em ' + PASTA);
  volta();
  setInterval(volta, INTERVALO);
  log('Versão ' + VERSAO);
  setTimeout(verAtualizacao, 60000);
  setInterval(verAtualizacao, 20 * 60000);
  const sair = () => { for (const id of [...rodando.keys()]) desligar(id, 'servidor parando'); setTimeout(() => process.exit(0), 1500); };
  process.on('SIGTERM', sair);
  process.on('SIGINT', sair);
}

module.exports = { volta, rodando };
