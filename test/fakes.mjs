// One fake upstream for all the generic services (geocoders, routers, search providers, a page). Tests point the
// router at it with PYFIO_URL_<NAME>=http://127.0.0.1:<port>. No real network is touched.
import http from 'node:http';

export const PLACES = {
  alpha: { lat: 53.553, lon: 10.006, name: 'Alpha Hauptbahnhof', road: 'Alphaplatz', city: 'Alphastadt', postcode: '20099' },
  beta: { lat: 52.525, lon: 13.369, name: 'Beta Hauptbahnhof', road: 'Betaplatz', city: 'Betastadt', postcode: '10557' },
};
const place = (q) => Object.entries(PLACES).find(([k]) => String(q).toLowerCase().includes(k))?.[1] || null;

export const SERPER_STRONG = 'strongtopic';   // a query containing this gets good Serper results
const strongSerper = (q) => ({ organic: [1, 2, 3].map((i) => ({ title: `${q} result ${i}`, link: `https://example.org/s${i}`, snippet: `${q} explained in detail ${i}`, date: '2026-10-01' })), answerBox: { answer: `answer about ${q}`, title: 'Box', link: 'https://example.org/box' } });
const weakSerper = () => ({ organic: [{ title: 'Unrelated', link: 'https://example.org/u', snippet: 'nothing here' }] });

// -> { port, url, hits, mode, close }.  mode: { down: every route answers 500, downPrefixes: paths that answer 500 }
export async function fakeUpstreams() {
  const hits = [];
  const mode = { down: false, downPrefixes: [] };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ method: req.method, path: u.pathname, search: u.search, ua: req.headers['user-agent'], serperKey: req.headers['x-api-key'], exaKey: req.headers['x-api-key'], body });
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (mode.down || mode.downPrefixes.some((p) => u.pathname.startsWith(p))) return send(500, { error: 'down' });
      const q = u.searchParams.get('q') || u.searchParams.get('srsearch') || u.searchParams.get('query') || u.searchParams.get('s') || '';
      if (u.pathname === '/search' && req.method === 'GET' && u.searchParams.get('format') === 'jsonv2') {   // Nominatim
        const p = place(q);
        if (!p) return send(200, []);
        return send(200, [{ lat: String(p.lat), lon: String(p.lon), name: p.name, addresstype: 'building', importance: 0.7, address: { road: p.road, city: p.city, postcode: p.postcode, country: 'Germany', country_code: 'de' }, display_name: `${p.name}, ${p.city}` }]);
      }
      if (u.pathname === '/api/') {   // Photon
        const p = place(q);
        if (!p) return send(200, { features: [] });
        return send(200, { features: [{ geometry: { coordinates: [p.lon + 0.0004, p.lat + 0.0003] }, properties: { name: p.name, street: p.road, postcode: p.postcode, city: p.city, country: 'Germany', countrycode: 'DE', type: 'house', osm_key: 'building' } }] });
      }
      if (u.pathname === '/v1/search') return send(200, { results: [] });   // Open-Meteo geocoder
      if (u.pathname.startsWith('/route/v1/driving/')) return send(200, { code: 'Ok', routes: [{ duration: 3600, distance: 100000, legs: [{ steps: [{ distance: 90000, ref: 'A 7' }, { distance: 10000, ref: '' }] }] }] });
      if (u.pathname === '/route') return send(200, { trip: { status: 0, summary: { time: 3900, length: 100.5 }, legs: [{ maneuvers: [{ length: 90, street_names: ['A 7'] }] }] } });
      if (u.pathname === '/search' && req.method === 'POST') {   // Serper (body.q) or Exa (body.query)
        let b = {}; try { b = JSON.parse(body); } catch {}
        if (req.headers['x-api-key'] && b.query !== undefined) return send(200, { results: [1, 2].map((i) => ({ title: `${b.query} exa ${i}`, url: `https://example.net/e${i}`, highlights: [`${b.query} highlight ${i}`], text: 'page text', publishedDate: '2026-10-02T00:00:00Z' })), costDollars: { total: 0.007 } });
        return send(200, String(b.q).includes(SERPER_STRONG) ? strongSerper(b.q) : weakSerper());
      }
      if (u.pathname === '/w/api.php') return send(200, { query: { search: [1, 2, 3].map((i) => ({ title: `${q} ${i}`, snippet: `<span>${q}</span> snippet ${i}`, timestamp: '2026-10-01T00:00:00Z' })) } });
      if (u.pathname === '/api/v1/search/') return send(200, [{ title: [{ value: `${q} mwmbl` }], url: 'https://example.com/mw1', extract: [{ value: 'extract' }] }]);
      if (u.pathname === '/2.3/search/advanced') return send(200, { items: [{ title: `${q} so`, link: 'https://stackoverflow.example/q/1', is_answered: true, score: 3, tags: ['a'] }] });
      if (u.pathname === '/api/v1/search') return send(200, { documents: [{ title: `${q} mdn`, mdn_url: '/en-US/docs/x', summary: 'sum' }], hits: [{ title: `${q} hn`, url: 'https://hn.example/1', points: 5, num_comments: 2, objectID: '1', created_at: '2026-10-01T00:00:00Z' }] });
      if (u.pathname === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(pageHtml()); }
      res.writeHead(404); res.end('nope');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  return { port, url, hits, mode, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }), env: upstreamEnv(url) };
}

// The environment that points every generic service at the fake (and removes the pauses of the public servers).
export const upstreamEnv = (url) => ({
  PYFIO_URL_NOMINATIM: url, PYFIO_URL_PHOTON: url, PYFIO_URL_OPEN_METEO_GEOCODING: url, PYFIO_URL_OSRM: url, PYFIO_URL_VALHALLA: url, PYFIO_URL_OSRM_DEMO: url,
  PYFIO_URL_SERPER: url, PYFIO_URL_EXA: url, PYFIO_URL_WIKIPEDIA: url, PYFIO_URL_MWMBL: url, PYFIO_URL_STACKEXCHANGE: url, PYFIO_URL_MDN: url, PYFIO_URL_HN: url,
  PYFIO_RATE_LIMIT: 'off',
});

function pageHtml() {
  const para = (i) => `<p>${Array.from({ length: 40 }, (_, k) => `wort${i}x${k}`).join(' ')}.</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fake page</title></head><body><nav><a href="/">Start</a></nav><article><h1>Fake headline</h1>${[1, 2, 3, 4, 5, 6, 7].map(para).join('')}</article><footer>Impressum</footer></body></html>`;
}
