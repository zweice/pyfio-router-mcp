// The signed verdict: key handling, signing, checking, tampering, and the standalone checker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpState, ROOT } from './helpers.mjs';

const dir = tmpState('urteil');
const { loadKeys, ephemeralKeys, publicInfo, keyIdOf, _resetKeys } = await import('../src/urteil/schluessel.mjs');
const { verifyUrteil, werkzeugVersionVon, AUSSTELLER } = await import('../src/urteil/urteil.mjs');
const { callSigned } = await import('../src/urteil/signiert.mjs');
const { definition } = await import('../src/tools.mjs');
const { verify: standalone } = await import('../scripts/verify-standalone.mjs');

const SCRIPT = path.join(ROOT, 'scripts', 'verify-standalone.mjs');
// A fixed clock and mock implementations: no network, no waiting.
const FIXED = Date.parse('2026-11-03T10:00:00Z');
const ctxFor = (extra = {}) => ({ now: () => FIXED, dir, impl: { readPage: async (url) => okPage(url), weather: async () => ({ ok: true, place: { name: 'X' }, days: [], provider: 'open-meteo (free): mean', judge: {} }) }, ...extra });
const okPage = (url) => ({ ok: true, url, title: 'T', text: 'text', words: 1, provider: 'trafilatura', route: { order: 'cascade', steps: [] }, judge: { measured: {}, live: {} } });
const sign = async (name = 'read_page', args = { url: 'https://example.org/' }, ctx = ctxFor()) => (await callSigned(name, args, ctx)).result;
const clone = (o) => JSON.parse(JSON.stringify(o));

test('the key is made on the first start, kept, and only the public part is shown', () => {
  const k1 = loadKeys({ dir });
  const f = path.join(dir, 'urteil-schluessel.json');
  assert.ok(fs.existsSync(f));
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600, 'readable by the owner only');
  _resetKeys();
  const k2 = loadKeys({ dir });
  assert.equal(k2.id, k1.id, 'the same key after a restart');
  const info = publicInfo(k1);
  assert.deepEqual(Object.keys(info).sort(), ['alg', 'oeffentlicher_schluessel', 'schluessel_id', 'v']);
  assert.equal(Buffer.from(info.oeffentlicher_schluessel, 'base64url').length, 32);
  assert.equal(info.schluessel_id, keyIdOf(Buffer.from(info.oeffentlicher_schluessel, 'base64url')));
  assert.equal(info.schluessel_id.length, 32);
  assert.doesNotMatch(JSON.stringify(info), new RegExp(JSON.parse(fs.readFileSync(f, 'utf8')).privat.slice(0, 20)), 'the private part is not in the public info');
});

test('PYFIO_URTEIL_KEY_FILE moves the key file; a broken file is never overwritten', () => {
  const custom = path.join(os.tmpdir(), `pyfio-router-keyfile-${crypto.randomBytes(4).toString('hex')}.json`);
  const base = loadKeys({ dir }).id;
  process.env.PYFIO_URTEIL_KEY_FILE = custom;
  try {
    _resetKeys();
    const k = loadKeys({ dir });
    assert.ok(fs.existsSync(custom));
    assert.notEqual(k.id, base, 'a key of its own at the other path');
    fs.writeFileSync(custom, '{not json');
    _resetKeys();
    assert.throws(() => loadKeys({ dir }));
    assert.equal(fs.readFileSync(custom, 'utf8'), '{not json', 'kept as it was');
  } finally { delete process.env.PYFIO_URTEIL_KEY_FILE; _resetKeys(); fs.rmSync(custom, { force: true }); }
});

