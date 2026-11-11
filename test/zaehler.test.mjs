import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpState } from './helpers.mjs';

const dir = tmpState('zaehler');
const Z = await import('../src/zaehler.mjs');
const I = await import('../src/interesse.mjs');

const allText = (d) => fs.readdirSync(d, { recursive: true }).map((f) => path.join(d, f)).filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f, 'utf8')).join('\n');

test('a count holds tool, outcome, provider, client, bucket and a pseudonym: no URL, no place, no IP', () => {
  const c = Z.createCounter({ mode: 'http', dir });
  const op = Z.requestPseudonym({ ip: '203.0.113.77' }, dir);
  assert.match(op, /^[0-9a-f]{16}$/);
  c.record({ tool: 'read_page', ok: true, provider: 'trafilatura', ms: 1200, client: 'Claude Code', operator: op });
  c.record({ tool: 'weather', ok: false, kind: 'timeout', provider: 'open-meteo', ms: 31000, client: 'cursor', operator: op });
  c.record({ tool: 'evil', ok: true, provider: 'x', operator: op });
  c.flush();
  const txt = allText(path.join(dir, 'zaehler'));
  assert.match(txt, /read_page\|ok\|trafilatura\|claude-code\|1-3s/);
  assert.match(txt, /weather\|err:timeout\|open-meteo\|cursor\|gt10s/);
  assert.doesNotMatch(txt, /203\.0\.113|evil|dresden|https?:\/\//i);
});

test('IPv6 privacy addresses of one /64 are one operator; different IPs differ', () => {
  assert.equal(Z.normIp('2001:db8:1:2:aaaa::1'), Z.normIp('2001:db8:1:2:bbbb:cccc:dddd:eeee'));
  assert.equal(Z.normIp('::ffff:198.51.100.4'), '198.51.100.4');
  assert.notEqual(Z.requestPseudonym({ ip: '198.51.100.4' }, dir), Z.requestPseudonym({ ip: '198.51.100.5' }, dir));
  assert.equal(Z.requestPseudonym({ ip: '198.51.100.4' }, dir), Z.requestPseudonym({ ip: '198.51.100.4' }, dir));
  assert.match(Z.requestPseudonym({ keyId: 'kunde-1' }, dir), /^k[0-9a-f]{15}$/);
});

test('a local install reports its days; the router keeps the latest per operator and day', () => {
  const c = Z.createCounter({ mode: 'stdio', dir });
  c.record({ tool: 'read_page', ok: true, provider: 'browser-readability', ms: 4000, client: 'claude-code', operator: 'x' });
  c.flush();
  const rep = Z.buildReport(dir, Z.installPseudonym(dir));
  assert.match(rep.operator, /^[0-9a-f]{16}$/);
  const day = Object.keys(rep.days)[0];
  assert.ok(rep.days[day]['read_page|ok|browser-readability|claude-code|3-10s'] >= 1);
  assert.deepEqual(Z.acceptReport(rep, dir), { ok: true, days: 1 });
  assert.deepEqual(Z.acceptReport(rep, dir), { ok: true, days: 1 });
  const ext = Z.reportsOf(dir, day);
  assert.equal(Object.keys(ext).length, 1);
  assert.equal(fs.readdirSync(path.join(dir, 'extern', day)).length, 1, 'one small file per operator');
  assert.throws(() => Z.acceptReport({ v: 1, operator: 'nothex', days: {} }, dir), (e) => e.kind === 'input');
  assert.throws(() => Z.acceptReport({ v: 1, operator: 'a'.repeat(16), days: { [day]: { 'read_page|ok|x|y|lt1s; rm -rf': 1 } } }, dir), (e) => e.kind === 'input');
  assert.throws(() => Z.acceptReport({ v: 1, operator: 'a'.repeat(16), days: { [day]: { 'read_page|ok|x|y|lt1s': -5 } } }, dir), (e) => e.kind === 'input');
});

test('no telemetry without an endpoint or with DO_NOT_TRACK', async () => {
  let sent = 0;
  const c = Z.createCounter({ mode: 'stdio', dir, send: async () => { sent++; return true; } });
  delete process.env.PYFIO_ZAEHLER_URL;
  assert.equal((await c.maybePing({ force: true })).sent, false);
  process.env.PYFIO_ZAEHLER_URL = 'http://127.0.0.1:9/v1/zaehler';
  process.env.DO_NOT_TRACK = '1';
  assert.equal((await c.maybePing({ force: true })).why, 'telemetry off');
  delete process.env.DO_NOT_TRACK;
  const r = await c.maybePing({ force: true });
  assert.equal(r.sent, true);
  assert.equal(sent, 1);
  assert.equal((await c.maybePing()).why, 'not due');
  delete process.env.PYFIO_ZAEHLER_URL;
});

test('fake door: clicks counted; an email only with consent, once; domain type', () => {
  assert.deepEqual(I.acceptInterest({ event: 'klick', tarif: 'router', sprache: 'de' }, dir), { ok: true, stored: 'count' });
  assert.equal(I.acceptInterest({ event: 'email', tarif: 'router', sprache: 'en', email: 'a@firma.example', einwilligung: false }, dir).stored, 'nothing (no consent)');
  assert.equal(I.acceptInterest({ event: 'email', tarif: 'router', sprache: 'en', email: 'Max@Firma.example', einwilligung: true }, dir).stored, 'email');
  assert.equal(I.acceptInterest({ event: 'email', tarif: 'router', sprache: 'en', email: 'max@firma.example', einwilligung: true }, dir).stored, 'email', 'no hint that it was known');
  I.acceptInterest({ event: 'email', tarif: 'router', sprache: 'de', email: 'jemand@gmx.de', einwilligung: true }, dir);
  const lines = fs.readFileSync(path.join(dir, 'interesse', 'emails.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines.find((l) => l.domain === 'firma.example').firma, true);
  assert.equal(lines.find((l) => l.domain === 'gmx.de').firma, false);
  assert.ok(!lines.some((l) => 'ip' in l || 'ua' in l));
  assert.throws(() => I.acceptInterest({ event: 'email', tarif: 'router', email: 'kein at', einwilligung: true }, dir));
  assert.throws(() => I.acceptInterest({ event: 'hack', tarif: 'router' }, dir));
});
