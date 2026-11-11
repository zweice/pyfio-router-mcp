// weather: the mix of the models the judge measured as best near the place (router-ausbau/
// schritt2-wetter-kurse, weather-judge/1 of 2026-10-15; table built by richter/build_wetter_tabelle.py).
// - Place: coordinates, or a name via the Open-Meteo geocoding API.
// - Ranking: the nearest of the 64 judged stations (within wetter.stationMaxKm and
//   wetter.stationMaxHoeheM); else the region of the nearest station (within wetter.regionMaxKm);
//   else the global ranking. Precipitation always by region or global: per station it is noise.
// - Forecast: one Open-Meteo call with the needed models; hourly the mean of the top wetter.topK
//   models per variable (a model with gaps is replaced by the next in the ranking); daily values from
//   the mixed hours. Measured out of sample (rolling, 01.08. to 12.10.2026): 13 to 16 % lower error
//   than the best fixed model, 18 to 23 % lower than Open-Meteo's default best_match.
// - Keys: OPEN_METEO_API_KEY (commercial plan, the operator's own) -> customer-api.open-meteo.com;
//   without it the free endpoint, which Open-Meteo allows for non-commercial use only.
import fs from 'node:fs';
import { setting, keys, lang } from '../config.mjs';
import { request } from '../net.mjs';

const TABLE = JSON.parse(fs.readFileSync(new URL('../richter/wetter-tabelle.json', import.meta.url), 'utf8'));
export const JUDGE_TABLE = TABLE;
const VARS = { t2m_c: 'temperature_2m', wind10_ms: 'wind_speed_10m', precip_day: 'precipitation' };
const UA = 'pyfio-router/0.1 (+https://pyfio.com)';

