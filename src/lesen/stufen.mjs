// The readers (stages) of read_page. Each returns { text (Markdown), titel, quelle? } or throws an
// error with a kind. Measured in router-ausbau/schritt1-seite-lesen (253 valid cases, token F1):
// trafilatura 0.567, browser-readability 0.572, jina 0.430; cascade 0.62.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PKG_ROOT, keys, setting, stateDir, mkdirp } from '../config.mjs';
import { runJson, ProcError, createLimiter } from '../proc.mjs';
import { readabilityHtml } from './extract-md.mjs';
import { FetchError } from './guard.mjs';
import { request } from '../net.mjs';

const PY_SCRIPT = path.join(PKG_ROOT, 'py', 'lesen.py');
const BROWSER_CLI = fileURLToPath(new URL('./browser-cli.mjs', import.meta.url));
export const PY_MS = 20000, BROWSER_MS = 30000;
// At most so many Python and Chromium processes at once, whatever the callers send (review 2026-10-20).
const pyLimit = createLimiter(() => setting('lesen.maxPython'));
const browserLimit = createLimiter(() => setting('lesen.maxBrowser'));
// Error texts go to callers: no local paths in them.
export const noPaths = (m) => String(m || '').replace(/[A-Za-z]:\\[^\s'"]+|\/(?:home|Users|root|tmp|var|opt)\/[^\s'"]+/g, '<path>');

// ---------- Trafilatura (Python) ----------
// PYFIO_PYTHON, else py/venv next to the package, else python3/python on PATH that can import
// trafilatura (checked once per process, 8 s each).
let pyFound;
export async function findPython() {
  if (pyFound !== undefined) return pyFound;
  const cands = [];
  if (process.env.PYFIO_PYTHON) cands.push(process.env.PYFIO_PYTHON);
  cands.push(path.join(PKG_ROOT, 'py', 'venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'])));
  if (process.env.PYFIO_PYTHON_PATH !== 'off') cands.push(...(process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']));
  pyFound = null;
  for (const c of cands) {
    if (path.isAbsolute(c) && !fs.existsSync(c)) continue;
    try {
      const j = await runJson(c, ['-I', '-c', 'import json,trafilatura;print(json.dumps({"v":trafilatura.__version__}))'], { timeoutMs: 8000, label: 'python' });
      if (j && j.v) { pyFound = { exe: c, version: j.v }; break; }
    } catch {}
  }
  return pyFound;
}
export const resetPythonCache = () => { pyFound = undefined; };

export async function trafilatura(html, url, { timeoutMs = PY_MS } = {}) {
  const py = await findPython();
  if (!py) throw new FetchError('trafilatura not installed', { kind: 'setup' });
  let j;
  const t0 = Date.now();
  try { j = await pyLimit.run(() => runJson(py.exe, ['-I', PY_SCRIPT], { input: JSON.stringify({ html, url }), timeoutMs: Math.max(2000, timeoutMs - (Date.now() - t0)), label: 'trafilatura', failKind: 'extract' }), { waitMs: Math.max(1000, timeoutMs - 3000), label: 'trafilatura' }); }
  catch (e) { throw new FetchError(noPaths(e.message), { kind: e instanceof ProcError ? e.kind : 'extract' }); }
  if (!j.ok) throw new FetchError(j.error || 'trafilatura: error', { kind: 'extract' });
  return { text: String(j.text || ''), titel: j.titel || null };
}

// ---------- Readability on the fetched HTML (Node only, no browser) ----------
export async function readabilityHttp(html, url) {
  const r = readabilityHtml(html, url);
  // The visible text of the whole page is no article: stage 1 then counts as empty.
  return { text: r.quelle === 'readability' ? r.text : '', titel: r.titel || null, quelle: r.quelle };
}

// ---------- headless Chromium with Readability, as its own process ----------
let browserOk;
export async function browserAvailable() {
  if (browserOk !== undefined) return browserOk;
  // The package alone is not enough: npx and Docker installs have no Chromium download (review 2026-10-20).
  try { const m = await import('playwright-core'); const c = m.chromium || m.default?.chromium; browserOk = !!c && fs.existsSync(c.executablePath()); } catch { browserOk = false; }
  return browserOk;
}
// Chromium's temporary profile goes to <state>/browser-tmp: a killed browser leaves it behind, and old
// ones (over 30 min, only in this folder) are removed before the next start (review 2026-10-20).
function browserEnv() {
  const dir = path.join(stateDir(), 'browser-tmp');
  try {
    mkdirp(dir);
    for (const e of fs.readdirSync(dir)) {
      const p = path.join(dir, e);
      try { if (Date.now() - fs.statSync(p).mtimeMs > 30 * 60e3) fs.rmSync(p, { recursive: true, force: true }); } catch {}
    }
  } catch { return undefined; }
  return { ...process.env, TMP: dir, TEMP: dir, TMPDIR: dir };
}
// ua: User-Agent to send (hosted mode: the honest one); tdm: refuse pages with a TDM reservation.
export async function browser(url, { timeoutMs = BROWSER_MS + 8000, pageMs = BROWSER_MS, ua = null, tdm = false } = {}) {
  let j;
  const t0 = Date.now();
  const args = [BROWSER_CLI, `--url=${url}`, `--ms=${Math.round(pageMs)}`, ...(ua ? [`--ua=${ua}`] : []), ...(tdm ? ['--tdm=1'] : [])];
  try {
    j = await browserLimit.run(() => runJson(process.execPath, args, { timeoutMs: Math.max(8000, timeoutMs - (Date.now() - t0)), label: 'browser', failKind: 'browser', env: browserEnv() }), { waitMs: Math.max(1000, timeoutMs - 15000), label: 'browser' });
  } catch (e) { throw new FetchError(noPaths(e.message), { kind: e.kind || 'browser' }); }
  if (!j.ok) throw new FetchError(noPaths(j.error || 'browser: error'), { kind: j.kind || 'browser' });
  return { text: String(j.text || ''), titel: j.titel || null, quelle: j.quelle, url: j.url };
}

// ---------- Jina Reader, only with the operator's own key (BYOK) ----------
// Measured: best on bot-protected pages (62 % real content where our browser got 403). Runs only when
// JINA_API_KEY is set: the call goes from the operator's machine on the operator's account; Pyfio
// resells nothing. Never in the hosted mode unless PYFIO_REMOTE_JINA=1 (written consent).
export const jinaEnabled = (mode) => !!keys().jina && (mode !== 'http' || process.env.PYFIO_REMOTE_JINA === '1');
export async function jina(url, { timeoutMs = 25000 } = {}) {
  const key = keys().jina;
  if (!key) throw new FetchError('no JINA_API_KEY', { kind: 'setup' });
  let res;
  try {
    res = await request(`https://r.jina.ai/${url}`, { timeoutMs, headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'X-Return-Format': 'markdown', 'X-With-Generated-Alt': 'false' } });
  } catch (e) { throw new FetchError(`jina: ${e.kind === 'timeout' ? `time limit ${Math.round(timeoutMs / 1000)} s` : 'not reachable'}`, { kind: e.kind === 'timeout' ? 'timeout' : 'network' }); }
  if (res.status < 200 || res.status >= 300) throw new FetchError(`jina: HTTP ${res.status}`, { status: res.status, kind: [401, 402, 403, 429].includes(res.status) ? 'blocked' : 'http' });
  let j;
  try { j = JSON.parse(res.text); } catch { return { text: res.text, titel: null }; }
  const d = j.data || {};
  return { text: String(d.content || ''), titel: d.title || null, url: d.url || url };
}
