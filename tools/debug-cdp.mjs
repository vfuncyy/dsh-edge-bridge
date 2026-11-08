import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const fixture = pathToFileURL(resolve('tools/fixture/page-fixture.html')).href;
const profile = mkdtempSync(join(tmpdir(), 'edge-dbg-'));
const port = 9911;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const edge = spawn(edgePath, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions',`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'about:blank'], { stdio:'ignore', windowsHide:true });

let version = null;
for (let i=0;i<80;i++){ try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); version = await r.json(); if (version.webSocketDebuggerUrl) break; } catch {} await sleep(150); }
console.log('endpoint', version?.webSocketDebuggerUrl);
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res,rej)=>{ ws.onopen=()=>res(); ws.onerror=()=>rej(new Error('open failed')); });
console.log('ws open');
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); console.log('<<', JSON.stringify(m).slice(0,300)); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
const send = (method, params={}, sessionId) => { const id = ++seq; return new Promise((resolve, reject)=>{ pending.set(id,{resolve,reject}); ws.send(JSON.stringify({id,method,params,sessionId})); setTimeout(()=>{ if(pending.has(id)){pending.delete(id); reject(new Error('timeout '+method));} }, 5000); }); };
const created = await send('Target.createTarget', { url: fixture });
console.log('created', created);
const attached = await send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
console.log('attached', attached);
const evalRes = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, attached.sessionId);
console.log('evalRes', JSON.stringify(evalRes));
ws.close(); edge.kill();
