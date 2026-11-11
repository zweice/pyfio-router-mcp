// Geocoding without an account: Photon (komoot) and Nominatim (OSMF), both on OpenStreetMap data, asked side
// by side; their agreement is the judge. Open-Meteo's geocoder (GeoNames: place names and postcodes only) is
// the last fallback. Rules kept: Nominatim at most 1 request per second, own User-Agent, results cached
// (its policy asks for it; the cache is in the state folder). Anything that looks like a position is never
// cached: it may be a live location. Ported from the maintainers' own tool; no default city, no bias point.
import { endpoint } from '../endpoints.mjs';
import { cacheGet, cachePut } from '../cache.mjs';
import { HttpError } from '../http-client.mjs';
import { setting } from '../config.mjs';

export const ATTRIBUTION = 'Data (c) OpenStreetMap contributors, ODbL (Nominatim, Photon); place names GeoNames via Open-Meteo, CC BY 4.0';
const DAY = 864e5;

export const haversineM = (a, b) => {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
export const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/str\.?\b/g, 'strasse').replace(/[^a-z0-9]+/g, ' ').trim();
export const COORD_RE = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

// Coordinates in the forms people and apps paste: "53.5,10.0", "53.5 10.0", "53.5;10.0", "53,5376, 10,0226"
// (decimal comma), "geo:53.5,10.0", "53.5,10.0 (Place)", Maps URLs with @lat,lon or q=lat,lon.
export function parseCoord(s) {
  let t = String(s || '').trim();
  let m = /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/.exec(t) || /[?&](?:query|q|ll|daddr|destination|origin)=(-?\d{1,2}\.\d+)(?:,|%2C)\s*(-?\d{1,3}\.\d+)/i.exec(t);
  if (!m) {
    t = t.replace(/^geo:/i, '').replace(/;u=.*$/i, '').replace(/\s*\([^)]*\)\s*$/, '');
    m = COORD_RE.exec(t) || /^\s*(-?\d{1,2}[.,]\d+)\s*[;,\s]\s*(-?\d{1,3}[.,]\d+)\s*$/.exec(t);
  }
  if (!m) return null;
  const lat = Number(m[1].replace(',', '.')), lon = Number(m[2].replace(',', '.'));
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}
// Two numbers with 3+ decimals look like a position: such a query and anything derived from it stays off the disk.
export const looksLikeCoord = (q) => parseCoord(q) !== null || (String(q).match(/\d+[.,]\d{3,}/g) || []).length >= 2;

// What the query asks for: house number, postcode, street words. The house number is the last plain number of
// the first comma part that has one; ordinals ("17. Juni") and decimals are not house numbers.
export function queryParts(q) {
  const s = String(q);
  const plz = (s.match(/\b\d{5}\b/) || [])[0] || null;
  const rest = s.replace(/\b\d{5}\b/g, '');
  const part = rest.split(',').find((p) => /\d/.test(p)) || '';
  const cands = [...part.matchAll(/(?<![\d.,])(\d{1,4})(?:\s?([a-zA-Z])(?=$|[\s,]))?(?![\d.,])(?!\s*(?:km|m)\b)/g)];
  const last = cands[cands.length - 1];
  const hn = last ? (last[1] + (last[2] || '')).toLowerCase() : null;
  const street = last ? norm(part.slice(0, last.index)) || null : null;
  const words = [...new Set(norm(rest).split(' ').filter((w) => w.length >= 3 && !/^\d/.test(w) && !['strasse', 'platz', 'weg', 'the', 'und', 'der', 'die', 'das'].includes(w)))];
  return { plz, hn, street, words };
}

const precisionOf = (p) => (p.housenumber ? 'house' : p.street ? 'street' : ['city', 'town', 'village', 'hamlet', 'suburb', 'district', 'locality', 'county', 'state', 'country', 'postcode'].includes(p.kind) ? 'place' : 'object');
const label = (p) => [p.name && p.name !== p.street ? p.name : null, [p.street, p.housenumber].filter(Boolean).join(' ') || null, [p.postcode, p.city].filter(Boolean).join(' ') || null, p.countrycode && p.countrycode !== 'DE' ? p.country : null].filter(Boolean).join(', ');

