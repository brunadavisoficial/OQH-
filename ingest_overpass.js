#!/usr/bin/env node
/**
 * OQHá · Camada 1 — Ingestão de locais do OpenStreetMap → Supabase
 * -------------------------------------------------------------------
 * Puxa bares, restaurantes, praias, mirantes, feiras etc. de João Pessoa
 * via Overpass API e faz upsert na tabela `estabelecimentos`.
 *
 * Requisitos: Node 18+ (usa fetch global). ZERO dependências npm.
 *
 * Uso:
 *   SUPABASE_URL="https://xxxx.supabase.co" \
 *   SUPABASE_SERVICE_KEY="eyJ...service_role..." \
 *   node ingest_overpass.js
 *
 * Teste sem tocar em rede (mostra como os dados ficam):
 *   node ingest_overpass.js --selftest
 *
 * IMPORTANTE: use a chave SERVICE_ROLE só aqui no backend. NUNCA no app
 * nem na extensão — ela ignora o RLS e pode escrever em tudo.
 */

'use strict';

// --- João Pessoa: caixa delimitadora (sul, oeste, norte, leste) ---
const BBOX = [-7.20, -34.92, -7.05, -34.78];
const OVERPASS = 'https://overpass-api.de/api/interpreter';
// espelhos alternativos: se um estiver sobrecarregado (504), tenta o próximo
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];
const UA = 'OQHa-ingest/1.0 (contato: seuemail@exemplo.com)'; // troque pelo seu contato (boa prática Overpass)

// --- Categorias OSM que nos interessam ---
function buildQuery([s, w, n, e]) {
  const bb = `(${s},${w},${n},${e})`;
  return `[out:json][timeout:90];
(
  nwr["amenity"~"^(bar|pub|biergarten|nightclub|restaurant|cafe|fast_food|ice_cream|food_court|marketplace|theatre|arts_centre|events_venue|cinema)$"]${bb};
  nwr["natural"="beach"]${bb};
  nwr["leisure"~"^(park|garden|beach_resort|stadium|sports_centre|marina)$"]${bb};
  nwr["tourism"~"^(viewpoint|attraction|artwork|museum|theme_park)$"]${bb};
);
out center tags;`;
}

// --- Mapeia tag OSM → categoria do OQHá ---
function mapCategory(t = {}) {
  const a = t.amenity, l = t.leisure, to = t.tourism, na = t.natural;
  if (na === 'beach' || l === 'beach_resort') return { cat: 'praia', sub: na ? 'natural=beach' : 'leisure=beach_resort' };
  if (to === 'viewpoint') return { cat: 'mirante', sub: 'tourism=viewpoint' };
  if (a === 'nightclub') return { cat: 'balada', sub: 'amenity=nightclub' };
  if (['bar', 'pub', 'biergarten'].includes(a)) return { cat: 'bar', sub: 'amenity=' + a };
  if (a === 'restaurant') return { cat: 'restaurante', sub: 'amenity=restaurant' };
  if (['cafe', 'fast_food', 'ice_cream', 'food_court'].includes(a)) return { cat: 'comida', sub: 'amenity=' + a };
  if (a === 'marketplace') return { cat: 'feira', sub: 'amenity=marketplace' };
  if (['theatre', 'arts_centre', 'events_venue', 'cinema'].includes(a)) return { cat: 'show', sub: 'amenity=' + a };
  if (['park', 'garden'].includes(l)) return { cat: 'parque', sub: 'leisure=' + l };
  if (['stadium', 'sports_centre'].includes(l)) return { cat: 'esporte', sub: 'leisure=' + l };
  if (l === 'marina') return { cat: 'turismo', sub: 'leisure=marina' };
  if (['attraction', 'artwork', 'museum', 'theme_park'].includes(to)) return { cat: 'turismo', sub: 'tourism=' + to };
  return null;
}

