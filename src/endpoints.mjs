// Where the generic services live. Every base URL can be overridden by an environment variable
// PYFIO_URL_<NAME> (a self-hosted Nominatim or OSRM, or a fake server in tests). A URL is read at call time.
// Polite use: the public servers ask for 1 request per second at most (Nominatim, FOSSGIS) and an
// identifying User-Agent; PYFIO_RATE_LIMIT=off removes the pause (only for servers of your own).
import { VERSION } from './config.mjs';

export const DEFAULT_URLS = {
  nominatim: 'https://nominatim.openstreetmap.org',
  photon: 'https://photon.komoot.io',
  open_meteo_geocoding: 'https://geocoding-api.open-meteo.com',
  osrm: 'https://routing.openstreetmap.de/routed-car',
  valhalla: 'https://valhalla1.openstreetmap.de',
  osrm_demo: 'https://router.project-osrm.org',
  serper: 'https://google.serper.dev',
  exa: 'https://api.exa.ai',
  wikipedia: 'https://{lang}.wikipedia.org',
  mwmbl: 'https://api.mwmbl.org',
  stackexchange: 'https://api.stackexchange.com',
  mdn: 'https://developer.mozilla.org',
  hn: 'https://hn.algolia.com',
};
export function endpoint(name, env = process.env) {
  const v = String(env[`PYFIO_URL_${name.toUpperCase()}`] || '').trim();
  return (v || DEFAULT_URLS[name]).replace(/\/+$/, '');
}
export const rateLimitOn = (env = process.env) => !['off', '0', 'false', 'no'].includes(String(env.PYFIO_RATE_LIMIT || 'on').toLowerCase());
// An identifying User-Agent; set PYFIO_USER_AGENT to add your own contact (Nominatim's policy asks for it).
export const userAgent = (env = process.env) => String(env.PYFIO_USER_AGENT || '').trim() || `pyfio-router/${VERSION} (+https://pyfio.com)`;
