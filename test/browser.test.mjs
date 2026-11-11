// The real browser stage on a local page that only JavaScript fills; no Chromium may survive the call.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tmpState, localServer, html, words } from './helpers.mjs';

tmpState('browser');
const S = await import('../src/lesen/stufen.mjs');
const { readPage, _resetMemory } = await import('../src/lesen/seite-lesen.mjs');

const MARK = `t${process.pid}`;
process.env.PYFIO_BROWSER_MARK = MARK;
const hasBrowser = await S.browserAvailable();

function ourChromes() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name like 'chrom%'" | Where-Object { $_.CommandLine -like '*router-mark=${MARK}*' } | Measure-Object | Select-Object -ExpandProperty Count`], { encoding: 'utf8', timeout: 30000, windowsHide: true });
      return Number(out.trim()) || 0;
    }
    return execFileSync('sh', ['-c', `pgrep -f "router-mark=${MARK}" | wc -l`], { encoding: 'utf8', timeout: 10000 }).trim() * 1;
  } catch { return 0; }
}

let srv;
before(async () => {
  const text = words(300, 'Gerendert');
  srv = await localServer({
    '/js': (q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(html(`<div id="app">Lade</div><script>document.getElementById('app').innerHTML = '<article><h1>Aus JS</h1><p>${text}</p><p>${text}</p></article>';</script>`)); },
    '/zu-lokal': (q, r) => { r.writeHead(302, { location: 'http://127.0.0.1:8099/geheim' }); r.end(); },
  });
  process.env.PYFIO_TEST_ALLOW = `127.0.0.1:${srv.port}`;
});
after(async () => { await srv.close(); });

test('a page filled by JavaScript: stage 1 short, the browser delivers', { skip: !hasBrowser && 'playwright-core or Chromium missing', timeout: 90000 }, async () => {
  _resetMemory();
  const r = await readPage(srv.url('/js'));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.provider, 'browser-readability');
  assert.match(r.text, /Aus JS/);
  assert.equal(r.route.steps.length, 2);
  assert.equal(ourChromes(), 0, 'Chromium still running after the call');
});

test('the browser refuses a redirect to a refused local address', { skip: !hasBrowser && 'no browser', timeout: 90000 }, async () => {
  await assert.rejects(S.browser(srv.url('/zu-lokal'), { timeoutMs: 40000, pageMs: 25000 }), (e) => e.kind === 'private');
  assert.equal(ourChromes(), 0);
});
