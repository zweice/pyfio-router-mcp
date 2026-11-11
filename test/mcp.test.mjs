// The MCP surface: stdio (the real bin as a child process) and Streamable HTTP (in this process).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tmpState, localServer, html, article, stdioClient, initialize } from './helpers.mjs';

const dir = tmpState('mcp');
const { createHttpServer } = await import('../src/http.mjs');
const { changeSetting } = await import('../src/config.mjs');

let page;
before(async () => {
  page = await localServer({ '/a': (q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(html(article(400), 'Seite A')); } });
});
after(async () => { await page.close(); });

test('stdio: initialize, tools/list in English, read_page with provider and judge, counted', { timeout: 90000 }, async () => {
  const c = stdioClient({ PYFIO_STATE_DIR: dir, PYFIO_TEST_ALLOW: `127.0.0.1:${page.port}`, PYFIO_LANG: 'en' });
  try {
    const init = await initialize(c, 'Test Client');
    assert.equal(init.result.serverInfo.name, 'pyfio-router');
    assert.ok(init.result.instructions.includes('judge'));
    const list = await c.request('tools/list', {});
    assert.deepEqual(list.result.tools.map((t) => t.name), ['read_page', 'weather', 'travel_time', 'web_search', 'build_or_use']);
    const r = await c.request('tools/call', { name: 'read_page', arguments: { url: page.url('/a'), max_chars: 1000 } });
    const out = JSON.parse(r.result.content[0].text);
    assert.equal(out.ok, true, out.error);
    assert.ok(['trafilatura', 'readability-http'].includes(out.provider));
    assert.ok(out.judge.measured.f1_mean > 0);
    assert.ok(out.text.length <= 1000);
    const bad = await c.request('tools/call', { name: 'read_page', arguments: { url: 'http://192.168.178.1/' } });
    assert.equal(bad.result.isError, true);
  } finally { await c.close(); }
  const day = new Date().toISOString().slice(0, 10);
  const files = fs.readdirSync(path.join(dir, 'zaehler', day));
  const txt = files.map((f) => fs.readFileSync(path.join(dir, 'zaehler', day, f), 'utf8')).join('');
  assert.match(txt, /read_page\|ok\|[a-z-]+\|test-client\|/);
  assert.match(txt, /read_page\|err:private/);
  assert.doesNotMatch(txt, /127\.0\.0\.1|192\.168/);
});

test('stdio: German names with PYFIO_LANG=de', { timeout: 60000 }, async () => {
  const c = stdioClient({ PYFIO_STATE_DIR: dir, PYFIO_LANG: 'de' });
  try {
    await initialize(c);
    const list = await c.request('tools/list', {});
    assert.deepEqual(list.result.tools.map((t) => t.name), ['seite_lesen', 'wetter', 'fahrzeit', 'websuche', 'bauen_oder_nutzen']);
    assert.ok(list.result.tools[1].inputSchema.properties.ort);
  } finally { await c.close(); }
});

// ---------- hosted mode ----------
const ADMIN = 'admin-token-0123456789abcdef';
let srv, base;
const stubImpl = {
  readPage: async (url) => ({ ok: true, url, title: 'T', text: 'x', words: 1, provider: 'trafilatura', judge: {} }),
  weather: async () => ({ ok: true, days: [], judge: { temperature: { strategy: 'mean of the top 3' } } }),
};
async function rpc(body, headers = {}) {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text };
}
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'http-test', version: '1' } } };
const call = (id, name = 'read_page', args = { url: 'https://example.org/' }) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('http: start', async () => {
  srv = createHttpServer({ dir, impl: stubImpl, adminToken: ADMIN });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});

test('http: initialize, tools/list and tools/call over Streamable HTTP (stateless, JSON)', async () => {
  let r = await rpc(init);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.j.result.serverInfo.name, 'pyfio-router');
  r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.equal(r.j.result.tools.length, 5);
  r = await rpc(call(3));
  assert.equal(JSON.parse(r.j.result.content[0].text).provider, 'trafilatura');
  r = await fetch(`${base}/mcp`);
  assert.equal(r.status, 405);
  const de = await fetch(`${base}/mcp?lang=de`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }) });
  assert.deepEqual((await de.json()).result.tools.map((t) => t.name), ['seite_lesen', 'wetter', 'fahrzeit', 'websuche', 'bauen_oder_nutzen']);
});

