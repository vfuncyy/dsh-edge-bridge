import { spawn } from 'node:child_process';
for (const [label, cmd, args] of [
  ['cmd echo', 'cmd.exe', ['/c', 'echo hello']],
  ['edge --version', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--version']],
  ['edge headless dom', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new','--disable-gpu','--dump-dom','about:blank']],
]) {
  try {
    const child = spawn(cmd, args, { stdio: ['ignore','pipe','pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const code = await new Promise((res) => { child.on('error', (e) => res('ERR ' + e.code)); child.on('exit', (c) => res(c)); });
    console.log(label, '->', code, String(out).replace(/\s+/g,' ').slice(0,120));
  } catch (e) { console.log(label, '-> throw', e.code); }
}
