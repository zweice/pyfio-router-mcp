// read_page: the measured cascade plus a memory per domain (router-ausbau/schritt1-seite-lesen):
// 1. plain HTTP fetch, main text by Trafilatura (or, without Python, by Readability on the HTML);
// 2. on an error, an empty text, under lesen.minWoerter words or a bot-check page: headless Chromium
//    with Readability (measured: needed in 31 % of the cases);
// 3. with the operator's own JINA_API_KEY only: Jina Reader for what is still blocked.
// The winner of a domain is stable (50 of 50 the same after an hour), so the stage that delivered for
// a domain is remembered (lesen.domainTtlTage) and tried first next time. Domains are stored only as a
// keyed hash; page content is never stored or cached.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setting, stateDir, mkdirp, lang } from '../config.mjs';
import { fetchPage, FetchError, checkHost } from './guard.mjs';
import { robotsCheck, tdmReserved, HONEST_UA } from './robots.mjs';
import * as S from './stufen.mjs';
import { countWords, isBlockPage, pageClass, measured, live } from '../richter/seite-richter.mjs';

export const MAX_LIMIT = 30000;
export const BUDGET_MS = 70000;

// ---------- domain memory ----------
const memFile = () => path.join(stateDir(), 'domains.json');
let mem = null, memTimer = null, salt = null;
function secret() {
  if (salt) return salt;
  const f = path.join(stateDir(), 'domain-salz');
  if (persist) { try { salt = fs.readFileSync(f, 'utf8').trim(); } catch {} }
  if (!salt || salt.length < 32) { salt = crypto.randomBytes(32).toString('hex'); if (persist) { try { mkdirp(stateDir()); fs.writeFileSync(f, salt, { mode: 0o600 }); } catch {} } }
  return salt;
}
const hostKey = (host) => crypto.createHmac('sha256', secret()).update(String(host).toLowerCase().replace(/^www\./, '')).digest('hex').slice(0, 20);
function loadMem() {
  if (mem) return mem;
  if (!persist) { mem = {}; return mem; }
  try { mem = JSON.parse(fs.readFileSync(memFile(), 'utf8')); } catch { mem = {}; }
  if (!mem || typeof mem !== 'object') mem = {};
  return mem;
}
function saveMemSoon() {
  if (memTimer) return;
  memTimer = setTimeout(() => { memTimer = null; flushMemory(); }, 2000);
  memTimer.unref?.();
}
// Hosted mode: the memory stays in RAM. On disk next to its salt, the hashes of what strangers read
// could be recovered with a list of domains (review 2026-10-20).
let persist = true;
export function setMemoryPersistence(on) { persist = !!on; }
export function flushMemory() {
  if (!mem || !persist) return;
  try {
    mkdirp(stateDir());
    const now = Date.now(), ttl = 90 * 864e5;
    for (const [k, v] of Object.entries(mem)) if (!v || now - v.t > ttl) delete mem[k];
    const tmp = `${memFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(mem));
    fs.renameSync(tmp, memFile());
  } catch {}
}
process.on('exit', flushMemory);
function remembered(host) {
  const days = setting('lesen.domainTtlTage');
  if (!days) return null;
  const e = loadMem()[hostKey(host)];
  return e && Date.now() - e.t <= days * 864e5 ? e.first : null;
}
function remember(host, first) {
  const m = loadMem(), k = hostKey(host);
  if (first) m[k] = { first, t: Date.now() };
  else if (m[k]) delete m[k];
  else return;
  saveMemSoon();
}
export function _resetMemory() { mem = null; salt = null; }

// ---------- helpers ----------
function clip(text, max) {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 2);
  const sp = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  if (sp > max - 300) cut = cut.slice(0, sp);
  return `${cut.trimEnd()} …`;
}
const visibleText = (h) => String(h || '').replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const titleOf = (html) => { const m = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(String(html || '')); return m ? m[1].replace(/\s+/g, ' ').trim() || null : null; };
const fail = (error, kind, steps) => ({ ok: false, error, kind, route: { steps } });
const T = {
  en: { del: (p, i, n) => `${p} delivered (step ${i} of ${n})`, meas: (c, f, n) => `measured on ${c === 'home' ? 'start pages' : 'sub pages'}: token F1 ${f} mean (n=${n})`, nomeas: 'not measured against a reference yet', live: (g, w) => `live check: ${g} (${w} words)`, mem: 'domain memory: started with the stage that delivered last time' },
  de: { del: (p, i, n) => `${p} lieferte (Schritt ${i} von ${n})`, meas: (c, f, n) => `gemessen auf ${c === 'home' ? 'Startseiten' : 'Unterseiten'}: Token-F1 im Mittel ${String(f).replace('.', ',')} (n=${n})`, nomeas: 'noch nicht gegen eine Referenz gemessen', live: (g, w) => `Live-Pruefung: ${{ good: 'gut', fair: 'mittel', poor: 'schwach' }[g] || g} (${w} Woerter)`, mem: 'Domain-Gedaechtnis: zuerst die Stufe, die zuletzt lieferte' },
};

// readPage(url, { max, mode }) -> { ok, url, title, text, words, truncated, provider, ms, route, judge, hint? }
// or { ok: false, error, kind, route }; never throws.
export async function readPage(url, { max, mode = 'stdio', budgetMs = BUDGET_MS, stages = S, lang: lg } = {}) {
  const t0 = Date.now();
  const left = () => budgetMs - (Date.now() - t0);
  const minWords = setting('lesen.minWoerter');
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return fail('not a valid address (http or https)', 'input', []); }
  if (!/^https?:$/.test(u.protocol)) return fail('http and https addresses only', 'input', []);
  if (u.username || u.password) return fail('addresses with credentials are not read', 'input', []);
  u.hash = '';
  const lim = Math.max(500, Math.min(MAX_LIMIT, Math.round(Number(max)) || setting('lesen.maxZeichen')));
  const steps = [];
  const usable = (r) => !!r && r.words > 0 && !r.blocked && !isBlockPage(r.text, r.words);
  const browserOn = setting('lesen.browser') === 1 && (await stages.browserAvailable());
  const jinaOn = stages.jinaEnabled(mode);
  const py = await stages.findPython();
  const stage1Name = py ? 'trafilatura' : 'readability-http';

  // A refused or unknown address ends here, before any stage (the browser and Jina would see it too).
  try { await checkHost(u.hostname, Number(u.port) || (u.protocol === 'https:' ? 443 : 80)); }
  catch (e) { steps.push({ provider: 'guard', ok: false, error: e.message, kind: e.kind, ms: Date.now() - t0 }); return fail(e.message, e.kind, steps); }

  // Hosted mode: say who we are, follow robots.txt and the TDM reservation.
  const hosted = mode === 'http';
  const honest = hosted && setting('lesen.ehrlicherUA') === 1;
  const tdm = hosted && setting('lesen.tdmVorbehalt') === 1;
  if (hosted && setting('lesen.robotsTxt') === 1) {
    const rb = await (stages.robotsCheck || robotsCheck)(u, { cacheHours: setting('lesen.robotsCacheStunden') });
    if (!rb.allowed) { steps.push({ provider: 'robots.txt', ok: false, error: rb.why, kind: 'robots', ms: Date.now() - t0 }); return fail(rb.why, 'robots', steps); }
  }
  const fetchHeaders = honest ? { 'User-Agent': HONEST_UA } : {};
  const browserOpts = { ...(honest ? { ua: HONEST_UA } : {}), ...(tdm ? { tdm: true } : {}) };

  const runBrowser = async () => {
    const t = Date.now();
    if (left() < 12000) { steps.push({ provider: 'browser-readability', ok: false, error: 'no time left', kind: 'timeout', ms: 0 }); return { err: { kind: 'timeout' } }; }
    try {
      const b = await stages.browser(u.href, { timeoutMs: Math.min(S.BROWSER_MS + 8000, left() - 1000), pageMs: Math.min(S.BROWSER_MS, left() - 8000), ...browserOpts });
      const r = { provider: 'browser-readability', url: b.url || u.href, title: b.titel || null, text: String(b.text || '').trim(), quelle: b.quelle };
      r.words = countWords(r.text);
      steps.push({ provider: r.provider, ok: true, words: r.words, ms: Date.now() - t, ...(r.quelle === 'seitentext' ? { source: 'whole visible text' } : {}) });
      return { r };
    } catch (e) {
      steps.push({ provider: 'browser-readability', ok: false, error: e.message, kind: e.kind, ms: Date.now() - t });
      return { err: e };
    }
  };
  const runJina = async () => {
    const t = Date.now();
    if (left() < 8000) { steps.push({ provider: 'jina', ok: false, error: 'no time left', kind: 'timeout', ms: 0 }); return {}; }
    try {
      const j = await stages.jina(u.href, { timeoutMs: Math.min(25000, left() - 1000) });
      const r = { provider: 'jina', url: j.url || u.href, title: j.titel || null, text: String(j.text || '').trim() };
      r.words = countWords(r.text);
      steps.push({ provider: 'jina', ok: true, words: r.words, ms: Date.now() - t });
      return { r };
    } catch (e) {
      steps.push({ provider: 'jina', ok: false, error: e.message, kind: e.kind, ms: Date.now() - t });
      return { err: e };
    }
  };

  let best = null, first = null, firstErr = null, second = null, secondErr = null, third = null;
  const memFirst = remembered(u.hostname);
  let order = 'cascade';
  // Domain memory: this domain needed the browser (or Jina) last time: start there.
  if (memFirst === 'browser' && browserOn) {
    order = 'domain-memory';
    const b = await runBrowser();
    second = b.r || null; secondErr = b.err || null;
    if (['private', 'tdm_reserved'].includes(secondErr?.kind)) return fail(secondErr.message, secondErr.kind, steps);
    if (usable(second) && second.quelle !== 'seitentext' && second.words >= minWords) best = second;
  } else if (memFirst === 'jina' && jinaOn) {
    order = 'domain-memory';
    const j = await runJina();
    third = j.r || null;
    if (usable(third) && third.words >= minWords) best = third;
  }

  if (!best) {
    const t1 = Date.now();
    try {
      const page = await fetchPage(u.href, { timeoutMs: Math.min(15000, left()), headers: fetchHeaders });
      if (tdm && tdmReserved(page.headers, page.html)) throw new FetchError('the site reserves text and data mining (tdm-reservation); not read in the hosted mode', { kind: 'tdm_reserved' });
      if (page.plain !== undefined) first = { provider: 'http-text', url: page.url, title: null, text: page.plain.trim() };
      else {
        const ex = py ? await stages.trafilatura(page.html, page.url, { timeoutMs: Math.min(S.PY_MS, Math.max(1000, left() - 15000)) }) : await stages.readabilityHttp(page.html, page.url);
        first = { provider: stage1Name, url: page.url, title: ex.titel || titleOf(page.html), text: String(ex.text || '').trim() };
      }
      first.words = countWords(first.text);
      // A bot-check page: also when the extractor dropped its text (Readability finds no article in it).
      if (page.html !== undefined && first.words < 300) { const vis = visibleText(page.html); first.blocked = isBlockPage(vis, countWords(vis)); }
      steps.push({ provider: first.provider, ok: true, words: first.words, ms: Date.now() - t1, ...(page.cut ? { note: 'first 3 MB only' } : {}) });
    } catch (e) {
      firstErr = e;
      steps.push({ provider: stage1Name, ok: false, error: e.message, kind: e.kind, ms: Date.now() - t1 });
    }
    // No other stage can change these: a refused address, no such name, not HTML, the page is gone.
    if (firstErr && (['input', 'private', 'dns', 'type', 'tdm_reserved'].includes(firstErr.kind) || [404, 410].includes(firstErr.status))) return fail(firstErr.message, firstErr.kind, steps);
    if (first?.provider === 'http-text') {
      if (!first.words) return fail('empty page', 'empty', steps);
      best = first;
    } else if (usable(first) && first.words >= minWords) best = first;
  }

  if (!best && browserOn && !second && !secondErr) {
    const b = await runBrowser();
    second = b.r || null; secondErr = b.err || null;
    if (['private', 'tdm_reserved'].includes(secondErr?.kind)) return fail(secondErr.message, secondErr.kind, steps);
  }
  if (!best) {
    // Readability's article when it has more words; else stage 1's short text; the whole visible text
    // only when there is nothing else.
    if (usable(second) && second.quelle !== 'seitentext' && second.words >= Math.max(1, usable(first) ? first.words + 1 : 1)) best = second;
    else if (usable(first)) best = first;
    else if (usable(second)) best = second;
  }
  // Jina (own key only) for what is still blocked, empty or short.
  if ((!best || best.words < minWords) && jinaOn && !third) {
    const j = await runJina();
    third = j.r || null;
    if (usable(third) && (!best || third.words > best.words)) best = third;
  }

  if (!best) {
    const blocked = !!first?.blocked || isBlockPage(first?.text, first?.words || 0) || isBlockPage(second?.text, second?.words || 0) || firstErr?.kind === 'blocked' || secondErr?.kind === 'blocked';
    const why = steps.map((v) => `${v.provider}: ${v.ok ? (v.words ? `${v.words} words` : 'empty') : v.error}`).join('; ');
    return fail(blocked ? `the page asks for a confirmation (bot protection): ${why}` : `page not readable: ${why}`, blocked ? 'blocked' : secondErr?.kind || firstErr?.kind || 'empty', steps);
  }

  // Memory: a later stage had to deliver -> start there next time; stage 1 delivered -> forget.
  if (best.provider === 'browser-readability' || best.provider === 'jina') remember(u.hostname, best.provider === 'jina' ? 'jina' : 'browser');
  else if (best === first) remember(u.hostname, null);

  const cls = pageClass(best.url || u.href);
  const meas = measured(best.provider, cls);
  const lv = live(best.text, { minWords });
  const L = T[lg === 'de' || lg === 'en' ? lg : lang()];
  const real = steps.filter((x) => x.provider !== 'guard');
  const idx = real.findIndex((x) => x.ok && x.provider === best.provider) + 1;
  const summary = [L.del(best.provider, idx, real.length), meas.f1_mean !== undefined ? L.meas(cls, meas.f1_mean, meas.n_cases) : L.nomeas, L.live(lv.grade, best.words), ...(order === 'domain-memory' ? [L.mem] : [])].join('; ');
  return {
    ok: true, url: best.url, title: best.title || null, text: clip(best.text, lim), words: best.words, truncated: best.text.length > lim,
    provider: best.provider, ms: Date.now() - t0,
    route: { order, steps },
    judge: { measured: meas, live: lv, summary },
    ...(best.quelle === 'seitentext' ? { hint: 'whole visible page text: Readability found no main text' } : best.words < minWords ? { hint: `short: under ${minWords} words` } : {}),
  };
}

export async function readerStatus(mode = 'stdio') {
  const py = await S.findPython();
  return { stage1: py ? `trafilatura ${py.version}` : 'readability-http (no Python with trafilatura found)', browser: (await S.browserAvailable()) && setting('lesen.browser') === 1, jina: S.jinaEnabled(mode) };
}
export { FetchError };
