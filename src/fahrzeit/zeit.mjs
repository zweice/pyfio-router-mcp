// Time of day and the traffic surcharge. No traffic data of our own: the free-flow time of the keyless router
// gets a surcharge by weekday and hour (data/verkehr-profil.json, calibrated against reference values, see the
// file). Berlin wall clock, because the profile was calibrated for Germany. Nationwide public holidays count as
// Sunday; regional holidays are not known.
import fs from 'node:fs';
import path from 'node:path';
import { PKG_ROOT } from '../config.mjs';

export const TZ = 'Europe/Berlin';
let profile = null;
export function loadProfile() {
  if (!profile) profile = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'data', 'verkehr-profil.json'), 'utf8'));
  return profile;
}

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
export function berlinParts(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute), wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
export function berlinMs(date, hh, mm) {
  const [y, mo, d] = date.split('-').map(Number);
  const want = Date.UTC(y, mo - 1, d, hh, mm);
  let ms = want;
  for (let i = 0; i < 2; i++) {
    const p = berlinParts(ms), [py, pm, pd] = p.date.split('-').map(Number);
    ms += want - Date.UTC(py, pm - 1, pd, p.hour, p.minute);
  }
  return ms;
}
export const clock = (ms) => { const p = berlinParts(ms); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };
export const isoLocal = (ms) => `${berlinParts(ms).date}T${clock(ms)}`;

// "2026-10-20 07:45", "2026-10-20T07:45", "07:45" (today; tomorrow if already past by more than an hour),
// "tue 07:45" / "dienstag 07:45" (next such day; a week later if today's is past), "tomorrow 07:45" / "morgen 07:45",
// "now" / "jetzt".
const WD = { so: 0, sonntag: 0, sun: 0, sunday: 0, mo: 1, montag: 1, mon: 1, monday: 1, di: 2, dienstag: 2, tue: 2, tues: 2, tuesday: 2, mi: 3, mittwoch: 3, wed: 3, wednesday: 3,
  do: 4, donnerstag: 4, thu: 4, thur: 4, thurs: 4, thursday: 4, fr: 5, freitag: 5, fri: 5, friday: 5, sa: 6, samstag: 6, sonnabend: 6, sat: 6, saturday: 6 };
const HELP = '(examples: 07:45, tue 07:45, tomorrow 17:00, 2026-10-20 07:45)';
const addDay = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const DAYWORD = Object.keys(WD).sort((a, b) => b.length - a.length).join('|');
const WHEN_RE = new RegExp(`^(?:(heute|today|morgen|tomorrow|\\u00fcbermorgen|uebermorgen|${DAYWORD})\\.?,?\\s+)?(?:(?:morgens|vormittags|mittags|nachmittags|abends|um|at)\\s+)*(\\d{1,2})[:.](\\d{2})(?:\\s*uhr)?$`);

export function parseWhen(s, nowMs) {
  const t = String(s || 'now').trim().toLowerCase();
  if (!t || t === 'jetzt' || t === 'now') return nowMs;
  const bad = (m) => Object.assign(new Error(m), { kind: 'input' });
  const clockOk = (h, mi) => { if (h > 23 || mi > 59) throw bad(`invalid clock time ${HELP}`); };
  let m = /^(\d{4}-\d{2}-\d{2})[ t](\d{1,2}):(\d{2})$/.exec(t);
  if (m) { clockOk(+m[2], +m[3]); return berlinMs(m[1], +m[2], +m[3]); }
  m = WHEN_RE.exec(t);
  if (!m) throw bad(`time not understood ${HELP}`);
  clockOk(+m[2], +m[3]);
  const today = berlinParts(nowMs);
  const w = m[1];
  let addDays = 0;
  if (w === 'morgen' || w === 'tomorrow') addDays = 1;
  else if (w === 'übermorgen' || w === 'uebermorgen') addDays = 2;
  else if (w && w !== 'heute' && w !== 'today') addDays = (WD[w] - today.wd + 7) % 7;
  let ms = berlinMs(addDay(today.date, addDays), +m[2], +m[3]);
  const isWeekday = w && WD[w] !== undefined;
  if ((!w || isWeekday) && ms < nowMs - 3600e3) ms = berlinMs(addDay(today.date, addDays + (isWeekday ? 7 : 1)), +m[2], +m[3]);
  return ms;
}

// ---------- nationwide public holidays count as Sunday ----------
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return Date.UTC(y, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1);
}
export function holiday(date) {
  const y = +date.slice(0, 4), md = date.slice(5);
  const fixed = { '01-01': 'New Year', '05-01': 'Labour Day', '10-03': 'German Unity Day', '12-25': 'Christmas Day', '12-26': 'Boxing Day' };
  if (fixed[md]) return fixed[md];
  const e = easter(y), off = { '-2': 'Good Friday', 1: 'Easter Monday', 39: 'Ascension Day', 50: 'Whit Monday' };
  for (const [k, v] of Object.entries(off)) if (new Date(e + Number(k) * 864e5).toISOString().slice(0, 10) === date) return v;
  return null;
}

function hourFactor(ms, prof) {
  const p = berlinParts(ms);
  const hol = holiday(p.date);
  const day = hol || p.wd === 0 ? 'sonntagFeiertag' : p.wd === 6 ? 'samstag' : 'werktag';
  let typ = prof[day].typisch[p.hour], cau = prof[day].vorsichtig[p.hour];
  const fr = prof.freitagNachmittagPlus;
  if (day === 'werktag' && p.wd === 5 && fr && p.hour >= fr.abStunde && p.hour < fr.bisStunde) { typ += fr.typisch; cau += fr.vorsichtig; }
  return { typ, cau, day: hol ? `holiday (${hol})` : { werktag: 'weekday', samstag: 'saturday', sonntagFeiertag: 'sunday' }[day] };
}
// Factor pair at a Berlin time, interpolated between this full hour and the next one.
export function factorAt(ms, prof = loadProfile()) {
  const p = berlinParts(ms);
  const w = p.minute / 60, h0ms = ms - p.minute * 60e3;
  const a = hourFactor(h0ms, prof), b = hourFactor(h0ms + 3600e3, prof);
  return { typ: a.typ * (1 - w) + b.typ * w, cau: a.cau * (1 - w) + b.cau * w, day: a.day };
}
// Free-flow OSRM minutes -> { freeMin, typMin, cauMin } for a departure at ms.
export function withTraffic(osrmMin, ms, prof = loadProfile()) {
  const f = factorAt(ms, prof);
  const base = prof.sonntagFeiertag.typisch[3];
  return { freeMin: osrmMin * base, typMin: osrmMin * f.typ, cauMin: osrmMin * f.cau, day: f.day, factor: +f.typ.toFixed(2) };
}
