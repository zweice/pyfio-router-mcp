// Configuration: environment (keys, mode, language, state folder) and the tunable settings that the
// admin menu of the hosted mode changes for everyone (project rule: tunables go into an admin menu,
// saved globally on the server). Keys are read from the environment only and never logged or returned.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;

export function stateDir() {
  const env = process.env.PYFIO_STATE_DIR;
  if (env) return path.resolve(env);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'pyfio-router');
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'pyfio-router');
}
export const mkdirp = (d) => { fs.mkdirSync(d, { recursive: true }); return d; };

export const lang = () => (String(process.env.PYFIO_LANG || 'en').toLowerCase().startsWith('de') ? 'de' : 'en');

// Bring your own key: present = that provider may run, for this operator's own account.
export const keys = () => ({
  jina: (process.env.JINA_API_KEY || '').trim() || null,
  openMeteo: (process.env.OPEN_METEO_API_KEY || '').trim() || null,
});

export function telemetryWanted() {
  const dnt = String(process.env.DO_NOT_TRACK || '').trim();
  if (dnt && dnt !== '0' && dnt.toLowerCase() !== 'false') return false;
  const t = String(process.env.PYFIO_TELEMETRY || 'on').toLowerCase();
  return !['off', '0', 'false', 'no', 'aus'].includes(t);
}
// Where a local install sends its anonymous daily counts. Empty in this demo build: nothing is sent
// until a live endpoint exists and the maintainers have approved it.
export const telemetryUrl = () => (process.env.PYFIO_ZAEHLER_URL || '').trim();

