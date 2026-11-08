/**
 * End-to-end test of the plugin (index.js → tools) with a fake Edge extension.
 *
 *   node edge-bridge/tools/test-plugin.mjs
 *
 * Builds a throwaway http server, mounts the plugin exactly the way the Host
 * does (ctx.webServer.registerUpgrade + ctx.tools.register), connects a fake
 * extension over a real websocket, and calls every edge_* tool.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../plugin/index.js';

const results = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const check = (name, condition, detail) => {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  <- ${String(detail).slice(0, 400)}`}`);
};

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const home = mkdtempSync(join(tmpdir(), 'edge-bridge-home-'));
process.env.DSH_HOME = home;
const captureDir = join(home, 'edge页面抓取');
// A throwaway knowledge base: captured pages must never touch the real one.
const kbRoot = join(home, 'kb');
mkdirSync(join(kbRoot, '补充'), { recursive: true });
writeFileSync(join(kbRoot, '补充', '条目.json'), `${JSON.stringify({ version: 1, note: 'test', items: [] }, null, 2)}\n`, 'utf8');
writeFileSync(join(kbRoot, 'kb.py'), '# fake\n', 'utf8');

/** Every edge_* tool registers here. */
const tools = new Map();

/** Records the capture workspace registration. */
const registry = {
  created: [],
  async list() {
    return [];
  },
  async create(dir, title) {
    this.created.push({ dir, title });
    return { id: 'ws-capture', path: dir, title };
  },
};

const ctx = {
  tools: {
    register(definition) {
      if (!definition || typeof definition.name !== 'string') throw new Error('bad tool definition');
      if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
  },
  get(service) {
    if (service === 'workingDirectory') {
      return { ensure: async () => join(home, 'workspace'), defaultDirectory: join(home, 'workspace') };
    }
    if (service === 'workspaceRegistry') return registry;
    return undefined;
  },
  effect(callback) {
    callback();
  },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
};

/** A port the plugin can bind: the test never guesses 17333. */
const port = await new Promise((resolvePort) => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port: free } = probe.address();
    probe.close(() => resolvePort(free));
  });
});

let dispose = null;
let socket = null;
let extensionCalls = 0;

