// End to end like a stranger's agent: the real MCP client of the SDK against the real server, over stdio and over
// Streamable HTTP (--http on a free port). The upstreams are fakes on 127.0.0.1; no real network. Every answer's
// verdict is checked with verifyUrteil and with the standalone script (node:crypto only), the key id pinned.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ROOT } from './helpers.mjs';
import { fakeUpstreams, SERPER_STRONG } from './fakes.mjs';
import { killTree } from '../src/proc.mjs';

const { verifyUrteil } = await import('../src/urteil/urteil.mjs');
const { loadKeys } = await import('../src/urteil/schluessel.mjs');
const BIN = path.join(ROOT, 'bin', 'pyfio-router.mjs');
const STANDALONE = path.join(ROOT, 'scripts', 'verify-standalone.mjs');
const stateDirs = [];
const pids = [];   // every server process this file starts
const mkState = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `pyfio-router-e2e-${tag}-`)); stateDirs.push(d); return d; };
const SERPER_KEY = ['sp', crypto.randomBytes(9).toString('hex')].join('_');   // put together at run time

let fake;
before(async () => { fake = await fakeUpstreams(); });
after(async () => { await fake.close(); });

// The environment of a server process: state folder, fakes in place of the public services, no real keys.
const serverEnv = (state, extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => typeof process.env[k] === 'string')),
  PYFIO_STATE_DIR: state, PYFIO_LANG: 'en', PYFIO_CACHE: 'off', PYFIO_TEST_ALLOW: `127.0.0.1:${fake.port}`,
  ...fake.env, JINA_API_KEY: '', SERPER_API_KEY: '', EXA_API_KEY: '', OPEN_METEO_API_KEY: '', PYFIO_ZAEHLER_URL: '', PYFIO_URL_STATE: '', ...extra,
});

const text = (res) => res.content.find((c) => c.type === 'text').text;
const parse = (res) => JSON.parse(text(res));

// Checks one tool result: parses it, verifies the verdict twice (library, standalone script) with the key id pinned.
function checkVerdict(res, args, keyId, tool) {
  const answer = parse(res);
  assert.ok(answer.urteil, `${tool}: no urteil`);
  assert.equal(answer.urteil.werkzeug, tool);
  const v = verifyUrteil(answer, { erwarteteSchluesselId: keyId, eingabe: args });
  assert.equal(v.ok, true, `${tool}: ${v.grund}`);
  const f = path.join(os.tmpdir(), `pyfio-router-e2e-${crypto.randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(f, text(res));
  try {
    const r = spawnSync(process.execPath, [STANDALONE, f, '--key-id', keyId], { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, `${tool}: standalone checker said ${r.stdout}${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).ok, true);
    // and it refuses a changed copy
    fs.writeFileSync(f, text(res).replace(/"ok":(true|false)/, (m, b) => `"ok":${b === 'true' ? 'false' : 'true'}`));
    assert.equal(spawnSync(process.execPath, [STANDALONE, f, '--key-id', keyId], { encoding: 'utf8', timeout: 30000 }).status, 1, `${tool}: a changed copy must fail`);
  } finally { fs.rmSync(f, { force: true }); }
  return answer;
}

