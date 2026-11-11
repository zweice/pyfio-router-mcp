// Etiquette of the hosted mode (hosted mode): there the router fetches pages for third
// parties, so it says who it is (an honest User-Agent), follows robots.txt (RFC 9309) and the
// text-and-data-mining reservation (TDMRep: header or meta tdm-reservation = 1; UrhG § 44b).
// The local mode is the operator's own fetch and keeps the browser's User-Agent.
import { fetchPage } from './guard.mjs';
import { VERSION } from '../config.mjs';

export const BOT_TOKEN = 'PyfioRouter';
export const HONEST_UA = `Mozilla/5.0 (compatible; ${BOT_TOKEN}/${VERSION}; +https://pyfio.com)`;

// robots.txt text -> groups [{ agents: [...], rules: [{ allow, path }] }]
export function parseRobots(txt) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of String(txt || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      if (cur) cur.rules.push({ allow: key === 'allow', path: val });
      lastWasAgent = false;
    } else lastWasAgent = false;
  }
  return groups;
}
// "*" = any characters, a final "$" = end of the path; everything else literal.
const toRx = (p) => {
  const end = p.endsWith('$');
  const body = (end ? p.slice(0, -1) : p).split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${end ? '$' : ''}`);
};
// RFC 9309 compares percent-encoded paths: "/über" in a rule matches "/%C3%BCber" in the URL. Both sides
// get the same form: %xx of unreserved characters decoded, other %xx upper case, non-ASCII and
// control characters encoded as UTF-8 (review 2026-10-20).
export function normPath(p) {
  const s = String(p || '').replace(/%[0-9a-fA-F]{2}/g, (m) => {
    const c = String.fromCharCode(parseInt(m.slice(1), 16));
    return /[A-Za-z0-9\-._~]/.test(c) ? c : m.toUpperCase();
  });
  let out = '';
  for (const ch of s) out += ch.codePointAt(0) > 0x7e || ch.codePointAt(0) <= 0x20 ? encodeURIComponent(ch) : ch;
  return out;
}
// Allowed for our token? The group whose user-agent equals our product token (case-insensitive),
// else "*". Longest matching rule wins; on a tie allow wins; no rule = allowed.
export function robotsAllows(groups, pathAndQuery, token = BOT_TOKEN) {
  const t = token.toLowerCase();
  let g = groups.filter((x) => x.agents.some((a) => a !== '*' && (a === t || a.split('/')[0].trim() === t)));
  if (!g.length) g = groups.filter((x) => x.agents.includes('*'));
  const target = normPath(pathAndQuery);
  let best = null;
  for (const r of g.flatMap((x) => x.rules)) {
    if (r.path === '') continue;   // "Disallow:" (empty) allows everything
    let rx;
    try { rx = toRx(normPath(r.path)); } catch { continue; }
    if (!rx.test(target)) continue;
    const len = r.path.replace(/\*/g, '').length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}

const cache = new Map();   // origin -> { t, groups | 'all' | 'none' } in memory only
export async function robotsCheck(u, { cacheHours = 24, fetcher = fetchPage } = {}) {
  const origin = u.origin;
  let e = cache.get(origin);
  // A "nothing allowed" from an unreachable robots.txt is asked again after an hour, not a day.
  if (!e || Date.now() - e.t > (e.groups === 'none' ? Math.min(1, cacheHours) : cacheHours) * 36e5) {
    let groups;
    try {
      // Any content type: many servers send robots.txt without one (review 2026-10-20).
      const r = await fetcher(`${origin}/robots.txt`, { timeoutMs: 6000, maxBytes: 500 * 1024, headers: { 'User-Agent': HONEST_UA }, anyText: true });
      groups = parseRobots(r.plain ?? r.html ?? '');
    } catch (err) {
      // RFC 9309: 4xx = no rules; 5xx or unreachable = everything disallowed
      groups = err.status >= 400 && err.status < 500 ? [] : 'none';
    }
    e = { t: Date.now(), groups };
    cache.set(origin, e);
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
  }
  if (e.groups === 'none') return { allowed: false, why: 'robots.txt not reachable (RFC 9309: then nothing is allowed)' };
  return robotsAllows(e.groups, `${u.pathname}${u.search}`) ? { allowed: true } : { allowed: false, why: `robots.txt disallows ${BOT_TOKEN} here` };
}
export const _clearRobots = () => cache.clear();

// TDM reservation (TDMRep): HTTP header tdm-reservation: 1, or <meta name="tdm-reservation" content="1">.
export function tdmReserved(headers = {}, html = '') {
  if (String(headers['tdm-reservation'] || '').trim() === '1') return true;
  return /<meta[^>]+name\s*=\s*["']tdm-reservation["'][^>]*content\s*=\s*["']\s*1\s*["']/i.test(String(html).slice(0, 200000))
    || /<meta[^>]+content\s*=\s*["']\s*1\s*["'][^>]*name\s*=\s*["']tdm-reservation["']/i.test(String(html).slice(0, 200000));
}
