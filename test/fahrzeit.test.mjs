// travel_time: geocoding, routing, the surcharge, back-computing the departure, polite use. Against a fake upstream.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpState } from './helpers.mjs';
import { fakeUpstreams } from './fakes.mjs';

const dir = tmpState('fahrzeit');
const { travelTime } = await import('../src/fahrzeit/fahrzeit.mjs');
const { geocode, parseCoord, looksLikeCoord, queryParts } = await import('../src/fahrzeit/geo.mjs');
const { parseWhen, berlinMs, berlinParts, holiday, withTraffic, loadProfile, isoLocal, clock } = await import('../src/fahrzeit/zeit.mjs');
const { makeHttp } = await import('../src/http-client.mjs');
const { createGate } = await import('../src/gate.mjs');

let fake;
before(async () => { fake = await fakeUpstreams(); Object.assign(process.env, fake.env); });
after(async () => { await fake.close(); for (const k of Object.keys(fake.env)) delete process.env[k]; });
const noCache = () => { process.env.PYFIO_CACHE = 'off'; };
const withCache = () => { delete process.env.PYFIO_CACHE; };
const NOW = Date.parse('2026-11-02T11:00:00Z');   // Monday 12:00 Berlin
const A = { from: 'Alpha station', to: 'Beta station', depart_at: '2026-11-03 09:00' };   // Tuesday

test('a drive: both ends geocoded with a confidence, two routers, the weekday surcharge, a route link', async () => {
  noCache();
  const r = await travelTime(A, { now: () => NOW });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.from.confidence, 'high');
  assert.equal(r.to.confidence, 'high');
  assert.match(r.from.label, /Alpha/);
  assert.equal(r.provider, 'osrm-fossgis+valhalla');
  assert.equal(r.distance_km, 100);
  assert.deepEqual(r.routers.map((x) => [x.source, x.minutes]), [['osrm-fossgis', 60], ['valhalla', 65]]);
  // Tuesday 09:00: factors 1.12 typical, 1.30 cautious on 60 minutes of free-flow OSRM time
  assert.equal(r.minutes_typical, 67);
  assert.equal(r.minutes_cautious, 78);
  assert.equal(r.depart, '2026-11-03T09:00');
  assert.equal(r.arrival_typical, '10:07');
  assert.equal(r.arrival_cautious, '10:18');
  assert.equal(r.traffic.day, 'weekday');
  assert.equal(r.traffic.live, false);
  assert.match(r.route_link, /^https:\/\/www\.openstreetmap\.org\/directions\?engine=fossgis_osrm_car&route=53\.5\d+%2C10\.0\d+%3B52\.5\d+%2C13\.3\d+$/);
  assert.equal(r.judge.measured.mean_error_min, 2.1);
  assert.equal(r.judge.measured.n, 23);
  assert.deepEqual(r.hints, []);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(`${'Hafer'}${'weg'}|${'Sol'}${'tau'}|Alpha station`), 'no personal default and no echo of the raw input');
});

test('the departure is computed backwards from a latest arrival with the cautious time', async () => {
  noCache();
  const r = await travelTime({ from: A.from, to: A.to, arrive_by: '2026-11-03 09:00' }, { now: () => NOW });
  assert.equal(r.ok, true);
  assert.equal(r.arrive_by, '2026-11-03T09:00');
  assert.equal(r.arrival_cautious, '09:00');
  const [h, m] = r.depart.slice(11).split(':').map(Number);
  assert.equal(h * 60 + m + r.minutes_cautious, 9 * 60, 'depart + cautious minutes = arrival');
  assert.ok(r.minutes_cautious > 78, 'the rush hour before 09:00 is slower than the 09:00 value');
});

test('from is required (no start place is assumed), depart_at and arrive_by exclude each other, bad times are refused', async () => {
  const before = fake.hits.length;
  let r = await travelTime({ to: 'Beta station' });
  assert.deepEqual([r.ok, r.kind], [false, 'input']);
  assert.match(r.error, /from and to are required/);
  r = await travelTime({ from: 'Alpha station', to: 'Beta station', depart_at: '07:45', arrive_by: '09:00' });
  assert.equal(r.kind, 'input');
  r = await travelTime({ from: 'Alpha station', to: 'Beta station', depart_at: '25:99' });
  assert.equal(r.kind, 'input');
  r = await travelTime({ from: 'Alpha station', to: 'Beta station', depart_at: 'whenever' });
  assert.equal(r.kind, 'input');
  assert.equal(fake.hits.length, before, 'nothing was asked of any service');
});

test('an unknown address says which end was not found and what the geocoders said', async () => {
  noCache();
  const r = await travelTime({ from: 'Alpha station', to: 'Nowhereville 9', depart_at: '2026-11-03 09:00' }, { now: () => NOW });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'not_found');
  assert.match(r.error, /to/);
  assert.equal(r.geocoding.to.ok, false);
});

