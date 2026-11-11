// Regression tests for the findings of the review of 2026-10-20 (an internal review).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import { tmpState, localServer, html, words } from './helpers.mjs';

const dir = tmpState('review');
const { createHttpServer } = await import('../src/http.mjs');
const { changeSetting } = await import('../src/config.mjs');
const Z = await import('../src/zaehler.mjs');
const R = await import('../src/lesen/robots.mjs');
const { isBlockPage, countWords } = await import('../src/richter/seite-richter.mjs');
const S = await import('../src/lesen/stufen.mjs');

const stubImpl = {
  readPage: async (url) => ({ ok: true, url, provider: 'trafilatura', judge: {} }),
  weather: async () => ({ ok: true, days: [], judge: { temperature: { strategy: 'mean of the top 3' } } }),
};
let srv, base;
before(async () => {
  srv = createHttpServer({ dir, impl: stubImpl, trustProxy: true });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); });

const call = (id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'read_page', arguments: { url: 'https://example.org/' } } });
const post = (body, headers = {}) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });

test('a JSON-RPC batch: every tools/call counts, more than allowed per request is refused', async () => {
  changeSetting('http.freiProTag', 3);
  let r = await post([call(1), call(2), call(3)], { 'x-forwarded-for': '203.0.113.9' });
  assert.equal(r.status, 400, 'default: one call per request');
  changeSetting('http.maxAufrufeJeAnfrage', 5);
  r = await post([call(1), call(2), call(3), call(4)], { 'x-forwarded-for': '203.0.113.9' });
  assert.equal(r.status, 429, '4 calls are over a quota of 3');
  r = await post([call(1), call(2)], { 'x-forwarded-for': '203.0.113.9' });
  assert.equal(r.status, 200);
  r = await post([call(3), call(4)], { 'x-forwarded-for': '203.0.113.9' });
  assert.equal(r.status, 429, '2 + 2 > 3');
  changeSetting('http.maxAufrufeJeAnfrage', null);
  changeSetting('http.freiProTag', null);
});

test('behind a proxy the last X-Forwarded-For entry counts, not the client-chosen first one', async () => {
  changeSetting('http.freiProTag', 1);
  let r = await post(call(1), { 'x-forwarded-for': '1.1.1.1, 198.51.100.50' });
  assert.equal(r.status, 200);
  r = await post(call(2), { 'x-forwarded-for': '2.2.2.2, 198.51.100.50' });
  assert.equal(r.status, 429);
  changeSetting('http.freiProTag', null);
});

test('DNS rebinding: a foreign Host on the loopback socket is refused', async () => {
  const r = await new Promise((resolve, reject) => {
    const http = require_('node:http');
    const q = http.request({ host: '127.0.0.1', port: srv.address().port, path: '/health', headers: { host: 'evil.example:80', origin: 'http://evil.example:80' } }, (res) => { res.resume(); resolve(res.statusCode); });
    q.on('error', reject); q.end();
  });
  assert.equal(r, 421);
});