// --- Magnitude-base inicial por categoria (Camada 2 refina depois) ---
const BASE = {
  balada: 0.9, bar: 0.8, show: 0.82, praia: 0.9, mirante: 0.8,
  restaurante: 0.78, comida: 0.65, feira: 0.72, parque: 0.6, esporte: 0.7, turismo: 0.65
};

// --- Converte elementos OSM → linhas da tabela ---
function osmToRows(elements = []) {
  const rows = [];
  let semNome = 0;
  for (const el of elements) {
    const t = el.tags || {};
    const nome = t.name;
    if (!nome) { semNome++; continue; }             // sem nome não serve pro app
    const m = mapCategory(t);
    if (!m) continue;

    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null) continue;

    const endereco = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(', ') || null;
    const bairro = t['addr:suburb'] || t['addr:neighbourhood'] || t['addr:district'] || null;

    rows.push({
      osm_id: `${el.type}/${el.id}`,
      fonte: 'osm',
      nome,
      categoria: m.cat,
      subcategoria: m.sub,
      lat, lng,
      bairro,
      endereco,
      horario_osm: t.opening_hours || null,
      telefone: t.phone || t['contact:phone'] || null,
      website: t.website || t['contact:website'] || null,
      cuisine: t.cuisine || null,
      base_magnitude: BASE[m.cat] ?? 0.6
    });
  }
  return { rows, semNome };
}

// --- Busca no Overpass (tenta vários espelhos; 504 = servidor cheio, tenta o próximo) ---
async function fetchOverpass(query) {
  let ultimoErro;
  for (const mirror of OVERPASS_MIRRORS) {
    const nome = mirror.split('/')[2];
    for (let tent = 1; tent <= 2; tent++) {
      try {
        console.log(`  … tentando ${nome} (${tent}/2)`);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 120000); // 2 min de paciência
        const res = await fetch(mirror, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
          body: 'data=' + encodeURIComponent(query),
          signal: ctrl.signal
        });
        clearTimeout(timer);
        if (res.status === 504 || res.status === 429 || res.status === 503) {
          throw new Error(`HTTP ${res.status} (servidor ocupado)`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        console.log(`  ✓ respondeu: ${nome}`);
        return json.elements || [];
      } catch (err) {
        ultimoErro = err;
        console.warn(`  ⚠️  ${nome} falhou: ${err.message}`);
        if (tent === 1) await new Promise(r => setTimeout(r, 4000));
      }
    }
  }
  throw new Error(`Todos os espelhos Overpass falharam. Último: ${ultimoErro?.message}. Tente de novo em alguns minutos.`);
}

