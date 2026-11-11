// Network guard and the plain HTTP step of read_page. Copied from werkzeuge/lib/lesen.mjs (job aqwuj,
// 2026-10-18; tested there against redirects to local servers) with the test switch renamed.
// http and https only. Every hop (redirects followed by hand, at most 5) is resolved and checked
// before it is connected: private, loopback, link-local, CGNAT, multicast and reserved addresses
// (IPv4 and IPv6, IPv4-mapped, NAT64, 6to4 too) are refused, also when only one address of a name is
// such; the socket goes to the checked address (no second lookup). So no page reaches services on
// 127.0.0.1 or the local network, also not in the hosted mode.
// Tests only: PYFIO_TEST_ALLOW="127.0.0.1:<port>,..." (or "*") lets these targets through.
import net from 'node:net';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream';

export class FetchError extends Error {
  constructor(msg, { status = 0, kind = 'http' } = {}) { super(msg); this.status = status; this.kind = kind; }
}

export const HTTP_MS = 15000, MAX_BYTES = 3 * 1024 * 1024, MAX_HOPS = 5;
export const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
export const ACCEPT_LANGUAGE = 'de-DE,de;q=0.9,en;q=0.7';

// ---------- addresses that are never fetched ----------
export function v4num(s) {
  const p = String(s).split('.');
  if (p.length !== 4 || !p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255)) return null;
  return p.reduce((n, x) => n * 256 + Number(x), 0);
}
const V4_BLOCKED = [
  ['0.0.0.0', 8, 'reserved'], ['10.0.0.0', 8, 'private'], ['100.64.0.0', 10, 'CGNAT'], ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'], ['172.16.0.0', 12, 'private'], ['192.0.0.0', 24, 'reserved'], ['192.0.2.0', 24, 'reserved'],
  ['192.168.0.0', 16, 'private'], ['198.18.0.0', 15, 'reserved'], ['198.51.100.0', 24, 'reserved'], ['203.0.113.0', 24, 'reserved'],
  ['224.0.0.0', 4, 'multicast'], ['240.0.0.0', 4, 'reserved'],
].map(([a, bits, why]) => ({ base: v4num(a), bits, why }));
const v4why = (n) => (V4_BLOCKED.find((r) => n >>> (32 - r.bits) === r.base >>> (32 - r.bits)) || {}).why || null;

// "::ffff:1.2.3.4", "fe80::1%12", "[::1]" -> eight 16-bit groups, or null.
export function v6groups(s) {
  let t = String(s).replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();
  let tail = [];
  const m = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(t);
  if (m) {
    const n = v4num(m[2]);
    if (n === null) return null;
    tail = [Math.floor(n / 65536), n % 65536];
    t = m[1].endsWith('::') ? m[1] : m[1].slice(0, -1);
  }
  const halves = t.split('::');
  if (halves.length > 2) return null;
  const grp = (h) => (h ? h.split(':') : []).map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  const head = grp(halves[0]);
  const back = [...(halves.length === 2 ? grp(halves[1]) : []), ...tail];
  if ([...head, ...back].some(Number.isNaN)) return null;
  if (halves.length === 1) return head.length + back.length === 8 ? [...head, ...back] : null;
  const fill = 8 - head.length - back.length;
  return fill >= 1 ? [...head, ...Array(fill).fill(0), ...back] : null;
}
function v6why(g) {
  const zero = (a, b) => g.slice(a, b).every((x) => x === 0);
  const v4 = (hi, lo) => v4why(hi * 65536 + lo);
  if (zero(0, 8)) return 'reserved';
  if (zero(0, 7) && g[7] === 1) return 'loopback';
  if (zero(0, 5) && g[5] === 0xffff) return v4(g[6], g[7]);
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4(g[6], g[7]);
  if (zero(0, 6)) return v4(g[6], g[7]) || 'reserved';
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return 'private';
  if (g[0] === 0x2002) return v4(g[1], g[2]);
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return 'reserved';
  if (g[0] === 0x100 && zero(1, 4)) return 'reserved';
  if ((g[0] & 0xfe00) === 0xfc00) return 'private';
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local';
  if ((g[0] & 0xffc0) === 0xfec0) return 'private';
  if ((g[0] & 0xff00) === 0xff00) return 'multicast';
  return null;
}
// Why an address is refused, or null.
export function blockedIp(addr) {
  const a = String(addr || '').replace(/^\[|\]$/g, '');
  if (net.isIPv4(a)) return v4why(v4num(a));
  if (net.isIPv6(a)) { const g = v6groups(a); return g ? v6why(g) : 'reserved'; }
  return 'reserved';
}
function testAllowed(ip, port) {
  const v = process.env.PYFIO_TEST_ALLOW;
  if (!v) return false;
  const list = v.split(',').map((x) => x.trim()).filter(Boolean);
  return list.includes('*') || list.includes(`${ip}:${port}`) || list.includes(`[${ip}]:${port}`);
}

// All addresses of a name, all checked. Throws kind 'private' or 'dns'. IPv4 first.
export async function checkHost(hostname, port) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '');
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host, family: net.isIP(host) }];
  else {
    try { addrs = await dns.promises.lookup(host, { all: true, order: 'ipv4first' }); }
    catch (e) { throw new FetchError(`${host}: name not found (${e.code || e.message})`, { kind: 'dns' }); }
    if (!addrs.length) throw new FetchError(`${host}: name not found`, { kind: 'dns' });
  }
  for (const a of addrs) {
    const why = blockedIp(a.address);
    if (why && !testAllowed(a.address, port)) throw new FetchError(`refused address (${why}): ${host === a.address ? host : `${host} = ${a.address}`}`, { kind: 'private' });
  }
  return addrs;
}
export const pinnedLookup = (addrs) => (_h, o, cb) => (o && o.all ? cb(null, addrs.map(({ address, family }) => ({ address, family }))) : cb(null, addrs[0].address, addrs[0].family));