export const haversineKm = (a, b) => {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

export class WeatherError extends Error { constructor(msg, kind = 'input') { super(msg); this.kind = kind; } }

// The key travels in the URL (Open-Meteo's customer API wants it there): never put a URL into an error.
async function getJson(url, { timeoutMs = 12000 } = {}) {
  let res;
  try { res = await request(url, { timeoutMs, headers: { 'User-Agent': UA, Accept: 'application/json' } }); }
  catch (e) { throw new WeatherError(`open-meteo: ${e.kind === 'timeout' ? `time limit ${Math.round(timeoutMs / 1000)} s` : 'not reachable'}`, e.kind === 'timeout' ? 'timeout' : 'network'); }
  let j = null;
  try { j = JSON.parse(res.text); } catch {}
  if (res.status < 200 || res.status >= 300) throw new WeatherError(`open-meteo: HTTP ${res.status}${j?.reason ? ` (${String(j.reason).slice(0, 160)})` : ''}`, res.status === 429 ? 'rate_limit' : 'http');
  if (!j) throw new WeatherError('open-meteo: no JSON', 'http');
  return j;
}

const host = (api) => (keys().openMeteo ? `https://customer-${api}.open-meteo.com` : `https://${api}.open-meteo.com`);
const keyParam = () => (keys().openMeteo ? `&apikey=${encodeURIComponent(keys().openMeteo)}` : '');

export function parseCoords(s) {
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(String(s || ''));
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

// "Dresden", "Dresden, Germany", "Paris, FR" -> { name, lat, lon, country, admin1, elevation }.
export async function geocode(place, { fetchJson = getJson, lang: lg } = {}) {
  const raw = String(place || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!raw) throw new WeatherError('place or coordinates missing');
  const [name, ...rest] = raw.split(',').map((x) => x.trim()).filter(Boolean);
  const hint = rest.join(' ').toLowerCase();
  const q = `${host('geocoding-api')}/v1/search?name=${encodeURIComponent(name)}&count=10&language=${lg === 'de' || lg === 'en' ? lg : lang()}&format=json${keyParam()}`;
  const j = await fetchJson(q);
  let res = Array.isArray(j.results) ? j.results : [];
  if (hint) {
    const hit = res.filter((r) => [r.country, r.country_code, r.admin1, r.admin2, r.postcodes?.join(' ')].filter(Boolean).some((x) => String(x).toLowerCase().includes(hint) || hint.includes(String(x).toLowerCase())));
    if (hit.length) res = hit;
  }
  if (!res.length) throw new WeatherError(`place not found: ${raw}`, 'not_found');
  const r = res[0];
  return { name: r.name, lat: r.latitude, lon: r.longitude, country: r.country_code || r.country || null, admin1: r.admin1 || null, elevation: r.elevation ?? null, alternatives: res.slice(1, 4).map((x) => `${x.name}${x.admin1 ? `, ${x.admin1}` : ''}${x.country_code ? `, ${x.country_code}` : ''}`) };
}

// Which ranking applies at a place. -> { level, station?, distance_km, region?, reason }
export function pickRanking(p) {
  let best = null;
  for (const [sid, s] of Object.entries(TABLE.stations)) {
    const d = haversineKm(p, s);
    if (!best || d < best.d) best = { sid, s, d };
  }
  const maxKm = setting('wetter.stationMaxKm'), maxDh = setting('wetter.stationMaxHoeheM');
  const dh = p.elevation != null && best.s.elev_m != null ? Math.abs(p.elevation - best.s.elev_m) : null;
  const near = { id: best.sid, name: best.s.name, distance_km: Math.round(best.d * 10) / 10, ...(dh != null ? { height_diff_m: Math.round(dh) } : {}) };
  if (best.d <= maxKm && (dh == null || dh <= maxDh)) return { level: 'station', station: near, region: best.s.region };
  if (best.d <= setting('wetter.regionMaxKm')) return { level: 'region', region: best.s.region, nearest_station: near, reason: best.d > maxKm ? 'no judged station close enough' : 'height differs too much from the nearest station' };
  return { level: 'global', nearest_station: near, reason: 'far from all judged stations' };
}

const leadFor = (dayIndex) => (dayIndex <= 1 ? 24 : dayIndex === 2 ? 48 : 72);
// The ranking for a variable at a place, and the strategy the judge measured as better there: the mix
// of the top models, or Open-Meteo's default (best_match) where the mix measured worse (out of sample).
function segment(pick, v, lead) {
  let seg = null;
  if (v !== 'precip_day' && pick.level === 'station') {
    const s = TABLE.segments[`${pick.station.id}|${v}|${lead}`];
    if (s?.rank?.length) seg = { level: 'station', key: pick.station.id, s };
  }
  if (!seg && pick.region && pick.level !== 'global') {
    const s = TABLE.regions[`${pick.region}|${v}|${lead}`];
    if (s?.rank?.length) seg = { level: 'region', key: pick.region, s };
  }
  if (!seg) seg = { level: 'global', key: 'global', s: TABLE.global[`${v}|${lead}`] };
  const g = seg.s.roll?.gain_vs_best_match_pct;
  seg.strategy = Number.isFinite(g) && g < 0 ? 'default' : 'mix';
  return seg;
}

const mean = (xs) => { const v = xs.filter((x) => Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

// weather({ place | lat, lon, days }) -> { ok, place, days[], provider, models, judge }
export async function weather({ place, lat, lon, days = 3 } = {}, { fetchJson = getJson, mode = 'stdio', lang: lg } = {}) {
  const L = lg === 'de' || lg === 'en' ? lg : lang();
  const t0 = Date.now();
  const nDays = Math.max(1, Math.min(7, Math.round(Number(days)) || 3));
  if (mode === 'http' && !keys().openMeteo && process.env.PYFIO_ALLOW_NONCOMMERCIAL !== '1') {
    throw new WeatherError('the hosted router needs a commercial Open-Meteo key (OPEN_METEO_API_KEY); the free API is non-commercial only', 'setup');
  }
  let p;
  const c = lat != null && lon != null ? parseCoords(`${lat},${lon}`) : parseCoords(place);
  if (c) p = { name: null, ...c, elevation: null, source: 'coordinates' };
  else p = { ...(await geocode(place, { fetchJson, lang: L })), source: 'open-meteo geocoding' };
  // The height decides whether a mountain station's ranking fits: for bare coordinates ask for it.
  if (p.elevation == null) {
    try { const e = await fetchJson(`${host('api')}/v1/elevation?latitude=${p.lat}&longitude=${p.lon}${keyParam()}`, { timeoutMs: 6000 }); if (Number.isFinite(e?.elevation?.[0])) p.elevation = e.elevation[0]; } catch {}
  }
  const pick = pickRanking(p);
  const K = setting('wetter.topK');
  // Candidates per variable and lead: the ranking; ask for a few spares in case a model has gaps here.
  const plan = {};
  const need = new Set();
  for (let d = 0; d < nDays; d++) {
    const lead = leadFor(d);
    for (const v of Object.keys(VARS)) {
      const key = `${v}|${lead}`;
      if (plan[key]) continue;
      const seg = segment(pick, v, lead);
      plan[key] = { ...seg, cand: seg.strategy === 'default' ? ['best_match'] : seg.s.rank.slice(0, K + 2) };
      plan[key].cand.forEach((m) => need.add(m));
    }
  }
  const models = [...need];
  const url = `${host('api')}/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&hourly=temperature_2m,wind_speed_10m,precipitation&models=${models.join(',')}&wind_speed_unit=ms&timezone=auto&forecast_days=${nDays}${keyParam()}`;
  const j = await fetchJson(url);
  const h = j.hourly || {};
  const time = h.time || [];
  if (!time.length) throw new WeatherError('open-meteo: no hourly data', 'http');
  const series = (v, m) => h[`${VARS[v]}_${m}`] || (models.length === 1 ? h[VARS[v]] : null);
  const dates = [...new Set(time.map((t) => t.slice(0, 10)))].slice(0, nDays);
  const outDays = [], used = {};
  dates.forEach((date, d) => {
    const lead = leadFor(d);
    const idx = time.map((t, i) => (t.startsWith(date) ? i : -1)).filter((i) => i >= 0);
    const day = { date };
    for (const v of Object.keys(VARS)) {
      const pl = plan[`${v}|${lead}`];
      // The top K models with values on this day.
      const ok = pl.cand.filter((m) => { const s = series(v, m); return s && idx.filter((i) => Number.isFinite(s[i])).length >= Math.ceil(idx.length * 0.9); }).slice(0, K);
      used[`${v}|${lead}`] = ok;
      const mixed = idx.map((i) => mean(ok.map((m) => series(v, m)[i])));
      if (v === 't2m_c') { const xs = mixed.filter(Number.isFinite); day.t_min_c = r1(Math.min(...xs)); day.t_max_c = r1(Math.max(...xs)); }
      if (v === 'wind10_ms') { const xs = mixed.filter(Number.isFinite); day.wind_max_ms = r1(Math.max(...xs)); day.wind_mean_ms = r1(mean(xs)); }
      if (v === 'precip_day') {
        day.precip_mm = r1(mixed.filter(Number.isFinite).reduce((a, b) => a + b, 0));
        const wet = ok.filter((m) => idx.reduce((a, i) => a + (Number(series(v, m)[i]) || 0), 0) >= 0.5).length;
        day.precip_yes = ok.length ? wet * 2 >= ok.length : null;   // a tie counts as yes, as in the judge (mean >= 0.5)
        day.precip_models_wet = `${wet}/${ok.length}`;
      }
    }
    day.models = { temperature: used[`t2m_c|${lead}`], wind: used[`wind10_ms|${lead}`], precipitation: used[`precip_day|${lead}`] };
    if (d >= 4) day.note = 'lead beyond 96 h: ranking of 72 h used, not measured further';
    outDays.push(day);
  });
  // The judge: measured out-of-sample score of the ranking that was used, per variable (24 h lead).
  const judgeVar = (v) => {
    const pl = plan[`${v}|24`] || plan[Object.keys(plan).find((k) => k.startsWith(v))];
    const roll = pl.s.roll || {};
    const dflt = pl.strategy === 'default';
    return {
      level: pl.level, ranking_of: pl.key, strategy: dflt ? 'open-meteo default (the mix measured worse here)' : `mean of the top ${K}`, models_now: used[`${v}|24`] || pl.cand.slice(0, K),
      gain_vs_open_meteo_default_pct: dflt ? 0 : roll.gain_vs_best_match_pct ?? null, mix_gain_vs_open_meteo_default_pct: roll.gain_vs_best_match_pct ?? null, gain_vs_best_fixed_model_pct: dflt ? null : roll.gain_vs_best_fixed_pct ?? null,
      best_fixed_model: roll.best_fixed || null, error_mix: roll.mae_mix ?? null, error_open_meteo_default: roll.mae_best_match ?? null, n: roll.n ?? null,
      unit: v === 't2m_c' ? 'MAE deg C, hourly, 24 h lead' : v === 'wind10_ms' ? 'MAE m/s, hourly, 24 h lead' : 'error rate rain yes/no per UTC day (days here are local), 24 h lead',
    };
  };
  const de = L === 'de';
  const jt = judgeVar('t2m_c'), jw = judgeVar('wind10_ms');
  const fmt = (x) => (x == null ? '?' : de ? String(x).replace('.', ',') : String(x));
  const where = pick.level === 'station' ? (de ? `Station ${pick.station.name} (${fmt(pick.station.distance_km)} km)` : `station ${pick.station.name} (${pick.station.distance_km} km)`) : pick.level === 'region' ? (de ? `Region ${pick.region}` : `region ${pick.region}`) : (de ? 'globale Rangliste' : 'global ranking');
  const part = (name, x) => (x.strategy.startsWith('open-meteo')
    ? (de ? `${name}: Open-Meteo-Standard behalten (Mix hier ${fmt(Math.abs(x.mix_gain_vs_open_meteo_default_pct))} % schlechter gemessen)` : `${name}: Open-Meteo default kept (mix measured ${Math.abs(x.mix_gain_vs_open_meteo_default_pct)} % worse here)`)
    : (de ? `${name} ${fmt(x.gain_vs_open_meteo_default_pct)} % weniger Fehler als der Open-Meteo-Standard` : `${name} ${x.gain_vs_open_meteo_default_pct} % lower error than Open-Meteo's default`));
  const summary = de
    ? `Mittel der ${K} besten Modelle laut Richter, ${where}; gemessen rollierend 01.08. bis 12.10.2026: ${part('Temperatur', jt)}; ${part('Wind', jw)}`
    : `mean of the ${K} best models per the judge, ${where}; measured rolling 2026-08-01 to 10-12: ${part('temperature', jt)}; ${part('wind', jw)}`;
  return {
    ok: true,
    place: { name: p.name, lat: Math.round(p.lat * 1e4) / 1e4, lon: Math.round(p.lon * 1e4) / 1e4, country: p.country || null, elevation_m: p.elevation ?? null, source: p.source, ...(p.alternatives?.length ? { other_matches: p.alternatives } : {}) },
    timezone: j.timezone || null,
    days: outDays,
    provider: `open-meteo (${keys().openMeteo ? 'commercial key of the operator' : 'free, non-commercial'}): mean of the judge's top ${K} models`,
    ms: Date.now() - t0,
    judge: {
      measured_on: TABLE.judge, table: TABLE.table, ranking_window: TABLE.rank_window, evaluated: TABLE.roll_eval,
      place_ranking: pick, temperature: jt, wind: jw, precipitation: judgeVar('precip_day'), summary,
    },
    attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)',
  };
}
