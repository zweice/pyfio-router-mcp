// callSigned: callTool plus the verdict. Every answer of every tool (also errors and unknown tools) gets a
// `urteil` field next to the result. ctx.urteil === false turns it off (tests of the plain tools only).
import { callTool, canonicalName, definition, schemaFor, LIMITS } from '../tools.mjs';
import { loadKeys, ephemeralKeys } from './schluessel.mjs';
import { pruefungen } from './pruefungen.mjs';
import { signiereUrteil, mitUrteil } from './urteil.mjs';

let fallback = null;
function keysFor(ctx) {
  if (ctx.keys) return ctx.keys;
  try { return loadKeys({ dir: ctx.dir }); }
  catch { return (fallback ||= ephemeralKeys()); }   // a key file that cannot be read must not stop the tool; never overwritten, see schluessel.mjs
}

// -> { result (with urteil), isError }
export async function callSigned(name, args, ctx = {}) {
  const now = ctx.now || Date.now;
  const t0 = now();
  const { result, isError } = await callTool(name, args, ctx);
  if (ctx.urteil === false) return { result, isError };
  const ms = now() - t0;
  const canon = canonicalName(name);
  const checks = canon
    ? pruefungen({ tool: canon, schema: schemaFor(name), args, result, ms, limitMs: LIMITS[canon] })
    : [{ name: 'werkzeug_bekannt', ok: false }];
  const urteil = signiereUrteil({ werkzeug: canon || String(name).replace(/[^\w.-]/g, '_').slice(0, 64), definition: canon ? definition(canon) : null, args, result, pruefungen: checks, keys: keysFor(ctx), now });
  return { result: mitUrteil(result, urteil), isError };
}
