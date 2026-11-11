// Small HTTP(S) client for the provider APIs (Open-Meteo, Jina, the counter endpoint): node:http(s)
// without keep-alive instead of the global fetch. Measured 2026-10-20 (Node 24, Windows): after a
// fetch, process.exit() of the stdio server died with a libuv assertion (UV_HANDLE_CLOSING) and
// exit code 3221226505; with agent: false nothing stays open. Page fetches use src/lesen/guard.mjs.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

export class NetError extends Error {
  constructor(msg, { status = 0, kind = 'http' } = {}) { super(msg); this.status = status; this.kind = kind; }
}

// -> { status, headers, text }. Throws NetError kind timeout | network | too_large.
export function request(url, { method = 'GET', headers = {}, body = null, timeoutMs = 12000, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new NetError('invalid URL', { kind: 'input' })); }
    const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!lib) return reject(new NetError('http and https only', { kind: 'input' }));
    let done = false;
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); fn(); };
    const req = lib.request(u, { method, agent: false, headers: { 'Accept-Encoding': 'gzip, deflate', ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } }, (res) => {
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const src = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
      const chunks = [];
      let n = 0;
      src.on('data', (c) => { n += c.length; if (n > maxBytes) { req.destroy(); finish(() => reject(new NetError(`${u.host}: answer too large`, { kind: 'too_large' }))); } else chunks.push(c); });
      src.on('end', () => finish(() => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') })));
      src.on('error', (e) => finish(() => reject(new NetError(`${u.host}: ${e.message}`, { kind: 'network' }))));
    });
    const timer = setTimeout(() => { req.destroy(); finish(() => reject(new NetError(`${u.host}: time limit ${Math.round(timeoutMs / 1000)} s`, { kind: 'timeout' }))); }, timeoutMs);
    req.on('error', (e) => finish(() => reject(new NetError(`${u.host}: ${e.code || e.message}`, { kind: 'network' }))));
    if (body) req.write(body);
    req.end();
  });
}