// ---------- tunable settings ----------
export const SETTINGS = {
  'lesen.minWoerter': { def: 150, unit: 'Woerter', min: 20, max: 2000, desc: 'Kaskade: unter so vielen Woertern kommt die Browser-Stufe (gemessen 150, Schritt 1)' },
  'lesen.domainTtlTage': { def: 7, unit: 'Tage', min: 0, max: 90, desc: 'Domain-Gedaechtnis: so lange startet eine Domain direkt mit der Stufe, die zuletzt lieferte (0 = aus)' },
  'lesen.maxZeichen': { def: 8000, unit: 'Zeichen', min: 500, max: 30000, desc: 'Standardlaenge des Texts, wenn der Agent nichts angibt' },
  'lesen.browser': { def: 1, unit: '0/1', min: 0, max: 1, desc: 'Browser-Stufe (Chromium mit Readability) an' },
  'lesen.maxBrowser': { def: 2, unit: 'Prozesse', min: 1, max: 16, desc: 'Hoechstens so viele Browser (Chromium) gleichzeitig, weitere warten' },
  'lesen.maxPython': { def: 4, unit: 'Prozesse', min: 1, max: 32, desc: 'Hoechstens so viele Trafilatura-Prozesse gleichzeitig, weitere warten' },
  'http.maxAufrufeJeAnfrage': { def: 1, unit: 'Aufrufe', min: 1, max: 20, desc: 'Gehosteter Modus: hoechstens so viele tools/call in einer HTTP-Anfrage (JSON-RPC-Batch)' },
  'lesen.robotsTxt': { def: 1, unit: '0/1', min: 0, max: 1, desc: 'Gehosteter Modus: robots.txt befolgen (RFC 9309)' },
  'lesen.tdmVorbehalt': { def: 1, unit: '0/1', min: 0, max: 1, desc: 'Gehosteter Modus: TDM-Nutzungsvorbehalt befolgen (tdm-reservation, UrhG § 44b)' },
  'lesen.ehrlicherUA': { def: 1, unit: '0/1', min: 0, max: 1, desc: 'Gehosteter Modus: als PyfioRouter mit Kontaktadresse abrufen statt als Browser' },
  'lesen.robotsCacheStunden': { def: 24, unit: 'h', min: 1, max: 168, desc: 'So lange gilt eine gelesene robots.txt (RFC 9309 empfiehlt hoechstens 24 h)' },
  'wetter.stationMaxKm': { def: 100, unit: 'km', min: 0, max: 1000, desc: 'Bis zu dieser Entfernung gilt die Rangliste der naechsten gemessenen Station' },
  'wetter.stationMaxHoeheM': { def: 250, unit: 'm', min: 0, max: 3000, desc: 'Hoechster Hoehenunterschied zur Station (Berge haben eigene Sieger)' },
  'wetter.regionMaxKm': { def: 2000, unit: 'km', min: 0, max: 20000, desc: 'Bis hier gilt die Rangliste der Region der naechsten Station, sonst die globale' },
  'wetter.topK': { def: 3, unit: 'Modelle', min: 1, max: 6, desc: 'So viele der besten Modelle werden gemittelt (gemessen: 3)' },
  'http.freiProTag': { def: 50, unit: 'Aufrufe', min: 0, max: 100000, desc: 'Gehosteter Modus ohne Schluessel: Aufrufe je Betreiber und Tag' },
  'http.berichteProStunde': { def: 24, unit: 'Berichte', min: 1, max: 1000, desc: 'Zaehler-Berichte lokaler Installationen je Absender und Stunde' },
  'http.interesseProStunde': { def: 10, unit: 'Anfragen', min: 1, max: 1000, desc: 'Preisseite: Interesse-Meldungen je Absender und Stunde' },
  'zaehler.pingStunden': { def: 24, unit: 'h', min: 1, max: 168, desc: 'Lokaler Modus: so oft gehen die anonymen Zaehler an den Router (nur mit Endpunkt)' },
  'router.freiProTag': { def: 50, unit: 'Aufrufe', min: 0, max: 100000, desc: 'bauen_oder_nutzen: Gratis-Kontingent je Betreiber und Tag; darueber zeigt die Antwort den Preis je Aufruf (Startpreis laut Schicht 4: 50 Aufrufe am Tag frei)' },
  'router.preisJe1000Usd': { def: 2, unit: 'USD je 1.000', min: 0, max: 1000, desc: 'bauen_oder_nutzen: Preis je 1.000 Aufrufe ueber dem Gratis-Kontingent, angezeigt als preis_je_aufruf_usd (Startpreis: 2 je 1.000, Waehrung noch nicht entschieden)' },
  'router.stufe1Usd': { def: 0.01, unit: 'USD', min: 0.0001, max: 1000, desc: 'Budget-Stufe klein bis mittel: Budgets unter diesem Wert zaehlen als "klein" (nur die Stufe wird gezaehlt, nie der Betrag)' },
  'router.stufe2Usd': { def: 0.1, unit: 'USD', min: 0.0001, max: 1000, desc: 'Budget-Stufe mittel bis gross: Budgets unter diesem Wert zaehlen als "mittel"' },
  'router.stufe3Usd': { def: 1, unit: 'USD', min: 0.0001, max: 1000, desc: 'Budget-Stufe gross bis sehr gross: Budgets unter diesem Wert zaehlen als "gross", darueber "sehr_gross"' },
  'router.zuordnungMinPunkte': { def: 2, unit: 'Punkte', min: 1, max: 10, desc: 'Zuordnung der Aufgabe zu einer Faehigkeit: so viele Schluesselwort-Punkte braucht die beste Kategorie, sonst "unbekannt"' },
  'router.zuordnungAbstand': { def: 1, unit: 'Punkte', min: 0, max: 10, desc: 'Zuordnung: so viele Punkte muss die beste Kategorie vor der zweiten liegen, sonst "unbekannt"' },
  'fahrzeit.nominatimAbstandMs': { def: 1100, unit: 'ms', min: 1000, max: 10000, desc: 'Fahrzeit: Pause zwischen zwei Anfragen an Nominatim (Nutzungsregel: hoechstens 1 Anfrage je Sekunde; unter 1000 geht nicht)' },
  'fahrzeit.routerAbstandMs': { def: 1100, unit: 'ms', min: 1000, max: 10000, desc: 'Fahrzeit: Pause zwischen zwei Anfragen an denselben Router (OSRM, Valhalla: hoechstens 1 Anfrage je Sekunde)' },
  'fahrzeit.geoCacheTage': { def: 30, unit: 'Tage', min: 0, max: 365, desc: 'Fahrzeit: so lange werden Geocoding-Treffer im Zustandsordner behalten (0 = nie; Positionen werden nie gespeichert)' },
  'fahrzeit.routeCacheTage': { def: 7, unit: 'Tage', min: 0, max: 90, desc: 'Fahrzeit: so lange werden Routen im Zustandsordner behalten (0 = nie; Routen mit Koordinaten nie)' },
  'fahrzeit.diensteZeitlimitMs': { def: 12000, unit: 'ms', min: 2000, max: 30000, desc: 'Fahrzeit: Zeitlimit je Anfrage an einen Geocoder oder Router' },
  'suche.serperProTag': { def: 100, unit: 'Suchen', min: 0, max: 100000, desc: 'Websuche: hoechstens so viele Suchen am Tag mit dem Serper-Schluessel des Betreibers (UTC-Tag; schuetzt sein Guthaben)' },
  'suche.exaProTag': { def: 50, unit: 'Suchen', min: 0, max: 100000, desc: 'Websuche: hoechstens so viele Suchen am Tag mit dem Exa-Schluessel des Betreibers' },
  'suche.schwacheSchwelle': { def: 0.35, unit: 'Wert 0 bis 1', min: 0, max: 1, desc: 'Websuche: unter diesem Wert gelten Serpers Treffer als "nichts gefunden" und Exa fragt nach (gemessen: 0,35)' },
  'suche.fallback': { def: 1, unit: '0/1', min: 0, max: 1, desc: 'Websuche: schluesselfreier Fallback (Wikipedia, Mwmbl, Stack Exchange, MDN, Hacker News) an' },
  'suche.standardTreffer': { def: 8, unit: 'Treffer', min: 1, max: 20, desc: 'Websuche: Anzahl Treffer, wenn der Agent nichts angibt' },
  'suche.zeitlimitMs': { def: 15000, unit: 'ms', min: 2000, max: 40000, desc: 'Websuche: Zeitlimit je Anfrage an einen Suchdienst' },
  'urteil.maxAntwortZeichen': { def: 200000, unit: 'Zeichen', min: 1000, max: 5000000, desc: 'Urteil: groessere Antworten bestehen die Pruefung "Groesse" nicht' },
};