// ---------- the HTTP step ----------
const HTML_TYPE = /^(text\/html|application\/xhtml\+xml|application\/xml|text\/xml)\b/;
const TEXT_TYPE = /^(text\/plain|text\/markdown|text\/csv|application\/json)\b/;
const charsetOf = (ct) => (/charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(ct || '') || [])[1] || null;
export function decodeHtml(buf, contentType = '') {
  let label = null;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) label = 'utf-8';
  else if (buf[0] === 0xff && buf[1] === 0xfe) label = 'utf-16le';
  else if (buf[0] === 0xfe && buf[1] === 0xff) label = 'utf-16be';
  label = label || charsetOf(contentType) || (/<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(buf.subarray(0, 4096).toString('latin1')) || [])[1] || null;
  if (label) { try { return new TextDecoder(label).decode(buf); } catch {} }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}

const abortable = (p, signal) => new Promise((resolve, reject) => {
  const stop = () => reject(new Error('aborted'));
  if (signal.aborted) return stop();
  signal.addEventListener('abort', stop, { once: true });
  p.then((v) => { signal.removeEventListener('abort', stop); resolve(v); }, (e) => { signal.removeEventListener('abort', stop); reject(e); });
});

function getOnce(u, addrs, signal, headers) {
  return new Promise((resolve, reject) => {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const req = (u.protocol === 'https:' ? https : http).request({
      protocol: u.protocol, hostname: host, port: u.port || undefined, path: `${u.pathname}${u.search}`, method: 'GET', agent: false, signal,
      ...(net.isIP(host) ? {} : { servername: host, lookup: pinnedLookup(addrs) }),
      headers: { 'User-Agent': CHROME_UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': ACCEPT_LANGUAGE, 'Accept-Encoding': 'gzip, deflate, br', ...headers },
    }, resolve);
    req.on('error', reject);
    req.end();
  });
}
async function readBody(res, maxBytes) {
  const enc = String(res.headers['content-encoding'] || '').trim().toLowerCase();
  const Z = zlib.constants;
  const dec = enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip({ finishFlush: Z.Z_SYNC_FLUSH })
    : enc === 'deflate' ? zlib.createInflate({ finishFlush: Z.Z_SYNC_FLUSH })
      : enc === 'br' ? zlib.createBrotliDecompress({ finishFlush: Z.BROTLI_OPERATION_FLUSH }) : null;
  if (enc && enc !== 'identity' && !dec) { res.destroy(); throw new FetchError(`encoding ${enc} not supported`, { kind: 'http' }); }
  const src = dec ? pipeline(res, dec, () => {}) : res;
  const chunks = [];
  let n = 0;
  for await (const c of src) {
    chunks.push(c);
    n += c.length;
    if (n >= maxBytes) { res.destroy(); return { buf: Buffer.concat(chunks).subarray(0, maxBytes), cut: true }; }
  }
  return { buf: Buffer.concat(chunks), cut: false };
}

// GET with redirects by hand -> { url (final), html, cut } or { url, plain, cut } for plain text.
// anyText: return any content type as plain text (robots.txt).
export async function fetchPage(url, { timeoutMs = HTTP_MS, maxBytes = MAX_BYTES, headers = {}, anyText = false } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let u = new URL(url);
  try {
    for (let hop = 0; ; hop++) {
      if (!/^https?:$/.test(u.protocol)) throw new FetchError(`redirect to ${u.protocol} not allowed`, { kind: 'input' });
      if (u.username || u.password) throw new FetchError('address with credentials', { kind: 'input' });
      const addrs = await abortable(checkHost(u.hostname, Number(u.port) || (u.protocol === 'https:' ? 443 : 80)), ctl.signal);
      const res = await getOnce(u, addrs, ctl.signal, headers);
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.destroy();
        if (hop >= MAX_HOPS) throw new FetchError(`${u.host}: more than ${MAX_HOPS} redirects`, { kind: 'http' });
        const next = new URL(res.headers.location, u);
        next.hash = '';
        u = next;
        continue;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.destroy();
        throw new FetchError(`${u.host}: HTTP ${res.statusCode}`, { status: res.statusCode, kind: [401, 403, 429].includes(res.statusCode) ? 'blocked' : 'http' });
      }
      const type = String(res.headers['content-type'] || '').toLowerCase().trim();
      if (!anyText && type && !HTML_TYPE.test(type) && !TEXT_TYPE.test(type)) { res.destroy(); throw new FetchError(`not HTML (${type.split(';')[0]})`, { kind: 'type' }); }
      const { buf, cut } = await readBody(res, maxBytes);
      const text = decodeHtml(buf, type);
      if (anyText) return { url: u.href, plain: text, cut, headers: res.headers };
      if (TEXT_TYPE.test(type)) return { url: u.href, plain: text, cut, headers: res.headers };
      if (!type && !/<(!doctype html|html|head|body)\b/i.test(text.slice(0, 4000))) throw new FetchError('not HTML (unknown content)', { kind: 'type' });
      return { url: u.href, html: text, cut, headers: res.headers };
    }
  } catch (e) {
    if (ctl.signal.aborted) throw new FetchError(`${u.host}: time limit ${Math.round(timeoutMs / 1000)} s`, { kind: 'timeout' });
    if (e instanceof FetchError) throw e;
    throw new FetchError(`${u.host}: ${e.code || e.message}`, { kind: 'network' });
  } finally { clearTimeout(timer); }
}
