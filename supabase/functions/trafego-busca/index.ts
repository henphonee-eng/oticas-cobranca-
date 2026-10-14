// Tráfego Orgânico (função Premium do sistema da ótica): acha empresas perto da ótica para a ótica oferecer óculos.
// modo "geo": endereço -> coordenadas; modo "mapa": empresas num raio (Google Maps), sem óticas; modo "cnpj": dados públicos de um CNPJ.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const OTICA = /(^|[^\p{L}])(ó|o)p?tic|(^|[^\p{L}])óculos|(^|[^\p{L}])oculos|lentes de contato/iu;
const FIELDS = 'places.id,places.displayName,places.formattedAddress,places.addressComponents,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.googleMapsUri,places.businessStatus,places.location,places.primaryTypeDisplayName,places.types,nextPageToken';

function distancia(a: number, b: number, c: number, d: number) {
  const R = 6371000, r = Math.PI / 180, x = (c - a) * r, y = (d - b) * r;
  const h = Math.sin(x / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(y / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
const comp = (p: any, t: string) => (p.addressComponents || []).find((c: any) => (c.types || []).includes(t))?.longText || '';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const auth = req.headers.get('Authorization') || '';
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } });
    const b = await req.json();
    const otica = String(b.otica || '');
    if (!/^[0-9a-f-]{36}$/.test(otica)) return json({ error: 'Ótica inválida' }, 400);
    const ok = await sb.rpc('trafego_pode_buscar', { p_otica: otica, p_tipo: String(b.modo || '') });
    if (ok.error) return json({ error: ok.error.message.includes('liberada') ? 'Função não liberada para a sua ótica.' : 'Sem permissão.' }, 403);
    if (!ok.data?.ok) return json({ error: ok.data?.erro || 'Limite atingido.' }, 429);

    if (b.modo === 'cnpj') {
      const cnpj = String(b.cnpj || '').replace(/\D/g, '');
      if (cnpj.length !== 14) return json({ error: 'Digite os 14 números do CNPJ.' }, 400);
      const r = await fetch('https://brasilapi.com.br/api/cnpj/v1/' + cnpj, { signal: AbortSignal.timeout(15000) });
      if (r.status === 404) return json({ error: 'CNPJ não encontrado.' }, 404);
      if (!r.ok) return json({ error: 'A consulta de CNPJ não respondeu agora. Tente de novo em instantes.' }, 502);
      const d = await r.json();
      const tels = [d.ddd_telefone_1, d.ddd_telefone_2].map((t: string) => String(t || '').replace(/\D/g, '')).filter((t: string) => t.length >= 10);
      return json({ empresa: {
        cnpj, nome: d.nome_fantasia || d.razao_social || '', razao: d.razao_social || '',
        telefone: tels[0] || '', telefone2: tels[1] || '',
        endereco: [d.descricao_tipo_de_logradouro, d.logradouro].filter(Boolean).join(' ') + (d.numero ? ', ' + d.numero : '') + (d.bairro ? ' - ' + d.bairro : '') + (d.municipio ? ', ' + d.municipio + (d.uf ? ' - ' + d.uf : '') : ''),
        bairro: d.bairro || '', categoria: d.cnae_fiscal_descricao || '', situacao: d.descricao_situacao_cadastral || '',
      } });
    }

    const key = Deno.env.get('GOOGLE_PLACES_KEY');
    if (!key) return json({ error: 'A busca no Google Maps ainda não foi configurada.' }, 400);
    const google = async (body: Record<string, unknown>) => {
      const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELDS }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error('Google: ' + (d?.error?.message || r.status));
      return d;
    };

    if (b.modo === 'geo') {
      const end = String(b.endereco || '').trim();
      if (end.length < 5) return json({ error: 'Informe o endereço da ótica.' }, 400);
      const d = await google({ textQuery: end, languageCode: 'pt-BR', regionCode: 'BR', pageSize: 1 });
      const p = (d.places || [])[0];
      if (!p?.location) return json({ error: 'Não encontrei esse endereço no mapa. Confira e tente de novo.' }, 404);
      return json({ lat: p.location.latitude, lng: p.location.longitude, bairro: comp(p, 'sublocality_level_1') || comp(p, 'sublocality'), label: p.formattedAddress || end });
    }

    // modo "mapa"
    const lat = Number(b.lat), lng = Number(b.lng), raio = Math.max(300, Math.min(5000, Number(b.raio) || 3000));
    if (!isFinite(lat) || !isFinite(lng)) return json({ error: 'Defina a localização da ótica primeiro.' }, 400);
    const q = String(b.consulta || 'empresas').trim().slice(0, 60) || 'empresas';
    const body: Record<string, unknown> = { textQuery: q, languageCode: 'pt-BR', regionCode: 'BR', pageSize: 20, rankPreference: 'DISTANCE',
      locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: raio } } };
    if (b.pageToken) body.pageToken = String(b.pageToken);
    const d = await google(body);
    const empresas = (d.places || [])
      .filter((p: any) => p.businessStatus !== 'CLOSED_PERMANENTLY' && p.location)
      .map((p: any) => ({
        place_id: p.id, nome: p.displayName?.text || '', endereco: p.formattedAddress || '',
        bairro: comp(p, 'sublocality_level_1') || comp(p, 'sublocality'), telefone: p.nationalPhoneNumber || '', site: p.websiteUri || '',
        categoria: p.primaryTypeDisplayName?.text || '', nota: p.rating ?? null, avaliacoes: p.userRatingCount ?? 0, maps_url: p.googleMapsUri || '',
        distancia_m: distancia(lat, lng, p.location.latitude, p.location.longitude), otica: OTICA.test(p.displayName?.text || '') || (p.types || []).includes('optician'),
      }))
      .filter((p: any) => !p.otica && p.distancia_m <= raio)
      .map(({ otica, ...p }: any) => p);
    return json({ empresas, nextPageToken: d.nextPageToken || null, restam: ok.data.restam });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e).slice(0, 200) }, 500);
  }
});
