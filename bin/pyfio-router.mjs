#!/usr/bin/env node
// Pyfio Router (MCP server).
//   pyfio-router                       stdio (local, BYOK): what an MCP client starts
//   pyfio-router --http [--port 8787] [--host 127.0.0.1]   hosted mode (Streamable HTTP on /mcp)
//   pyfio-router status                which readers run here, state folder, telemetry
//   pyfio-router whoami [--ip <addr>]  this install's pseudonym, or the hosted one of an address (to exclude own calls)
//   pyfio-router call <tool> '<json>'  one tool call without a client (for trying it out); the answer carries the verdict
//   pyfio-router pruefen <file|->      verify the verdict (urteil) of an answer, from a file or stdin; --schluessel-id <id> pins the signer; exit 0 = holds
//   pyfio-router schluessel            the public key and key id that sign the verdicts of this install
import fs from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../src/server.mjs';
import { createHttpServer } from '../src/http.mjs';
import { createCounter, installPseudonym, requestPseudonym } from '../src/zaehler.mjs';
import { callSigned } from '../src/urteil/signiert.mjs';
import { loadKeys, publicInfo } from '../src/urteil/schluessel.mjs';
import { verifyUrteil } from '../src/urteil/urteil.mjs';
import { keys as searchKeys } from '../src/suche/suche.mjs';
import { readerStatus, flushMemory } from '../src/lesen/seite-lesen.mjs';
import { stateDir, telemetryWanted, telemetryUrl, VERSION, lang, keys } from '../src/config.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); if (i >= 0 && argv[i + 1]) return argv[i + 1]; const e = argv.find((a) => a.startsWith(`--${k}=`)); return e ? e.slice(k.length + 3) : d; };
const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');

if (argv[0] === 'status') {
  out({ name: 'pyfio-router', version: VERSION, lang: lang(), state: stateDir(), readers: await readerStatus('stdio'), keys: { jina: !!keys().jina, openMeteo: !!keys().openMeteo, serper: !!searchKeys().serper, exa: !!searchKeys().exa }, urteil: { schluessel_id: publicInfo(loadKeys()).schluessel_id }, telemetry: { wanted: telemetryWanted(), endpoint: telemetryUrl() || null } });
  process.exit(0);
} else if (argv[0] === 'whoami') {
  // --ip <address>: the pseudonym the hosted router of this state folder gives that address (own calls out of the evaluation)
  const ip = opt('ip');
  out(ip ? { operator: requestPseudonym({ ip }), via: 'hosted', state: stateDir() } : { operator: installPseudonym(), via: 'local', state: stateDir() });
  process.exit(0);
} else if (argv[0] === 'schluessel') {
  out(publicInfo(loadKeys()));
  process.exit(0);
} else if (argv[0] === 'pruefen') {
  const src = argv[1];
  if (!src) { out({ ok: false, grund: 'usage: pyfio-router pruefen <file|-> [--schluessel-id <id>]' }); process.exit(2); }
  let text;
  try { text = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8'); } catch (e) { out({ ok: false, grund: `cannot read ${src === '-' ? 'stdin' : 'the file'}` }); process.exit(2); }
  const r = verifyUrteil(text, { erwarteteSchluesselId: opt('schluessel-id') });
  out(r);
  process.exitCode = r.ok ? 0 : 1;
} else if (argv[0] === 'call') {
  let args = {};
  try { args = JSON.parse(argv[2] || '{}'); } catch { out({ ok: false, error: 'arguments: JSON expected' }); process.exit(2); }
  const counter = createCounter({ mode: 'stdio' });
  const { result, isError } = await callSigned(argv[1], args, { mode: 'stdio', counter, operator: installPseudonym(), client: 'pyfio-router-cli' });
  counter.flush();
  flushMemory();
  out(result);
  process.exitCode = isError ? 1 : 0;   // no process.exit after fetch: libuv asserts on Windows (Node 24, measured)
} else if (argv.includes('--http')) {
  const port = Number(opt('port', process.env.PORT || 8787));
  const host = opt('host', '127.0.0.1');
  const server = createHttpServer();
  server.listen(port, host, () => process.stderr.write(`pyfio-router ${VERSION} http://${host}:${port}/mcp (state ${stateDir()})\n`));
  const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  const counter = createCounter({ mode: 'stdio' });
  const server = createServer({ mode: 'stdio', counter, operator: installPseudonym() });
  await server.connect(new StdioServerTransport());
  const bye = () => { counter.flush(); flushMemory(); process.exit(0); };
  process.stdin.on('close', bye);
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  // A parent that died without closing the pipe must not leave us running.
  const parent = process.ppid;
  setInterval(() => { try { process.kill(parent, 0); } catch (e) { if (e.code !== 'EPERM') bye(); } }, 15000).unref();
}
