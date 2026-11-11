// The signed verdict ("urteil") on every tool answer. Format v1:
//   { v: 1, alg: "Ed25519", aussteller: "pyfio-router/<version>",
//     werkzeug, werkzeug_version (16 hex of the sha-256 of the canonical English tool definition: name, description, schema),
//     eingabe_sha256 (canonical JSON of the arguments), ergebnis_sha256 (canonical JSON of the answer WITHOUT the field urteil),
//     pruefungen: [{ name, ok, ... }], ergebnis: "bestanden" | "nicht_bestanden" | "fehler", zeit (ISO 8601 UTC),
//     schluessel_id (32 hex), oeffentlicher_schluessel (base64url, 32 bytes), signatur (base64url Ed25519) }
// signatur signs the UTF-8 bytes of the canonical JSON of all other fields. Anyone can check it with an Ed25519 library
// and sha-256 alone (scripts/verify-standalone.mjs does it with node:crypto only). The public key travels inside the
// verdict, so a check without a pinned key id proves only that nothing was changed after signing; pin schluessel_id
// (or the key from /.well-known/pyfio-urteil.json) to also prove who signed.
import crypto from 'node:crypto';
import { VERSION } from '../config.mjs';
import { kanonisch, kanonischSha256, sha256Hex } from './kanonisch.mjs';
import { publicKeyFromRaw, keyIdOf, b64u } from './schluessel.mjs';

export const URTEIL_V = 1;
export const AUSSTELLER = `pyfio-router/${VERSION}`;
const clean = (v) => JSON.parse(JSON.stringify(v ?? null));

// Hash of a tool definition (the pinned version): language independent, so it is the definition in English.
export const werkzeugVersionVon = (definition) => (definition ? sha256Hex(kanonisch({ name: definition.name, description: definition.description, inputSchema: definition.inputSchema })).slice(0, 16) : null);

// Builds and signs the verdict. in: { werkzeug, definition, args, result, pruefungen, keys, now }
export function signiereUrteil({ werkzeug, definition, args, result, pruefungen, keys, now = Date.now }) {
  const res = clean(result);
  const ergebnis = res?.ok === false ? 'fehler' : pruefungen.every((p) => p.ok) ? 'bestanden' : 'nicht_bestanden';
  const body = {
    v: URTEIL_V,
    alg: 'Ed25519',
    aussteller: AUSSTELLER,
    werkzeug: String(werkzeug).slice(0, 64),
    werkzeug_version: werkzeugVersionVon(definition),
    eingabe_sha256: kanonischSha256(clean(args || {})),
    ergebnis_sha256: kanonischSha256(res),
    pruefungen: clean(pruefungen),
    ergebnis,
    zeit: new Date(now()).toISOString(),
    schluessel_id: keys.id,
    oeffentlicher_schluessel: keys.oeffentlicherSchluessel,
  };
  const signatur = b64u(crypto.sign(null, Buffer.from(kanonisch(body), 'utf8'), keys.privateKey));
  return { ...body, signatur };
}

// The answer a client gets: the result with the verdict next to it.
export const mitUrteil = (result, urteil) => ({ ...clean(result), urteil });

// Finds the answer object in what a caller hands over: the answer itself, its JSON text, or an MCP response
// ({ content: [{ type: 'text', text }] } or { result: { content: [...] } }).
export function antwortAus(x) {
  let v = x;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  if (v && typeof v === 'object' && v.result && Array.isArray(v.result.content)) v = v.result;
  if (v && typeof v === 'object' && Array.isArray(v.content) && v.urteil === undefined) {
    const t = v.content.find((c) => c && c.type === 'text' && typeof c.text === 'string');
    if (!t) return null;
    try { v = JSON.parse(t.text); } catch { return null; }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

const FELDER = ['v', 'alg', 'aussteller', 'werkzeug', 'werkzeug_version', 'eingabe_sha256', 'ergebnis_sha256', 'pruefungen', 'ergebnis', 'zeit', 'schluessel_id', 'oeffentlicher_schluessel', 'signatur'];

// verifyUrteil(antwort, { erwarteteSchluesselId?, erwarteterOeffentlicherSchluessel?, eingabe?, erwarteteWerkzeugVersion? })
//   -> { ok, grund, ergebnis?, schluessel_id? }.   ok = "the signature holds and the answer is the signed one";
// whether the verdict says bestanden is in `ergebnis`, and is a separate question.
export function verifyUrteil(antwort, opts = {}) {
  const no = (grund) => ({ ok: false, grund });
  const a = antwortAus(antwort);
  if (!a) return no('answer is not a JSON object');
  const u = a.urteil;
  if (!u || typeof u !== 'object' || Array.isArray(u)) return no('urteil missing');
  for (const f of FELDER) if (u[f] === undefined) return no(`urteil field missing: ${f}`);
  if (u.v !== URTEIL_V) return no('unknown verdict version');
  if (u.alg !== 'Ed25519') return no('unknown algorithm');
  if (typeof u.signatur !== 'string' || typeof u.oeffentlicher_schluessel !== 'string') return no('urteil fields have the wrong type');
  let raw;
  try { raw = Buffer.from(u.oeffentlicher_schluessel, 'base64url'); } catch { return no('public key is not base64url'); }
  if (raw.length !== 32) return no('public key must be 32 bytes');
  if (keyIdOf(raw) !== u.schluessel_id) return no('schluessel_id does not match the public key');
  if (opts.erwarteteSchluesselId && opts.erwarteteSchluesselId !== u.schluessel_id) return no('signed by another key than the expected one');
  if (opts.erwarteterOeffentlicherSchluessel && opts.erwarteterOeffentlicherSchluessel !== u.oeffentlicher_schluessel) return no('signed by another key than the expected one');
  let ok = false;
  try {
    const { signatur, ...body } = u;
    ok = crypto.verify(null, Buffer.from(kanonisch(body), 'utf8'), publicKeyFromRaw(raw), Buffer.from(signatur, 'base64url'));
  } catch { return no('signature cannot be checked'); }
  if (!ok) return no('signature invalid');
  const { urteil, ...ohne } = a;
  let h;
  try { h = kanonischSha256(ohne); } catch { return no('answer is not canonical JSON'); }
  if (h !== u.ergebnis_sha256) return no('result was changed after signing');
  if (opts.eingabe !== undefined) {
    let eh; try { eh = kanonischSha256(clean(opts.eingabe)); } catch { return no('eingabe is not JSON'); }
    if (eh !== u.eingabe_sha256) return no('the verdict is for other arguments');
  }
  if (opts.erwarteteWerkzeugVersion && opts.erwarteteWerkzeugVersion !== u.werkzeug_version) return no('tool version differs from the expected one');
  return { ok: true, grund: 'ok', ergebnis: u.ergebnis, schluessel_id: u.schluessel_id };
}
