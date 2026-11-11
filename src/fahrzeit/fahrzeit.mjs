// travel_time (fahrzeit): driving time by car from A to B without an account. Both ends are geocoded
// (geo.mjs), two keyless routers are asked (route.mjs), a surcharge by weekday and hour is added (zeit.mjs) and
// the departure is given or back-computed from a latest arrival with the cautious time. Departure and arrival
// times are Berlin local time. No start default: "from" is required.
import { geocode, looksLikeCoord } from './geo.mjs';
import { routeAll, ROUTE_ATTRIBUTION } from './route.mjs';
import { parseWhen, withTraffic, isoLocal, clock, loadProfile } from './zeit.mjs';
import { ATTRIBUTION as GEO_ATTRIBUTION } from './geo.mjs';
import { makeHttp } from '../http-client.mjs';

const up = (x) => Math.ceil(x - 0.05);
const MEASURED = { metric: 'mean absolute error of the typical minutes against a commercial maps service', mean_error_min: null, n: null, date: null };

function endInfo(g) {
  return { label: g.best.label, confidence: g.confidence, precision: g.best.precision, ambiguous: !!g.ambiguous, ...(g.agree_m != null ? { sources_agree_m: g.agree_m } : {}), ...(g.notes?.length ? { notes: g.notes } : {}) };
}
// Link to show the route on OpenStreetMap (no account, no tracker).
const routeLink = (a, b) => `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${a.lat.toFixed(5)}%2C${a.lon.toFixed(5)}%3B${b.lat.toFixed(5)}%2C${b.lon.toFixed(5)}`;

// args: { from, to, depart_at?, arrive_by? }; deps: { http?, now? (ms clock) }
export async function travelTime(args = {}, deps = {}) {
  const now = deps.now || Date.now;
  const http = deps.http || makeHttp({ now });
  const d = { http, now };
  const from = String(args.from || '').trim(), to = String(args.to || '').trim();
  if (!from || !to) return { ok: false, error: 'from and to are required (an address, a place or "lat,lon")', kind: 'input' };
  if (args.depart_at && args.arrive_by) return { ok: false, error: 'give depart_at or arrive_by, not both', kind: 'input' };
  const nowMs = now();
  let wantDep = null, arrBy = null;
  try {
    if (args.arrive_by) arrBy = parseWhen(args.arrive_by, nowMs);
    else wantDep = parseWhen(args.depart_at || 'now', nowMs);
  } catch (e) { return { ok: false, error: e.message, kind: 'input' }; }
  const lang = args.lang === 'de' ? 'de' : 'en';
  // Both ends one after the other: the geocoders' pause is per host, the second end would wait anyway.
  const gf = await geocode(d, from, { lang });
  const gt = await geocode(d, to, { lang });
  if (!gf.ok || !gt.ok) return { ok: false, error: `address not found: ${!gf.ok ? 'from' : 'to'} (${!gf.ok ? gf.error : gt.error})`, kind: 'not_found', geocoding: { from: gf.ok ? endInfo(gf) : { ok: false, error: gf.error, sources: gf.sources }, to: gt.ok ? endInfo(gt) : { ok: false, error: gt.error, sources: gt.sources } } };
  // Raw coordinates may be a live location: those routes are never cached.
  const r = await routeAll(d, gf.best, gt.best, { cacheable: !looksLikeCoord(from) && !looksLikeCoord(to) });
  if (!r.answers.length) return { ok: false, error: 'no router reachable', kind: 'network', failures: r.failures };
  const prof = loadProfile();
  const osrm = r.answers.find((x) => x.source === 'osrm-fossgis') || r.answers.find((x) => x.source === 'osrm-demo');
  const valh = r.answers.find((x) => x.source === 'valhalla');
  const baseMin = osrm ? osrm.sec / 60 : valh.sec / 60 / prof.valhallaZuOsrm;
  const lead = osrm || valh;
  const hints = [];
  if (osrm && valh) { const q = valh.sec / osrm.sec; if (q < 0.95 || q > 1.45) hints.push(`routers disagree (Valhalla ${Math.round(valh.sec / 60)} min, OSRM ${Math.round(osrm.sec / 60)} min): check the destination`); }
  else hints.push(`only one router answered (${lead.source})`);
  for (const [g, w] of [[gf, 'from'], [gt, 'to']]) {
    const benign = (g.notes || []).every((n) => /^house number/.test(n));
    if (g.confidence === 'low' || g.ambiguous || (g.confidence === 'medium' && !benign)) hints.push(`${w} is uncertain: ${g.best.label}${g.ambiguous ? ' (ambiguous)' : ''}`);
  }
  let depMs = wantDep;
  if (arrBy !== null) {
    depMs = arrBy;
    for (let i = 0; i < 3; i++) depMs = arrBy - up(withTraffic(baseMin, depMs, prof).cauMin) * 60e3;
  }
  const t = withTraffic(baseMin, depMs, prof);
  const typ = Math.round(t.typMin), cau = up(t.cauMin);
  if (arrBy !== null) depMs = arrBy - cau * 60e3;
  return {
    ok: true,
    provider: r.answers.map((x) => x.source).join('+'),
    from: endInfo(gf),
    to: endInfo(gt),
    depart: isoLocal(depMs),
    ...(arrBy !== null ? { arrive_by: isoLocal(arrBy) } : {}),
    arrival_typical: clock(depMs + typ * 60e3),
    arrival_cautious: clock(depMs + cau * 60e3),
    minutes_typical: typ,
    minutes_cautious: cau,
    minutes_free_flow: Math.round(t.freeMin),
    distance_km: +lead.km.toFixed(1),
    via: lead.via,
    traffic: { model: 'weekday and hour surcharge on free-flow time', day: t.day, factor: t.factor, live: false },
    route_link: routeLink(gf.best, gt.best),
    hints,
    routers: r.answers.map((x) => ({ source: x.source, minutes: +(x.sec / 60).toFixed(1), km: +x.km.toFixed(1) })),
    failures: r.failures,
    judge: { measured: { ...MEASURED, mean_error_min: prof.mean_error_min, n: prof.reference_values, date: prof.calibrated }, note: 'Times are a model without live traffic; use minutes_cautious to plan.' },
    attribution: `${ROUTE_ATTRIBUTION}; ${GEO_ATTRIBUTION}`,
  };
}
