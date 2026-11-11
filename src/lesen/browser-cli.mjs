#!/usr/bin/env node
// The browser stage of read_page, as its own process (src/lesen/stufen.mjs starts it), so a hanging
// Chromium ends with its process tree. Copied from werkzeuge/lib/lesen-browser.mjs (job aqwuj,
// 2026-10-18): headless Chromium from playwright-core, Mozilla Readability 0.6.0 (Apache 2.0), the
// article as Markdown (extract-md.mjs). Every request of the browser goes through a guard proxy in
// this process that checks the target like the HTTP step and connects to the checked address:
// redirects, frames and scripts included ("<-loopback>" sends 127.0.0.1 through it too). No images,
// fonts, media; no clicks; no cookies kept; context and browser closed in any case.
//   node src/lesen/browser-cli.mjs --url=<url> [--ms=30000]    -> one JSON line
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import { checkHost, pinnedLookup, ACCEPT_LANGUAGE } from './guard.mjs';
import { extract } from './extract-md.mjs';

const require = createRequire(import.meta.url);
const READABILITY = fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf8');
const BLOCK = new Set(['image', 'media', 'font']);
const HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'transfer-encoding', 'te', 'trailer', 'upgrade'];
const kindErr = (msg, kind) => Object.assign(new Error(msg), { kind });
const cleanMsg = (e) => String(e?.message || e).split('\n')[0].replace(/\s+/g, ' ').slice(0, 200);
const bare = (h) => String(h || '').replace(/^\[|\]$/g, '');

async function playwright() {
  const specs = ['playwright-core'];
  if (process.env.PYFIO_PLAYWRIGHT) specs.push(process.env.PYFIO_PLAYWRIGHT);
  for (const spec of specs) {
    try { const m = await import(spec); const c = m.chromium || m.default?.chromium; if (c) return c; } catch {}
  }
  throw kindErr('playwright-core missing (npm install; then npx playwright-core install chromium)', 'setup');
}

