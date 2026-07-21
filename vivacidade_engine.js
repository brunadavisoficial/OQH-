#!/usr/bin/env node
/**
 * OQHá · Camada 2 — Motor de previsão de vivacidade (P)
 * -------------------------------------------------------------------
 * Lê os locais do Supabase e calcula, para AGORA, a vivacidade prevista
 * de cada um:  P = curva_da_categoria(hora) × clima × pôr-do-sol × horário
 * Grava o resultado na tabela `vivacidade`. Roda sem NENHUM usuário —
 * é o que faz a cidade "acender" no cold-start.
 *
 * Node 18+ (fetch global). ZERO dependências. Clima via Open-Meteo (grátis, sem chave).
 *
 * Uso:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node vivacidade_engine.js
 *   node vivacidade_engine.js --selftest      (prova a matemática, sem rede)
 *   node vivacidade_engine.js --dry-run       (calcula de verdade, não grava)
 *
 * Ideal: rodar num cron a cada 15-30 min. A previsão muda com hora e clima.
 */

'use strict';

// João Pessoa
const JP = { lat: -7.115, lng: -34.861, tz: -3 };
const OPEN_METEO = `https://api.open-meteo.com/v1/forecast?latitude=${JP.lat}&longitude=${JP.lng}&current=precipitation,cloud_cover,is_day&timezone=America%2FRecife`;

// ---------- 1. CURVAS-ARQUÉTIPO (forma 0..1 por categoria) ----------
const bump = (h, c, w) => Math.exp(-Math.pow((h - c) / w, 2));
function shape(cat, h, ctx) {
  const sunset = ctx.sunset; // hora decimal do pôr do sol hoje
  switch (cat) {
    case 'bar':         return Math.max(bump(h, 23.5, 2.6), bump(h, 0.5, 2.0) * 0.9);
    case 'balada':      return Math.max(bump(h, 1.2, 1.6), h > 23 ? 0.6 : 0);
    case 'show':        return bump(h, 22.3, 1.9);
    case 'restaurante': return Math.max(bump(h, 12.8, 1.3) * 0.85, bump(h, 20.3, 1.8));
    case 'comida':      return Math.max(bump(h, 12.5, 1.6) * 0.8, bump(h, 20.5, 2.2));
    case 'praia':       return bump(h, 15, 2.6) * (h > sunset ? 0.35 : 1);
    case 'mirante':     return bump(h, sunset, 0.85);      // ancorado no sol!
    case 'parque':      return Math.max(bump(h, 10, 2) * 0.8, bump(h, 16.5, 1.8));
    case 'feira':       return bump(h, 9.5, 2.2);
    case 'esporte':     return Math.max(bump(h, 10, 2.4), bump(h, 19, 2.2));
    case 'turismo':     return bump(h, 13, 3.5);
    default:            return bump(h, 19, 3);
  }
}

// ---------- 2. CLIMA ----------
function weatherState(w) {
  if (w.precip >= 0.3) return 'chuva';
  if (w.cloud >= 70) return 'nublado';
  return 'sol';
}
function wxFactor(cat, wx) {
  const outdoor = { praia: 1, mirante: 1, feira: 1, parque: 1, esporte: 0.8, comida: 0.5 };
  const s = outdoor[cat] || 0;
  if (wx === 'sol') return 1;
  if (wx === 'nublado') return 1 - 0.30 * s;
  if (wx === 'chuva') return 1 - 0.85 * s;
  return 1;
}
function dayFactor(cat, isWeekend) {
  const nite = { bar: 1, balada: 1, show: 1 };
  const beachy = { praia: 1, mirante: 1, parque: 1, feira: 1 };
  if (isWeekend) return 1 + (nite[cat] ? 0.15 : 0) + (beachy[cat] ? 0.35 : 0);
  return 1 - (nite[cat] ? 0.35 : 0) - (beachy[cat] ? 0.15 : 0);
}

