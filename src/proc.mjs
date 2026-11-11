// Child processes with a hard time limit; the whole process tree ends (a hanging Chromium or Python
// must never outlive its call).
import { spawn, execFile, execFileSync } from 'node:child_process';

export class ProcError extends Error {
  constructor(msg, kind) { super(msg); this.kind = kind; }
}

const running = new Set();
export const runningCount = () => running.size;

export const killTree = (child) => new Promise((resolve) => {
  if (!child || child.exitCode !== null || child.signalCode) return resolve();
  const hard = () => { try { child.kill('SIGKILL'); } catch {} resolve(); };
  // taskkill first: once the parent is gone, its children (Chromium) are no longer found by /T.
  if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, hard);
  else {
    // SIGTERM first: Playwright starts Chromium in its own process group and kills it only from its
    // own SIGTERM handler; a SIGKILL would orphan the browser (review 2026-10-20, reproduced in WSL).
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    const t = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} hard(); }, 2000);
    child.once('close', () => { clearTimeout(t); resolve(); });
  }
});

export function killAllSync() {
  for (const c of running) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
      // At exit there is no time to wait: SIGTERM lets Playwright take its Chromium down with it.
      else { try { process.kill(-c.pid, 'SIGTERM'); } catch {} try { c.kill('SIGTERM'); } catch {} }
    } catch {}
  }
}
process.on('exit', killAllSync);

// At most getMax() runs of fn at the same time; others wait up to waitMs, then fail with kind 'busy'.
// (Review 2026-10-20: 100 calls in one request each started their own Chromium.)
export function createLimiter(getMax) {
  let active = 0;
  const queue = [];
  const next = () => {
    while (queue.length && active < Math.max(1, getMax())) {
      const w = queue.shift();
      clearTimeout(w.timer);
      active++;
      w.go();
    }
  };
  return {
    get active() { return active; },
    async run(fn, { waitMs = 30000, label = 'slot' } = {}) {
      if (active >= Math.max(1, getMax())) {
        await new Promise((go, fail) => {
          const w = { go, timer: setTimeout(() => { const i = queue.indexOf(w); if (i >= 0) queue.splice(i, 1); fail(new ProcError(`${label}: all slots busy for ${Math.round(waitMs / 1000)} s`, 'busy')); }, waitMs) };
          queue.push(w);
        });
      } else active++;
      try { return await fn(); } finally { active--; next(); }
    },
  };
}

// Runs exe args, writes input to stdin -> the last JSON line of stdout. Error kinds: timeout, setup
// (cannot start), failKind (no answer).
export function runJson(exe, args, { input = null, timeoutMs = 20000, label = exe, failKind = 'proc', env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, detached: process.platform !== 'win32', stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...(env ? { env } : {}) });
    } catch (e) { return reject(new ProcError(`${label}: ${e.message}`, 'setup')); }
    running.add(child);
    child.on('close', () => running.delete(child));
    let out = '', err = '', done = false;
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => { const c = child; finish(() => reject(new ProcError(`${label}: time limit ${Math.round(timeoutMs / 1000)} s`, 'timeout'))); killTree(c); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; if (out.length > 32e6) killTree(child); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    child.on('error', (e) => finish(() => reject(new ProcError(`${label}: ${e.message}`, 'setup'))));
    child.on('close', (code) => finish(() => {
      const line = out.trim().split('\n').pop() || '';
      try { return resolve(JSON.parse(line)); } catch {}
      const why = err.trim().split('\n').pop() || '';
      reject(new ProcError(`${label}: no answer (code ${code}${why ? `, ${why.slice(0, 160)}` : ''})`, failKind));
    }));
    if (input !== null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}
