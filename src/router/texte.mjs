// The fixed text blocks of the answer of bauen_oder_nutzen. The "begruendung" consists of these and nothing
// else: no word of the task text, no number from the request. The verdict checks that every text of an answer
// is exactly one of these blocks.
export const BAUSTEINE = {
  de: {
    keine_messung: 'Fuer diese Aufgabe liegt keine Messung vor: bauen.',
    gegenbefund_datum: 'Datum, Feiertage und Werktage sind mit Bordmitteln in wenigen Minuten und fehlerfrei gebaut (gemessen); dafuer gibt es kein Angebot.',
    angebot_gratis_kontingent: 'Das Angebot liegt im Gratis-Kontingent, der Aufruf kostet nichts.',
    angebot_kostet: 'Das Angebot kostet je Aufruf den angegebenen Preis, das liegt im Budget.',
    selbstbau_teurer: 'Der gemessene Selbstbau kostet mehr als ein Aufruf.',
    selbstbau_nicht_moeglich: 'Selbstbau ist ohne Schluessel eines Suchdienstes nicht moeglich.',
    selbstbau_nicht_sauber: 'Der gemessene Selbstbau war nicht fehlerfrei.',
    selbstbau_ueber_budget: 'Auch der gemessene Selbstbau kostet mehr als das Budget.',
    preis_ueber_budget: 'Der Preis je Aufruf liegt ueber dem Budget: das Angebot ist abgelehnt.',
    datenschutz_nicht_erfuellt: 'Das Angebot erfuellt die geforderte Datenschutz-Stufe nicht: das Angebot ist abgelehnt.',
    frist_kuerzer_als_latenz: 'Die Frist ist kuerzer als die gemessene Antwortzeit des Angebots: das Angebot ist abgelehnt.',
    frist_kuerzer_als_selbstbau: 'Die Frist ist auch kuerzer als die gemessene Zeit des Selbstbaus.',
  },
  en: {
    keine_messung: 'There is no measurement for this task: build it.',
    gegenbefund_datum: 'Dates, public holidays and working days are built with built-in means in a few minutes and without errors (measured); there is no offer for it.',
    angebot_gratis_kontingent: 'The offer is within the free quota, the call costs nothing.',
    angebot_kostet: 'The offer costs the stated price per call, which is within the budget.',
    selbstbau_teurer: 'The measured self-build costs more than one call.',
    selbstbau_nicht_moeglich: 'Self-build is not possible without a key of a search service.',
    selbstbau_nicht_sauber: 'The measured self-build was not error-free.',
    selbstbau_ueber_budget: 'The measured self-build also costs more than the budget.',
    preis_ueber_budget: 'The price per call is above the budget: the offer is rejected.',
    datenschutz_nicht_erfuellt: 'The offer does not meet the required privacy level: the offer is rejected.',
    frist_kuerzer_als_latenz: 'The deadline is shorter than the measured response time of the offer: the offer is rejected.',
    frist_kuerzer_als_selbstbau: 'The deadline is also shorter than the measured time of the self-build.',
  },
};
export const CODES = Object.keys(BAUSTEINE.en);
export const baustein = (code, l) => ({ code, text: (BAUSTEINE[l] || BAUSTEINE.en)[code] });
// All texts of both languages, for the verdict's check.
export const ALLE_TEXTE = new Set([...Object.values(BAUSTEINE.de), ...Object.values(BAUSTEINE.en)]);