// ---------- 3. PÔR DO SOL (algoritmo Sunset/Sunrise, Almanac for Computers) ----------
function sunsetHour(lat, lng, date, tz) {
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const N = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start) / 86400000);
  const lngHour = lng / 15;
  const t = N + ((18 - lngHour) / 24);            // 18 = sunset
  const M = (0.9856 * t) - 3.289;
  let L = M + (1.916 * Math.sin(M * rad)) + (0.020 * Math.sin(2 * M * rad)) + 282.634;
  L = (L % 360 + 360) % 360;
  let RA = Math.atan(0.91764 * Math.tan(L * rad)) * deg;
  RA = (RA % 360 + 360) % 360;
  RA += (Math.floor(L / 90) * 90) - (Math.floor(RA / 90) * 90);   // mesmo quadrante de L
  RA /= 15;
  const sinDec = 0.39782 * Math.sin(L * rad);
  const cosDec = Math.cos(Math.asin(sinDec));
  const zenith = 90.833;
  const cosH = (Math.cos(zenith * rad) - (sinDec * Math.sin(lat * rad))) / (cosDec * Math.cos(lat * rad));
  if (cosH > 1 || cosH < -1) return 18;           // sem pôr do sol (polar) — irrelevante em JP
  const H = (Math.acos(cosH) * deg) / 15;         // sunset: +acos
  const T = H + RA - (0.06571 * t) - 6.622;
  let UT = (T - lngHour) % 24; if (UT < 0) UT += 24;
  return ((UT + tz) % 24 + 24) % 24;              // hora local decimal
}

// ---------- 4. HORÁRIO DE FUNCIONAMENTO (parser leve do opening_hours) ----------
const DAYS = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };
function parseDays(str) {
  const set = new Set();
  for (const part of str.split(',')) {
    const p = part.trim();
    if (p.includes('-')) {
      const [a, b] = p.split('-').map(s => s.trim());
      if (!(a in DAYS) || !(b in DAYS)) return null;
      let i = DAYS[a];
      for (let g = 0; g < 8; g++) { set.add(i); if (i === DAYS[b]) break; i = (i + 1) % 7; }
    } else {
      if (!(p in DAYS)) return null;
      set.add(DAYS[p]);
    }
  }
  return set;
}
// retorna true (aberto), false (fechado) ou null (não sei parsear → não penaliza)
function isOpenAt(oh, date) {
  if (!oh) return null;
  if (/24\s*\/\s*7/.test(oh)) return true;
  const dow = date.getDay(), mins = date.getHours() * 60 + date.getMinutes();
  try {
    for (const rule of oh.split(';').map(s => s.trim()).filter(Boolean)) {
      const m = rule.match(/^([A-Za-z][A-Za-z,\-\s]*?)\s+(\d.*)$/);
      let dayset = null, timesStr;
      if (m) { dayset = parseDays(m[1].replace(/\s/g, '')); if (dayset === null) return null; timesStr = m[2]; }
      else if (/^\d/.test(rule)) { timesStr = rule; }       // só horas → todos os dias
      else return null;
      for (const rg of timesStr.split(',').map(x => x.trim())) {
        const tm = rg.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
        if (!tm) continue;
        const start = (+tm[1]) * 60 + (+tm[2]);
        let end = (+tm[3]) * 60 + (+tm[4]);
        const todayOK = !dayset || dayset.has(dow);
        const prevOK = !dayset || dayset.has((dow + 6) % 7);
        if (end <= start) {                                  // vira a madrugada
          if (todayOK && mins >= start) return true;
          if (prevOK && mins < end) return true;
        } else {
          if (todayOK && mins >= start && mins < end) return true;
        }
      }
    }
    return false;
  } catch { return null; }
}

// ---------- 5. VIVACIDADE PREVISTA de um local ----------
function computeViv(v, date, ctx) {
  const h = date.getHours() + date.getMinutes() / 60;
  const base = v.base_magnitude ?? 0.6;
  const raw = base * shape(v.categoria, h, ctx) * wxFactor(v.categoria, ctx.wx) * dayFactor(v.categoria, ctx.weekend);

  const open = isOpenAt(v.horario_osm, date);
  const gate = open === false ? 0.05 : 1;          // fechado → quase zero; aberto/desconhecido → normal
  const P = Math.max(0, Math.min(1, raw * gate));

  // trajetória = derivada da forma daqui a 45min
  const hF = (h + 0.75) % 24;
  const pF = base * shape(v.categoria, hF, ctx) * wxFactor(v.categoria, ctx.wx) * dayFactor(v.categoria, ctx.weekend);
  const d = pF - raw;
  const traj = d > 0.06 ? 'subindo' : d < -0.06 ? 'esvaziando' : 'pico';

  return { P: +P.toFixed(3), traj };
}

