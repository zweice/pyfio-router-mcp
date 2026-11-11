// web_search: the keyed cascade, the keyless fallback, the daily limits, the error with a hint. Fake upstream only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { tmpState } from './helpers.mjs';
import { fakeUpstreams, SERPER_STRONG } from './fakes.mjs';

const dir = tmpState('suche');
const { webSearch, weakness, contentWords, isGerman, kindOf, chainFor, SOURCES } = await import('../src/suche/suche.mjs');
const { changeSetting } = await import('../src/config.mjs');
const { makeHttp, HttpError } = await import('../src/http-client.mjs');

let fake;
before(async () => { fake = await fakeUpstreams(); Object.assign(process.env, fake.env, { PYFIO_CACHE: 'off' }); });
after(async () => { await fake.close(); for (const k of [...Object.keys(fake.env), 'PYFIO_CACHE']) delete process.env[k]; });
// Key-shaped values are put together at run time, never written as literals.
const secret = (tag) => [tag, crypto.randomBytes(9).toString('hex')].join('_');
const KEY = { serper: secret('sp'), exa: secret('ex') };
const NOW = Date.parse('2026-11-03T10:00:00Z');
const run = (query, args = {}, deps = {}) => webSearch({ query, ...args }, { now: () => NOW, dir, keys: { serper: null, exa: null }, ...deps });

test('a strong Serper answer ends the cascade: one call, the answer box, cost, the key never in the output', async () => {
  fake.hits.length = 0;
  const r = await run(`${SERPER_STRONG} question`, {}, { keys: KEY });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.provider, 'serper');
  assert.equal(r.results.length, 3);
  assert.ok(r.results.every((x) => x.source === 'serper' && x.url.startsWith('https://')));
  assert.match(r.answer.text, /answer about/);
  assert.equal(r.cost_usd, 0.001);
  assert.equal(fake.hits.filter((h) => h.method === 'POST').length, 1);
  assert.equal(fake.hits.at(-1).serperKey, KEY.serper, 'the operator\'s key goes to the provider');
  assert.doesNotMatch(JSON.stringify(r), new RegExp(`${KEY.serper}|${KEY.exa}`), 'and nowhere else');
  assert.match(r.next, /deeper: true/, 'Exa is available for a second look');
  assert.match(r.note, /third-party content/);
});

test('weak Serper snippets: the cascade goes on to Exa; deeper skips Serper', async () => {
  let r = await run('obscure question without good snippets', {}, { keys: KEY });
  assert.equal(r.provider, 'exa');
  assert.deepEqual(r.used.map((u) => u.name), ['serper', 'exa']);
  assert.equal(r.used[0].continue, true);
  assert.equal(r.cost_usd, 0.008);
  fake.hits.length = 0;
  r = await run(`${SERPER_STRONG} question`, { deeper: true }, { keys: KEY });
  assert.equal(r.provider, 'exa');
  assert.deepEqual(r.used.map((u) => u.name), ['exa']);
  assert.equal(r.next, undefined);
  assert.ok(fake.hits.every((h) => h.body.includes('"query"')), 'only Exa was asked');
});

test('only an Exa key: Exa answers', async () => {
  const r = await run('some question', {}, { keys: { serper: null, exa: KEY.exa } });
  assert.equal(r.provider, 'exa');
  assert.deepEqual(r.keyed, ['exa']);
});

test('no key: the keyless fallback answers (Wikipedia and Mwmbl), every source is a known one', async () => {
  fake.hits.length = 0;
  const r = await run('history of the lighthouse');
  assert.equal(r.ok, true, r.error);
  assert.match(r.provider, /^wikipedia\+mwmbl$|^wikipedia$/);
  assert.deepEqual(r.keyed, []);
  assert.ok(r.results.length >= 3);
  assert.ok(r.results.every((x) => SOURCES.includes(x.source)));
  assert.match(r.judge.summary, /keyless fallback/);
  assert.equal(r.cost_usd, 0);
  assert.ok(!fake.hits.some((h) => h.method === 'POST'), 'no keyed provider was asked');
});

test('a technical question goes to Stack Exchange, MDN and Mwmbl first', async () => {
  assert.equal(kindOf('python error: timeout in fetch'), 'tech');
  assert.equal(kindOf('history of the lighthouse'), 'general');
  assert.deepEqual(chainFor('tech'), [['stackexchange', 'mdn', 'mwmbl'], ['wikipedia', 'hn']]);
  const r = await run('javascript fetch timeout error');
  assert.equal(r.ok, true);
  assert.ok(r.results.some((x) => x.source === 'stackexchange'));
});