test('one router down: the other answers and the answer says so; all down: a clear error', async () => {
  noCache();
  try {
  fake.mode.downPrefixes = ['/route/v1'];
  let r = await travelTime(A, { now: () => NOW });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'valhalla');
  assert.ok(r.hints.some((h) => /only one router answered/.test(h)));
  assert.equal(r.minutes_free_flow, Math.round(65 / 1.13 * 1.03), 'Valhalla time scaled to OSRM, then the free-flow factor');
  assert.deepEqual(r.failures.map((f) => f.source), ['osrm-fossgis'], 'the failure is reported');
  fake.mode.downPrefixes = ['/route'];
  r = await travelTime(A, { now: () => NOW });
  assert.deepEqual([r.ok, r.kind], [false, 'network']);
  assert.match(r.error, /no router reachable/);
  assert.deepEqual(r.failures.map((f) => f.source).sort(), ['osrm-demo', 'osrm-fossgis', 'valhalla'], 'the demo server is the last resort');
  } finally { fake.mode.downPrefixes = []; }
});

test('geocoders and routes are cached in the state folder; coordinates never', async () => {
  withCache();
  const cacheDir = path.join(dir, 'cache');
  fs.rmSync(cacheDir, { recursive: true, force: true });
  const count = (re) => fake.hits.filter((h) => re.test(h.path)).length;
  await travelTime(A, { now: () => NOW });
  const geo1 = count(/^\/search$/), route1 = count(/^\/route/);
  assert.ok(fs.existsSync(path.join(cacheDir, 'geo')));
  assert.ok(fs.existsSync(path.join(cacheDir, 'route')));
  const again = await travelTime(A, { now: () => NOW });
  assert.equal(again.ok, true);
  assert.equal(count(/^\/search$/), geo1, 'no new geocoder request');
  assert.equal(count(/^\/route/), route1, 'no new route request');
  // positions: nothing on disk
  fs.rmSync(cacheDir, { recursive: true, force: true });
  const c = await travelTime({ from: '53.5530,10.0060', to: '52.5250,13.3690', depart_at: '2026-11-03 09:00' }, { now: () => NOW });
  assert.equal(c.ok, true);
  assert.equal(c.from.precision, 'coordinate');
  const files = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir, { recursive: true }).filter((f) => f.endsWith('.json')) : [];
  assert.deepEqual(files, [], 'nothing about positions is kept');
  const mixed = await travelTime({ from: 'Alpha station', to: '52.5250,13.3690', depart_at: '2026-11-03 09:00' }, { now: () => NOW });
  assert.equal(mixed.ok, true);
  assert.ok(!fs.existsSync(path.join(cacheDir, 'route')), 'a route with a coordinate is not cached either');
  noCache();
});

