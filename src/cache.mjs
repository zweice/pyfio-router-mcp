// A small file cache in the state folder of this package (<state>/cache/<namespace>/<sha1>.json): Nominatim's
// policy asks clients to cache. Whatever might be a live position (coordinates) is never put here; callers
// decide that. Clock injectable. PYFIO_CACHE=off turns it off.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { stateDir, mkdirp } from './config.mjs';

const keyOf = (k) => crypto.createHash('sha1').update(typeof k === 'string' ? k : JSON.stringify(k)).digest('hex');
const on = () => !['off', '0', 'false', 'no'].includes(String(process.env.PYFIO_CACHE || 'on').toLowerCase());
const file = (ns, key, dir) => path.join(dir || path.join(stateDir(), 'cache'), ns, `${keyOf(key)}.json`);

export function cacheGet(ns, key, ttlMs, { now = Date.now(), dir } = {}) {
  if (!on()) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file(ns, key, dir), 'utf8'));
    if (now() - j.t <= ttlMs) return j.v;
  } catch {}
  return null;
}
export function cachePut(ns, key, v, { now = Date.now(), dir } = {}) {
  if (!on()) return;
  try { const f = file(ns, key, dir); mkdirp(path.dirname(f)); fs.writeFileSync(f, JSON.stringify({ t: now(), v })); } catch {}
}
