// bauen_oder_nutzen (build_or_use): build it yourself or call a measured offer? The estimate comes from a table of
// measurements (data/messungen.json), not from a model. The text of the task is assigned to a capability
// locally (zuordnung.mjs) and then forgotten: it is not returned, not counted, not stored. The reasons are fixed
// text blocks (texte.mjs). Phase 1: only own offers, so no foreign text enters the answer, only typed fields.
import fs from 'node:fs';
import path from 'node:path';
import { PKG_ROOT, setting, keys as configKeys } from '../config.mjs';
import { ordneZu } from './zuordnung.mjs';
import { baustein } from './texte.mjs';

let table = null;
export function messungen() {
  if (!table) table = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'data', 'messungen.json'), 'utf8'));
  return table;
}

export const DATENSCHUTZ = ['lokal', 'EU', 'egal'];
// Accepts the English spelling too.
export const normDatenschutz = (v) => {
  const s = String(v ?? 'egal').trim().toLowerCase();
  if (['lokal', 'local'].includes(s)) return 'lokal';
  if (s === 'eu') return 'EU';
  if (['egal', 'any', ''].includes(s)) return 'egal';
  return null;
};

// Budget level from the three limits (settings router.stufe1Usd .. stufe3Usd): only the level is counted.
export function budgetStufe(usd) {
  const b = Number(usd);
  if (!(b > 0)) return 'null';
  if (b < setting('router.stufe1Usd')) return 'klein';
  if (b < setting('router.stufe2Usd')) return 'mittel';
  if (b < setting('router.stufe3Usd')) return 'gross';
  return 'sehr_gross';
}

// What a call of the offer costs now: free while the day's quota lasts (this call counts too), then the price per 1,000 / 1,000.
export function preisJeAufruf(ctx) {
  const frei = setting('router.freiProTag');
  const genutzt = Number(ctx.counter?.usedToday?.(ctx.operator)) || 0;
  const danach = genutzt + 1;   // this very call
  const preis = danach < frei ? 0 : Math.round((setting('router.preisJe1000Usd') / 1000) * 1e6) / 1e6;
  return { preis, kontingent: { pro_tag: frei, genutzt_heute: Math.min(danach, frei), uebrig: Math.max(0, frei - danach) } };
}

