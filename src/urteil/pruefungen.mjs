// The deterministic checks behind a verdict ("urteil"). Each check looks only at the arguments, the result, the
// measured time and fixed tables: same input, same outcome, no model, no network. A check never copies text of
// the result into the verdict (only field names, counts and numbers).
import { validate } from './schema.mjs';
import { setting } from '../config.mjs';
import { ALLE_TEXTE, CODES } from '../router/texte.mjs';
import { SOURCES } from '../suche/suche.mjs';

// Fields a successful result of each tool must carry; an error result carries ERROR_FIELDS.
export const REQUIRED = {
  read_page: ['ok', 'url', 'text', 'provider', 'route', 'judge'],
  weather: ['ok', 'place', 'days', 'provider', 'judge'],
  travel_time: ['ok', 'provider', 'from', 'to', 'minutes_typical', 'minutes_cautious', 'distance_km', 'route_link'],
  web_search: ['ok', 'query', 'provider', 'results', 'used', 'judge'],
  build_or_use: ['ok', 'empfehlung', 'kategorie', 'selbstbau', 'nutzung', 'begruendung', 'aufruf'],
};
export const ERROR_FIELDS = ['ok', 'error', 'kind'];
export const READ_PROVIDERS = new Set(['trafilatura', 'readability-http', 'browser-readability', 'jina', 'http-text']);
export const ROUTERS = new Set(['osrm-fossgis', 'osrm-demo', 'valhalla']);
export const ROUTE_LINK_PREFIX = 'https://www.openstreetmap.org/';
export const AUFRUF_NAMEN = new Set(['read_page', 'travel_time', 'web_search', 'seite_lesen', 'fahrzeit', 'websuche']);
const SEARCH_SOURCES = new Set(SOURCES);

// Is every source in the result one of the allowed ones? -> { ok, geprueft, ... }
function quelle(tool, r) {
  if (tool === 'read_page') { const ok = READ_PROVIDERS.has(r.provider); return { ok, regel: 'provider in the known readers' }; }
  if (tool === 'weather') return { ok: typeof r.provider === 'string' && r.provider.startsWith('open-meteo'), regel: 'provider is Open-Meteo' };
  if (tool === 'travel_time') {
    const bad = (r.routers || []).filter((x) => !ROUTERS.has(x?.source)).length;
    return { ok: bad === 0 && typeof r.route_link === 'string' && r.route_link.startsWith(ROUTE_LINK_PREFIX), regel: 'routers known, route link on openstreetmap.org', unbekannt: bad };
  }
  if (tool === 'web_search') {
    const bad = (r.results || []).filter((x) => !SEARCH_SOURCES.has(x?.source)).length;
    return { ok: bad === 0, regel: 'result sources are known search providers', unbekannt: bad };
  }
  if (tool === 'build_or_use') {
    const texts = (r.begruendung || []);
    const badText = texts.filter((b) => !(CODES.includes(b?.code) && ALLE_TEXTE.has(b?.text))).length;
    const badCall = r.aufruf && !AUFRUF_NAMEN.has(r.aufruf.werkzeug) ? 1 : 0;
    return { ok: badText === 0 && badCall === 0, regel: 'reasons are fixed text blocks, the call names an own tool', unbekannt: badText + badCall };
  }
  return { ok: false, regel: 'unknown tool' };
}

// -> array of { name, ok, ... }
export function pruefungen({ tool, schema, args, result, ms, limitMs }) {
  const fehler = schema ? validate(schema, args || {}) : ['no schema for this tool'];
  const need = result?.ok === false ? ERROR_FIELDS : REQUIRED[tool] || ERROR_FIELDS;
  const fehlend = need.filter((k) => result?.[k] === undefined);
  const zeichen = JSON.stringify(result ?? null).length;
  const maxZ = setting('urteil.maxAntwortZeichen');
  const q = result?.ok === false ? { ok: true, regel: 'error result, no sources' } : quelle(tool, result || {});
  return [
    { name: 'eingabe_schema', ok: fehler.length === 0, ...(fehler.length ? { fehler: fehler.slice(0, 5) } : {}) },
    { name: 'pflichtfelder', ok: fehlend.length === 0, ...(fehlend.length ? { fehlend } : {}) },
    { name: 'zeitlimit', ok: ms <= limitMs, ms: Math.max(0, Math.round(ms)), grenze_ms: limitMs },
    { name: 'quelle_erlaubt', ...q },
    { name: 'groesse', ok: zeichen <= maxZ, zeichen, grenze: maxZ },
  ];
}