test('an oversized body gets 413, not a connection reset', async () => {
  const r = await fetch(`${base}/v1/interesse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(20000) });
  assert.equal(r.status, 413);
});

test('reports of local installs are limited per sender and hour', async () => {
  changeSetting('http.berichteProStunde', 2);
  const day = Z.dayOf();
  const rep = (op) => fetch(`${base}/v1/zaehler`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.77' }, body: JSON.stringify({ v: 1, operator: op, days: { [day]: { 'weather|ok|open-meteo-mix|x|lt1s': 1 } } }) });
  assert.equal((await rep('1'.repeat(16))).status, 200);
  assert.equal((await rep('2'.repeat(16))).status, 200);
  assert.equal((await rep('3'.repeat(16))).status, 429);
  changeSetting('http.berichteProStunde', null);
});

test('an unwritable state folder keeps one salt (the quota holds)', () => {
  const f = path.join(os.tmpdir(), `pyfio-router-file-${process.pid}`);
  fs.writeFileSync(f, 'not a folder');
  const a = Z.requestPseudonym({ ip: '198.51.100.7' }, f), b = Z.requestPseudonym({ ip: '198.51.100.7' }, f);
  assert.equal(a, b);
  assert.equal(Z.installPseudonym(f), Z.installPseudonym(f));
});

test('an article that mentions captcha further down is no block page', () => {
  const text = `# Login-Schutz im Test\n\n${words(200, 'Absatz')} Am Ende ein Satz über Captcha und Bot-Schutz.`;
  assert.equal(isBlockPage(text, countWords(text)), false);
  assert.equal(isBlockPage('Just a moment... Checking your browser before accessing example.org', 9), true);
});

test('robots.txt: percent-encoded paths, exact product token', () => {
  const g = R.parseRobots('User-agent: *\nDisallow: /über-uns\nDisallow: /a%3cd.html\n\nUser-agent: io\nDisallow: /\n');
  assert.equal(R.robotsAllows(g, new URL('https://x.de/über-uns/team').pathname), false);
  assert.equal(R.robotsAllows(g, '/a%3Cd.html'), false);
  assert.equal(R.robotsAllows(g, '/anderes'), true, '"io" is not our token');
  assert.equal(R.robotsAllows(R.parseRobots('User-agent: PyfioRouter/0.1\nDisallow: /x\n'), '/x/y'), false);
});

test('a robots.txt without content type is read', async () => {
  const s = await localServer({ '/robots.txt': (q, r) => { r.writeHead(200); r.end('User-agent: *\nDisallow: /zu\n'); } });
  process.env.PYFIO_TEST_ALLOW = `127.0.0.1:${s.port}`;
  R._clearRobots();
  assert.equal((await R.robotsCheck(new URL(s.url('/offen')))).allowed, true);
  assert.equal((await R.robotsCheck(new URL(s.url('/zu/x')))).allowed, false);
  await s.close();
});

test('rain: a tie of an even mix counts as yes, as in the judge', async () => {
  const W = await import('../src/wetter/wetter.mjs');
  changeSetting('wetter.topK', 2);
  const seg = W.JUDGE_TABLE.regions['Deutschland|precip_day|24'];
  const [a] = seg.rank;
  const fetchJson = async (url) => {
    if (url.includes('/v1/search')) return { results: [{ name: 'Dresden', latitude: 51.13, longitude: 13.75, country_code: 'DE', elevation: 228 }] };
    const u = new URL(url);
    const time = Array.from({ length: 24 }, (_, h) => `2026-10-20T${String(h).padStart(2, '0')}:00`);
    const hourly = { time };
    for (const m of u.searchParams.get('models').split(',')) {
      hourly[`temperature_2m_${m}`] = time.map(() => 5); hourly[`wind_speed_10m_${m}`] = time.map(() => 2);
      hourly[`precipitation_${m}`] = time.map(() => (m === a ? 0.1 : 0));
    }
    return { timezone: 'Europe/Berlin', hourly };
  };
  const r = await W.weather({ place: 'Dresden', days: 1 }, { fetchJson });
  assert.equal(r.days[0].precip_models_wet, '1/2');
  assert.equal(r.days[0].precip_yes, true);
  changeSetting('wetter.topK', null);
});

test('without a Chromium download the browser stage reports itself unavailable', async () => {
  const ok = await S.browserAvailable();
  const m = await import('playwright-core');
  assert.equal(ok, fs.existsSync(m.chromium.executablePath()));
  assert.equal(S.noPaths('Executable doesn\'t exist at C:\\Users\\x\\AppData\\chrome.exe'), 'Executable doesn\'t exist at <path>');
});

const hasBrowser = await S.browserAvailable();
test('WebRTC in the browser stage sends no UDP past the guard proxy', { skip: !hasBrowser && 'no Chromium', timeout: 90000 }, async () => {
  const udp = dgram.createSocket('udp4');
  let packets = 0;
  udp.on('message', () => { packets++; });
  await new Promise((r) => udp.bind(0, '127.0.0.1', r));
  const port = udp.address().port;
  const s = await localServer({
    '/rtc': (q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(html(`<article><h1>RTC</h1><p>${words(200, 'Text')}</p></article><script>try { const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${port}' }] }); pc.createDataChannel('x'); pc.createOffer().then((o) => pc.setLocalDescription(o)); } catch (e) {}</script>`)); },
  });
  process.env.PYFIO_TEST_ALLOW = `127.0.0.1:${s.port}`;
  await S.browser(s.url('/rtc'), { timeoutMs: 40000, pageMs: 25000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  udp.close();
  await s.close();
  assert.equal(packets, 0);
});

import { createRequire } from 'node:module';
function require_(m) { return createRequire(import.meta.url)(m); }
