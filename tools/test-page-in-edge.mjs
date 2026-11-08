/**
 * Exercise page.js (the injected reader/actor) inside a real Edge page.
 *
 *   node edge-bridge/tools/test-page-in-edge.mjs
 *
 * Serves tools/fixture/ over http, launches a throwaway headless Edge pointed at
 * it (a file:// page cannot resolve root-relative links to http URLs),
 * attaches to that page target over CDP, and checks the rendered Markdown plus
 * click/type/wait behaviour. Exits 0 with SKIP when Edge cannot be started.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readPage, actPage, inspectPage } from '../extension/page.js';

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const edgePath = EDGE_CANDIDATES.find((candidate) => existsSync(candidate));
if (!edgePath) {
  console.log('SKIP: Microsoft Edge was not found');
  process.exit(0);
}

const fixtureDir = resolve(import.meta.dirname, 'fixture');
const profile = mkdtempSync(join(tmpdir(), 'edge-bridge-test-'));
const results = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  <- ${String(detail).slice(0, 400)}`}`);
}

const freePort = () =>
  new Promise((resolvePort) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });

class Cdp {
  constructor(url, sessionId) {
    this.url = url;
    this.sessionId = sessionId;
    this.seq = 0;
    this.pending = new Map();
  }

  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.onopen = () => resolveOpen();
      this.socket.onerror = () => rejectOpen(new Error('cannot reach the page debugging socket'));
      setTimeout(() => rejectOpen(new Error('page debugging socket timed out')), 10000);
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    };
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) rejectSend(new Error(`${method} got no answer within 20s`));
      }, 20000);
    });
  }
}

async function pageTarget(port) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      // Headless Edge can open a blank start page next to the fixture tab.
      const page = pages.find((target) => String(target.url).includes('page-fixture')) ?? pages[0];
      if (page && String(page.url).includes('page-fixture')) return page;
    } catch {
      /* the browser is still starting */
    }
    await sleep(150);
  }
  return null;
}

