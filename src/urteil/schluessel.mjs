// The signing key of this installation: an Ed25519 pair made on the first start, kept in the state
// folder (file readable by the owner only; override the path with PYFIO_URTEIL_KEY_FILE). The private part
// is never logged, printed or returned; only publicInfo() leaves this module.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { stateDir, mkdirp } from '../config.mjs';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
// Key id: first 32 hex characters (128 bit) of the sha-256 of the raw 32-byte public key.
export const keyIdOf = (rawPublic) => crypto.createHash('sha256').update(rawPublic).digest('hex').slice(0, 32);

export function publicKeyFromRaw(raw) {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64u(raw) }, format: 'jwk' });
}
function derive(privateKey) {
  const publicKey = crypto.createPublicKey(privateKey);
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return { privateKey, publicKey, publicRaw: raw, oeffentlicherSchluessel: b64u(raw), id: keyIdOf(raw) };
}
export function ephemeralKeys() {
  return derive(crypto.generateKeyPairSync('ed25519').privateKey);
}

const cache = new Map();
export const keyFile = (dir) => (process.env.PYFIO_URTEIL_KEY_FILE ? path.resolve(process.env.PYFIO_URTEIL_KEY_FILE) : path.join(dir || stateDir(), 'urteil-schluessel.json'));
export function _resetKeys() { cache.clear(); }

function readKeyFile(f) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!j || j.v !== 1 || j.alg !== 'Ed25519' || typeof j.privat !== 'string') throw new Error('verdict key file is not valid');
  return derive(crypto.createPrivateKey({ key: Buffer.from(j.privat, 'base64url'), format: 'der', type: 'pkcs8' }));
}

// Loads the key of this installation, or makes it. A key file that exists but cannot be read is an error
// (never overwritten: the old verdicts would no longer match). If the folder cannot be written, a key
// for this process only is used, so the tool still answers.
export function loadKeys({ dir } = {}) {
  const f = keyFile(dir);
  const hit = cache.get(f);
  if (hit) return hit;
  let keys;
  try { keys = readKeyFile(f); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const fresh = ephemeralKeys();
    const body = JSON.stringify({ v: 1, alg: 'Ed25519', erzeugt: new Date().toISOString(), privat: b64u(fresh.privateKey.export({ format: 'der', type: 'pkcs8' })) });
    try {
      mkdirp(path.dirname(f));
      fs.writeFileSync(f, body, { flag: 'wx', mode: 0o600 });
      keys = fresh;
    } catch (w) {
      if (w.code === 'EEXIST') keys = readKeyFile(f);   // another process of this install was faster
      else keys = fresh;                                // not writable: key for this process only
    }
  }
  cache.set(f, keys);
  return keys;
}

// What may be shown to anyone.
export const publicInfo = (keys) => ({ v: 1, alg: 'Ed25519', schluessel_id: keys.id, oeffentlicher_schluessel: keys.oeffentlicherSchluessel });
