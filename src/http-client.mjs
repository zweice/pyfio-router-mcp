// HTTP for the generic services (geocoders, routers, search): own User-Agent, a hard time limit, the polite
// pause of the gate, JSON parsing. Errors carry a kind: timeout | network | http | blocked | quota | parse | too_large | input.
import { request } from './net.mjs';
import { defaultGate } from './gate.mjs';
import { userAgent, rateLimitOn } from './endpoints.mjs';

export class HttpError extends Error {
  constructor(msg, { status = 0, kind = 'http', body = '' } = {}) { super(msg); this.status = status; this.kind = kind; this.body = body; }
}

// deps: { gate, now }  -> get(url, { method, headers, body, timeoutMs, gapMs, as }) -> { data, ms, status }
export function makeHttp({ gate = defaultGate, now = Date.now } = {}) {
  return async function get(url, { method = 'GET', headers = {}, body, timeoutMs = 10000, gapMs = 0, as = 'json' } = {}) {
    let host;
    try { host = new URL(url).host; } catch { throw new HttpError('invalid URL', { kind: 'input' }); }
    if (rateLimitOn()) await gate.turn(host, gapMs);
    const t0 = now();
    let r;
    try { r = await request(url, { method, headers: { 'User-Agent': userAgent(), 'Accept-Language': 'en,de;q=0.8', ...headers }, body, timeoutMs, maxBytes: 4 * 1024 * 1024 }); }
    catch (e) { throw new HttpError(String(e.message || e).slice(0, 200), { kind: e.kind || 'network' }); }
    const ms = Math.max(0, now() - t0);
    if (r.status < 200 || r.status >= 300) {
      const blocked = [401, 403, 429].includes(r.status) || /captcha|anomaly|unusual traffic/i.test(r.text.slice(0, 4000));
      throw new HttpError(`${host}: HTTP ${r.status}`, { status: r.status, kind: blocked ? 'blocked' : 'http', body: r.text.slice(0, 300) });
    }
    if (as === 'text') return { data: r.text, ms, status: r.status };
    try { return { data: JSON.parse(r.text), ms, status: r.status }; }
    catch { throw new HttpError(`${host}: not a JSON answer`, { status: r.status, kind: 'parse', body: r.text.slice(0, 300) }); }
  };
}