let edge;
let cdp;
let server;
try {
  // The fixture is served over http so root-relative links and images resolve
  // to absolute http URLs, exactly like a real page.
  const httpPort = await freePort();
  server = createServer((request, response) => {
    const name = decodeURIComponent((request.url || '/').split('?')[0]).replace(/^\/+/, '') || 'page-fixture.html';
    const type = name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.png') ? 'image/png' : 'application/octet-stream';
    try {
      const body = readFileSync(join(fixtureDir, name));
      response.writeHead(200, { 'content-type': type });
      response.end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    }
  });
  await new Promise((done) => server.listen(httpPort, '127.0.0.1', done));
  const fixture = `http://127.0.0.1:${httpPort}/page-fixture.html`;

  const port = await freePort();
  try {
    edge = spawn(
      edgePath,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${port}`,
        fixture,
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    edge.on('error', (error) => console.log('edge spawn error:', String(error)));
  } catch (error) {
    console.log(`SKIP: cannot start Microsoft Edge here (${String((error && error.message) || error)})`);
    process.exit(0);
  }

  const target = await pageTarget(port);
  if (!target) {
    console.log('SKIP: headless Edge did not expose a page target (the sandbox may forbid spawning the browser)');
    process.exit(0);
  }

  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();

  const evaluate = async (expression) => {
    const response = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      allowUnsafeEvalBlockedByCSP: true,
    });
    if (response.exceptionDetails) {
      const text = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text;
      throw new Error(String(text));
    }
    return response.result?.value;
  };

  // Headless Edge lists the target as soon as the tab exists, which can be
  // before the fixture navigation commits: an about:blank document already
  // reports readyState "complete". Wait for the real document instead of the
  // readyState flag alone, otherwise readPage sees an empty page.
  const pageIsLive = async () => {
    try {
      return await evaluate(
        "location.href.indexOf('page-fixture') > -1 && document.readyState === 'complete' && !!document.body && document.body.children.length > 0 && !!document.getElementById('btn')",
      );
    } catch {
      return false;
    }
  };

  let live = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await pageIsLive()) {
      live = true;
      break;
    }
    await sleep(100);
  }
  if (!live) {
    console.log('SKIP: headless Edge opened the debugging target but never committed the fixture page');
    process.exit(0);
  }
  await sleep(100);

  const read = async (options) => evaluate(`(${readPage.toString()})(${JSON.stringify(options)})`);
  const act = async (options) => evaluate(`(${actPage.toString()})(${JSON.stringify(options)})`);

  // ---- markdown read -------------------------------------------------------
  const markdown = await read({ format: 'markdown', includeLinks: true });
  const body = String(markdown.text ?? '');
  check('read succeeds', markdown.ok === true, JSON.stringify(markdown).slice(0, 200));
  check('title captured', markdown.title === 'Fixture Page', markdown.title);
  check('description captured', markdown.description === 'A fixture page for the DSH reader', markdown.description);
  check('heading rendered', body.includes('## Section one'), body.slice(0, 300));
  check('bold rendered', body.includes('**bold**'), body);
  check('italic rendered', body.includes('*italic*'), body);
  check('relative link made absolute', /\[relative link\]\(https?:\/\/127\.0\.0\.1:\d+\/relative\/link\)/.test(body), body);
  check('list rendered', body.includes('- first item'), body);
  check('table rendered', /\| Name \| Qty \|/.test(body) && /\| Widget \| 3 \|/.test(body), body);
  check('code fence rendered', body.includes('```\nconst answer = 42;\n```'), body);
  check('blockquote rendered', body.includes('> Quoted line'), body);
  check('image rendered', /!\[diagram\]\(https?:\/\/[^)]*x\.png\)/.test(body), body);
  check('nav stripped', !body.includes('Navigation should be stripped'), body);
  check('footer stripped', !body.includes('Footer text should be stripped'), body);
  check('script stripped', !body.includes('addEventListener'), body);
  check('data uri images stripped', !body.includes('data:image/png;base64'), body.slice(0, 400));
  check('canvas count reported', typeof markdown.canvasCount === 'number', String(markdown.canvasCount));
  check('subsection present', body.includes('### Subsection'), body);
  check('auto scope chose the article', String(markdown.scope).startsWith('auto:'), markdown.scope);
  check(
    'outline has headings',
    Array.isArray(markdown.outline) && markdown.outline.some((item) => item.level === 2 && item.text === 'Section one'),
    JSON.stringify(markdown.outline),
  );
  check(
    'links collected and absolutized',
    Array.isArray(markdown.links) && markdown.links.some((link) => link.text === 'relative link' && /\.\/relative\/link$|\/relative\/link$/.test(link.href)),
    JSON.stringify(markdown.links),
  );
  check('canonical captured', markdown.canonical === 'https://example.com/canonical', markdown.canonical);
  check('siteName captured', markdown.siteName === 'Fixture Site', markdown.siteName);

  // ---- plain text ----------------------------------------------------------
  const plain = await read({ format: 'text' });
  check('text format drops markdown syntax', plain.ok === true && !String(plain.text).includes('## Section one'), String(plain.text).slice(0, 200));
  check('text format keeps prose', String(plain.text).includes('first item'), String(plain.text).slice(0, 300));

  // ---- truncation ----------------------------------------------------------
  const shortRead = await read({ format: 'markdown', maxChars: 1000 });
  check('fixture is long enough to truncate', String((await read({ format: 'markdown' })).text).length > 1000);
  check('max chars respected', String(shortRead.text).length <= 1200 && shortRead.truncated === true, `${String(shortRead.text).length} / ${shortRead.truncated}`);

  // ---- html + bad scope ----------------------------------------------------
  const html = await read({ format: 'html', scope: 'article' });
  check('html format returns markup', html.ok === true && String(html.text).includes('<h2>Section one</h2>'), String(html.text).slice(0, 200));
  const missing = await read({ scope: '#does-not-exist' });
  check('missing scope reports an error', missing.ok === false && /no element matches/.test(missing.error), JSON.stringify(missing));

  // ---- interactions --------------------------------------------------------
  const click = await act({ action: 'click', text: 'Press me' });
  check('click by text succeeds', click.ok === true && click.detail.tag === 'button', JSON.stringify(click));
  check('click handler ran', (await evaluate("document.getElementById('readout').textContent")) === 'clicked!');

  const typed = await act({ action: 'type', selector: '#field', text: 'hello world' });
  check('type succeeds', typed.ok === true, JSON.stringify(typed));
  check('input event fired', (await evaluate("document.getElementById('readout').textContent")) === 'typed:hello world');

  const waited = await act({ action: 'wait', selector: '#readout' });
  check('wait finds an existing element', waited.ok === true && waited.found === true, JSON.stringify(waited));

  const missingClick = await act({ action: 'click', selector: '#nope' });
  check('missing target reports an error', missingClick.ok === false && /no element matches/.test(missingClick.error), JSON.stringify(missingClick));

  const scroll = await act({ action: 'scroll', amount: 200 });
  check('scroll reports a position', scroll.ok === true && typeof scroll.scrollY === 'number', JSON.stringify(scroll));

  // ---- edge_inspect's injected function -------------------------------
  const inspect = await evaluate(`(${inspectPage.toString()})({})`);
  check('inspect succeeds', inspect.ok === true, JSON.stringify(inspect).slice(0, 300));
  check('inspect reports headings', Array.isArray(inspect.outline) && inspect.outline.some((h) => h.text === 'Section one'), JSON.stringify(inspect.outline ?? []).slice(0, 300));
  check('inspect lists the button', (inspect.interactive ?? []).some((el) => el.tag === 'button' && /Press me|Read more/.test(el.text ?? '')), JSON.stringify(inspect.interactive ?? []).slice(0, 400));
  check('inspect gives a usable selector', (inspect.interactive ?? []).every((el) => typeof el.sel === 'string' && el.sel.length > 0), JSON.stringify((inspect.interactive ?? []).map((el) => el.sel)));
  check('inspect finds the table', (inspect.lists ?? []).some((l) => l.kind === 'table' && l.rows >= 2), JSON.stringify(inspect.lists ?? []).slice(0, 400));
  check('inspect samples table rows', (inspect.lists ?? []).some((l) => (l.sample ?? []).some((row) => (row ?? []).join(' ').includes('Widget'))), JSON.stringify(inspect.lists ?? []).slice(0, 400));
  check('inspect skips invisible nodes', !(inspect.interactive ?? []).some((el) => /hidden/i.test(el.text ?? '')), JSON.stringify(inspect.interactive ?? []).slice(0, 400));
  check('inspect counts canvases', inspect.canvasCount === 0, String(inspect.canvasCount));
  const scoped = await evaluate(`(${inspectPage.toString()})({selector:'#about', maxInteractive: 5})`);
  check('inspect honours a scope', scoped.ok === true && (scoped.interactive ?? []).length <= 5, JSON.stringify(scoped).slice(0, 200));
  const badScope = await evaluate(`(${inspectPage.toString()})({selector:'#nope-nope'})`);
  check('inspect reports a missing scope', badScope.ok === false && /no element matches/.test(badScope.error), JSON.stringify(badScope));

  // ---- refs, expectations and effect_state ------------------------------
  const refs = (inspect.interactive ?? []).map((el) => el.ref);
  check('inspect stamps a ref on every control', refs.length > 0 && refs.every((ref) => typeof ref === 'string' && ref.length > 0), JSON.stringify(refs));
  check('refs are unique', new Set(refs).size === refs.length, JSON.stringify(refs));
  const pressRef = (inspect.interactive ?? []).find((el) => el.text === 'Press me')?.ref;
  const secondPass = await evaluate(`(${inspectPage.toString()})({})`);
  check('a second inspect reuses the same ref', pressRef && secondPass.interactive.find((el) => el.text === 'Press me')?.ref === pressRef, String(pressRef));

  const byRefClick = await act({ action: 'click', ref: pressRef });
  check('click by ref succeeds', byRefClick.ok === true && byRefClick.detail.ref === pressRef, JSON.stringify(byRefClick));
  // The handler only rewrites another node's text, so this is the case that caught
  // fingerprint() ignoring body text: element counts do not move, the page still changed.
  check('click by ref reports a committed effect', byRefClick.effect?.state === 'committed', JSON.stringify(byRefClick.effect));
  check('click by ref ran the handler', (await evaluate("document.getElementById('readout').textContent")) === 'clicked!');

  const blocked = await act({ action: 'click', ref: pressRef, expect: { text: 'Delete forever' } });
  check('a failing expectation blocks the action', blocked.ok === false && String(blocked.error).includes('expectation failed'), JSON.stringify(blocked));
  check('a blocked action reports effect none', blocked.effect?.state === 'none', JSON.stringify(blocked.effect));
  check('a blocked action touches nothing', (await evaluate("document.getElementById('readout').textContent")) === 'clicked!');

  const expectType = await act({ action: 'type', selector: '#field', text: 'second', expect: { value: 'hello world' } });
  check('a matching expectation lets the action run', expectType.ok === true, JSON.stringify(expectType));
  check('typing a field commits', expectType.effect?.state === 'committed', JSON.stringify(expectType.effect));

  const attributeBlocked = await act({ action: 'click', ref: pressRef, expect: { attribute: { name: 'id', value: 'not-the-button' } } });
  check('an attribute expectation is enforced', attributeBlocked.ok === false && String(attributeBlocked.error).includes('@id'), JSON.stringify(attributeBlocked));

  const missingRef = await act({ action: 'click', ref: 'e999' });
  check('an unknown ref explains where refs come from', missingRef.ok === false && String(missingRef.error).includes('edge_inspect'), JSON.stringify(missingRef));
} catch (error) {
  check('suite ran to completion', false, String((error && error.stack) || error));
} finally {
  try {
    cdp?.socket?.close();
  } catch {
    /* ignore */
  }
  edge?.kill();
  try {
    server?.closeAllConnections?.();
    server?.close();
  } catch {
    /* ignore */
  }
  await sleep(400);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* the browser may still hold a file */
  }
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);