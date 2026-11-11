// Fake door of the pricing page: clicks on "I'm interested" are counted per day; an email address is
// kept only with the consent checkbox ticked, for one message when the paid tier starts. No IP, no
// user agent, no cookie. The domain type (company or free mail) is what the 15.11. decision reads.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { stateDir, mkdirp } from './config.mjs';

export const FREEMAIL = new Set(`gmail.com googlemail.com outlook.com outlook.de hotmail.com hotmail.de hotmail.co.uk live.com live.de msn.com
yahoo.com yahoo.de yahoo.co.uk ymail.com aol.com aol.de icloud.com me.com mac.com gmx.de gmx.net gmx.at gmx.ch gmx.com web.de t-online.de
freenet.de posteo.de posteo.net mailbox.org proton.me protonmail.com protonmail.ch pm.me tutanota.com tutanota.de tuta.io zoho.com
yandex.ru yandex.com mail.ru inbox.ru bk.ru list.ru qq.com 163.com 126.com sina.com naver.com hanmail.net fastmail.com fastmail.fm
hey.com duck.com mail.com email.de arcor.de online.de kabelmail.de vodafonemail.de o2online.de 1und1.de ionos.de seznam.cz wp.pl o2.pl
interia.pl libero.it virgilio.it orange.fr free.fr laposte.net sfr.fr wanadoo.fr btinternet.com sky.com bigpond.com rediffmail.com`.split(/\s+/).filter(Boolean));

const EMAIL_RX = /^[^\s@<>()[\]\\,;:"]{1,64}@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i;
export const TIERS = ['router', 'team', 'free'];

function atomicWrite(file, data) {
  mkdirp(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

export function domainType(email) {
  const m = EMAIL_RX.exec(String(email || '').trim());
  if (!m) return null;
  const domain = m[1].toLowerCase();
  return { domain, company: !FREEMAIL.has(domain) };
}

// body: { event: 'klick' | 'email', tarif, sprache, seite?, email?, einwilligung? } -> { ok, stored }
export function acceptInterest(body, dir = stateDir(), now = Date.now()) {
  const bad = (m) => { throw Object.assign(new Error(m), { kind: 'input' }); };
  if (!body || typeof body !== 'object') bad('JSON object expected');
  const event = body.event;
  if (!['klick', 'email'].includes(event)) bad('event: klick or email');
  const tarif = TIERS.includes(body.tarif) ? body.tarif : bad('tarif');
  const sprache = body.sprache === 'de' ? 'de' : 'en';
  const day = new Date(now).toISOString().slice(0, 10);
  const f = path.join(dir, 'interesse', `${day}.json`);
  const c = readJson(f, { klick: {}, email: {}, ohne_einwilligung: 0, sprache: {} });
  if (event === 'klick') {
    c.klick[tarif] = (c.klick[tarif] || 0) + 1;
    c.sprache[sprache] = (c.sprache[sprache] || 0) + 1;
    atomicWrite(f, JSON.stringify(c));
    return { ok: true, stored: 'count' };
  }
  const email = String(body.email || '').trim().toLowerCase();
  if (email.length > 254) bad('email too long');
  const dt = domainType(email);
  if (!dt) bad('email invalid');
  if (body.einwilligung !== true) {
    c.ohne_einwilligung++;
    atomicWrite(f, JSON.stringify(c));
    return { ok: true, stored: 'nothing (no consent)' };
  }
  const list = path.join(dir, 'interesse', 'emails.jsonl');
  let known = false;
  try { known = fs.readFileSync(list, 'utf8').split('\n').some((l) => { try { return JSON.parse(l).email === email; } catch { return false; } }); } catch {}
  if (!known) {
    mkdirp(path.dirname(list));
    fs.appendFileSync(list, JSON.stringify({ t: new Date(now).toISOString(), email, tarif, sprache, domain: dt.domain, firma: dt.company }) + '\n');
  }
  c.email[tarif] = (c.email[tarif] || 0) + (known ? 0 : 1);
  atomicWrite(f, JSON.stringify(c));
  // The same answer either way: nobody learns from it whether an address is on the list.
  return { ok: true, stored: 'email' };
}
