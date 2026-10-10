'use strict';
// Teste do ritmo e da fila com um "WhatsApp" de mentira (não usa a internet).
const assert = require('assert');
const { criarApi, criarRobo } = require('./fila');
(async () => {
  const chamadas = [];
  let fila = [{ id: 'a', telefone: '5581999990001', texto: 'oi A' }, { id: 'b', telefone: '5581999990002', texto: 'oi B' }, { id: 'c', telefone: '5581000', texto: 'oi C' }];
  const fakeFetch = async (url, o) => {
    const nome = url.split('/rpc/')[1]; const corpo = JSON.parse(o.body); chamadas.push([nome, corpo]);
    let out = { ok: true };
    if (nome === 'wa_puxar') out = fila.length ? { ok: true, msg: fila.shift() } : { ok: true, msg: null, motivo: 'fila_vazia' };
    return { ok: true, status: 200, json: async () => out };
  };
  const enviados = [];
  const wa = { conectado: () => true, existe: async (t) => t !== '5581000', enviar: async (t, x) => { enviados.push([t, x]); } };
  const api = criarApi({ supabaseUrl: 'http://x', supabaseKey: 'k', token: 'wa_t' }, fakeFetch);
  const robo = criarRobo(api, wa, () => {}, { pausaMin: 1, pausaMax: 2, digitarMin: 1, digitarMax: 2 });
  assert.strictEqual(await robo.umaVez(), 'enviada');
  assert.strictEqual(await robo.umaVez(), 'enviada');
  assert.strictEqual(await robo.umaVez(), 'sem_whatsapp');
  assert.strictEqual(await robo.umaVez(), 'vazio');
  assert.deepStrictEqual(enviados.map((x) => x[0]), ['5581999990001', '5581999990002']);
  const res = chamadas.filter((c) => c[0] === 'wa_resultado').map((c) => [c[1].p_id, c[1].p_ok, c[1].p_erro]);
  assert.deepStrictEqual(res, [['a', true, null], ['b', true, null], ['c', false, 'sem_whatsapp']]);
  // falha no envio: relata o erro e segue
  fila = [{ id: 'd', telefone: '5581999990004', texto: 'x' }];
  wa.enviar = async () => { throw new Error('boom'); };
  assert.strictEqual(await robo.umaVez(), 'falhou');
  // desconectado: não puxa nada
  wa.conectado = () => false; const n = chamadas.length; assert.strictEqual(await robo.umaVez(), 'desconectado'); assert.strictEqual(chamadas.length, n);
  console.log('Teste ok');
})().catch((e) => { console.error('FALHOU', e); process.exit(1); });
