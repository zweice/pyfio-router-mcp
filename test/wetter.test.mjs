import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpState } from './helpers.mjs';

tmpState('wetter');
const W = await import('../src/wetter/wetter.mjs');
const { changeSetting } = await import('../src/config.mjs');

test('ranking level: Dresden station, Zugspitze valley vs summit, Honolulu global', () => {
  let p = W.pickRanking({ lat: 51.13, lon: 13.75, elevation: 228 });
  assert.equal(p.level, 'station');
  assert.equal(p.station.name, 'Dresden-Klotzsche');
  p = W.pickRanking({ lat: 47.421, lon: 10.985, elevation: 2950 });
  assert.equal(p.level, 'station', 'summit = station height');
  p = W.pickRanking({ lat: 47.42, lon: 10.98, elevation: 2677 });
  assert.equal(p.level, 'region', 'height differs too much');
  p = W.pickRanking({ lat: 21.31, lon: -157.86, elevation: 5 });
  assert.equal(p.level, 'global');
});

test('the table holds a ranking and an out-of-sample score per segment', () => {
  const t = W.JUDGE_TABLE;
  assert.equal(Object.keys(t.stations).length, 63);
  const s = t.segments['DWD01048|t2m_c|24'];
  assert.ok(s.rank.length >= 10);
  assert.ok(!s.rank.includes('best_match'), 'best_match is never a candidate');
  assert.ok(Number.isFinite(s.roll.gain_vs_best_match_pct));
  for (const k of ['t2m_c|24', 'wind10_ms|24', 'precip_day|24']) assert.ok(t.global[k].rank.length);
});

// A fake Open-Meteo: every model gives a constant per variable, so the mix is checkable.
function fakeMeteo(values) {
  const calls = [];
  return {
    calls,
    fetchJson: async (url) => {
      calls.push(url);
      if (url.includes('/v1/search')) return { results: [{ name: 'Dresden', latitude: 51.13, longitude: 13.75, country_code: 'DE', admin1: 'Sachsen', elevation: 228 }] };
      if (url.includes('/v1/elevation')) return { elevation: [228] };
      const u = new URL(url);
      const models = u.searchParams.get('models').split(',');
      const days = Number(u.searchParams.get('forecast_days'));
      const time = [];
      for (let d = 0; d < days; d++) for (let hr = 0; hr < 24; hr++) time.push(`2026-10-${String(20 + d).padStart(2, '0')}T${String(hr).padStart(2, '0')}:00`);
      const hourly = { time };
      for (const m of models) {
        const v = values(m);
        hourly[`temperature_2m_${m}`] = time.map(() => v.t);
        hourly[`wind_speed_10m_${m}`] = time.map(() => v.w);
        hourly[`precipitation_${m}`] = time.map(() => v.p);
      }
      return { timezone: 'Europe/Berlin', elevation: 228, hourly };
    },
  };
}

test('weather: mean of the top 3 of the station ranking; precipitation by majority', async () => {
  const seg = W.JUDGE_TABLE.segments['DWD01048|t2m_c|24'];
  const top3 = seg.rank.slice(0, 3);
  const f = fakeMeteo((m) => ({ t: top3.includes(m) ? (top3.indexOf(m) + 1) * 3 : 100, w: 2, p: 0.1 }));
  const r = await W.weather({ place: 'Dresden', days: 2 }, { fetchJson: f.fetchJson });
  assert.equal(r.ok, true);
  assert.deepEqual(r.days[0].models.temperature, top3);
  assert.equal(r.days[0].t_min_c, 6);   // (3 + 6 + 9) / 3
  assert.equal(r.days[0].precip_mm, 2.4);   // 24 h x 0.1
  assert.equal(r.days[0].precip_yes, true);
  assert.equal(r.judge.place_ranking.level, 'station');
  assert.ok(r.judge.summary.includes('Dresden-Klotzsche'));
  assert.ok(f.calls.every((u) => !u.includes('apikey')), 'no key without a key');
});

test('a model without values here is replaced by the next in the ranking', async () => {
  const seg = W.JUDGE_TABLE.segments['DWD01048|t2m_c|24'];
  const [a, b, c, d] = seg.rank;
  const f = fakeMeteo((m) => ({ t: m === a ? NaN : 1, w: 1, p: 0 }));
  const r = await W.weather({ lat: 51.13, lon: 13.75, days: 1 }, { fetchJson: f.fetchJson });
  assert.deepEqual(r.days[0].models.temperature, [b, c, d]);
});

test('where the mix measured worse than the default, the default is used and said so', async () => {
  const w = W.JUDGE_TABLE.segments['DWD01048|wind10_ms|24'];
  const f = fakeMeteo(() => ({ t: 5, w: 3, p: 0 }));
  const r = await W.weather({ place: 'Dresden', days: 1 }, { fetchJson: f.fetchJson });
  if (w.roll.gain_vs_best_match_pct < 0) {
    assert.deepEqual(r.days[0].models.wind, ['best_match']);
    assert.match(r.judge.wind.strategy, /default/);
    assert.equal(r.judge.wind.gain_vs_open_meteo_default_pct, 0);
  } else assert.notDeepEqual(r.days[0].models.wind, ['best_match']);
});

test('setting wetter.topK changes how many models are mixed', async () => {
  changeSetting('wetter.topK', 2);
  const f = fakeMeteo(() => ({ t: 5, w: 3, p: 0 }));
  const r = await W.weather({ place: 'Dresden', days: 1 }, { fetchJson: f.fetchJson });
  assert.equal(r.days[0].models.temperature.length, 2);
  changeSetting('wetter.topK', null);
});

test('hosted mode without a commercial key refuses (Open-Meteo free = non-commercial)', async () => {
  const save = process.env.OPEN_METEO_API_KEY;
  delete process.env.OPEN_METEO_API_KEY;
  await assert.rejects(W.weather({ place: 'Dresden' }, { mode: 'http', fetchJson: fakeMeteo(() => ({})).fetchJson }), (e) => e.kind === 'setup');
  process.env.OPEN_METEO_API_KEY = 'test-key-123';
  const f = fakeMeteo(() => ({ t: 5, w: 3, p: 0 }));
  const r = await W.weather({ place: 'Dresden', days: 1 }, { mode: 'http', fetchJson: f.fetchJson });
  assert.ok(f.calls.every((u) => u.startsWith('https://customer-') && u.includes('apikey=test-key-123')));
  assert.ok(!JSON.stringify(r).includes('test-key-123'), 'the key never appears in an answer');
  if (save) process.env.OPEN_METEO_API_KEY = save; else delete process.env.OPEN_METEO_API_KEY;
});

test('coordinates are parsed and checked', () => {
  assert.deepEqual(W.parseCoords('51.13, 13.75'), { lat: 51.13, lon: 13.75 });
  assert.equal(W.parseCoords('95,10'), null);
  assert.equal(W.parseCoords('Dresden'), null);
});
