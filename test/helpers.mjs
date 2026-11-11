// Test helpers: a temporary state folder, a local HTTP server, a stdio MCP client over a child process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { killTree } from '../src/proc.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function tmpState(tag = 't') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `pyfio-router-${tag}-`));
  process.env.PYFIO_STATE_DIR = d;
  return d;
}

// routes: { '/path': (req, res) => ... } -> { port, url(p), close() }
export async function localServer(routes) {
  const server = http.createServer((req, res) => {
    const h = routes[new URL(req.url, 'http://x').pathname];
    if (!h) { res.writeHead(404); return res.end('nope'); }
    h(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { port, url: (p) => `http://127.0.0.1:${port}${p}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

export const html = (body, title = 'Test') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
export const words = (n, w = 'Heide') => Array.from({ length: n }, (_, i) => `${w}${i % 7 === 0 ? '.' : ''}`).join(' ');
// Distinct paragraphs of varied words (Trafilatura drops repeated paragraphs as boilerplate).
const VOCAB = 'Heide Dresden Wetter Bahn Markt Stadt Fluss Wald Schule Rathaus Sommer Herbst Winter Bruecke Turm Feld Weg Haus Garten Kirche'.split(' ');
const sentence = (p, k) => Array.from({ length: 10 }, (_, i) => VOCAB[(p * 7 + k * 3 + i * 5) % VOCAB.length].toLowerCase() + (i === 0 ? `${p}x${k}` : '')).join(' ') + '.';
export const article = (n = 400) => `<nav><a href="/">Start</a> <a href="/a">Menue</a></nav><article><h1>Ueberschrift</h1>${Array.from({ length: Math.ceil(n / 40) }, (_, p) => `<p>${Array.from({ length: 4 }, (_, k) => sentence(p, k)).join(' ')}</p>`).join('')}</article><footer>Impressum</footer>`;

// A stdio MCP client: starts the server, sends JSON-RPC lines, reads answers by id.
export function stdioClient(env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'pyfio-router.mjs')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buf = '', nextId = 1;
  const waiting = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); w(m); }
    }
  });
  const request = (method, params, timeoutMs = 90000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => { waiting.delete(id); reject(new Error(`timeout ${method}`)); }, timeoutMs);
    waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const close = async () => { try { child.stdin.end(); } catch {} await new Promise((r) => { const t = setTimeout(r, 3000); child.once('close', () => { clearTimeout(t); r(); }); }); await killTree(child); };
  return { child, request, notify, close };
}

export async function initialize(c, name = 'test-client') {
  const r = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1.0' } });
  c.notify('notifications/initialized', {});
  return r;
}
