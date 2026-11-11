// Probe : does the stdio server exit cleanly after a weather call (real network)?
//   node scripts/probe-exit.mjs   -> exit code and stderr of the server
import { stdioClient, initialize } from '../test/helpers.mjs';

const c = stdioClient({ PYFIO_STATE_DIR: process.env.PYFIO_STATE_DIR || '' });
let err = '';
c.child.stderr.on('data', (d) => { err += d; });
await initialize(c);
const r = await c.request('tools/call', { name: 'weather', arguments: { place: 'Hamburg', days: 1 } }, 30000);
console.log('call ok:', JSON.parse(r.result.content[0].text).ok);
const code = await new Promise((res) => { c.child.once('close', (k) => res(k)); c.child.stdin.end(); setTimeout(() => res('timeout'), 8000); });
console.log('exit code:', code, 'stderr:', JSON.stringify(err.slice(0, 300)));
await c.close();
