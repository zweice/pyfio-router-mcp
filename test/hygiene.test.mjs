// The package goes to strangers: nothing personal, nothing from outside the package, no secrets, no em dashes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './helpers.mjs';

const SKIP_DIRS = new Set(['node_modules', '.state-dev', 'py']);
function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, out); else out.push(p);
  }
  return out;
}
const all = files(ROOT);
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');
const textFiles = all.filter((f) => /\.(mjs|js|json|md|html|txt|py)$|LICENSE|NOTICE|\.gitignore$/.test(f));

test('no personal data, no paths of the maintainer\'s machine, no foreign accounts in any file of the package', () => {
  // The patterns are assembled so that this file does not match itself.
  const bad = [['Haferw', 'eg'], ['D:[\\\\/]+Cl', 'aude'], ['zwe', 'ice'], ['Tis', 'sen'], ['abla', 'ge[\\\\/]'], ['secre', 'ts[\\\\/]'], ['claudette', '\\.br'], ['Sol', 'tau'], ['Vatten', 'fall']].map(([a, b]) => new RegExp(a + b, 'i'));
  const hits = [];
  for (const f of textFiles) {
    if (rel(f) === 'test/hygiene.test.mjs') continue;
    const t = fs.readFileSync(f, 'utf8').split('github.com/' + 'zw' + 'eice/pyfio-router-mcp').join('').split('github:' + 'zw' + 'eice/pyfio-router-mcp').join('');
    for (const re of bad) if (re.test(t)) hits.push(`${rel(f)}: ${re}`);
  }
  assert.deepEqual(hits, []);
});

test('the code reads no file outside the package and no secrets file', () => {
  const hits = [];
  for (const f of all.filter((x) => /\.mjs$/.test(x) && !rel(x).startsWith('test/'))) {
    const t = fs.readFileSync(f, 'utf8');
    for (const m of t.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (spec.startsWith('.')) { const target = path.resolve(path.dirname(f), spec); if (!target.startsWith(ROOT)) hits.push(`${rel(f)} imports ${spec}`); }
    }
    if (/keys\.env|secrets?[\\/]|['"`]\.env|KEYS_FILE/.test(t.replace(/PYFIO_URTEIL_KEY_FILE/g, ''))) hits.push(`${rel(f)} mentions a secrets file`);
  }
  assert.deepEqual(hits, []);
});

test('no key-shaped literal in the package or its tests', () => {
  const rx = [/\bsk-[A-Za-z0-9]{20,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /(?:secret|token|api_?key|password)\w*['"]?\s*[:=]\s*['"][0-9A-Za-z_-]{24,}['"]/i];
  const hits = [];
  for (const f of textFiles) {
    if (/package-lock|\.json$/.test(f) && !/data[\\/]/.test(f)) continue;
    const t = fs.readFileSync(f, 'utf8');
    for (const re of rx) if (re.test(t)) hits.push(`${rel(f)}: ${re}`);
  }
  assert.deepEqual(hits, []);
});

test('state, caches and runtime files are not part of the package; the key file would be ignored by git', () => {
  assert.ok(!all.some((f) => /urteil-schluessel|install-id|einstellungen\.json|domain-salz|zaehler-salz|api-keys/.test(rel(f))));
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  for (const need of ['node_modules/', '.state-dev/']) assert.match(ignore, new RegExp(need.replace('.', '\\.')));
});

test('texts have no em dash (scripts/pruefe-text.mjs)', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'pruefe-text.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('every file the package.json "files" list names exists', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true, 'stays private until it is published on purpose');
  for (const f of pkg.files) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});
