// Hosted mode (prepared, not deployed): MCP over Streamable HTTP, stateless (one server and transport
// per request), plus the endpoints the demand test needs.
//   POST /mcp              MCP (JSON responses). Bearer key -> paid tier; without key a free quota.
//   GET  /health           version and which readers run
//   GET  /.well-known/pyfio-urteil.json   the public key that signs the verdicts (urteil) of every answer
//   POST /v1/zaehler       daily counts of local installs (src/zaehler.mjs acceptReport)
//   POST /v1/interesse     fake-door counter (src/interesse.mjs); not used by this repo, no page sends to it
//   GET  /admin            admin menu: the tunable settings, global for all users (PYFIO_ADMIN_TOKEN)
// No IP is stored or logged: the caller is a keyed hash (src/zaehler.mjs requestPseudonym).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.mjs';
import { PKG_ROOT, VERSION, stateDir, setting, allSettings, changeSetting } from './config.mjs';
import { createCounter, requestPseudonym, acceptReport, dayOf } from './zaehler.mjs';
import { acceptInterest } from './interesse.mjs';
import { readerStatus, setMemoryPersistence } from './lesen/seite-lesen.mjs';
import { loadKeys, publicInfo } from './urteil/schluessel.mjs';
import { AUSSTELLER } from './urteil/urteil.mjs';

const BODY_MAX = 1 << 20;
const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'" };

const json = (res, status, obj, extra = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(JSON.stringify(obj));
};
function readBody(req, max = BODY_MAX) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    const t = setTimeout(() => { req.destroy(); reject(Object.assign(new Error('body time limit'), { status: 408 })); }, 15000);
    // Too large: stop keeping it, drain the rest, answer 413 (a destroyed socket would only reset).
    req.on('data', (c) => { n += c.length; if (n > max) { clearTimeout(t); req.removeAllListeners('data'); req.removeAllListeners('end'); req.resume(); reject(Object.assign(new Error('body too large'), { status: 413 })); } else chunks.push(c); });
    req.on('end', () => { clearTimeout(t); const s = Buffer.concat(chunks).toString('utf8'); if (!s) return resolve(undefined); try { resolve(JSON.parse(s)); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); } });
    req.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const bearer = (req) => (/^Bearer\s+(\S{8,1000})$/i.exec(String(req.headers.authorization || '')) || [])[1] || null;
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const isLoopback = (a) => /^(127\.|::1$|::ffff:127\.)/.test(String(a || ''));

// API keys of the paid tier: <state>/api-keys.json { "<sha256 of the key>": { "id": "...", "tier": "router" } }.
function keyRecord(key, dir) {
  if (!key) return null;
  let all = {};
  try { all = JSON.parse(fs.readFileSync(path.join(dir, 'api-keys.json'), 'utf8')); } catch {}
  const rec = all[crypto.createHash('sha256').update(key).digest('hex')];
  return rec && rec.id ? rec : null;
}

