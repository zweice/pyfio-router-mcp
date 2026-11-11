// Readability's article as Markdown. One function for both places it runs:
// - in the browser (page.evaluate(extract)): no argument, the page's globals document, Readability, DOMParser;
// - in Node on fetched HTML (readabilityHtml below): linkedom's document and Mozilla Readability.
// It must stay self-contained (page.evaluate serialises the function source: no closures, no imports).
//
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';

export function extract(env) {
  const doc = (env && env.document) || document;
  const R = (env && env.Readability) || Readability;
  const DP = (env && env.DOMParser) || DOMParser;
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|IFRAME|OBJECT|EMBED|BUTTON|INPUT|SELECT|TEXTAREA|IMG|PICTURE|VIDEO|AUDIO|SOURCE|MATH|FORM|HEAD)$/;
  const INLINE = /^(A|ABBR|B|BDI|BDO|BIG|CITE|CODE|DATA|DFN|EM|FONT|I|INS|DEL|KBD|LABEL|MARK|NOBR|Q|S|SAMP|SMALL|SPAN|STRONG|SUB|SUP|TIME|TT|U|VAR|WBR)$/;
  const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const tag = (n) => String(n.tagName || '').toUpperCase();
  const inl = (n) => {
    if (n.nodeType === 3) return n.nodeValue;
    if (n.nodeType !== 1 || SKIP.test(tag(n))) return '';
    if (tag(n) === 'BR') return '\n';
    const s = [...n.childNodes].map(inl).join('');
    return INLINE.test(tag(n)) ? s : `\n${s}\n`;
  };
  const lines = (s) => s.split('\n').map(squash).filter(Boolean);
  function list(el, level) {
    const pad = '  '.repeat(level), out = [];
    let i = 0;
    for (const li of el.children) {
      if (tag(li) !== 'LI') continue;
      const mark = tag(el) === 'OL' ? `${++i}. ` : '- ';
      const own = [], sub = [];
      for (const c of li.childNodes) (c.nodeType === 1 && (tag(c) === 'UL' || tag(c) === 'OL') ? sub : own).push(c);
      const t = lines(own.map(inl).join(''));
      if (t.length) out.push(t.map((l, k) => (k ? `${pad}  ` : pad + mark) + l).join('\n'));
      for (const s of sub) { const x = list(s, level + 1); if (x) out.push(x); }
    }
    return out.join('\n');
  }
  function blocks(n) {
    const out = [];
    let run = '';
    const end = () => { const t = lines(run); if (t.length) out.push(t.join('\n')); run = ''; };
    for (const c of n.childNodes) {
      if (c.nodeType === 3 || (c.nodeType === 1 && (INLINE.test(tag(c)) || tag(c) === 'BR'))) { run += inl(c); continue; }
      if (c.nodeType !== 1 || SKIP.test(tag(c))) continue;
      end();
      const t = tag(c);
      if (/^H[1-6]$/.test(t)) { const h = squash(inl(c)); if (h) out.push(`${'#'.repeat(Number(t[1]))} ${h}`); }
      else if (t === 'PRE') { const x = String(c.textContent || '').replace(/\s+$/, ''); if (x.trim()) out.push('```\n' + x + '\n```'); }
      else if (t === 'UL' || t === 'OL') { const x = list(c, 0); if (x) out.push(x); }
      else if (t === 'BLOCKQUOTE') { const q = blocks(c).join('\n\n'); if (q) out.push(q.split('\n').map((l) => `> ${l}`).join('\n')); }
      else if (t === 'TABLE') {
        // rows of this table only: a table nested in a cell would otherwise come out twice (measured on 3 of 246 pages)
        const rows = [...c.querySelectorAll('tr')].filter((tr) => tr.closest('table') === c).map((tr) => [...tr.children].map((td) => squash(inl(td)))).filter((r) => r.some(Boolean));
        if (rows.length) out.push(rows.map((r) => `| ${r.join(' | ')} |`).join('\n'));
      } else if (t !== 'HR') out.push(...blocks(c));
    }
    end();
    return out;
  }
  let art = null;
  try { art = new R(doc.cloneNode(true)).parse(); } catch (e) { art = null; }
  let md = '';
  if (art && art.content) {
    try { md = blocks(new DP().parseFromString(`<!doctype html><html><body>${art.content}</body></html>`, 'text/html').body).join('\n\n'); } catch (e) { md = ''; }
  }
  const titel = squash((art && art.title) || doc.title || '');
  // Readability found no article: the visible text of the page (the cascade takes it only when nothing else came).
  if (squash(md).length < 80) {
    const b = doc.body;
    const raw = b ? (typeof b.innerText === 'string' && b.innerText ? b.innerText : b.textContent || '') : '';
    return { titel, text: String(raw).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), quelle: 'seitentext' };
  }
  return { titel, text: md, quelle: 'readability' };
}

// Readability on HTML fetched over plain HTTP, without a browser (no JavaScript runs, nothing loads):
// the stage-1 reader when no Python with Trafilatura is there. -> { titel, text, quelle }.
export function readabilityHtml(html, url) {
  // linkedom has no base URL; Readability uses it only for relative links, which the Markdown drops.
  const { document, DOMParser } = parseHTML(String(html || ''));
  for (const s of document.querySelectorAll('script,style,noscript,template')) s.remove();
  try { if (url && !document.querySelector('base')) { const b = document.createElement('base'); b.setAttribute('href', url); document.head?.appendChild(b); } } catch {}
  return extract({ document, Readability, DOMParser });
}