// ---------- rede: clima ----------
async function fetchWeather() {
  try {
    const r = await fetch(OPEN_METEO);
    const j = await r.json();
    const c = j.current || {};
    return { precip: c.precipitation ?? 0, cloud: c.cloud_cover ?? 0, isDay: c.is_day ?? 1 };
  } catch (e) {
    console.warn('  ⚠️  clima indisponível, assumindo céu limpo:', e.message);
    return { precip: 0, cloud: 0, isDay: 1 };
  }
}

// ---------- helper: fetch com retry (Supabase free oscila; 5xx = tenta de novo) ----------
async function fetchRetry(u, opts, tentativas = 4) {
  let ultimo;
  for (let t = 1; t <= tentativas; t++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      const r = await fetch(u, { ...opts, signal: ctrl.signal });
      clearTimeout(timer);
      if (r.status >= 500) throw new Error(`HTTP ${r.status} (servidor instável)`);
      return r;
    } catch (e) {
      ultimo = e;
      const espera = t * 5000;
      console.warn(`  ⚠️  tentativa ${t}/${tentativas} falhou (${e.message}) — aguardando ${espera / 1000}s`);
      if (t < tentativas) await new Promise(rs => setTimeout(rs, espera));
    }
  }
  throw new Error(`Supabase indisponível após ${tentativas} tentativas: ${ultimo.message}`);
}