// --- Upsert no Supabase (lotes menores + retry com backoff) ---
async function upsertSupabase(rows) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Defina SUPABASE_URL e SUPABASE_SERVICE_KEY no ambiente.');

  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/estabelecimentos?on_conflict=osm_id`;
  const CHUNK = 100;
  let ok = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const lote = rows.slice(i, i + CHUNK);
    let gravou = false;
    for (let tent = 1; tent <= 4 && !gravou; tent++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'apikey': key,
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates,return=minimal'
          },
          body: JSON.stringify(lote),
          signal: ctrl.signal
        });
        clearTimeout(timer);
        if (res.status >= 500) throw new Error(`HTTP ${res.status} (servidor instável)`);
        if (!res.ok) {
          const txt = await res.text();
          throw Object.assign(new Error(`HTTP ${res.status}: ${txt.slice(0, 250)}`), { fatal: res.status < 500 });
        }
        gravou = true;
      } catch (err) {
        if (err.fatal) throw err;                       // 4xx = erro de config, não adianta repetir
        const espera = tent * 5000;
        console.warn(`  ⚠️  lote ${i / CHUNK + 1} falhou (${err.message}) — nova tentativa em ${espera / 1000}s (${tent}/4)`);
        if (tent === 4) throw new Error(`Supabase indisponível após 4 tentativas: ${err.message}`);
        await new Promise(r => setTimeout(r, espera));
      }
    }
    ok += lote.length;
    console.log(`  ↑ enviados ${ok}/${rows.length}`);
  }
  return ok;
}

function resumo(rows) {
  const porCat = {};
  let comHorario = 0;
  for (const r of rows) {
    porCat[r.categoria] = (porCat[r.categoria] || 0) + 1;
    if (r.horario_osm) comHorario++;
  }
  console.log('\n📊 Resumo:');
  Object.entries(porCat).sort((a, b) => b[1] - a[1])
    .forEach(([c, n]) => console.log(`   ${c.padEnd(12)} ${n}`));
  console.log(`   ${'—'.repeat(16)}`);
  console.log(`   com horário    ${comHorario}/${rows.length} (${Math.round(comHorario / rows.length * 100)}%)`);
}

// ===================== SELF-TEST (sem rede) =====================
function selftest() {
  const amostra = [
    { type: 'node', id: 1, lat: -7.11, lon: -34.82, tags: { name: 'Bar do Cais', amenity: 'bar', opening_hours: 'Mo-Su 18:00-02:00', 'addr:suburb': 'Tambaú' } },
    { type: 'node', id: 2, lat: -7.12, lon: -34.79, tags: { name: 'Mirante do Farol', tourism: 'viewpoint' } },
    { type: 'way', id: 3, center: { lat: -7.13, lon: -34.80 }, tags: { name: 'Praia do Cabo Branco', natural: 'beach' } },
    { type: 'node', id: 4, lat: -7.10, lon: -34.84, tags: { name: 'Club Vertigo', amenity: 'nightclub', opening_hours: 'Fr-Sa 23:00-05:00' } },
    { type: 'node', id: 5, lat: -7.09, lon: -34.83, tags: { amenity: 'bar' } }, // sem nome → ignorado
    { type: 'node', id: 6, lat: -7.14, lon: -34.85, tags: { name: 'Bloco Y', shop: 'clothes' } } // categoria irrelevante → ignorado
  ];
  const { rows, semNome } = osmToRows(amostra);
  console.log('🧪 SELF-TEST (nenhuma rede tocada)\n');
  console.log(JSON.stringify(rows, null, 2));
  console.log(`\nIgnorados por falta de nome: ${semNome}`);
  resumo(rows);
  console.log('\n✅ Parsing OK. Rode sem --selftest (com as env vars) para popular o Supabase.');
}

// ===================== MAIN =====================
const fs = require('fs');
const CACHE = 'locais_jp.json';

async function main() {
  if (process.argv.includes('--selftest')) return selftest();

  let rows;
  if (fs.existsSync(CACHE) && !process.argv.includes('--refresh')) {
    rows = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    console.log(`📦 Usando cache local (${CACHE}): ${rows.length} locais.`);
    console.log('   (para buscar de novo no OSM, rode com --refresh)');
  } else {
    console.log('🌍 Consultando Overpass para João Pessoa...');
    const els = await fetchOverpass(buildQuery(BBOX));
    console.log(`   ${els.length} elementos brutos recebidos.`);
    const parsed = osmToRows(els);
    rows = parsed.rows;
    console.log(`   ${rows.length} locais válidos (${parsed.semNome} ignorados por não ter nome).`);
    fs.writeFileSync(CACHE, JSON.stringify(rows, null, 1));
    console.log(`   💾 Cache salvo em ${CACHE} — a busca nunca mais se perde.`);
  }
  resumo(rows);

  if (process.argv.includes('--dry-run')) {
    console.log('\n(--dry-run: nada enviado ao Supabase)');
    return;
  }

  console.log('\n💾 Enviando ao Supabase...');
  const n = await upsertSupabase(rows);
  console.log(`\n✅ Pronto. ${n} locais no Supabase (upsert por osm_id — rodar de novo só atualiza).`);
}

main().catch(err => { console.error('\n❌ Erro:', err.message); process.exit(1); });