test('every answer carries a verdict next to the result; verifyUrteil and the standalone checker agree', async () => {
  const a = await sign();
  assert.equal(a.ok, true);
  assert.equal(a.url, 'https://example.org/', 'the result stays as it was');
  const u = a.urteil;
  assert.equal(u.v, 1);
  assert.equal(u.alg, 'Ed25519');
  assert.equal(u.aussteller, AUSSTELLER);
  assert.equal(u.werkzeug, 'read_page');
  assert.equal(u.werkzeug_version, werkzeugVersionVon(definition('read_page')));
  assert.match(u.werkzeug_version, /^[0-9a-f]{16}$/);
  assert.match(u.eingabe_sha256, /^[0-9a-f]{64}$/);
  assert.match(u.ergebnis_sha256, /^[0-9a-f]{64}$/);
  assert.equal(u.zeit, '2026-11-03T10:00:00.000Z', 'the injected clock');
  assert.equal(u.ergebnis, 'bestanden');
  assert.deepEqual(u.pruefungen.map((p) => p.name), ['eingabe_schema', 'pflichtfelder', 'zeitlimit', 'quelle_erlaubt', 'groesse']);
  assert.ok(u.pruefungen.every((p) => p.ok));
  const v = verifyUrteil(a, { erwarteteSchluesselId: loadKeys({ dir }).id, eingabe: { url: 'https://example.org/' } });
  assert.deepEqual(v, { ok: true, grund: 'ok', ergebnis: 'bestanden', schluessel_id: u.schluessel_id });
  assert.equal(standalone(a).ok, true);
  assert.equal(standalone(a, { keyId: u.schluessel_id }).ok, true);
  // also from the JSON text and from an MCP response
  assert.equal(verifyUrteil(JSON.stringify(a)).ok, true);
  assert.equal(verifyUrteil({ content: [{ type: 'text', text: JSON.stringify(a) }], isError: false }).ok, true);
  assert.equal(verifyUrteil({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(a) }] } }).ok, true);
});

test('the same input signs to the same hashes; other arguments give other hashes', async () => {
  const a1 = await sign(), a2 = await sign();
  assert.equal(a1.urteil.eingabe_sha256, a2.urteil.eingabe_sha256);
  assert.equal(a1.urteil.ergebnis_sha256, a2.urteil.ergebnis_sha256);
  const b = await sign('read_page', { url: 'https://example.org/other' });
  assert.notEqual(b.urteil.eingabe_sha256, a1.urteil.eingabe_sha256);
  assert.notEqual(b.urteil.ergebnis_sha256, a1.urteil.ergebnis_sha256);
  assert.equal(verifyUrteil(a1, { eingabe: { url: 'https://example.org/other' } }).ok, false, 'a verdict for other arguments is refused');
});

test('every tool is signed, also wetter, errors and unknown tools', async () => {
  const w = await sign('weather', { place: 'X' });
  assert.equal(w.urteil.werkzeug, 'weather');
  assert.equal(verifyUrteil(w).ok, true);
  const de = await sign('seite_lesen', { url: 'https://example.org/' });
  assert.equal(de.urteil.werkzeug, 'read_page', 'the German name stands for the same tool');
  assert.equal(de.urteil.werkzeug_version, (await sign()).urteil.werkzeug_version, 'the version hash does not depend on the language');
  const err = await sign('read_page', { url: 'https://example.org/' }, ctxFor({ impl: { readPage: async () => { throw Object.assign(new Error('boom'), { kind: 'network' }); } } }));
  assert.equal(err.ok, false);
  assert.equal(err.urteil.ergebnis, 'fehler');
  assert.equal(verifyUrteil(err).ok, true);
  const unk = await sign('rm_rf', {});
  assert.equal(unk.ok, false);
  assert.equal(unk.urteil.ergebnis, 'fehler');
  assert.equal(unk.urteil.werkzeug_version, null);
  assert.equal(verifyUrteil(unk).ok, true);
  const bu = await sign('build_or_use', { task: 'Which public holidays are there in Bavaria?', budget_usd: 0.1 });
  assert.equal(bu.urteil.werkzeug, 'build_or_use');
  assert.equal(verifyUrteil(bu).ok, true);
});