try {
  apply(ctx, { port, captureDir, captureTitle: 'edge页面抓取', kbRoot });
  await sleep(200);

  const ping = await fetch(`http://127.0.0.1:${port}/edge-bridge/ping`).then((response) => response.json());
  check('listener answers the discovery ping', ping.ok === true && ping.name === 'dsh-edge-bridge' && ping.port === port, JSON.stringify(ping));

  check('capture workspace exists before the first button press', existsSync(join(captureDir, 'index.md')), captureDir);
  check('capture workspace is registered with DSH', registry.created.length === 1 && registry.created[0].title === 'edge页面抓取', JSON.stringify(registry.created));

  const tokenPath = join(home, 'edge-bridge-token');
  check('pairing token file written', existsSync(tokenPath), tokenPath);
  const token = readFileSync(tokenPath, 'utf8').trim();
  check('pairing token is url-safe base64', /^[A-Za-z0-9_-]{20,128}$/.test(token), token);

  // ---- lazy activation ---------------------------------------------------
  check('only the control tool is registered at load', tools.size === 1 && tools.has('edge_bridge'), [...tools.keys()].join(','));
  const control = tools.get('edge_bridge');
  const idleStatus = await control.execute({ action: 'status' }, {});
  check('status says the browser tools are off', /OFF/.test(idleStatus.text), idleStatus.text);
  check(
    'status still prints endpoint + token',
    idleStatus.text.includes(`127.0.0.1:${port}/edge-bridge`) && idleStatus.text.includes(token),
    idleStatus.text,
  );

  const started = await control.execute({ action: 'start' }, {});
  check('start registers the browser tools', tools.size === 8, [...tools.keys()].join(','));
  check('start explains the next step', /next model step/.test(started.text) && started.active === true, started.text);
  const repeated = await control.execute({ action: 'start' }, {});
  check('start twice is harmless', tools.size === 8 && /already ON/.test(repeated.text), repeated.text);
  check(
    'expected tool names',
    ['edge_status', 'edge_tabs', 'edge_read', 'edge_inspect', 'edge_eval', 'edge_act', 'edge_screenshot'].every((name) => tools.has(name)),
    [...tools.keys()].join(','),
  );
  check('tools carry a json-schema root object', [...tools.values()].every((tool) => tool.parameters && tool.parameters.type === 'object'));
  check('tools carry an output schema + render', [...tools.values()].every((tool) => tool.output?.schema && typeof tool.output.render === 'function'));

  // ---- disconnected behaviour -------------------------------------------
  const offline = await tools
    .get('edge_tabs')
    .execute({ action: 'list' }, {})
    .then(() => 'resolved')
    .catch((error) => String(error.message ?? error));
  check('disconnected edge_tabs explains how to connect', /not connected/i.test(offline) && /extension/i.test(offline), offline);

  const offlineRead = await tools
    .get('edge_read')
    .execute({}, {})
    .then(() => 'resolved')
    .catch((error) => String(error.message ?? error));
  check('edge_read rejects while offline', /not connected/i.test(offlineRead), offlineRead);

  const statusOffline = await tools.get('edge_status').execute({}, {});
  check('edge_status prints the ws endpoint', statusOffline.text.includes(`127.0.0.1:${port}/edge-bridge`), statusOffline.text);
  check('edge_status reports the token', statusOffline.text.includes(token), statusOffline.text);
  check('edge_status says NOT CONNECTED', /NOT CONNECTED/.test(statusOffline.text), statusOffline.text);

  // ---- connect a fake extension -----------------------------------------
  socket = new WebSocket(`ws://127.0.0.1:${port}/edge-bridge`);
  const inbox = [];
  const hello = new Promise((done, fail) => {
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          t: 'hello',
          token,
          extension: { name: 'fake-edge-bridge', version: '9.9.9' },
          browser: { name: 'Microsoft Edge', version: '156.0.0.0' },
          protocol: 1,
          caps: [
            'tabs.list',
            'tabs.open',
            'tabs.navigate',
            'tabs.activate',
            'tabs.close',
            'tabs.reload',
            'page.read',
            'page.eval',
            'page.inspect',
            'page.act',
            'page.screenshot',
          ],
        }),
      );
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      inbox.push(message);
      if (message.t === 'hello') done(message);
    });
    socket.addEventListener('error', () => fail(new Error('fake extension could not connect')));
    setTimeout(() => fail(new Error('hello timed out')), 5000);
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.t !== 'req') return;
    extensionCalls += 1;
    const { id, method, params } = message;
    const reply = (value) => socket.send(JSON.stringify({ t: 'res', id, ok: true, value }));
    const failWith = (error) => socket.send(JSON.stringify({ t: 'res', id, ok: false, error }));
    switch (method) {
      case 'tabs.list':
        return reply({
          tabs: [
            { id: 11, windowId: 1, index: 0, active: true, pinned: false, discarded: false, status: 'complete', title: 'Example Domain', url: 'https://example.com/' },
            { id: 12, windowId: 1, index: 1, active: false, pinned: true, discarded: false, status: 'loading', title: 'Docs', url: 'https://example.com/docs' },
          ],
          activeTabId: 11,
          focusedWindowId: 1,
        });
      case 'tabs.open':
        return reply({ tab: { id: 13, windowId: 1, index: 2, active: true, status: 'complete', title: 'Opened', url: params.url } });
      case 'tabs.navigate':
        return reply({ tab: { id: params.tabId, title: 'Navigated', url: params.url } });
      case 'tabs.activate':
        return reply({ tab: { id: params.tabId, title: 'Focused', url: 'https://example.com/docs' } });
      case 'tabs.close':
        return reply({ closed: true });
      case 'tabs.reload':
        return reply({ tab: { id: params.tabId, title: 'Reloaded', url: 'https://example.com/' } });
      case 'page.read':
        return reply({
          tabId: params.tabId ?? 11,
          url: 'https://example.com/',
          title: 'Example Domain',
          description: 'An example page',
          format: params.format,
          text: `# Example Domain\n\n${'Body text. '.repeat(30)}`,
          truncated: false,
          outline: [{ level: 1, text: 'Example Domain' }],
          links: [{ text: 'More information', href: 'https://www.iana.org/domains/example' }],
        });
      case 'page.eval':
        return reply({
          tabId: 11,
          value: { answer: 42 },
          type: 'object',
          waited: params.waitForSelector ? { selector: params.waitForSelector, found: true } : null,
        });
      case 'page.inspect':
        if (params.selector === '#crowded') {
          return reply({
            ok: true,
            tabId: 11,
            url: 'https://example.com/',
            title: 'Example Domain',
            readyState: 'complete',
            canvasCount: 0,
            iframeCount: 0,
            scrollHeight: 4000,
            outline: [],
            interactive: [],
            matchedInteractive: 42,
            hiddenInteractive: 42,
            lists: [],
          });
        }
        return reply({
          ok: true,
          tabId: 11,
          url: 'https://example.com/',
          title: 'Example Domain',
          readyState: 'complete',
          canvasCount: 0,
          iframeCount: 0,
          scrollHeight: 1200,
          outline: [{ level: 1, text: 'Example Domain' }],
          interactive: [{ ref: 'e1', tag: 'button', role: 'button', sel: '#go', text: 'Go to the docs', y: 120 }],
          matchedInteractive: 1,
          hiddenInteractive: 0,
          lists: [{ kind: 'table', sel: '#results', rows: 3, cols: 2, sample: [['Title', 'Year']] }],
          waited: params.waitForSelector ? { selector: params.waitForSelector, found: true } : null,
        });
      case 'page.act':
        return reply({
          tabId: 11,
          found: true,
          detail: { ref: params.ref ?? null, selector: params.selector ?? null, text: params.text ?? null, tag: 'button', expect: params.expect ?? null },
          effect: { state: params.ref === 'e404' ? 'none' : 'committed', reason: params.ref === 'e404' ? 'the expectation failed before the click' : 'the page changed immediately' },
        });
      case 'page.screenshot':
        return reply({ base64: TINY_PNG_BASE64, format: params.format ?? 'png', width: 1, height: 1 });
      default:
        return failWith(`unknown method ${method}`);
    }
  });

  const greeting = await hello;
  check('handshake accepted', greeting.ok === true, JSON.stringify(greeting));
  check('handshake advertises capabilities', Array.isArray(greeting.caps) && greeting.caps.includes('page.read'), JSON.stringify(greeting.caps));
  check('handshake names the server', greeting.server?.name === 'dsh-edge-bridge', JSON.stringify(greeting.server));

  // ---- capture events from the popup buttons ------------------------------
  check('start points at the capture workspace', /Capture summaries: .*edge页面抓取/.test(started.text), started.text);
  check('start points at the knowledge base', started.text.includes(join(kbRoot, '补充', '原文', '页面抓取')), started.text);
  const captureResult = new Promise((done, fail) => {
    const started_at = Date.now();
    const timer = setInterval(() => {
      const hit = inbox.find((message) => message.t === 'event' && message.name === 'capture.result');
      if (hit) {
        clearInterval(timer);
        done(hit);
      } else if (Date.now() - started_at > 5000) {
        clearInterval(timer);
        fail(new Error('capture.result never arrived'));
      }
    }, 50);
  });
  socket.send(JSON.stringify({ t: 'event', name: 'capture.page', data: { tabId: 11, url: 'https://example.com/', source: 'start' } }));
  const captured = await captureResult.catch((error) => ({ error }));
  check('capture.page is answered with capture.result', captured?.data?.ok === true, JSON.stringify(captured));
  check('capture.result names the kb snapshot', /^页面抓取\/\d{4}-\d{2}-\d{2}_\d{6}-Example-Domain\.html$/.test(String(captured?.data?.file)), JSON.stringify(captured?.data));
  check('capture.result names the kb entry', /^sup\d+$/.test(String(captured?.data?.kbId)), JSON.stringify(captured?.data));
  check('the snapshot really exists in the knowledge base', existsSync(join(kbRoot, '补充', '原文', String(captured?.data?.file ?? 'missing'))), String(captured?.data?.file));
  const kbDoc = JSON.parse(readFileSync(join(kbRoot, '补充', '条目.json'), 'utf8'));
  check('the page became a webpage entry', kbDoc.items.length === 1 && kbDoc.items[0].type === 'webpage' && kbDoc.items[0].collections.includes('页面抓取'), JSON.stringify(kbDoc.items));
  check('the browsable 清单 exists', existsSync(join(kbRoot, '页面抓取', '清单.md')));
  const indexed = JSON.parse(readFileSync(join(captureDir, 'index.json'), 'utf8'));
  check('the job summary is indexed', indexed.length === 1 && indexed[0].kind === 'start' && indexed[0].saved === 1, JSON.stringify(indexed));

  socket.send(JSON.stringify({ t: 'event', name: 'capture.batch', data: { tabIds: [11, 12], source: 'batch' } }));
  const batchResult = await new Promise((done, fail) => {
    const started_at = Date.now();
    const timer = setInterval(() => {
      const hit = inbox.find((message) => message.t === 'event' && message.name === 'capture.batch.result');
      if (hit) {
        clearInterval(timer);
        done(hit);
      } else if (Date.now() - started_at > 8000) {
        clearInterval(timer);
        fail(new Error('capture.batch.result never arrived'));
      }
    }, 50);
  }).catch((error) => ({ error }));
  check('capture.batch is answered with counts', batchResult?.data?.ok === true && batchResult.data.saved === 2, JSON.stringify(batchResult));
  check('a batch capture lands in the index too', JSON.parse(readFileSync(join(captureDir, 'index.json'), 'utf8')).length === 2);
  check('the batch became more kb entries', JSON.parse(readFileSync(join(kbRoot, '补充', '条目.json'), 'utf8')).items.length === 3);

  const status = await tools.get('edge_status').execute({ include_tabs: true }, {});
  check('edge_status sees the extension', status.connected === true && /Attached extensions: 1/.test(status.text), status.text);
  check('edge_status renders the tab list', /Example Domain/.test(status.text) && /tab 11/.test(status.text), status.text);
  check('edge_status shows the reported capabilities', /caps:\s+11 method\(s\)/.test(status.text) && !/missing/.test(status.text), status.text);

  const list = await tools.get('edge_tabs').execute({ action: 'list' }, {});
  check('edge_tabs renders windows', /1 tab\(s\)|2 tab\(s\)/.test(list.text) && /Window 1 \(focused\)/.test(list.text), list.text);
  check('edge_tabs marks the active tab', /tab 11 \[active\]/.test(list.text), list.text);
  check('edge_tabs marks pinned + loading', /tab 12 \[pinned, loading\]/.test(list.text), list.text);

  const opened = await tools.get('edge_tabs').execute({ action: 'open', url: 'https://example.com/new' }, {});
  check('edge_tabs open reports the new tab', /Opened tab 13/.test(opened.text), opened.text);
  const navigated = await tools.get('edge_tabs').execute({ action: 'navigate', tab_id: 11, url: 'https://example.com/docs' }, {});
  check('edge_tabs navigate reports the tab', /Tab 11 navigated/.test(navigated.text), navigated.text);
  const activated = await tools.get('edge_tabs').execute({ action: 'activate', tab_id: 12 }, {});
  check('edge_tabs activate reports the tab', /Focused tab 12/.test(activated.text), activated.text);
  const closed = await tools.get('edge_tabs').execute({ action: 'close', tab_id: 12 }, {});
  check('edge_tabs close reports the tab', /Closed tab 12/.test(closed.text), closed.text);
  const reloaded = await tools.get('edge_tabs').execute({ action: 'reload', tab_id: 11 }, {});
  check('edge_tabs reload reports the tab', /Reloaded tab 11/.test(reloaded.text), reloaded.text);

  const missingUrl = await tools
    .get('edge_tabs')
    .execute({ action: 'open' }, {})
    .then(() => 'resolved')
    .catch((error) => String(error.message ?? error));
  check('edge_tabs open without url is refused', /requires "url"/.test(missingUrl), missingUrl);

  const read = await tools.get('edge_read').execute({ tab_id: 11, include_links: true }, {});
  check('edge_read renders the header', /Microsoft Edge tab 11 — "Example Domain"/.test(read.text), read.text.slice(0, 300));
  check('edge_read renders the body separator', read.text.includes('\n---\n'), read.text.slice(0, 300));
  check('edge_read renders the outline', /Outline:/.test(read.text) && /- Example Domain/.test(read.text), read.text.slice(0, 400));
  check('edge_read renders links', /Links \(1\):/.test(read.text) && /iana\.org/.test(read.text), read.text.slice(-400));
  check('edge_read reports the description', /Description: An example page/.test(read.text), read.text.slice(0, 300));

  const evaluated = await tools.get('edge_eval').execute({ code: '({answer: 42})' }, {});
  check('edge_eval pretty-prints json', /"answer": 42/.test(evaluated.text), evaluated.text);
  check('edge_eval names the value type', /object/.test(evaluated.text.split('\n')[0]), evaluated.text.split('\n')[0]);
  const waitedEval = await tools.get('edge_eval').execute({ code: '1', wait_for_selector: '#gridTable' }, {});
  check('edge_eval forwards wait_for_selector', /after waiting for #gridTable/.test(waitedEval.text), waitedEval.text);

  const inspected = await tools.get('edge_inspect').execute({ tab_id: 11 }, {});
  check('edge_inspect renders the outline', /Example Domain/.test(inspected.text), inspected.text);
  check('edge_inspect lists a selector', /#go/.test(inspected.text), inspected.text);
  check('edge_inspect lists a ref before the selector', /\be1 #go\b/.test(inspected.text), inspected.text);
  check('edge_inspect explains how to use a ref', /Pass a ref/.test(inspected.text), inspected.text);
  check('edge_inspect reports the table', /#results — 3 row\(s\) × 2/.test(inspected.text), inspected.text);
  check('edge_inspect samples rows', /\| Title \| Year \|/.test(inspected.text), inspected.text);

  const crowded = await tools.get('edge_inspect').execute({ tab_id: 11, selector: '#crowded' }, {});
  check('edge_inspect reports hidden controls', /42 interactive elements hidden by filter/.test(crowded.text), crowded.text);

  const acted = await tools.get('edge_act').execute({ action: 'click', ref: 'e1' }, {});
  check('edge_act reports the ref it used', /clicked ref e1/.test(acted.text), acted.text);
  check('edge_act reports effect_state', /effect_state: committed/.test(acted.text), acted.text);

  const guarded = await tools.get('edge_act').execute(
    { action: 'click', ref: 'e404', expect: { text: 'Delete forever' } },
    {},
  );
  check('edge_act surfaces a blocked expectation', /effect_state: none/.test(guarded.text), guarded.text);
  check('edge_act forwards expect to the extension', guarded.detail?.expect?.text === 'Delete forever', JSON.stringify(guarded.detail));

  const bySelector = await tools.get('edge_act').execute({ action: 'click', selector: '#submit' }, {});
  check('edge_act reports a plain selector', /clicked #submit/.test(bySelector.text), bySelector.text);
  const waited = await tools.get('edge_act').execute({ action: 'wait', selector: '#late' }, {});
  check('edge_act wait reports found', /Found #late/.test(waited.text), waited.text);

  const shot = await tools.get('edge_screenshot').execute({ tab_id: 11 }, {});
  check('edge_screenshot writes a file', existsSync(shot.path) && statSync(shot.path).size > 0, shot.path);
  check('edge_screenshot explains the next step', /read_image/.test(shot.text), shot.text);

  check('extension received every request', extensionCalls >= 12, String(extensionCalls));

  // ---- unauthenticated peer --------------------------------------------
  const rogue = new WebSocket(`ws://127.0.0.1:${port}/edge-bridge`);
  const rogueReply = await new Promise((done, fail) => {
    rogue.addEventListener('open', () => rogue.send(JSON.stringify({ t: 'hello', token: 'f'.repeat(64), protocol: 1 })));
    rogue.addEventListener('message', (event) => done(JSON.parse(String(event.data))));
    setTimeout(() => fail(new Error('no answer to a bad handshake')), 5000);
  });
  check('bad token is refused', rogueReply.ok === false, JSON.stringify(rogueReply));
  const rogueClose = await new Promise((done) => {
    rogue.addEventListener('close', (event) => done(event.code));
    setTimeout(() => done('timeout'), 4000);
  });
  check('bad token socket is closed with 4003', rogueClose === 4003, String(rogueClose));

  // ---- detach disposes --------------------------------------------------
  dispose = tools.get('edge_status');
  socket.close();
  await sleep(300);
  const afterClose = await tools.get('edge_status').execute({}, {});
  check('disconnect is reflected in edge_status', /Attached extensions: 0/.test(afterClose.text), afterClose.text);

  const stopped = await control.execute({ action: 'stop' }, {});
  check('stop removes the browser tools', tools.size === 1 && !tools.has('edge_tabs') && tools.has('edge_bridge'), [...tools.keys()].join(','));
  check('stop explains how to get back', /OFF/.test(stopped.text) && /start/.test(stopped.text), stopped.text);
  const resumed = await control.execute({ action: 'start' }, {});
  check('start after stop restores the tools', tools.size === 8 && resumed.active === true, [...tools.keys()].join(','));
} catch (error) {
  check('suite ran to completion', false, String((error && error.stack) || error));
} finally {
  try {
    socket?.close();
  } catch {
    /* ignore */
  }
  await sleep(200);
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);