test('http: free quota per operator and day, an API key passes', async () => {
  changeSetting('http.freiProTag', 2);
  let r = await rpc(call(4));
  assert.equal(r.status, 200, 'second call of this operator today (one above)');
  r = await rpc(call(41));
  assert.equal(r.status, 429, 'third call');
  r = await rpc({ jsonrpc: '2.0', id: 42, method: 'tools/list', params: {} });
  assert.equal(r.status, 200, 'listing is never counted against the quota');
  const key = 'pk_test_' + crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(path.join(dir, 'api-keys.json'), JSON.stringify({ [crypto.createHash('sha256').update(key).digest('hex')]: { id: 'kunde-test', tier: 'router' } }));
  r = await rpc(call(5), { authorization: `Bearer ${key}` });
  assert.equal(r.status, 200);
  r = await rpc(call(6), { authorization: 'Bearer pk_wrong_123456789' });
  assert.equal(r.status, 401);
  changeSetting('http.freiProTag', null);
});

test('http: a foreign Origin is refused (DNS rebinding, CSRF)', async () => {
  const r = await rpc(init, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('http: fake door and local install reports', async () => {
  let r = await fetch(`${base}/v1/interesse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'klick', tarif: 'router', sprache: 'en' }) });
  assert.equal(r.status, 200);
  r = await fetch(`${base}/v1/interesse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(r.status, 400);
  const day = new Date().toISOString().slice(0, 10);
  r = await fetch(`${base}/v1/zaehler`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, operator: 'b'.repeat(16), days: { [day]: { 'weather|ok|open-meteo-mix|cursor|lt1s': 3 } } }) });
  assert.equal((await r.json()).days, 1);
  const stored = fs.readFileSync(path.join(dir, 'interesse', `${day}.json`), 'utf8');
  assert.doesNotMatch(stored, /127\.0\.0\.1/);
});

test('http: admin menu needs the token; a setting changes globally and resets', async () => {
  let r = await fetch(`${base}/admin/api/einstellungen`);
  assert.equal(r.status, 401);
  r = await fetch(`${base}/admin/api/einstellungen`, { headers: { authorization: `Bearer ${ADMIN}` } });
  const list = (await r.json()).settings;
  assert.ok(list.find((s) => s.key === 'lesen.minWoerter' && s.default === 150 && s.unit));
  r = await fetch(`${base}/admin/api/einstellungen`, { method: 'PUT', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'lesen.minWoerter', value: 99999 }) });
  assert.equal(r.status, 400, 'out of range');
  r = await fetch(`${base}/admin/api/einstellungen`, { method: 'PUT', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'lesen.minWoerter', value: 200 }) });
  assert.equal((await r.json()).settings.find((s) => s.key === 'lesen.minWoerter').value, 200);
  const { setting } = await import('../src/config.mjs');
  assert.equal(setting('lesen.minWoerter'), 200, 'the same value for every caller of this state folder');
  r = await fetch(`${base}/admin/api/einstellungen`, { method: 'PUT', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'lesen.minWoerter', reset: true }) });
  assert.equal(setting('lesen.minWoerter'), 150);
  r = await fetch(`${base}/admin`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('http: PYFIO_HTTP_MCP=off serves pages and counters but no tools', async () => {
  const s2 = createHttpServer({ dir, impl: stubImpl, mcp: false });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const r = await fetch(`${b2}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(init) });
  assert.equal(r.status, 503);
  const k = await fetch(`${b2}/v1/interesse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'klick', tarif: 'router', sprache: 'de' }) });
  assert.equal(k.status, 200);
  s2.closeAllConnections?.();
  await new Promise((r2) => s2.close(r2));
});

test('http: health; stop', async () => {
  const r = await fetch(`${base}/health`);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok(j.readers.stage1);
  assert.equal(j.readers.jina, false, 'no Jina in the hosted mode without written consent');
  srv.closeAllConnections?.();
  await new Promise((r2) => srv.close(r2));
});