// options: { dir, trustProxy, allowedOrigins, adminToken, impl (tests) }
export function createHttpServer(opts = {}) {
  const dir = opts.dir || stateDir();
  setMemoryPersistence(false);   // domain memory in RAM only in the hosted mode
  const counter = createCounter({ mode: 'http', dir });
  const free = new Map();        // pseudonym -> { day, n }  (free calls today)
  const interest = new Map();    // pseudonym -> { hour, n }
  const reports = new Map();     // pseudonym -> { hour, n }
  // true = one more allowed this hour for who. Old hours are pruned, the current one never.
  const perHour = (map, who, max) => {
    const hour = Math.floor(Date.now() / 36e5), q = map.get(who);
    const n = q && q.hour === hour ? q.n : 0;
    if (n >= max) return false;
    if (!q && map.size >= 50000) { for (const [k, v] of map) if (v.hour !== hour) map.delete(k); if (map.size >= 50000) return false; }
    map.set(who, { hour, n: n + 1 });
    return true;
  };
  const allowedOrigins = new Set(opts.allowedOrigins || String(process.env.PYFIO_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean));
  const adminToken = opts.adminToken ?? process.env.PYFIO_ADMIN_TOKEN ?? '';
  const trustProxy = opts.trustProxy ?? process.env.PYFIO_TRUST_PROXY === '1';
  const mcpOn = opts.mcp ?? String(process.env.PYFIO_HTTP_MCP || 'on').toLowerCase() !== 'off';
  const allowedHosts = new Set((opts.allowedHosts || String(process.env.PYFIO_ALLOWED_HOSTS || '').split(',')).map((s) => s.trim().toLowerCase()).filter(Boolean));
  const clientIp = (req) => {
    if (trustProxy) {
      const cf = req.headers['cf-connecting-ip'];
      if (cf) return String(cf);
      // The last entry is the one our proxy appended; the first ones come from the client.
      const xf = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean).pop();
      if (xf) return xf;
    }
    return req.socket.remoteAddress || '';
  };
  // DNS rebinding: a foreign name pointing at this server sends its own Host (Origin then matches it).
  // With PYFIO_ALLOWED_HOSTS only those; on a loopback socket without a list only loopback names.
  const hostOk = (req) => {
    const h = String(req.headers.host || '').toLowerCase();
    const name = h.replace(/:\d+$/, '');
    if (allowedHosts.size) return allowedHosts.has(h) || allowedHosts.has(name);
    if (isLoopback(req.socket.localAddress)) return LOOPBACK_NAMES.has(name);
    return true;
  };
  // A browser page of another site must not drive the endpoints (CSRF): Origin, if sent, must be
  // this host or listed. MCP clients outside a browser send none.
  const originOk = (req) => {
    const o = req.headers.origin;
    if (!o) return true;
    if (allowedOrigins.has(o)) return true;
    try { return new URL(o).host === req.headers.host; } catch { return false; }
  };

  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return json(res, 400, { ok: false, error: 'bad url' }); }
    const p = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (!hostOk(req)) return json(res, 421, { ok: false, error: 'host not allowed' });
      if (!originOk(req)) return json(res, 403, { ok: false, error: 'origin not allowed' });

      if (p === '/mcp') {
        // Phase 1 of the demand test: pricing page and counters only, no fetching for strangers.
        if (!mcpOn) return json(res, 503, { jsonrpc: '2.0', error: { code: -32003, message: 'the hosted router is not open yet; run it locally: npx -y @pyfio/router-mcp' }, id: null });
        if (req.method !== 'POST') return json(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: POST only)' }, id: null }, { allow: 'POST' });
        const body = await readBody(req);
        const rec = keyRecord(bearer(req), dir);
        if (bearer(req) && !rec) return json(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'unknown API key' }, id: null });
        const operator = requestPseudonym(rec ? { keyId: rec.id } : { ip: clientIp(req) }, dir);
        // Every tools/call in a JSON-RPC batch counts (review 2026-10-20: 100 calls cost 1 of the quota).
        const calls = [].concat(body || []).filter((m) => m && m.method === 'tools/call').length;
        if (calls > setting('http.maxAufrufeJeAnfrage')) return json(res, 400, { jsonrpc: '2.0', error: { code: -32600, message: `at most ${setting('http.maxAufrufeJeAnfrage')} tools/call per request` }, id: null });
        if (!rec && calls) {
          const day = dayOf(), q = free.get(operator);
          const n = q && q.day === day ? q.n : 0;
          if (n + calls > setting('http.freiProTag')) return json(res, 429, { jsonrpc: '2.0', error: { code: -32002, message: `free quota of ${setting('http.freiProTag')} calls per day used up; run it locally with your own keys (npx -y @pyfio/router-mcp) or use an API key` }, id: null });
          if (!q && free.size >= 50000) {
            for (const [k, v] of free) if (v.day !== day) free.delete(k);   // yesterday's entries only, never today's quota
            if (free.size >= 50000) return json(res, 429, { jsonrpc: '2.0', error: { code: -32002, message: 'too many free users today; try later or run it locally' }, id: null });
          }
          free.set(operator, { day, n: n + calls });
        }
        // Client name for the counts: only the first product token of the User-Agent ("claude-code/2.1" -> claude-code).
        const clientHint = (/^([A-Za-z][\w.-]{0,39})/.exec(String(req.headers['user-agent'] || '')) || [])[1];
        const mcp = createServer({ mode: 'http', counter, operator, impl: opts.impl, dir, now: opts.now, keys: opts.keys, lang: url.searchParams.get('lang'), clientHint });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      if (p === '/.well-known/pyfio-urteil.json' && req.method === 'GET') return json(res, 200, { ...publicInfo(opts.keys || loadKeys({ dir })), aussteller: AUSSTELLER, pruefen: 'Verify a verdict with an Ed25519 library; the signature covers the canonical JSON (RFC 8785 subset) of all verdict fields except signatur. See the README, section Verdict.' }, { 'cache-control': 'public, max-age=300' });
      if (p === '/health' && req.method === 'GET') return json(res, 200, { ok: true, name: 'pyfio-router', version: VERSION, mcp: mcpOn, readers: await readerStatus('http') });
      if (p === '/v1/zaehler' && req.method === 'POST') {
        // Anyone can send a report (anonymous by design): a limit per sender and hour keeps it cheap.
        if (!perHour(reports, requestPseudonym({ ip: clientIp(req) }, dir), setting('http.berichteProStunde'))) return json(res, 429, { ok: false, error: 'too many reports' });
        const body = await readBody(req, 64 * 1024);
        return json(res, 200, acceptReport(body, dir));
      }
      if (p === '/v1/interesse' && req.method === 'POST') {
        if (!perHour(interest, requestPseudonym({ ip: clientIp(req) }, dir), setting('http.interesseProStunde'))) return json(res, 429, { ok: false, error: 'too many requests' });
        const body = await readBody(req, 8 * 1024);
        return json(res, 200, acceptInterest(body, dir));
      }
      if (req.method === 'GET' && p === '/') return json(res, 200, { ok: true, name: 'pyfio-router', mcp: '/mcp', health: '/health' });
      if (p === '/admin' && req.method === 'GET') {
        res.writeHead(200, HTML_HEADERS);
        return res.end(fs.readFileSync(path.join(PKG_ROOT, 'src', 'admin.html')));
      }
      if (p === '/admin/api/einstellungen') {
        if (!adminToken || adminToken.length < 16) return json(res, 503, { ok: false, error: 'admin menu off: set PYFIO_ADMIN_TOKEN (16+ characters)' });
        if (!safeEq(bearer(req) || '', adminToken)) return json(res, 401, { ok: false, error: 'admin token wrong' });
        if (req.method === 'GET') return json(res, 200, { ok: true, settings: allSettings() });
        if (req.method === 'PUT') {
          const b = await readBody(req, 8 * 1024);
          if (!b || typeof b.key !== 'string') return json(res, 400, { ok: false, error: 'key missing' });
          return json(res, 200, { ok: true, settings: changeSetting(b.key, b.reset ? null : b.value) });
        }
        return json(res, 405, { ok: false, error: 'GET or PUT' });
      }
      return json(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch {} return; }
      const status = e.status || (e.kind === 'input' ? 400 : 500);
      return json(res, status, { ok: false, error: status === 500 ? 'internal error' : e.message }, status === 413 ? { connection: 'close' } : {});
    }
  });
  server.headersTimeout = 20000;
  server.requestTimeout = 100000;
  server.on('close', () => counter.flush());
  return server;
}