// The same flow on both transports.
async function flow(client, keyIdOf, { keyed }) {
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name), ['read_page', 'weather', 'travel_time', 'web_search', 'build_or_use']);
  assert.ok(tools.tools.every((t) => t.inputSchema && t.description));
  const call = async (name, args) => client.callTool({ name, arguments: args });
  const verdicts = [];

  // 1. ask before building: three capabilities, a free fact, an unknown task
  const ask = async (task, extra = {}) => {
    const args = { task, budget_usd: 0.1, ...extra };
    const res = await call('build_or_use', args);
    const a = checkVerdict(res, args, keyIdOf(), 'build_or_use');
    verdicts.push(a.urteil);
    return a;
  };
  let a = await ask('Read the page https://example.org/docs and give me the main text');
  assert.deepEqual([a.empfehlung, a.kategorie, a.aufruf.werkzeug], ['nutzen', 'seite_lesen', 'read_page']);
  a = await ask('How long does it take to drive from Alpha to Beta?');
  assert.deepEqual([a.empfehlung, a.kategorie, a.aufruf.werkzeug], ['nutzen', 'fahrzeit', 'travel_time']);
  a = await ask('Search the web for the latest news on lighthouses');
  assert.deepEqual([a.empfehlung, a.kategorie, a.aufruf.werkzeug], ['nutzen', 'websuche', 'web_search']);
  a = await ask('How many working days are there between 1 March and 31 May 2027?');
  assert.deepEqual([a.empfehlung, a.kategorie, a.aufruf], ['gratis', 'datum', null]);
  a = await ask('Write a poem about autumn');
  assert.deepEqual([a.empfehlung, a.kategorie], ['bauen', 'unbekannt']);
  assert.equal(a.begruendung[0].code, 'keine_messung');
  a = await ask('How long does it take to drive from Alpha to Beta?', { privacy: 'local' });
  assert.deepEqual([a.empfehlung, a.nutzung.abgelehnt_grund], ['bauen', ['datenschutz_nicht_erfuellt']]);
  // the schema it returns is the one the server lists
  assert.deepEqual((await ask('Read the page https://example.org/docs')).aufruf.argument_schema, tools.tools.find((t) => t.name === 'read_page').inputSchema);

  // 2. the three capabilities, as the advice said
  let args = { url: `${fake.url}/page`, max_chars: 1000 };
  let res = await call('read_page', args);
  assert.ok(!res.isError, text(res).slice(0, 300));
  a = checkVerdict(res, args, keyIdOf(), 'read_page');
  assert.equal(a.ok, true);
  assert.match(a.text, /wort1x0/);
  assert.ok(a.text.length <= 1000);
  assert.equal(a.urteil.ergebnis, 'bestanden', JSON.stringify(a.urteil.pruefungen));
  verdicts.push(a.urteil);

  args = { from: 'Alpha station', to: 'Beta station', depart_at: '2026-11-03 09:00' };
  res = await call('travel_time', args);
  assert.ok(!res.isError, text(res).slice(0, 300));
  a = checkVerdict(res, args, keyIdOf(), 'travel_time');
  assert.deepEqual([a.minutes_typical, a.minutes_cautious, a.distance_km, a.from.confidence, a.to.confidence], [67, 78, 100, 'high', 'high']);
  assert.match(a.route_link, /^https:\/\/www\.openstreetmap\.org\//);
  assert.equal(a.urteil.ergebnis, 'bestanden', JSON.stringify(a.urteil.pruefungen));
  verdicts.push(a.urteil);

  args = { query: `${SERPER_STRONG} lighthouses`, max_results: 3 };
  res = await call('web_search', args);
  assert.ok(!res.isError, text(res).slice(0, 300));
  a = checkVerdict(res, args, keyIdOf(), 'web_search');
  assert.equal(a.provider, keyed ? 'serper' : 'wikipedia+mwmbl');
  assert.ok(a.results.length >= 1 && a.results.length <= 3);
  assert.equal(a.urteil.ergebnis, 'bestanden', JSON.stringify(a.urteil.pruefungen));
  assert.doesNotMatch(text(res), new RegExp(SERPER_KEY), 'the operator\'s key is not in the answer');
  verdicts.push(a.urteil);

  // 3. errors are signed too: a private address, a wrong argument, an unknown address
  args = { url: 'http://192.168.178.1/' };
  res = await call('read_page', args);
  assert.equal(res.isError, true);
  a = checkVerdict(res, args, keyIdOf(), 'read_page');
  assert.equal(a.urteil.ergebnis, 'fehler');
  verdicts.push(a.urteil);
  args = { from: 'Alpha station', to: 'Nowhereville 9' };
  res = await call('travel_time', args);
  assert.equal(res.isError, true);
  a = checkVerdict(res, args, keyIdOf(), 'travel_time');
  assert.equal(a.kind, 'not_found');
  args = { query: 'x', surprise: true };
  res = await call('web_search', args);
  a = checkVerdict(res, args, keyIdOf(), 'web_search');
  assert.equal(a.urteil.pruefungen.find((p) => p.name === 'eingabe_schema').ok, false, 'an argument the schema does not know is noted in the verdict');

  // the tool versions are pinned: the same tool, the same hash, in every verdict
  const byTool = new Map();
  for (const u of verdicts) { byTool.set(u.werkzeug, byTool.get(u.werkzeug) || u.werkzeug_version); assert.equal(byTool.get(u.werkzeug), u.werkzeug_version); assert.match(u.werkzeug_version, /^[0-9a-f]{16}$/); }
  assert.equal(new Set(verdicts.map((u) => u.schluessel_id)).size, 1, 'one key signs everything');
}

