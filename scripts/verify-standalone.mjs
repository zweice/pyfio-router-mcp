#!/usr/bin/env node
// Check the signed verdict ("urteil") of a Pyfio Router answer WITHOUT any Pyfio code: this file uses only
// node:crypto, node:fs and node:url. A stranger can read it in two minutes and run it with plain Node (>= 20).
//
//   node verify-standalone.mjs <answer.json | ->  [--key-id <schluessel_id>]
//
// The input is the answer JSON (the text of the MCP tool result) or the whole MCP response. What it checks:
//   1. the verdict has all fields, version 1, algorithm Ed25519;
//   2. schluessel_id is the first 32 hex characters of sha-256 of the 32-byte public key;
//   3. with --key-id: the signer is the key you expect (otherwise the key inside the verdict is trusted only for
//      "nothing was changed since signing", not for "who signed");
//   4. signatur is a valid Ed25519 signature over the canonical JSON (RFC 8785 subset: keys sorted, no white space,
//      ECMAScript number and string forms) of all verdict fields except signatur;
//   5. ergebnis_sha256 is the sha-256 of the canonical JSON of the answer without the field urteil.
// Exit code 0 = it holds, 1 = it does not, 2 = usage or unreadable input. Prints one line of JSON.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

function canon(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new TypeError('not JSON'); return JSON.stringify(v); }
  if (Array.isArray(v)) return `[${v.map((x) => canon(x === undefined ? null : x)).join(',')}]`;
  if (typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  throw new TypeError('not JSON');
}
const sha = (s, enc = 'hex') => crypto.createHash('sha256').update(s).digest(enc);

export function verify(input, { keyId } = {}) {
  const no = (grund) => ({ ok: false, grund });
  let a;
  try { a = typeof input === 'string' ? JSON.parse(input) : input; } catch { return no('not JSON'); }
  if (a && a.result && Array.isArray(a.result.content)) a = a.result;
  if (a && Array.isArray(a.content) && a.urteil === undefined) {
    const t = a.content.find((c) => c && c.type === 'text');
    try { a = JSON.parse(t.text); } catch { return no('MCP response without a JSON text'); }
  }
  const u = a && a.urteil;
  if (!u || typeof u !== 'object') return no('urteil missing');
  for (const f of ['v', 'alg', 'aussteller', 'werkzeug', 'werkzeug_version', 'eingabe_sha256', 'ergebnis_sha256', 'pruefungen', 'ergebnis', 'zeit', 'schluessel_id', 'oeffentlicher_schluessel', 'signatur']) if (u[f] === undefined) return no(`field missing: ${f}`);
  if (u.v !== 1 || u.alg !== 'Ed25519') return no('unknown version or algorithm');
  const raw = Buffer.from(String(u.oeffentlicher_schluessel), 'base64url');
  if (raw.length !== 32) return no('public key is not 32 bytes');
  if (sha(raw).slice(0, 32) !== u.schluessel_id) return no('schluessel_id does not match the public key');
  if (keyId && keyId !== u.schluessel_id) return no('signed by another key than the expected one');
  const { signatur, ...body } = u;
  let ok = false;
  try {
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
    ok = crypto.verify(null, Buffer.from(canon(body), 'utf8'), key, Buffer.from(String(signatur), 'base64url'));
  } catch { return no('signature cannot be checked'); }
  if (!ok) return no('signature invalid');
  const { urteil, ...rest } = a;
  if (sha(canon(rest)) !== u.ergebnis_sha256) return no('result was changed after signing');
  return { ok: true, grund: 'ok', ergebnis: u.ergebnis, schluessel_id: u.schluessel_id, werkzeug: u.werkzeug };
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const ki = args.indexOf('--key-id');
  const keyId = ki >= 0 ? args.splice(ki, 2)[1] : undefined;
  const src = args[0];
  if (!src) { console.log(JSON.stringify({ ok: false, grund: 'usage: node verify-standalone.mjs <answer.json | -> [--key-id <id>]' })); process.exit(2); }
  let text;
  try { text = fs.readFileSync(src === '-' ? 0 : src, 'utf8'); } catch { console.log(JSON.stringify({ ok: false, grund: 'cannot read the input' })); process.exit(2); }
  const r = verify(text, { keyId });
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}
