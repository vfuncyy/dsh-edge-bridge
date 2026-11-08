const url = process.argv[2] ?? 'ws://127.0.0.1:17333/edge-bridge';
const token = process.argv[3] ?? 'deadbeef';
await new Promise((done) => {
  let settled = false;
  const finish = (label, extra) => { if (!settled) { settled = true; console.log(label, extra ?? ''); done(); } };
  let ws;
  try { ws = new WebSocket(url); } catch (e) { finish('constructor-failed', String(e)); return; }
  const timer = setTimeout(() => finish('timeout-no-answer'), 6000);
  ws.addEventListener('open', () => { console.log('socket open'); ws.send(JSON.stringify({ t:'hello', token, extension:{name:'probe',version:'0'}, protocol:1 })); });
  ws.addEventListener('message', (e) => { clearTimeout(timer); finish('reply', String(e.data).slice(0,300)); setTimeout(()=>{try{ws.close();}catch{}},50); });
  ws.addEventListener('close', (e) => { clearTimeout(timer); finish('closed', `code=${e.code} reason=${e.reason}`); });
  ws.addEventListener('error', () => { clearTimeout(timer); finish('error-event'); });
  setTimeout(() => { clearTimeout(timer); finish('no-reply-within-6s'); }, 6000);
});
