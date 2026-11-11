// Local, deterministic assignment of a task text to a capability: keyword lists in German and English plus URL
// detection, a score per category, no model, no network. Only the category leaves this module; the text of the
// task is never kept, returned or counted. Thresholds are settings (router.zuordnungMinPunkte, router.zuordnungAbstand).
import { setting } from '../config.mjs';

export const KATEGORIEN = ['seite_lesen', 'fahrzeit', 'websuche', 'datum'];

// Lower case, no diacritics, sharp s as ss, single spaces: "Fährt" -> "fahrt".
export const normalisiere = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/\s+/g, ' ').trim();

const URL_RE = /\bhttps?:\/\/\S+|\bwww\.[a-z0-9-]+\.[a-z]{2,}\S*|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|de|io|eu|info|dev|ai|app|co|uk|fr|nl|ch|at|wiki|gov|edu)\b(?:\/\S*)?/;

// [regex on the normalized text, points]. Every entry counts once per task.
const REGELN = {
  seite_lesen: [
    [URL_RE, 2],
    [/\b(lies|lese|lesen|read|fetch|scrape|scrapen|abrufen|auslesen|extract|extrahier\w*|summari[sz]e|zusammenfass\w*|open|offne|offnen)\b/, 1],
    [/\bfass\w*\b.*\bzusammen\b/, 1],
    [/\b(seite|webseite|website|webpage|web page|page|url|link|artikel|article|haupttext|main text|blogpost|blog post)\b/, 1],
  ],
  fahrzeit: [
    [/\b(fahrzeit|fahrtzeit|fahrtdauer|fahrdauer|anfahrt|anfahrtszeit|reisezeit|travel time|drive time|driving time|travel duration|commute time|journey time)\b/, 2],
    [/\bwie lange (fahre|fahrt|dauert die fahrt|braucht man (mit dem|per) (auto|pkw)|fahr)\b/, 2],
    [/\bhow long (does|will|would|is) (it|the (drive|trip|journey))\b.*\b(drive|driving|car|by car)\b/, 2],
    [/\bwie lange\b.*\b(fahr\w*|auto|pkw)\b/, 1],
    [/\b(route|routenplan\w*|directions|navigation|navigier\w*|routing)\b/, 1],
    [/\bvon\b.+\bnach\b/, 1],
    [/\bfrom\b.+\bto\b/, 1],
    [/\b(abfahrt|abfahren|losfahren|ankunft|ankommen|arrive|arrival|depart\w*|leave by|eta|stau|traffic)\b/, 1],
    [/\b(auto|pkw|car|by car|mit dem auto)\b/, 1],
    [/\b(km|kilometer|entfernung|distance)\b/, 1],
  ],
  websuche: [
    [/\b(websuche|web search|websearch|google\w*|recherchier\w*|search (the )?(web|internet|online)|suche? (im|in dem) (web|internet)|internetsuche|im internet|online recherche)\b/, 2],
    [/\b(suche|such|search|find|finde|look up|nachschlagen|herausfinden|find out|finde heraus)\b/, 1],
    [/\b(news|nachrichten|aktuell\w*|neueste\w*|latest|current|heute|today)\b/, 1],
    [/\b(wer ist|wer war|was ist|what is|who is|who was|when did|wann wurde|wie viele einwohner)\b/, 1],
  ],
  datum: [
    [/\b(feiertag\w*|holiday\w*|public holiday|bank holiday|schulferien|school holiday\w*|ferien|werktag\w*|working days?|business days?|arbeitstag\w*|wochentag\w*|weekday\w*|day of the week|kalenderwoche|week number|schaltjahr|leap year|unix[- ]?(time|timestamp|zeit)|zeitzone\w*|time ?zone\w*|ostern|easter|sommerzeit|daylight saving)\b/, 2],
    [/\b(datum|date|wie viele tage|how many days|tage bis|days (until|between|since)|welcher tag|what day|heute ist)\b/, 1],
    [/\b(in \d+ (tagen|wochen|days|weeks)|vor \d+ tagen|\d+ days (ago|from now))\b/, 1],
  ],
};

// -> { kategorie: 'seite_lesen' | 'fahrzeit' | 'websuche' | 'datum' | 'unbekannt', punkte, abstand }
// unbekannt: the best score is below router.zuordnungMinPunkte, or the lead over the second is below router.zuordnungAbstand.
export function ordneZu(aufgabe) {
  const t = normalisiere(aufgabe);
  const punkte = {};
  for (const k of KATEGORIEN) punkte[k] = REGELN[k].reduce((s, [re, p]) => s + (re.test(t) ? p : 0), 0);
  const rang = KATEGORIEN.map((k) => [k, punkte[k]]).sort((a, b) => b[1] - a[1]);
  const [best, bp] = rang[0], sp = rang[1][1];
  if (bp < setting('router.zuordnungMinPunkte') || bp - sp < setting('router.zuordnungAbstand')) return { kategorie: 'unbekannt', punkte: bp, abstand: bp - sp };
  return { kategorie: best, punkte: bp, abstand: bp - sp };
}