test('polite use: own User-Agent, and Nominatim is asked at most once a second (fake clock, no real waiting)', async () => {
  noCache();
  process.env.PYFIO_RATE_LIMIT = 'on';
  try {
    let t = 1_000_000;
    const now = () => t;
    const sleeps = [];
    const gate = createGate({ now, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
    const log = [];
    const spy = { turn: async (host, gap) => { await gate.turn(host, gap); log.push({ gap, t }); } };
    fake.hits.length = 0;
    const r = await travelTime(A, { http: makeHttp({ gate: spy, now }), now: () => NOW });
    assert.equal(r.ok, true, r.error);
    const nom = log.filter((x) => x.gap === 1100);
    assert.ok(nom.length >= 3, 'two geocodings and two routers have a 1.1 s gap');
    for (let i = 1; i < nom.length; i++) assert.ok(nom[i].t - nom[i - 1].t >= 1100, `request ${i} came ${nom[i].t - nom[i - 1].t} ms after the one before`);
    assert.ok(sleeps.length > 0 && sleeps.every((s) => s <= 1100), 'it slept in the fake clock only');
    assert.ok(fake.hits.length >= 6);
    assert.ok(fake.hits.every((h) => /^pyfio-router\/\d+\.\d+\.\d+ \(\+https:\/\/pyfio\.com\)$/.test(h.ua)), 'an identifying User-Agent on every request');
  } finally { process.env.PYFIO_RATE_LIMIT = 'off'; }
});

test('PYFIO_USER_AGENT adds the operator\'s own contact', async () => {
  noCache();
  process.env.PYFIO_USER_AGENT = 'my-app/1.0 (ops@example.org)';
  try {
    fake.hits.length = 0;
    await travelTime(A, { now: () => NOW });
    assert.ok(fake.hits.length > 0 && fake.hits.every((h) => h.ua === 'my-app/1.0 (ops@example.org)'));
  } finally { delete process.env.PYFIO_USER_AGENT; }
});

// ---------- geocoding confidence, with stubbed services ----------
const stub = (nominatim, photon) => async (url) => {
  if (url.includes('/search?')) return { data: nominatim, ms: 1 };
  if (url.includes('/api/?')) return { data: photon, ms: 1 };
  return { data: { results: [] }, ms: 1 };
};
const nomHit = (lat, lon, extra = {}) => ({ lat: String(lat), lon: String(lon), name: 'Zed', addresstype: 'building', importance: 0.5, address: { road: 'Zedweg', city: 'Zedstadt', country: 'Germany', country_code: 'de', ...extra } });
const phoHit = (lat, lon) => ({ geometry: { coordinates: [lon, lat] }, properties: { name: 'Zed', street: 'Zedweg', city: 'Zedstadt', countrycode: 'DE', type: 'house' } });

test('confidence: both sources agree = high, far apart = low, one source = medium', async () => {
  noCache();
  const now = () => NOW;
  let g = await geocode({ http: stub([nomHit(53, 10)], { features: [phoHit(53.0002, 10.0002)] }), now }, 'Zed');
  assert.equal(g.confidence, 'high');
  g = await geocode({ http: stub([nomHit(53, 10)], { features: [phoHit(54, 11)] }), now }, 'Zed');
  assert.equal(g.confidence, 'low');
  g = await geocode({ http: stub([nomHit(53, 10)], { features: [] }), now }, 'Zed');
  assert.equal(g.confidence, 'medium');
  const down = async () => { throw Object.assign(new Error('x'), { kind: 'network' }); };
  g = await geocode({ http: down, now }, 'Zed');
  assert.deepEqual([g.ok, g.error], [false, 'all geocoders unreachable']);
});

test('a missing house number is said, not hidden', async () => {
  noCache();
  const g = await geocode({ http: stub([nomHit(53, 10, { road: 'Zedweg' })], { features: [phoHit(53, 10)] }), now: () => NOW }, 'Zedweg 30b');
  assert.ok(g.notes.some((n) => /house number 30b is not in OpenStreetMap/.test(n)), JSON.stringify(g.notes));
  assert.notEqual(g.confidence, 'high');
});

test('coordinates in the forms people paste', () => {
  assert.deepEqual(parseCoord('53.5,10.0'), { lat: 53.5, lon: 10 });
  assert.deepEqual(parseCoord('53,5376, 10,0226'), { lat: 53.5376, lon: 10.0226 });
  assert.deepEqual(parseCoord('geo:53.5,10.0'), { lat: 53.5, lon: 10 });
  assert.deepEqual(parseCoord('https://maps.example/@53.5,10.0,15z'), { lat: 53.5, lon: 10 });
  assert.equal(parseCoord('91,10'), null);
  assert.equal(parseCoord('Main Street 5'), null);
  assert.ok(looksLikeCoord('near 53.5530 and 10.0060'));
  assert.ok(!looksLikeCoord('17. Juni 1953'));
  assert.deepEqual(queryParts('Zedweg 30b, 20099 Zedstadt'), { plz: '20099', hn: '30b', street: 'zedweg', words: ['zedweg', 'zedstadt'] });
});

// ---------- times ----------
test('departure and arrival times in several spellings (Berlin time, fixed clock)', () => {
  const now = Date.parse('2026-11-02T11:00:00Z');   // Monday 12:00
  const at = (s) => isoLocal(parseWhen(s, now));
  assert.equal(at('now'), '2026-11-02T12:00');
  assert.equal(at('jetzt'), '2026-11-02T12:00');
  assert.equal(at('13:30'), '2026-11-02T13:30');
  assert.equal(at('07:45'), '2026-11-03T07:45', 'past by more than an hour: tomorrow');
  assert.equal(at('tue 07:45'), '2026-11-03T07:45');
  assert.equal(at('di 07:45'), '2026-11-03T07:45');
  assert.equal(at('mon 07:45'), '2026-11-09T07:45', 'today\'s weekday and past: next week');
  assert.equal(at('tomorrow 17:00'), '2026-11-03T17:00');
  assert.equal(at('morgen 17:00'), '2026-11-03T17:00');
  assert.equal(at('2026-12-24T18:15'), '2026-12-24T18:15');
  assert.equal(at('2026-12-24 8:05'), '2026-12-24T08:05');
  for (const bad of ['25:00', '12:60', 'soon', '']) if (bad) assert.throws(() => parseWhen(bad, now), /input|invalid|understood/i);
});

test('Berlin wall clock across the summer-time change and holidays count as Sunday', () => {
  const ms = berlinMs('2026-03-29', 3, 30);   // the change happens at 02:00 -> 03:00
  assert.deepEqual([berlinParts(ms).date, berlinParts(ms).hour, berlinParts(ms).minute], ['2026-03-29', 3, 30]);
  assert.equal(clock(berlinMs('2026-10-25', 4, 15)), '04:15');
  assert.equal(holiday('2026-12-25'), 'Christmas Day');
  assert.equal(holiday('2026-04-03'), 'Good Friday');
  assert.equal(holiday('2026-11-03'), null);
  const prof = loadProfile();
  const weekday = withTraffic(60, berlinMs('2026-11-03', 8, 0), prof);
  const holidayDrive = withTraffic(60, berlinMs('2026-12-25', 8, 0), prof);
  assert.equal(weekday.day, 'weekday');
  assert.match(holidayDrive.day, /^holiday/);
  assert.ok(weekday.typMin > holidayDrive.typMin);
  assert.equal(withTraffic(60, berlinMs('2026-11-08', 8, 0), prof).day, 'sunday');
  assert.equal(withTraffic(60, berlinMs('2026-11-07', 8, 0), prof).day, 'saturday');
});
