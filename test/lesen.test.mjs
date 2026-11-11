import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpState, localServer, html, article, words } from './helpers.mjs';

tmpState('lesen');
const { blockedIp, checkHost, fetchPage } = await import('../src/lesen/guard.mjs');
const { readabilityHtml } = await import('../src/lesen/extract-md.mjs');
const { readPage, _resetMemory } = await import('../src/lesen/seite-lesen.mjs');
const S = await import('../src/lesen/stufen.mjs');

let srv;
before(async () => {
  srv = await localServer({
    '/artikel': (q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(html(article(400), 'Artikel')); },
    '/kurz': (q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(html('<div id="app"></div><p>Bitte JavaScript</p>')); },
    '/text': (q, r) => { r.writeHead(200, { 'content-type': 'text/plain' }); r.end(words(30)); },
    '/pdf': (q, r) => { r.writeHead(200, { 'content-type': 'application/pdf' }); r.end('%PDF'); },
    '/weg': (q, r) => { r.writeHead(302, { location: 'http://127.0.0.1:1/geheim' }); r.end(); },
    '/sperre': (q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(html('<h1>Just a moment...</h1><p>Checking your browser before accessing.</p>')); },
  });
  process.env.PYFIO_TEST_ALLOW = `127.0.0.1:${srv.port}`;
});
after(async () => { await srv.close(); delete process.env.PYFIO_TEST_ALLOW; });

test('guard refuses private, loopback, mapped and reserved addresses', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '192.168.178.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '64:ff9b::7f00:1', '2002:7f00:1::', '0.0.0.0', '224.0.0.1'])
    assert.ok(blockedIp(a), a);
  for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(blockedIp(a), null, a);
});

test('checkHost refuses localhost without the test switch', async () => {
  const save = process.env.PYFIO_TEST_ALLOW;
  delete process.env.PYFIO_TEST_ALLOW;
  await assert.rejects(checkHost('localhost', 80), (e) => e.kind === 'private');
  await assert.rejects(checkHost('127.0.0.1', srv.port), (e) => e.kind === 'private');
  process.env.PYFIO_TEST_ALLOW = save;
});

test('fetchPage: a redirect to a non-allowed local port is refused', async () => {
  await assert.rejects(fetchPage(srv.url('/weg')), (e) => e.kind === 'private');
});

test('readabilityHtml: article as Markdown, menus out; nested tables once', () => {
  const r = readabilityHtml(html(article(300)), 'https://example.org/a');
  assert.equal(r.quelle, 'readability');
  assert.match(r.text, /^## Ueberschrift|# Ueberschrift/m);
  assert.doesNotMatch(r.text, /Menue|Impressum/);
  const nested = html(`<article><h1>T</h1><p>${words(120, 'Text')}</p><table><tr><td>aussen<table><tr><td>innen</td></tr></table></td></tr><tr><td>zwei</td></tr></table><p>${words(120, 'Mehr')}</p></article>`);
  const n = readabilityHtml(nested, 'https://example.org/b');
  assert.equal((n.text.match(/innen/g) || []).length, 1, n.text);
});

// Stub stages around the real HTTP fetch: which stage ran, and with what.
function stub({ py = true, browserText = null, jinaKey = false } = {}) {
  const calls = [];
  return {
    calls,
    stages: {
      ...S,
      findPython: async () => (py ? { exe: 'x', version: 'test' } : null),
      trafilatura: async (h) => { calls.push('trafilatura'); return S.readabilityHttp(h, 'https://x'); },
      readabilityHttp: async (h, u) => { calls.push('readability-http'); return S.readabilityHttp(h, u); },
      browserAvailable: async () => true,
      browser: async (u) => { calls.push('browser'); if (!browserText) throw Object.assign(new Error('no browser'), { kind: 'browser' }); return { text: browserText, titel: 'B', quelle: 'readability', url: u }; },
      jinaEnabled: () => jinaKey,
      jina: async (u) => { calls.push('jina'); return { text: words(500, 'Jina'), titel: 'J', url: u }; },
    },
  };
}

test('cascade: stage 1 good -> no browser; provider and judge in the answer', async () => {
  _resetMemory();
  const s = stub();
  const r = await readPage(srv.url('/artikel'), { stages: s.stages });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.provider, 'trafilatura');
  assert.deepEqual(s.calls, ['trafilatura']);
  assert.equal(r.judge.measured.provider, 'trafilatura');
  assert.equal(r.judge.measured.page_class, 'sub');
  assert.ok(r.judge.live.grade);
  assert.ok(r.words >= 150);
});

test('cascade: short stage 1 -> browser; domain memory starts there next time', async () => {
  _resetMemory();
  const s = stub({ browserText: `# Gerendert\n\n${words(400, 'Inhalt')}` });
  const r1 = await readPage(srv.url('/kurz'), { stages: s.stages });
  assert.equal(r1.provider, 'browser-readability');
  assert.deepEqual(s.calls, ['trafilatura', 'browser']);
  assert.equal(r1.route.order, 'cascade');
  s.calls.length = 0;
  const r2 = await readPage(srv.url('/kurz'), { stages: s.stages });
  assert.equal(r2.provider, 'browser-readability');
  assert.equal(r2.route.order, 'domain-memory');
  assert.deepEqual(s.calls, ['browser']);
});

test('cascade without Python: readability-http is stage 1 and is judged as such', async () => {
  _resetMemory();
  const s = stub({ py: false });
  const r = await readPage(srv.url('/artikel'), { stages: s.stages });
  assert.equal(r.provider, 'readability-http');
  assert.equal(r.judge.measured.provider, 'readability-http');
  assert.ok(r.judge.measured.f1_mean > 0.5);
});

test('Jina only with a key, after the browser failed on a block page', async () => {
  _resetMemory();
  let s = stub();
  let r = await readPage(srv.url('/sperre'), { stages: s.stages });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'blocked');
  assert.ok(!s.calls.includes('jina'));
  _resetMemory();
  s = stub({ jinaKey: true });
  r = await readPage(srv.url('/sperre'), { stages: s.stages });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'jina');
});

test('refused, not HTML, plain text', async () => {
  const s = stub();
  const save = process.env.PYFIO_TEST_ALLOW;
  delete process.env.PYFIO_TEST_ALLOW;
  let r = await readPage(srv.url('/artikel'), { stages: s.stages });
  assert.equal(r.kind, 'private');
  assert.equal(s.calls.length, 0, 'no stage may see a refused address');
  process.env.PYFIO_TEST_ALLOW = save;
  r = await readPage(srv.url('/pdf'), { stages: s.stages });
  assert.equal(r.kind, 'type');
  r = await readPage(srv.url('/text'), { stages: s.stages });
  assert.equal(r.provider, 'http-text');
  r = await readPage('file:///etc/passwd', { stages: s.stages });
  assert.equal(r.kind, 'input');
  r = await readPage('http://user:pw@example.org/', { stages: s.stages });
  assert.equal(r.kind, 'input');
});

test('domain memory stores no host names in clear text', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { flushMemory } = await import('../src/lesen/seite-lesen.mjs');
  flushMemory();
  const raw = fs.readFileSync(path.join(process.env.PYFIO_STATE_DIR, 'domains.json'), 'utf8');
  assert.doesNotMatch(raw, /127\.0\.0\.1|localhost/);
});
