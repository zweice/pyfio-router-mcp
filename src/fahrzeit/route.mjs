// Driving time without an account: FOSSGIS OSRM (car) and FOSSGIS Valhalla in parallel; the OSRM demo server
// (non-commercial use only) only when both fail. None of them knows traffic; zeit.mjs adds the time-of-day
// surcharge. Rules kept: at most 1 request per second per server, own User-Agent, results cached.
import { endpoint } from '../endpoints.mjs';
import { cacheGet, cachePut } from '../cache.mjs';
import { setting } from '../config.mjs';

export const ROUTE_ATTRIBUTION = 'Routing (c) OpenStreetMap contributors (ODbL); servers: FOSSGIS e.V. (OSRM, Valhalla) or the OSRM demo server';
const DAY = 864e5;
const ll = (p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`;

async function osrm(http, base, label, from, to, { timeoutMs }) {
  const url = `${base}/route/v1/driving/${ll(from)};${ll(to)}?overview=false&alternatives=false&steps=true`;
  const { data, ms } = await http(url, { timeoutMs, gapMs: setting('fahrzeit.routerAbstandMs') });
  if (data.code !== 'Ok' || !data.routes?.[0]) throw Object.assign(new Error(`${label}: ${String(data.code || 'no route').slice(0, 40)}`), { kind: 'http' });
  const r = data.routes[0];
  const steps = r.legs?.[0]?.steps || [];
  const via = [...new Set(steps.filter((s) => s.distance > 3000 && s.ref).map((s) => s.ref.split(';')[0].replace(/\s+/g, '')))].slice(0, 4);
  return { source: label, sec: Number(r.duration), km: Number(r.distance) / 1000, via, ms };
}

async function valhalla(http, from, to, { timeoutMs }) {
  const req = { locations: [{ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon }], costing: 'auto', units: 'kilometers', directions_type: 'maneuvers' };
  const url = `${endpoint('valhalla')}/route?json=${encodeURIComponent(JSON.stringify(req))}`;
  const { data, ms } = await http(url, { timeoutMs, gapMs: setting('fahrzeit.routerAbstandMs') });
  const t = data.trip;
  if (!t || t.status !== 0) throw Object.assign(new Error(`valhalla: ${String(t?.status_message || data.error || 'no route').slice(0, 60)}`), { kind: 'http' });
  const names = new Map();
  for (const m of t.legs?.[0]?.maneuvers || []) for (const x of m.street_names || []) if (/^[AB] ?\d/.test(x) && m.length > 3) names.set(x, (names.get(x) || 0) + m.length);
  return { source: 'valhalla', sec: Number(t.summary.time), km: Number(t.summary.length), via: [...names.keys()].slice(0, 4), ms };
}

const ROUTERS = {
  'osrm-fossgis': (h, f, t, o) => osrm(h, endpoint('osrm'), 'osrm-fossgis', f, t, o),
  valhalla: (h, f, t, o) => valhalla(h, f, t, o),
  'osrm-demo': (h, f, t, o) => osrm(h, endpoint('osrm_demo'), 'osrm-demo', f, t, o),
};

// Ask the routers. cacheable = false for raw coordinates (could be a live location).
export async function routeAll(deps, from, to, { cacheable = true } = {}) {
  const { http, now = Date.now } = deps;
  const names = ['osrm-fossgis', 'valhalla'];
  const ck = { v: 1, from: ll(from), to: ll(to), names, osrm: endpoint('osrm'), valhalla: endpoint('valhalla') };
  const ttl = setting('fahrzeit.routeCacheTage') * DAY;
  if (cacheable && ttl > 0) { const c = cacheGet('route', ck, ttl, { now }); if (c) return { ...c, cached: true }; }
  const timeoutMs = setting('fahrzeit.diensteZeitlimitMs');
  const answers = [], failures = [];
  const ask = async (n) => { try { answers.push(await ROUTERS[n](http, from, to, { timeoutMs })); } catch (e) { failures.push({ source: n, error: String(e.message).slice(0, 120), kind: e.kind }); } };
  await Promise.all(names.map(ask));
  if (!answers.length) await ask('osrm-demo');
  answers.sort((a, b) => a.source.localeCompare(b.source));
  const out = { answers, failures };
  if (cacheable && ttl > 0 && answers.length && !failures.length) cachePut('route', ck, out, { now });   // partial answers are not kept
  return out;
}