let cache = { file: null, mtime: -1, values: {} };
const settingsFile = () => path.join(stateDir(), 'einstellungen.json');
function readStored() {
  const f = settingsFile();
  try {
    const st = fs.statSync(f);
    if (cache.file === f && cache.mtime === st.mtimeMs) return cache.values;
    const v = JSON.parse(fs.readFileSync(f, 'utf8'));
    cache = { file: f, mtime: st.mtimeMs, values: v && typeof v === 'object' ? v : {} };
  } catch { cache = { file: f, mtime: -1, values: {} }; }
  return cache.values;
}
export function setting(key) {
  const s = SETTINGS[key];
  if (!s) throw new Error(`unknown setting ${key}`);
  const v = Number(readStored()[key]);
  return Number.isFinite(v) && v >= s.min && v <= s.max ? v : s.def;
}
export function allSettings() {
  const stored = readStored();
  return Object.entries(SETTINGS).map(([key, s]) => ({ key, value: setting(key), default: s.def, unit: s.unit, min: s.min, max: s.max, desc: s.desc, changed: key in stored }));
}
// value null = back to the default. Writes atomically. -> the new list.
export function changeSetting(key, value) {
  const s = SETTINGS[key];
  if (!s) throw Object.assign(new Error(`unknown setting ${key}`), { kind: 'input' });
  const stored = { ...readStored() };
  if (value === null || value === undefined) delete stored[key];
  else {
    const n = Number(value);
    if (!Number.isFinite(n) || n < s.min || n > s.max) throw Object.assign(new Error(`${key}: ${s.min} to ${s.max} ${s.unit}`), { kind: 'input' });
    stored[key] = n;
  }
  mkdirp(stateDir());
  const tmp = `${settingsFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stored, null, 1));
  fs.renameSync(tmp, settingsFile());
  cache.mtime = -1;
  return allSettings();
}