test('the checks are deterministic: a wrong argument, a missing field and a slow call fail the verdict, not the signature', async () => {
  const bad = await sign('read_page', { url: 'https://example.org/', nope: 1 });
  assert.equal(bad.urteil.ergebnis, 'nicht_bestanden');
  assert.equal(bad.urteil.pruefungen.find((p) => p.name === 'eingabe_schema').ok, false);
  assert.equal(verifyUrteil(bad).ok, true, 'signed correctly, the content of the verdict is another question');
  const thin = await sign('read_page', { url: 'https://example.org/' }, ctxFor({ impl: { readPage: async (url) => ({ ok: true, url, provider: 'trafilatura' }) } }));
  assert.equal(thin.urteil.ergebnis, 'nicht_bestanden');
  assert.deepEqual(thin.urteil.pruefungen.find((p) => p.name === 'pflichtfelder').fehlend.sort(), ['judge', 'route', 'text']);
  const alien = await sign('read_page', { url: 'https://example.org/' }, ctxFor({ impl: { readPage: async (url) => ({ ...okPage(url), provider: 'made-up-reader' }) } }));
  assert.equal(alien.urteil.pruefungen.find((p) => p.name === 'quelle_erlaubt').ok, false);
  let t = 0;
  const slow = await sign('read_page', { url: 'https://example.org/' }, ctxFor({ now: () => (t += 80000) }));
  const z = slow.urteil.pruefungen.find((p) => p.name === 'zeitlimit');
  assert.equal(z.ok, false);
  assert.ok(z.ms > z.grenze_ms);
});

// ---------- tampering ----------
const refused = (a, opts, re) => {
  const r = verifyUrteil(a, opts);
  assert.equal(r.ok, false, `expected a refusal, got ${JSON.stringify(r)}`);
  if (re) assert.match(r.grund, re);
  assert.equal(standalone(a, opts?.erwarteteSchluesselId ? { keyId: opts.erwarteteSchluesselId } : {}).ok, false, 'the standalone checker refuses it too');
};

test('tampering: a changed result field is refused', async () => {
  const a = clone(await sign());
  a.text = 'something else';
  refused(a, {}, /result was changed/);
  const b = clone(await sign());
  b.extra = 1;
  refused(b, {}, /result was changed/);
  const c = clone(await sign());
  delete c.title;
  refused(c, {}, /result was changed/);
});

test('tampering: a changed signature is refused', async () => {
  const a = clone(await sign());
  const raw = Buffer.from(a.urteil.signatur, 'base64url');
  raw[0] ^= 1;
  a.urteil.signatur = raw.toString('base64url');
  refused(a, {}, /signature invalid/);
  const b = clone(await sign());
  b.urteil.signatur = 'AAAA';
  refused(b, {}, /signature/);
});

test('tampering: a changed verdict field is refused', async () => {
  for (const [field, value] of [['ergebnis', 'nicht_bestanden'], ['zeit', '2030-01-01T00:00:00.000Z'], ['werkzeug', 'weather'], ['pruefungen', []], ['eingabe_sha256', 'a'.repeat(64)], ['werkzeug_version', 'f'.repeat(16)], ['aussteller', 'pyfio-router/9.9.9']]) {
    const a = clone(await sign());
    a.urteil[field] = value;
    refused(a, {}, /signature invalid/);
  }
  const b = clone(await sign());
  b.urteil.pruefungen[0].ok = false;
  refused(b, {}, /signature invalid/);
  const c = clone(await sign());
  c.urteil.neu = 'x';
  refused(c, {}, /signature invalid/);
  const d = clone(await sign());
  delete d.urteil.zeit;
  refused(d, {}, /field missing/);
});