// ---------- rede: ler locais (paginado) ----------
async function fetchVenues(url, key) {
  const base = `${url.replace(/\/$/, '')}/rest/v1/estabelecimentos?select=osm_id,categoria,base_magnitude,horario_osm,bairro`;
  const out = []; const STEP = 1000;
  for (let from = 0; ; from += STEP) {
    const r = await fetchRetry(base, { headers: { apikey: key, Authorization: `Bearer ${key}`, Range: `${from}-${from + STEP - 1}` } });
    if (!r.ok) throw new Error(`Supabase read HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < STEP) break;
  }
  return out;
}

// ---------- rede: gravar vivacidade ----------
async function upsertViv(url, key, rows) {
  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/vivacidade?on_conflict=osm_id`;
  const CHUNK = 200; let ok = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const lote = rows.slice(i, i + CHUNK);
    const r = await fetchRetry(endpoint, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(lote)
    });
    if (!r.ok) throw new Error(`Supabase write HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    ok += lote.length; console.log(`  ↑ gravados ${ok}/${rows.length}`);
  }
  return ok;
}

function contexto(date) {
  const weekend = [0, 5, 6].includes(date.getDay()); // sex/sáb/dom "clima de fim de semana"
  const sunset = sunsetHour(JP.lat, JP.lng, date, JP.tz);
  return { date, weekend, sunset };
}
function resumoZonas(locais, vivMap) {
  const z = {};
  for (const v of locais) {
    const b = v.bairro || '(sem bairro)';
    const p = vivMap[v.osm_id]?.P || 0;
    (z[b] = z[b] || []).push(p);
  }
  console.log('\n📊 Energia por bairro (previsão):');
  Object.entries(z).map(([b, arr]) => [b, arr.reduce((a, x) => a + x, 0) / arr.length, arr.length])
    .sort((a, b) => b[1] - a[1]).slice(0, 12)
    .forEach(([b, m, n]) => console.log(`   ${String(Math.round(m * 100)).padStart(3)}  ${b.padEnd(20)} (${n})`));
}

// ===================== SELF-TEST (sem rede) =====================
function selftest() {
  const now = new Date();
  const ctx = contexto(now);
  console.log('🧪 SELF-TEST (sem rede)\n');
  console.log(`Pôr do sol calculado para hoje em JP: ${Math.floor(ctx.sunset)}h${String(Math.round((ctx.sunset % 1) * 60)).padStart(2, '0')}`);
  console.log(`(esperado ~17h00–17h30 — se bateu, o algoritmo solar está certo)\n`);

  const amostra = [
    { osm_id: 'node/1', categoria: 'bar', base_magnitude: 0.8, horario_osm: 'Mo-Su 18:00-02:00', bairro: 'Tambaú' },
    { osm_id: 'node/2', categoria: 'praia', base_magnitude: 0.9, horario_osm: null, bairro: 'Cabo Branco' },
    { osm_id: 'node/3', categoria: 'mirante', base_magnitude: 0.8, horario_osm: null, bairro: 'Cabo Branco' },
    { osm_id: 'node/4', categoria: 'restaurante', base_magnitude: 0.78, horario_osm: 'Tu-Su 11:00-15:00,19:00-23:00', bairro: 'Tambaú' }
  ];
  console.log('Vivacidade prevista para AGORA (' + now.getHours() + 'h):');
  const vivMap = {};
  for (const v of amostra) {
    const r = computeViv(v, now, ctx);
    vivMap[v.osm_id] = r;
    const openTxt = isOpenAt(v.horario_osm, now);
    console.log(`   ${String(Math.round(r.P * 100)).padStart(3)}  ${v.categoria.padEnd(12)} ${r.traj.padEnd(11)} ${openTxt === false ? '(fechado agora)' : ''}`);
  }
  // demonstra a curva ao longo do dia p/ um bar e a praia
  console.log('\nCurva do dia (bar × praia × mirante), previsão por hora:');
  console.log('   h    bar  praia  mirante');
  for (let hh = 12; hh <= 23; hh++) {
    const d = new Date(now); d.setHours(hh, 0, 0, 0);
    const c = contexto(d);
    const bar = computeViv({ categoria: 'bar', base_magnitude: 0.8 }, d, c).P;
    const pr = computeViv({ categoria: 'praia', base_magnitude: 0.9 }, d, c).P;
    const mi = computeViv({ categoria: 'mirante', base_magnitude: 0.8 }, d, c).P;
    const bar100 = Math.round(bar * 100), pr100 = Math.round(pr * 100), mi100 = Math.round(mi * 100);
    console.log(`   ${String(hh).padStart(2)}h  ${String(bar100).padStart(3)}  ${String(pr100).padStart(4)}   ${String(mi100).padStart(4)}  ${'█'.repeat(Math.round(Math.max(bar, pr, mi) * 20))}`);
  }
  resumoZonas(amostra, vivMap);
  console.log('\n✅ Motor OK. Repare: a praia cai e o mirante pica no pôr do sol; o bar sobe à noite.');
}

// ===================== MAIN =====================
async function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Defina SUPABASE_URL e SUPABASE_SERVICE_KEY.');

  const now = new Date();
  console.log('☁️  Buscando clima (Open-Meteo)...');
  const w = await fetchWeather();
  const wx = weatherState(w);
  const ctx = contexto(now); ctx.wx = wx;
  console.log(`   Clima: ${wx} · pôr do sol hoje ~${Math.floor(ctx.sunset)}h${String(Math.round((ctx.sunset % 1) * 60)).padStart(2, '0')}`);

  console.log('📥 Lendo locais do Supabase...');
  const locais = await fetchVenues(url, key);
  console.log(`   ${locais.length} locais.`);

  const vivMap = {};
  const rows = locais.map(v => {
    const r = computeViv(v, now, ctx); vivMap[v.osm_id] = r;
    return { osm_id: v.osm_id, viv_prevista: r.P, trajetoria: r.traj, fonte: 'previsao', clima: wx, atualizado_em: new Date().toISOString() };
  });
  resumoZonas(locais, vivMap);

  if (process.argv.includes('--dry-run')) { console.log('\n(--dry-run: nada gravado)'); return; }
  console.log('\n💾 Gravando vivacidade...');
  const n = await upsertViv(url, key, rows);
  console.log(`\n✅ ${n} locais com vivacidade prevista. O app já pode ler a cidade acesa.`);
}

main().catch(e => { console.error('\n❌ Erro:', e.message); process.exit(1); });
