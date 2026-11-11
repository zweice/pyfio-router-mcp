// Hosted-mode etiquette: robots.txt (RFC 9309), TDM reservation, honest User-Agent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpState, localServer, html, article } from './helpers.mjs';

tmpState('robots');
const R = await import('../src/lesen/robots.mjs');
const { readPage, _resetMemory } = await import('../src/lesen/seite-lesen.mjs');
const S = await import('../src/lesen/stufen.mjs');

test('robots.txt rules: own group before *, longest match, allow wins a tie, * and $', () => {
  const g = R.parseRobots(`User-agent: *\nDisallow: /privat\nAllow: /privat/offen\n\nUser-agent: PyfioRouter\nUser-agent: other\nDisallow: /nur-wir\nDisallow: /*.pdf$\n`);
  assert.equal(R.robotsAllows(g, '/nur-wir/x'), false);
  assert.equal(R.robotsAllows(g, '/privat'), true, 'our own group replaces *');
  assert.equal(R.robotsAllows(g, '/datei.pdf'), false);
  assert.equal(R.robotsAllows(g, '/datei.pdf?x=1'), true);
  const star = R.parseRobots('User-agent: *\nDisallow: /privat\nAllow: /privat/offen\nDisallow:\n');
  assert.equal(R.robotsAllows(star, '/privat/x'), false);
  assert.equal(R.robotsAllows(star, '/privat/offen/a'), true);
  assert.equal(R.robotsAllows(star, '/oeffentlich'), true);
  assert.equal(R.robotsAllows(R.parseRobots('User-agent: *\nDisallow: /a.b+c(d)\n'), '/a.b+c(d)/e'), false, 'regex characters are literal');
  assert.match(R.HONEST_UA, /PyfioRouter\/[\d.]+; \+https:\/\/pyfio\.com/);
});

test('TDM reservation by header or meta tag', () => {
  assert.equal(R.tdmReserved({ 'tdm-reservation': '1' }, ''), true);
  assert.equal(R.tdmReserved({}, '<meta name="tdm-reservation" content="1">'), true);
  assert.equal(R.tdmReserved({}, '<meta content="1" name="tdm-reservation">'), true);
  assert.equal(R.tdmReserved({}, '<meta name="tdm-reservation" content="0">'), false);
});

let srv, seenUA = [];
before(async () => {
  const page = (extra = '') => (q, r) => { seenUA.push(q.headers['user-agent']); r.writeHead(200, { 'content-type': 'text/html' }); r.end(html(extra + article(400))); };
  srv = await localServer({
    '/robots.txt': (q, r) => { r.writeHead(200, { 'content-type': 'text/plain' }); r.end('User-agent: *\nDisallow: /gesperrt\n'); },
    '/frei': page(),
    '/gesperrt': page(),
    '/tdm': page('<meta name="tdm-reservation" content="1">'),
  });
  process.env.PYFIO_TEST_ALLOW = `127.0.0.1:${srv.port}`;
});
after(async () => { await srv.close(); });

const stages = { ...S, findPython: async () => null, browserAvailable: async () => false, jinaEnabled: () => false };

test('hosted mode: robots.txt and TDM are followed, the User-Agent is honest', async () => {
  _resetMemory(); R._clearRobots(); seenUA = [];
  let r = await readPage(srv.url('/frei'), { mode: 'http', stages });
  assert.equal(r.ok, true, r.error);
  assert.match(seenUA.at(-1), /PyfioRouter/);
  r = await readPage(srv.url('/gesperrt'), { mode: 'http', stages });
  assert.equal(r.kind, 'robots');
  r = await readPage(srv.url('/tdm'), { mode: 'http', stages });
  assert.equal(r.kind, 'tdm_reserved');
});

test('local mode: the operator\'s own fetch, as a browser', async () => {
  _resetMemory(); seenUA = [];
  const r = await readPage(srv.url('/gesperrt'), { mode: 'stdio', stages });
  assert.equal(r.ok, true);
  assert.match(seenUA.at(-1), /Chrome\//);
});

test('robots.txt unreachable (5xx) means nothing is allowed; 404 means no rules', async () => {
  R._clearRobots();
  const five = await R.robotsCheck(new URL('https://example.org/a'), { fetcher: async () => { throw Object.assign(new Error('x'), { status: 503 }); } });
  assert.equal(five.allowed, false);
  R._clearRobots();
  const four = await R.robotsCheck(new URL('https://example.org/a'), { fetcher: async () => { throw Object.assign(new Error('x'), { status: 404 }); } });
  assert.equal(four.allowed, true);
});
