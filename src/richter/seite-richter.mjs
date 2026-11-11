// The judge of read_page. Two parts in every answer:
// - measured: what the factory run measured for the provider that delivered, on this kind of page
//   (start page or sub page), against a reference; stable numbers with sample size and date;
// - live: a cheap check of this one answer without a reference (length, block page, menu-like
//   lines, repeated lines); a heuristic, said so in the answer.
import fs from 'node:fs';

const M = JSON.parse(fs.readFileSync(new URL('./seite-messung.json', import.meta.url), 'utf8'));
export const MEASUREMENT = M;

// Words as in the measurement (router-ausbau/schritt1-seite-lesen/code/analyze.py): Markdown images
// and URLs out, link texts in, a number of 5 or more digits is no word.
export function countWords(md) {
  const s = String(md || '').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, ' $1 ').replace(/https?:\/\/\S+|www\.\S+/g, ' ').replace(/<[^>]+>/g, ' ');
  return (s.toLowerCase().match(/[\p{L}\p{M}\p{N}_]+/gu) || []).filter((w) => !/^\d+$/.test(w) || w.length < 5).length;
}
const BLOCK_RX = /(just a moment|checking your browser|verify(ing)? you are (a )?human|are you a robot|access denied|attention required|pardon our interruption|unusual traffic|captcha|enable javascript and cookies|request blocked|403 forbidden|bot protection|please verify you are a human|ddos protection|security check)/i;
// A bot-check page is short and says so at the top; an article that mentions "captcha" further down is
// none (review 2026-10-20: a 216-word article was refused).
export const isBlockPage = (text, words) => {
  const t = String(text || '');
  return words < 300 && (BLOCK_RX.test(t.slice(0, 600)) || (words < 80 && BLOCK_RX.test(t.slice(0, 3000))));
};

export function pageClass(url) {
  try { const u = new URL(url); return u.pathname.replace(/\/+$/, '') === '' && !u.search ? 'home' : 'sub'; } catch { return 'sub'; }
}

export function measured(provider, cls) {
  const p = M.providers[provider];
  if (!p) {
    return { provider, measured: false, note: provider === 'http-text' ? 'plain text or JSON as delivered by the server, nothing extracted' : 'not measured against the reference yet' };
  }
  const c = p[cls] || p.all;
  const o = { provider, page_class: cls, n_cases: c.n, f1_mean: c.f1_mean, f1_median: c.f1_median, success_rate: c.success, measured_on: M.judge, ...(p.note ? { note: p.note } : {}) };
  for (const k of Object.keys(o)) if (o[k] === null || o[k] === undefined) delete o[k];
  return o;
}

// One answer, no reference. score 0..1; grade good >= 0.8, fair >= 0.5, else poor.
export function live(text, { minWords = 150 } = {}) {
  const words = countWords(text);
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const checks = { words };
  let score = 1;
  if (isBlockPage(text, words)) { checks.block_page = true; score = 0; }
  if (words < 50) { checks.very_short = true; score -= 0.6; }
  else if (words < minWords) { checks.short = true; score -= 0.3; }
  if (lines.length >= 10) {
    const shortLines = lines.filter((l) => countWords(l) <= 3 && !/^#/.test(l)).length / lines.length;
    checks.menu_like_lines = Math.round(shortLines * 100) / 100;
    if (shortLines > 0.5) score -= 0.2;
    const seen = new Map();
    for (const l of lines) seen.set(l, (seen.get(l) || 0) + 1);
    const dup = lines.filter((l) => seen.get(l) > 1 && l.length > 3).length / lines.length;
    checks.repeated_lines = Math.round(dup * 100) / 100;
    if (dup > 0.2) score -= 0.1;
  }
  const links = (String(text || '').match(/\]\([^)]*\)/g) || []).length;
  if (words > 0) { checks.links_per_100_words = Math.round((links / words) * 1000) / 10; if (links / words > 0.08) score -= 0.1; }
  score = Math.max(0, Math.round(score * 100) / 100);
  return { grade: score >= 0.8 ? 'good' : score >= 0.5 ? 'fair' : 'poor', score, checks, method: 'heuristic per answer, not a reference measurement' };
}