test('no key and the fallback down: a clear error with the hint what to set', async () => {
  fake.mode.down = true;
  try {
    const r = await run('anything at all');
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'unavailable');
    assert.match(r.error, /SERPER_API_KEY/);
    assert.match(r.error, /EXA_API_KEY/);
    assert.match(r.error, /no search provider answered/);
    assert.ok(r.failed.length >= 2);
  } finally { fake.mode.down = false; }
});

test('the fallback can be switched off (suche.fallback): then no key means an error with the hint', async () => {
  changeSetting('suche.fallback', 0);
  try {
    const r = await run('anything at all');
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'empty');
    assert.match(r.error, /no search key is set/);
  } finally { changeSetting('suche.fallback', null); }
});

test('a refused key falls back to the open sources and says so; the key is not in the error', async () => {
  const base = makeHttp({ now: () => NOW });
  const http = async (url, o) => { if (o?.method === 'POST') throw new HttpError('serper.example: HTTP 401', { status: 401, kind: 'blocked', body: `bad key ${KEY.serper}` }); return base(url, o); };
  const r = await run('history of the lighthouse', {}, { keys: { serper: KEY.serper, exa: null }, http });
  assert.equal(r.ok, true);
  assert.match(r.provider, /wikipedia/);
  assert.equal(r.failed[0].name, 'serper');
  assert.match(r.failed[0].error, /key refused/);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(KEY.serper));
});

test('the operator\'s daily limit protects the key: after it the next provider answers, the next day Serper again', async () => {
  const qdir = tmpState('suche-quota');
  changeSetting('suche.serperProTag', 1);
  try {
    let clock = Date.parse('2026-11-03T10:00:00Z');
    const deps = { keys: KEY, dir: qdir, now: () => clock };
    const q = `${SERPER_STRONG} limit`;
    assert.equal((await webSearch({ query: q }, deps)).provider, 'serper');
    const second = await webSearch({ query: q }, deps);
    assert.equal(second.provider, 'exa', 'Serper\'s limit of the day is used up');
    assert.deepEqual(second.failed.map((f) => [f.name, f.kind]), [['serper', 'quota']]);
    clock += 86400e3;
    assert.equal((await webSearch({ query: q }, deps)).provider, 'serper', 'a new UTC day');
  } finally { changeSetting('suche.serperProTag', null); tmpState('suche'); }
});

test('the fallback is cached for a few hours (no new requests, cached: true)', async () => {
  process.env.PYFIO_CACHE = 'on';
  try {
    const cdir = tmpState('suche-cache');
    const q = `cache probe ${crypto.randomBytes(3).toString('hex')}`;
    const a = await webSearch({ query: q }, { now: () => NOW, dir: cdir, keys: { serper: null, exa: null } });
    const n = fake.hits.length;
    const b = await webSearch({ query: q }, { now: () => NOW, dir: cdir, keys: { serper: null, exa: null } });
    assert.equal(fake.hits.length, n);
    assert.equal(b.cached, true);
    assert.deepEqual(b.results, a.results);
  } finally { process.env.PYFIO_CACHE = 'off'; tmpState('suche'); }
});

test('input is checked', async () => {
  assert.deepEqual([(await run('')).ok, (await run('')).kind], [false, 'input']);
  assert.equal((await run('x'.repeat(501))).kind, 'input');
  const r = await run('history of the lighthouse', { max_results: 2 });
  assert.ok(r.results.length <= 2);
});

test('the weakness score: matching snippets score high, unrelated ones low; German is recognized', () => {
  const q = 'when was the lighthouse built';
  const good = weakness(q, { organic: [{ title: 'The lighthouse', snippet: 'The lighthouse was built in 1850' }] });
  const bad = weakness(q, { organic: [{ title: 'Cooking', snippet: 'pasta recipes' }] });
  assert.ok(good.score > 0.35 && bad.score < 0.35, `${good.score} ${bad.score}`);
  assert.equal(weakness(q, {}).score, 0);
  assert.deepEqual(contentWords('The lighthouse was built in 1850'), ['lighthouse', 'built', '1850']);
  assert.ok(isGerman('Wann wurde der Leuchtturm gebaut?'));
  assert.ok(!isGerman('When was the lighthouse built?'));
});
