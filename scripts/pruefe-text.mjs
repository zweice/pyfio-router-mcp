#!/usr/bin/env node
// Checks the demo's own text files: no control characters (a broken edit), no long dash U+2014
// (project rule). Exit 1 with the hits.   node scripts/pruefe-text.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'py', '.state-dev', 'html', 'out', '_shots', '_tmp', '_agb-tmp', '.git']);
const EXT = /\.(mjs|js|json|md|html|yaml|yml|py|txt|css)$/;
const DASH = String.fromCharCode(0x2014);
const hits = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (EXT.test(e.name) && fs.statSync(p).size < 5e6) {
      const s = fs.readFileSync(p, 'utf8');
      s.split('\n').forEach((l, i) => {
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(l)) hits.push(`${path.relative(ROOT, p)}:${i + 1}: control character`);
        if (l.includes(DASH)) hits.push(`${path.relative(ROOT, p)}:${i + 1}: long dash U+2014`);
      });
    }
  }
})(ROOT);
console.log(hits.length ? hits.join('\n') : 'ok: no control characters, no U+2014');
process.exit(hits.length ? 1 : 0);