test('stdio: the MCP client of the SDK against the real server, keyed search', { timeout: 120000 }, async () => {
  const state = mkState('stdio');
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], env: serverEnv(state, { SERPER_API_KEY: SERPER_KEY }), stderr: 'pipe' });
  const client = new Client({ name: 'e2e-agent', version: '1.0.0' });
  await client.connect(transport);
  pids.push(transport.pid);
  try {
    assert.equal(client.getServerVersion().name, 'pyfio-router');
    assert.match(client.getInstructions(), /signed verdict/);
    let keyId = null;
    // The key is made at the first call; read its id from the file the server made, never from an answer it can forge.
    const idOf = () => (keyId ||= loadKeys({ dir: state }).id);
    // make the key exist before the first pin
    const first = await client.callTool({ name: 'build_or_use', arguments: { task: 'Write a poem', budget_usd: 1 } });
    assert.ok(first.content);
    await flow(client, idOf, { keyed: true });
  } finally { await client.close(); }
  // the counters: tool, outcome, client name; no URL, no address, no query
  const day = new Date().toISOString().slice(0, 10);
  const dayDir = path.join(state, 'zaehler', day);
  const raw = fs.readdirSync(dayDir).map((f) => fs.readFileSync(path.join(dayDir, f), 'utf8')).join('\n');
  for (const re of [/read_page\|ok\|[a-z-]+\|e2e-agent\|/, /travel_time\|ok\|[a-z+-]+\|e2e-agent\|/, /web_search\|ok\|serper\|e2e-agent\|/, /build_or_use\|ok\|router\|e2e-agent\|/]) assert.match(raw, re);
  assert.doesNotMatch(raw, /127\.0\.0\.1|192\.168|Alpha|Nowhere|lighthouse|example\.org|poem|working days/i);
  assert.match(raw, /"noOffer":3/, 'the poem (twice) and the working days: asked, but no offer');
  assert.ok(!fs.readdirSync(state).some((f) => /cache/.test(f)), 'caching was off');
});

test('stdio, German names: the same tools under German names', { timeout: 60000 }, async () => {
  const state = mkState('stdio-de');
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], env: serverEnv(state, { PYFIO_LANG: 'de' }), stderr: 'pipe' });
  const client = new Client({ name: 'e2e-agent-de', version: '1.0.0' });
  await client.connect(transport);
  pids.push(transport.pid);
  try {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ['seite_lesen', 'wetter', 'fahrzeit', 'websuche', 'bauen_oder_nutzen']);
    const args = { aufgabe: 'Wie lange fahre ich mit dem Auto von Alpha nach Beta?', budget_usd: 0.1 };
    const res = await client.callTool({ name: 'bauen_oder_nutzen', arguments: args });
    const a = parse(res);
    assert.deepEqual([a.empfehlung, a.aufruf.werkzeug], ['nutzen', 'fahrzeit']);
    assert.match(a.begruendung[0].text, /Gratis-Kontingent/);
    const id = loadKeys({ dir: state }).id;
    assert.equal(verifyUrteil(a, { erwarteteSchluesselId: id, eingabe: args }).ok, true);
    assert.equal(a.urteil.werkzeug, 'build_or_use', 'the verdict names the canonical tool');
    const f = parse(await client.callTool({ name: 'fahrzeit', arguments: { von: 'Alpha station', nach: 'Beta station', ab: '2026-11-03 09:00' } }));
    assert.equal(f.ok, true, f.error);
    assert.equal(f.minutes_typical, 67);
    assert.equal(verifyUrteil(f, { erwarteteSchluesselId: id }).ok, true);
  } finally { await client.close(); }
});

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });

test('Streamable HTTP: --http on a free port, the same flow, keyless search falls back; the public key is published', { timeout: 120000 }, async () => {
  const state = mkState('http');
  const port = await freePort();
  const child = spawn(process.execPath, [BIN, '--http', '--port', String(port)], { env: serverEnv(state), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  pids.push(child.pid);
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`server did not start: ${err}`)), 20000);
      const poll = setInterval(() => { if (err.includes(`:${port}/mcp`)) { clearInterval(poll); clearTimeout(t); resolve(); } }, 50);
      child.on('exit', (c) => { clearInterval(poll); clearTimeout(t); reject(new Error(`server exited ${c}: ${err}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    // the public key, from the well-known address
    const wk = await (await fetch(`${base}/.well-known/pyfio-urteil.json`)).json();
    assert.equal(wk.alg, 'Ed25519');
    assert.match(wk.schluessel_id, /^[0-9a-f]{32}$/);
    assert.equal(Buffer.from(wk.oeffentlicher_schluessel, 'base64url').length, 32);
    assert.doesNotMatch(JSON.stringify(wk), /privat/i);
    const client = new Client({ name: 'e2e-agent-http', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      await flow(client, () => wk.schluessel_id, { keyed: false });
      // the published key is the one that signs: the file in the state folder says the same
      assert.equal(loadKeys({ dir: state }).id, wk.schluessel_id);
    } finally { await client.close(); }
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ok, true);
  } finally { await killTree(child); }
});

test('no server process of this file is left running', async () => {
  // the stdio servers end with their client; give them a moment, then look
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  for (let i = 0; i < 40 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(pids.length, 3);
  assert.deepEqual(pids.filter(alive), []);
  for (const d of stateDirs) fs.rmSync(d, { recursive: true, force: true });
});
