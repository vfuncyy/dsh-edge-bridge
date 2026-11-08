import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';

const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const fixture = pathToFileURL(resolve('tools/fixture/page-fixture.html')).href;
const profile = mkdtempSync(join(tmpdir(), 'edge-dbg2-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
console.log('chosen port', port);

const child = spawn(edgePath, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions',`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'about:blank'], { stdio: ['ignore','pipe','pipe'], windowsHide: true });
child.on('exit', (code, signal) => console.log('child exit', code, signal));
child.stderr.on('data', (d) => { const t = String(d).trim(); if (t) console.log('stderr:', t.slice(0, 300)); });
child.stdout.on('data', (d) => { const t = String(d).trim(); if (t) console.log('stdout:', t.slice(0, 300)); });

let version = null;
for (let i=0;i<100;i++) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); version = await r.json(); if (version.webSocketDebuggerUrl) break; }
  catch (e) { if (i % 20 === 0) console.log('fetch fail', String(e.cause?.code ?? e.message)); }
  await sleep(150);
}
console.log('version', JSON.stringify(version)?.slice(0,200));
child.kill();