test('tampering: re-signed with a foreign key is refused when the key id is pinned', async () => {
  const mine = loadKeys({ dir });
  const a = clone(await sign());
  a.text = 'forged';
  const foreign = ephemeralKeys();
  // the forger recomputes everything with his own key
  const { kanonisch, kanonischSha256 } = await import('../src/urteil/kanonisch.mjs');
  const { urteil, ...rest } = a;
  const body = { ...urteil, ergebnis_sha256: kanonischSha256(rest), schluessel_id: foreign.id, oeffentlicher_schluessel: foreign.oeffentlicherSchluessel };
  delete body.signatur;
  a.urteil = { ...body, signatur: crypto.sign(null, Buffer.from(kanonisch(body)), foreign.privateKey).toString('base64url') };
  assert.equal(verifyUrteil(a).ok, true, 'without a pinned key a self-consistent forgery is not detectable: that is why the id is pinned');
  refused(a, { erwarteteSchluesselId: mine.id }, /another key/);
  assert.equal(verifyUrteil(a, { erwarteterOeffentlicherSchluessel: mine.oeffentlicherSchluessel }).ok, false);
});

test('tampering: swapping in a foreign public key under the old id is refused', async () => {
  const a = clone(await sign());
  a.urteil.oeffentlicher_schluessel = ephemeralKeys().oeffentlicherSchluessel;
  refused(a, {}, /does not match the public key/);
});

test('tampering: a missing or malformed verdict, or another version or algorithm, is refused', async () => {
  const a = clone(await sign());
  const { urteil, ...ohne } = a;
  refused(ohne, {}, /urteil missing/);
  refused({ ...ohne, urteil: null }, {}, /urteil missing/);
  refused({ ...ohne, urteil: [] }, {}, /urteil missing/);
  refused('not json at all', {}, /not a JSON object/);
  refused(null, {}, /not a JSON object/);
  const v2 = clone(a); v2.urteil.v = 2;
  refused(v2, {}, /unknown verdict version/);
  const alg = clone(a); alg.urteil.alg = 'none';
  refused(alg, {}, /unknown algorithm/);
  const short = clone(a); short.urteil.oeffentlicher_schluessel = 'AAAA';
  refused(short, {}, /32 bytes/);
});

test('the standalone checker script runs as a program: exit codes and a pinned key id', async () => {
  const a = await sign();
  const f = path.join(dir, 'answer.json');
  fs.writeFileSync(f, JSON.stringify(a));
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30000 });
  let r = run(f);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
  r = run(f, '--key-id', a.urteil.schluessel_id);
  assert.equal(r.status, 0);
  r = run(f, '--key-id', '0'.repeat(32));
  assert.equal(r.status, 1);
  const t = clone(a); t.text = 'x';
  fs.writeFileSync(f, JSON.stringify(t));
  r = run(f);
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).grund, /changed/);
  r = run();
  assert.equal(r.status, 2);
  r = run(path.join(dir, 'missing.json'));
  assert.equal(r.status, 2);
});

test('the CLI pruefen checks a file and exits 1 when it does not hold', async () => {
  const a = await sign();
  const f = path.join(dir, 'answer2.json');
  fs.writeFileSync(f, JSON.stringify(a));
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'pyfio-router.mjs'), 'pruefen', ...args], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PYFIO_STATE_DIR: dir } });
  assert.equal(run(f).status, 0);
  assert.equal(run(f, '--schluessel-id', a.urteil.schluessel_id).status, 0);
  assert.equal(run(f, '--schluessel-id', '1'.repeat(32)).status, 1);
  const t = clone(a); t.ok = false;
  fs.writeFileSync(f, JSON.stringify(t));
  assert.equal(run(f).status, 1);
});

test('the tool version hash changes when the definition changes', () => {
  const d = definition('read_page');
  const h = werkzeugVersionVon(d);
  assert.equal(werkzeugVersionVon({ ...d }), h);
  assert.notEqual(werkzeugVersionVon({ ...d, description: `${d.description} (changed)` }), h);
  assert.notEqual(werkzeugVersionVon({ ...d, inputSchema: { ...d.inputSchema, required: [] } }), h);
  assert.equal(werkzeugVersionVon(null), null);
});