function fromPhoton(f) {
  const p = f.properties || {};
  const r = { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], name: p.name || null, street: p.street || (p.osm_key === 'highway' ? p.name : null) || null, housenumber: p.housenumber || null,
    postcode: p.postcode || null, city: p.city || p.town || p.village || p.district || p.county || null, country: p.country || null, countrycode: (p.countrycode || '').toUpperCase() || null,
    kind: p.type || p.osm_value || null, source: 'photon' };
  return { ...r, precision: precisionOf(r), label: label(r) };
}
function fromNominatim(x) {
  const a = x.address || {};
  const r = { lat: Number(x.lat), lon: Number(x.lon), name: x.name || null, street: a.road || a.pedestrian || a.footway || null, housenumber: a.house_number || null,
    postcode: a.postcode || null, city: a.city || a.town || a.village || a.municipality || a.suburb || a.county || null, country: a.country || null, countrycode: (a.country_code || '').toUpperCase() || null,
    kind: x.addresstype || x.type || null, source: 'nominatim', importance: Number(x.importance) || 0 };
  return { ...r, precision: precisionOf(r), label: label(r) || x.display_name };
}
function fromOpenMeteo(x) {
  const r = { lat: x.latitude, lon: x.longitude, name: x.name, street: null, housenumber: null, postcode: (x.postcodes || [])[0] || null, city: x.name, country: x.country || null,
    countrycode: (x.country_code || '').toUpperCase() || null, kind: 'city', source: 'open-meteo' };
  return { ...r, precision: 'place', label: [x.name, x.admin1, x.country].filter(Boolean).join(', ') };
}

async function photonSearch(http, q, { lang, limit = 5, timeoutMs = 8000 }) {
  const u = new URL('/api/', endpoint('photon'));
  u.searchParams.set('q', q); u.searchParams.set('limit', String(limit));
  if (['de', 'en', 'fr'].includes(lang)) u.searchParams.set('lang', lang);
  const { data, ms } = await http(u.href, { timeoutMs, gapMs: 250 });
  return { ms, hits: (data.features || []).map(fromPhoton) };
}
async function nominatimSearch(http, q, { lang, limit = 5, timeoutMs = 10000 }) {
  const u = new URL('/search', endpoint('nominatim'));
  u.searchParams.set('q', q); u.searchParams.set('format', 'jsonv2'); u.searchParams.set('addressdetails', '1'); u.searchParams.set('limit', String(limit));
  u.searchParams.set('accept-language', lang);
  const { data, ms } = await http(u.href, { timeoutMs, gapMs: setting('fahrzeit.nominatimAbstandMs') });
  return { ms, hits: (Array.isArray(data) ? data : []).map(fromNominatim) };
}
async function openMeteoSearch(http, q, { lang, timeoutMs = 8000 }) {
  const name = String(q).split(',')[0].replace(/\b\d{5}\b/g, '').trim();
  const u = new URL('/v1/search', endpoint('open_meteo_geocoding'));
  u.searchParams.set('name', name); u.searchParams.set('count', '5'); u.searchParams.set('language', lang); u.searchParams.set('format', 'json');
  const { data, ms } = await http(u.href, { timeoutMs, gapMs: 200 });
  return { ms, hits: (data.results || []).map(fromOpenMeteo) };
}

// How well a hit fits the query: house number and postcode are hard evidence.
function fit(hit, parts, { words = true } = {}) {
  let s = 0;
  if (parts.hn) s += hit.housenumber && hit.housenumber.replace(/\s/g, '').toLowerCase() === parts.hn ? 3 : hit.housenumber && parseInt(hit.housenumber) === parseInt(parts.hn) ? 2 : hit.precision === 'house' ? -2 : -1;
  if (parts.plz) s += hit.postcode === parts.plz ? 2 : hit.postcode ? -2 : 0;
  if (parts.street && hit.street) { const a = norm(hit.street), b = parts.street; s += a === b ? 2 : a.includes(b) || b.includes(a) ? 1 : -3; }
  // Share of the query's words found in the hit (city, name, country): "Sydney Opera House" must not land in Douglas, USA.
  if (words && parts.words?.length) {
    const hay = ` ${norm([hit.label, hit.name, hit.city, hit.country].join(' '))} `;
    s += 3 * (parts.words.filter((w) => hay.includes(` ${w} `)).length / parts.words.length);
  }
  return s;
}
const tolM = { house: 150, street: 1000, object: 1000, place: 6000 };