function guardProxy(blocked) {
  const seen = new Map();
  const check = async (host, port) => {
    const k = `${host}:${port}`, hit = seen.get(k);
    if (hit && Date.now() - hit.t < 60000) return hit.addrs;
    const addrs = await checkHost(host, port);
    seen.set(k, { addrs, t: Date.now() });
    return addrs;
  };
  const server = http.createServer(async (req, res) => {
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
    if (u.protocol !== 'http:') { res.writeHead(400); return res.end(); }
    const host = bare(u.hostname), port = Number(u.port) || 80;
    let addrs;
    try { addrs = await check(host, port); } catch (e) {
      blocked.push({ host, kind: e.kind });
      res.writeHead(e.kind === 'private' ? 403 : 502, { 'content-type': 'text/plain', 'x-router-blocked': e.kind || 'error' });
      return res.end(e.kind === 'private' ? 'refused' : 'unreachable');
    }
    const headers = { ...req.headers };
    for (const h of HOP) delete headers[h];
    const up = http.request({ hostname: host, port, method: req.method, path: `${u.pathname}${u.search}`, headers, agent: false, ...(net.isIP(host) ? {} : { lookup: pinnedLookup(addrs) }) }, (r) => {
      const h = { ...r.headers };
      for (const k of HOP) delete h[k];
      res.writeHead(r.statusCode, h);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => up.destroy());
    req.pipe(up);
  });
  server.on('connect', async (req, sock, head) => {
    sock.on('error', () => {});
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(String(req.url || ''));
    if (!m) return sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    const host = bare(m[1]), port = Number(m[2]);
    let addrs;
    try { addrs = await check(host, port); } catch (e) {
      blocked.push({ host, kind: e.kind });
      return sock.end(`HTTP/1.1 ${e.kind === 'private' ? '403 Forbidden' : '502 Bad Gateway'}\r\nx-router-blocked: ${e.kind || 'error'}\r\n\r\n`);
    }
    const up = net.connect({ host, port, ...(net.isIP(host) ? {} : { lookup: pinnedLookup(addrs) }) }, () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on('error', () => sock.destroy());
    sock.on('close', () => up.destroy());
  });
  server.on('clientError', (e, s) => s.destroy());
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function read(url, pageMs, { ua = '', tdm = false } = {}) {
  const t0 = Date.now();
  const left = () => pageMs - (Date.now() - t0);
  let u;
  try { u = new URL(url); } catch { return { ok: false, kind: 'input', error: 'invalid address' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, kind: 'input', error: 'http and https only' };
  await checkHost(u.hostname, Number(u.port) || (u.protocol === 'https:' ? 443 : 80));
  const blocked = [];
  const proxy = await guardProxy(blocked);
  const chromium = await playwright();
  let browser = null, ctx = null, timer, done = false;
  const shut = async () => {
    const c = ctx, b = browser;
    ctx = null; browser = null;
    let t;
    const closing = (c ? c.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {}).then(() => c.close()).catch(() => {}) : Promise.resolve()).then(() => (b ? b.close() : null)).catch(() => {});
    await Promise.race([closing, new Promise((r) => { t = setTimeout(r, 5000); })]).finally(() => clearTimeout(t));
  };
  const viaBlocked = (href) => { try { const h = bare(new URL(href).hostname); return blocked.some((x) => x.kind === 'private' && x.host === h); } catch { return false; } };
  const run = (async () => {
    // WebRTC would send UDP past the guard proxy (STUN to 127.0.0.1 measured in the review of
    // 2026-10-20); QUIC is UDP too. Both off: every byte goes through the proxy.
    const args = ['--disable-gpu', '--no-first-run', '--no-default-browser-check', '--lang=de-DE',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-quic'];
    if (process.env.PYFIO_BROWSER_MARK) args.push(`--router-mark=${process.env.PYFIO_BROWSER_MARK}`);
    const b = await chromium.launch({ headless: true, args, timeout: 20000, proxy: { server: `http://127.0.0.1:${proxy.address().port}`, bypass: '<-loopback>' } });
    if (done) { browser = b; await shut(); throw kindErr('aborted', 'timeout'); }
    browser = b;
    const major = String(b.version()).split('.')[0];
    const c = ctx = await b.newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin', viewport: { width: 1280, height: 900 }, bypassCSP: true, serviceWorkers: 'block', acceptDownloads: false,
      userAgent: ua || `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
      extraHTTPHeaders: { 'Accept-Language': ACCEPT_LANGUAGE } });
    // Second lock on WebRTC: pages do not even get the constructors.
    await c.addInitScript(() => { for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate']) { try { delete window[k]; } catch {} } });
    await c.route('**/*', (r) => (BLOCK.has(r.request().resourceType()) ? r.abort() : r.continue()).catch(() => {}));
    const page = await c.newPage();
    page.setDefaultTimeout(10000);
    let navBlocked = false;
    const main = (r) => { try { return r.isNavigationRequest() && r.frame() === page.mainFrame(); } catch { return false; } };
    page.on('requestfailed', (r) => { if (main(r) && viaBlocked(r.url())) navBlocked = true; });
    page.on('response', (r) => { if (main(r.request()) && r.headers()['x-router-blocked'] === 'private') navBlocked = true; });
    let resp;
    try { resp = await page.goto(u.href, { waitUntil: 'domcontentloaded', timeout: Math.max(3000, left() - 3000) }); }
    catch (e) {
      if (navBlocked || (/ERR_TUNNEL_CONNECTION_FAILED/.test(e.message) && blocked.some((x) => x.kind === 'private'))) throw kindErr('redirect to a refused address (private or local)', 'private');
      throw kindErr(cleanMsg(e), /Timeout/i.test(e.message) ? 'timeout' : 'browser');
    }
    if (navBlocked || resp?.headers()['x-router-blocked'] === 'private') throw kindErr('redirect to a refused address (private or local)', 'private');
    if (resp && resp.status() >= 400) throw kindErr(`HTTP ${resp.status()}`, [401, 403, 429].includes(resp.status()) ? 'blocked' : 'http');
    if (tdm && String(resp?.headers()['tdm-reservation'] || '').trim() === '1') throw kindErr('the site reserves text and data mining (tdm-reservation)', 'tdm_reserved');
    await page.waitForLoadState('load', { timeout: Math.max(500, Math.min(6000, left() - 4000)) }).catch(() => {});
    await page.waitForTimeout(Math.max(0, Math.min(1200, left() - 3000)));
    if (tdm && (await page.evaluate(() => String(document.querySelector('meta[name="tdm-reservation" i]')?.getAttribute('content') || '').trim() === '1'))) throw kindErr('the site reserves text and data mining (tdm-reservation)', 'tdm_reserved');
    await page.addScriptTag({ content: READABILITY });
    const r = await page.evaluate(extract);
    return { ok: true, url: page.url(), titel: r.titel || null, text: r.text, quelle: r.quelle, ms: Date.now() - t0 };
  })();
  run.catch(() => {});
  try {
    return await Promise.race([run, new Promise((_, rej) => { timer = setTimeout(() => rej(kindErr(`time limit ${Math.round(pageMs / 1000)} s`, 'timeout')), Math.max(1000, left())); })]);
  } finally {
    done = true;
    clearTimeout(timer);
    await shut();
    proxy.closeAllConnections?.();
    proxy.close();
  }
}

const arg = (k) => (process.argv.slice(2).find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3);
const pageMs = Math.max(5000, Math.min(60000, Number(arg('ms')) || 30000));
let out;
try { out = await read(String(arg('url') || ''), pageMs, { ua: arg('ua'), tdm: arg('tdm') === '1' }); } catch (e) { out = { ok: false, error: cleanMsg(e), kind: e.kind || 'browser' }; }
process.stdout.write(JSON.stringify(out) + '\n', () => process.exit(0));
setTimeout(() => process.exit(0), 1500).unref();
