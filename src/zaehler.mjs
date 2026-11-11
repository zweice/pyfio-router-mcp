// Anonymous demand counters. What is counted per call: day (UTC), tool, ok or error kind, provider,
// client name (from the MCP handshake, e.g. "claude-code"), duration bucket, and a pseudonym of the
// operator. Never counted: URLs, places, page text, forecasts, IP addresses, keys.
// Operator pseudonym:
// - local (stdio): a random install id, created once in the state folder, hashed (sha256, 16 hex);
// - hosted (http): an API key's id hashed, else HMAC-SHA256 of the IP (IPv6 as its /64) with a secret
//   salt of this server that is renewed every 90 days; the IP itself is never written anywhere.
// Each process writes its own file per day (no lock needed): <state>/zaehler/<day>/<proc>.json.
// A local install can send its daily counts to the hosted router (telemetryUrl, off in this build),
// which keeps per operator and day the latest report (/v1/zaehler, idempotent).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { stateDir, mkdirp, telemetryWanted, telemetryUrl, setting, VERSION } from './config.mjs';
import { request } from './net.mjs';

export const TOOLS = ['read_page', 'weather', 'travel_time', 'web_search', 'build_or_use'];
export const ROUTER_KATEGORIEN = ['seite_lesen', 'fahrzeit', 'websuche', 'datum', 'unbekannt'];
export const ROUTER_STUFEN = ['null', 'klein', 'mittel', 'gross', 'sehr_gross'];
export const ROUTER_EMPFEHLUNGEN = ['nutzen', 'bauen', 'gratis'];
const BUCKETS = ['lt1s', '1-3s', '3-10s', 'gt10s'];
export const bucketOf = (ms) => (ms < 1000 ? 'lt1s' : ms < 3000 ? '1-3s' : ms < 10000 ? '3-10s' : 'gt10s');
export const cleanClient = (s) => (String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'unknown');
const cleanToken = (s, max = 30) => String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, max) || 'none';
export const KEY_RX = /^(read_page|weather|travel_time|web_search|build_or_use)\|(ok|err:[a-z0-9_-]{1,20})\|[a-z0-9._-]{1,30}\|[a-z0-9._-]{1,40}\|(lt1s|1-3s|3-10s|gt10s)$/;
export const dayOf = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function atomicWrite(file, data) {
  mkdirp(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };

// ---------- pseudonyms ----------
// Ids and salts are kept in memory too: with a state folder that cannot be written, every call would
// otherwise get a new one (review 2026-10-20: then no quota held).
const installIds = new Map(), salts = new Map();
export function installPseudonym(dir = stateDir()) {
  let id = installIds.get(dir) || '';
  if (!id) {
    const f = path.join(dir, 'install-id');
    try { id = fs.readFileSync(f, 'utf8').trim(); } catch {}
    if (!/^[0-9a-f]{32}$/.test(id)) { id = crypto.randomBytes(16).toString('hex'); try { mkdirp(dir); fs.writeFileSync(f, id, { mode: 0o600 }); } catch {} }
    installIds.set(dir, id);
  }
  return sha(`pyfio-router-install|${id}`).slice(0, 16);
}

const SALT_DAYS = 90;
function serverSalt(dir) {
  const mem = salts.get(dir);
  if (mem && Date.now() - mem.created < SALT_DAYS * 864e5) return mem.salt;
  const f = path.join(dir, 'zaehler-salz.json');
  let j = readJson(f, null);
  if (!(j && /^[0-9a-f]{64}$/.test(j.salt) && Date.now() - j.created < SALT_DAYS * 864e5)) {
    j = { salt: crypto.randomBytes(32).toString('hex'), created: Date.now() };
    try { atomicWrite(f, JSON.stringify(j)); } catch {}
  }
  salts.set(dir, j);
  return j.salt;
}
export function normIp(ip) {
  let a = String(ip || '').trim().replace(/^::ffff:(?=\d+\.)/i, '');
  if (net.isIPv4(a)) return a;
  if (net.isIPv6(a)) {
    // the /64: privacy addresses of one household count once
    const full = a.split('%')[0];
    const halves = full.split('::');
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
    const groups = halves.length > 1 ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head;
    return groups.slice(0, 4).map((g) => parseInt(g || '0', 16).toString(16)).join(':') + '::/64';
  }
  return 'unknown';
}
export function requestPseudonym({ ip, keyId } = {}, dir = stateDir()) {
  if (keyId) return `k${sha(`pyfio-router-key|${keyId}`).slice(0, 15)}`;
  return crypto.createHmac('sha256', serverSalt(dir)).update(normIp(ip)).digest('hex').slice(0, 16);
}

// ---------- the counter of this process ----------
export function createCounter({ mode = 'stdio', dir = stateDir(), send = defaultSend } = {}) {
  const proc = `${mode}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  let cur = null, timer = null;
  const freshDay = (day) => ({ v: 1, day, mode, version: VERSION, calls: {}, operators: {}, router: {}, noOffer: 0 });
  const fileFor = (day) => path.join(dir, 'zaehler', day, `${proc}.json`);
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!cur) return;
    try { atomicWrite(fileFor(cur.day), JSON.stringify(cur)); } catch {}
  };
  const soon = () => { if (!timer) { timer = setTimeout(flush, 3000); timer.unref?.(); } };
  process.on('exit', flush);
  const self = {
    mode,
    proc,
    record({ tool, ok, kind, provider, ms = 0, client, operator }) {
      const day = dayOf();
      if (!cur || cur.day !== day) { flush(); cur = freshDay(day); }
      const t = TOOLS.includes(tool) ? tool : null;
      if (!t) return;
      const key = `${t}|${ok ? 'ok' : `err:${cleanToken(kind, 20)}`}|${cleanToken(provider)}|${cleanClient(client)}|${bucketOf(ms)}`;
      cur.calls[key] = (cur.calls[key] || 0) + 1;
      const op = String(operator || 'unknown').slice(0, 16);
      const o = cur.operators[op] || (cur.operators[op] = { n: 0, tools: {}, calls: {} });
      o.n++;
      o.tools[t] = (o.tools[t] || 0) + 1;
      o.calls[key] = (o.calls[key] || 0) + 1;   // per operator too, so own calls can leave the totals
      soon();
      if (mode === 'stdio') self.maybePing().catch(() => {});
    },
    flush,
    // Calls of one operator today in this process (the free quota of build_or_use asks for it).
    usedToday(operator) {
      if (!cur || cur.day !== dayOf()) return 0;
      return cur.operators[String(operator || 'unknown').slice(0, 16)]?.n || 0;
    },
    // build_or_use: only fixed tokens are counted (category, budget level, recommendation, ok or error), never the
    // task text. "Asked, but no offer" (unknown task, or a free fact) is counted on its own.
    recordRouter({ kategorie, stufe, empfehlung, ok }) {
      const day = dayOf();
      if (!cur || cur.day !== day) { flush(); cur = freshDay(day); }
      const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);
      const key = [pick(kategorie, ROUTER_KATEGORIEN, 'ungueltig'), pick(stufe, ROUTER_STUFEN, 'keine'), pick(empfehlung, ROUTER_EMPFEHLUNGEN, 'keine'), ok ? 'ok' : 'err'].join('|');
      cur.router[key] = (cur.router[key] || 0) + 1;
      if (ok && (kategorie === 'unbekannt' || kategorie === 'datum')) cur.noOffer += 1;
      soon();
    },
    // Sends the finished and today's counts of this install, at most every zaehler.pingStunden.
    async maybePing({ force = false } = {}) {
      const url = telemetryUrl();
      if (!url || !telemetryWanted()) return { sent: false, why: !url ? 'no endpoint' : 'telemetry off' };
      const stamp = path.join(dir, 'zaehler', 'ping.json');
      const st = readJson(stamp, { t: 0 });
      if (!force && Date.now() - st.t < setting('zaehler.pingStunden') * 36e5) return { sent: false, why: 'not due' };
      atomicWrite(stamp, JSON.stringify({ t: Date.now() }));
      flush();
      const payload = buildReport(dir, installPseudonym(dir));
      if (!Object.keys(payload.days).length) return { sent: false, why: 'nothing counted' };
      const ok = await send(url, payload);
      return { sent: ok, days: Object.keys(payload.days).length };
    },
  };
  return self;
}

// The local install's counts of the last 14 days, all processes merged: { v, operator, version, mode, days: { day: calls } }.
export function buildReport(dir, operator) {
  const root = path.join(dir, 'zaehler');
  const days = {};
  let names = [];
  try { names = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(-14); } catch {}
  for (const day of names) {
    const calls = {};
    for (const f of fs.readdirSync(path.join(root, day)).filter((x) => x.endsWith('.json'))) {
      const j = readJson(path.join(root, day, f), null);
      if (!j || j.mode !== 'stdio') continue;
      for (const [k, n] of Object.entries(j.calls || {})) if (KEY_RX.test(k)) calls[k] = (calls[k] || 0) + n;
    }
    if (Object.keys(calls).length) days[day] = calls;
  }
  return { v: 1, operator, version: VERSION, mode: 'stdio', days };
}

async function defaultSend(url, payload) {
  try {
    const r = await request(url, { method: 'POST', timeoutMs: 5000, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    return r.status >= 200 && r.status < 300;
  } catch { return false; }
}

// ---------- receiving reports of local installs (hosted mode) ----------
// -> { ok, days } or throws kind 'input'. Keeps per operator and day the latest report.
export function acceptReport(body, dir = stateDir()) {
  const bad = (m) => { throw Object.assign(new Error(m), { kind: 'input' }); };
  if (!body || typeof body !== 'object' || body.v !== 1) bad('v must be 1');
  if (!/^[0-9a-f]{16}$/.test(String(body.operator || ''))) bad('operator: 16 hex');
  const days = body.days && typeof body.days === 'object' ? body.days : bad('days missing');
  const today = Date.parse(dayOf());
  let n = 0;
  for (const [day, calls] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) bad(`day ${day}`);
    const age = (today - Date.parse(day)) / 864e5;
    if (!(age >= 0 && age <= 30)) continue;
    const clean = {};
    let keysN = 0;
    for (const [k, v] of Object.entries(calls || {})) {
      if (!KEY_RX.test(k) || !Number.isInteger(v) || v < 0 || v > 1e6) bad(`count ${String(k).slice(0, 60)}`);
      if (++keysN > 200) bad('too many keys');
      clean[k] = v;
    }
    // One small file per operator and day: a write never grows with the number of operators
    // (review 2026-10-20: one shared file reached 39 MB and blocked the event loop).
    const dDir = path.join(dir, 'extern', day);
    const f = path.join(dDir, `${body.operator}.json`);
    if (!fs.existsSync(f)) {
      let count = 0;
      try { count = fs.readdirSync(dDir).length; } catch {}
      if (count >= MAX_REPORTS_PER_DAY) bad('report limit of the day reached');
    }
    atomicWrite(f, JSON.stringify({ calls: clean, version: String(body.version || '').slice(0, 20), t: Date.now() }));
    n++;
  }
  return { ok: true, days: n };
}
export const MAX_REPORTS_PER_DAY = 20000;

// All reports of one day: { operator: { calls, version, t } }.
export function reportsOf(dir, day) {
  const out = {};
  const dDir = path.join(dir, 'extern', day);
  let names = [];
  try { names = fs.readdirSync(dDir).filter((x) => /^[0-9a-f]{16}\.json$/.test(x)); } catch {}
  for (const f of names) { const j = readJson(path.join(dDir, f), null); if (j) out[f.slice(0, 16)] = j; }
  return out;
}