// geocode(deps, query, { lang, cache }) -> { ok, query, best, agree_m, confidence: high|medium|low, ambiguous, notes, alternatives, sources }
// deps: { http, now }
export async function geocode(deps, q, { lang = 'en', cache: wantCache = true } = {}) {
  const query = String(q || '').trim();
  if (!query) throw new HttpError('empty address', { kind: 'input' });
  const { http, now = Date.now } = deps;
  const c = parseCoord(query);
  if (c) return { ok: true, query, best: { ...c, label: `${c.lat},${c.lon}`, precision: 'coordinate', source: 'input' }, agree_m: null, confidence: 'high', ambiguous: false, notes: [], alternatives: [], sources: [] };
  const cache = wantCache && !looksLikeCoord(query);
  const ck = { v: 1, query, lang };
  const ttl = setting('fahrzeit.geoCacheTage') * DAY;
  if (cache && ttl > 0) { const hit = cacheGet('geo', ck, ttl, { now }); if (hit) return { ...hit, cached: true }; }

  const parts = queryParts(query);
  const sources = [];
  const run = async (name, fn) => {
    try { const r = await fn(); sources.push({ name, ok: true, ms: r.ms, n: r.hits.length }); return r.hits; }
    catch (e) { sources.push({ name, ok: false, error: String(e.message).slice(0, 120), kind: e.kind }); return null; }
  };
  const timeoutMs = setting('fahrzeit.diensteZeitlimitMs');
  const [ph, no] = await Promise.all([run('photon', () => photonSearch(http, query, { lang, timeoutMs })), run('nominatim', () => nominatimSearch(http, query, { lang, timeoutMs }))]);
  let pool = [...(ph || []).map((h, i) => ({ ...h, rank: i })), ...(no || []).map((h, i) => ({ ...h, rank: i }))];
  if (!pool.length) { const om = await run('open-meteo', () => openMeteoSearch(http, query, { lang, timeoutMs })); pool = (om || []).map((h, i) => ({ ...h, rank: i })); }
  if (!pool.length) {
    const allDown = sources.every((s) => !s.ok);
    return { ok: false, query, error: allDown ? 'all geocoders unreachable' : 'no match', sources };
  }
  for (const h of pool) h.score = fit(h, parts) * 10 + (h.importance || 0) * 4 - h.rank * 2;
  pool.sort((a, b) => b.score - a.score);
  const best = pool[0];
  const other = pool.find((h) => h.source !== best.source && h.rank === 0) || pool.find((h) => h.source !== best.source);
  const agreeM = other ? Math.round(haversineM(best, other)) : null;
  const tol = tolM[best.precision] ?? 1000;
  const fitOk = fit(best, parts, { words: false }) >= (parts.hn ? 3 : 0) + (parts.plz ? 2 : 0) + (parts.street ? 2 : 0) - 1;
  // high: both sources agree and the hit fits; low: the sources disagree widely; a single source is at most medium.
  const confidence = agreeM === null ? (fitOk ? 'medium' : 'low') : agreeM > tol * 3 ? 'low' : agreeM <= tol && fitOk ? 'high' : 'medium';
  // Ambiguous: good-looking hits more than 5 km apart in different places.
  const rivals = pool.filter((h) => h !== best && h.score >= best.score - 6 && haversineM(best, h) > 5000 && h.city !== best.city);
  const ambiguous = rivals.length > 0 && !parts.plz;
  const seen = new Set();
  const alternatives = pool.slice(1).filter((h) => { const k = `${h.label}|${Math.round(h.lat * 1e3)}|${Math.round(h.lon * 1e3)}`; if (seen.has(k) || h.label === best.label) return false; seen.add(k); return true; })
    .slice(0, 3).map((h) => ({ label: h.label, precision: h.precision, source: h.source, distance_m: Math.round(haversineM(best, h)) }));
  const strip = ({ score, rank, importance, ...h }) => h;
  const notes = [];
  if (parts.hn && !(best.housenumber && parseInt(best.housenumber) === parseInt(parts.hn))) notes.push(`house number ${parts.hn} is not in OpenStreetMap, the match is the ${best.precision === 'street' ? 'street' : 'nearest fitting place'}`);
  if (parts.street && best.street && norm(best.street) !== parts.street && !norm(best.street).includes(parts.street)) notes.push(`street differs: ${best.street}`);
  if (parts.plz && best.postcode && best.postcode !== parts.plz) notes.push(`postcode differs: ${best.postcode} instead of ${parts.plz}`);
  if (ambiguous) notes.push('ambiguous: name the place');
  const out = { ok: true, query, best: strip(best), agree_m: agreeM, confidence, ambiguous, notes, alternatives, sources };
  if (cache && ttl > 0 && best.source !== 'open-meteo' && sources.every((x) => x.ok)) cachePut('geo', ck, out, { now });   // partial answers are not kept
  return out;
}