// args: { task, budget_usd, privacy?, deadline_s? } already normalized: { aufgabe, budget_usd, datenschutz, frist_s }
// ctx: { lang, mode, tools (the tool list in the language of the answer), counter, operator }
export function bauenOderNutzen(args, ctx = {}) {
  const l = ctx.lang === 'de' ? 'de' : 'en';
  const aufgabe = typeof args.aufgabe === 'string' ? args.aufgabe.trim() : '';
  if (!aufgabe) return { ok: false, error: 'task is required (text, at most 500 characters)', kind: 'input' };
  if (aufgabe.length > 500) return { ok: false, error: 'task: at most 500 characters', kind: 'input' };
  const budget = Number(args.budget_usd);
  if (args.budget_usd === undefined || args.budget_usd === null || !Number.isFinite(budget) || budget < 0) return { ok: false, error: 'budget_usd is required (a number, 0 or more)', kind: 'input' };
  const ds = normDatenschutz(args.datenschutz);
  if (ds === null) return { ok: false, error: 'privacy must be one of: local, EU, any (lokal, EU, egal)', kind: 'input' };
  const frist = args.frist_s === undefined || args.frist_s === null ? null : Number(args.frist_s);
  if (frist !== null && !(Number.isFinite(frist) && frist > 0)) return { ok: false, error: 'deadline_s must be a number above 0', kind: 'input' };

  const z = ordneZu(aufgabe);   // from here on only the category; the task text is dropped
  const T = messungen();
  const stufe = budgetStufe(budget);
  const base = { ok: true, kategorie: z.kategorie, budget_stufe: stufe, zuordnung: { punkte: z.punkte, abstand: z.abstand }, messtabelle: { stand: T.stand, version: T.v } };
  const codes = [];
  const b = (code) => { codes.push(code); };

  if (z.kategorie === 'unbekannt') {
    b('keine_messung');
    return { ...base, empfehlung: 'bauen', selbstbau: { moeglich: null, usd: null, minuten: null, fehlerquote: null, sauber: null, messdatum: null, quelle: null, hinweis: 'keine Messung' }, nutzung: { angebot: null }, datenschutz: { gefordert: ds, erfuellt: null, geht_nach: [] }, aufruf: null, begruendung: codes.map((c) => baustein(c, l)) };
  }
  const e = T.faehigkeiten[z.kategorie];
  const sb = e.selbstbau;
  const selbstbau = { moeglich: sb.moeglich, usd: sb.usd, minuten: sb.minuten, fehlerquote: sb.fehlerquote, fehlerquote_art: sb.fehlerquote_art, sauber: sb.sauber, korrekturrunden: sb.korrekturrunden, messdatum: sb.messdatum, quelle: sb.quelle, modell: T.selbstbau_messung.modell };
  if (z.kategorie === 'datum') {
    b('gegenbefund_datum');
    return { ...base, empfehlung: 'gratis', selbstbau, nutzung: { angebot: null }, datenschutz: { gefordert: ds, erfuellt: true, geht_nach: [] }, aufruf: null, begruendung: codes.map((c) => baustein(c, l)) };
  }

  // Data protection: where do the data of the offer go? (local server: also to the operator of the server)
  const hosted = ctx.mode === 'http';
  const jina = z.kategorie === 'seite_lesen' && !!configKeys().jina;
  const lokal = !hosted && !jina && e.daten.lokal;
  const eu = !hosted && !jina && e.daten.eu;
  const geht = [...e.daten.geht_nach, ...(jina ? ['Jina Reader (USA), weil ein JINA_API_KEY gesetzt ist'] : []), ...(hosted ? ['der Betreiber dieses Servers'] : [])];
  const erfuellt = ds === 'egal' || (ds === 'lokal' && lokal) || (ds === 'EU' && eu);

  const { preis, kontingent } = preisJeAufruf(ctx);
  const q = e.nutzung;
  const grund = [];
  if (!erfuellt) grund.push('datenschutz_nicht_erfuellt');
  if (preis > budget) grund.push('preis_ueber_budget');
  if (frist !== null && frist * 1000 < q.latenz_ms) {
    grund.push('frist_kuerzer_als_latenz');
    if (sb.minuten !== null && frist < sb.minuten * 60) grund.push('frist_kuerzer_als_selbstbau');
  }
  const werkzeug = (ctx.tools || []).find((t) => t.name === (l === 'de' ? { read_page: 'seite_lesen', travel_time: 'fahrzeit', web_search: 'websuche' }[e.werkzeug] : e.werkzeug));
  const nutzung = { angebot: werkzeug?.name || e.werkzeug, preis_je_aufruf_usd: preis, gratis_kontingent: kontingent, kontext_tokens: q.kontext_tokens, qualitaet: { metrik: q.qualitaet.metrik, wert: q.qualitaet.wert, stichprobe: q.qualitaet.stichprobe, einheit: q.qualitaet.einheit, datum: q.qualitaet.datum }, latenz_ms: q.latenz_ms, latenz_art: q.latenz_art, abgelehnt: grund.length > 0, abgelehnt_grund: grund.length ? grund : null };
  const datenschutz = { gefordert: ds, erfuellt, lokal, eu, geht_nach: geht };

  if (grund.length) {
    codes.push(...grund);
    if (!sb.moeglich) b('selbstbau_nicht_moeglich');
    else if (sb.usd > budget) b('selbstbau_ueber_budget');
    return { ...base, empfehlung: 'bauen', selbstbau, nutzung, datenschutz, aufruf: null, begruendung: codes.map((c) => baustein(c, l)) };
  }
  b(preis === 0 ? 'angebot_gratis_kontingent' : 'angebot_kostet');
  if (!sb.moeglich) b('selbstbau_nicht_moeglich');
  else {
    if (sb.usd > preis) b('selbstbau_teurer');
    if (sb.fehlerquote > 0) b('selbstbau_nicht_sauber');
  }
  return { ...base, empfehlung: 'nutzen', selbstbau, nutzung, datenschutz, aufruf: { werkzeug: werkzeug?.name || e.werkzeug, argument_schema: werkzeug?.inputSchema || null }, begruendung: codes.map((c) => baustein(c, l)) };
}
