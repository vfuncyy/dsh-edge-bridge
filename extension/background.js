/**
 * DSH Edge Bridge — the browser side of the bridge.
 *
 * Holds one websocket to the DSH Host plugin, answers its requests, and
 * exposes the real tabs of this Edge profile: read, evaluate, interact,
 * screenshot.
 *
 * Protocol (JSON text frames):
 *   ext → host  { t:'hello', protocol, token, extension:{name,version}, browser:{name,version} }
 *   host → ext  { t:'hello', ok:true, protocol, server:{name,version}, caps:[...] } | { ok:false, error }
 *   host → ext  { t:'ping', ts }          ext → host  { t:'pong', ts }
 *   host → ext  { t:'req', id, method, params }
 *   ext → host  { t:'res', id, ok:true, value } | { t:'res', id, ok:false, error }
 *   ext → host  { t:'event', name, data }
 */
import { readPage, actPage, inspectPage } from './page.js';

const PROTOCOL = 1;
const EXTENSION_NAME = 'DSH Edge Bridge';
const VERSION = chrome.runtime.getManifest().version;
const DEFAULT_ENDPOINT = 'ws://127.0.0.1:17333/edge-bridge';
/** The plugin binds the first free port in this range; the ping route tells us which. */
const DISCOVERY_FIRST_PORT = 17333;
const DISCOVERY_PORTS = 12;
const DISCOVERY_TIMEOUT_MS = 700;
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 20000, 30000];
const HELLO_TIMEOUT_MS = 8000;
const KEEPALIVE_ALARM = 'edge-bridge-keepalive';

const state = {
  // endpoint '' = discover the live port on every connect.
  settings: { endpoint: '', token: '', verbose: false },
  socket: null,
  status: 'idle',
  lastError: '',
  server: null,
  caps: [],
  connectedAt: 0,
  lastMessageAt: 0,
  rpcCount: 0,
  attempts: 0,
  retryTimer: null,
  logs: [],
  // Page capture is driven from the toolbar: the popup turns a session on or
  // asks for a one-shot batch, and DSH owns the actual writing.
  capture: { active: false, saved: 0, failed: 0, lastTitle: '', lastAt: 0, lastError: '' },
};

let connectGeneration = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(...parts) {
  const line = `${new Date().toISOString().slice(11, 19)} ${parts
    .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
    .join(' ')}`;
  state.logs.push(line);
  if (state.logs.length > 80) state.logs.shift();
  if (state.settings.verbose) console.log('[edge-bridge]', line);
}

function setStatus(status, patch) {
  state.status = status;
  if (patch) Object.assign(state, patch);
  refreshBadge();
}

/**
 * One badge, two jobs: the bridge state while idle, the capture counter while
 * a session runs. The title carries both, so hovering explains the number.
 */
function refreshBadge() {
  const capturing = state.capture.active;
  const text = capturing
    ? state.capture.saved > 0
      ? String(state.capture.saved)
      : '●'
    : state.status === 'connected'
      ? ''
      : state.status === 'needs-token' || state.status === 'error'
        ? '!'
        : '…';
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({
    color: capturing || state.status === 'connected' ? '#1e8e3e' : state.status === 'error' ? '#c0392b' : '#8a6d3b',
  }).catch(() => {});
  const capture = capturing ? ` · 抓取中，已存 ${state.capture.saved} 页` : '';
  chrome.action.setTitle({ title: `DSH Edge Bridge — ${state.status}${capture}${state.lastError ? ` (${state.lastError})` : ''}` }).catch(() => {});
}

// ---------------------------------------------------------------- settings ---

async function loadSettings() {
  const stored = await chrome.storage.local.get(['endpoint', 'token', 'verbose', 'capture']);
  state.settings = {
    endpoint: typeof stored.endpoint === 'string' ? stored.endpoint.trim() : '',
    token: typeof stored.token === 'string' ? stored.token.trim() : '',
    verbose: stored.verbose === true,
  };
  const capture = stored.capture;
  if (capture !== null && typeof capture === 'object') {
    state.capture = {
      active: capture.active === true,
      saved: Number.isFinite(capture.saved) ? capture.saved : 0,
      failed: Number.isFinite(capture.failed) ? capture.failed : 0,
      lastTitle: typeof capture.lastTitle === 'string' ? capture.lastTitle : '',
      lastAt: Number.isFinite(capture.lastAt) ? capture.lastAt : 0,
      lastError: typeof capture.lastError === 'string' ? capture.lastError : '',
    };
  }
  return state.settings;
}

async function saveCapture() {
  await chrome.storage.local.set({ capture: state.capture }).catch(() => {});
}

async function saveSettings(patch) {
  const next = {
    // An empty endpoint means "discover it", so store it verbatim.
    endpoint: typeof patch?.endpoint === 'string' ? patch.endpoint.trim() : state.settings.endpoint,
    token: typeof patch?.token === 'string' ? patch.token.trim() : state.settings.token,
    verbose: patch?.verbose === undefined ? state.settings.verbose : patch.verbose === true,
  };
  await chrome.storage.local.set(next);
  state.settings = next;
  return next;
}

// ------------------------------------------------------------- connection ---

function send(message) {
  const socket = state.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch (error) {
    log('send failed', String((error && error.message) || error));
    return false;
  }
}

function closeSocket(code, reason) {
  const socket = state.socket;
  state.socket = null;
  if (socket) {
    try {
      socket.close(code, reason);
    } catch {
      /* already closed */
    }
  }
}

function scheduleRetry() {
  if (state.retryTimer !== null) clearTimeout(state.retryTimer);
  const delay = RECONNECT_DELAYS[Math.min(state.attempts, RECONNECT_DELAYS.length - 1)];
  state.attempts += 1;
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    connect('retry').catch((error) => log('retry failed', String(error)));
  }, delay);
  log(`retrying in ${delay}ms`);
}

function browserInfo() {
  const userAgent = navigator.userAgent || '';
  const match = /Edg\/([\d.]+)/.exec(userAgent);
  return { name: 'Microsoft Edge', version: match ? match[1] : '', userAgent };
}

/**
 * Ask one loopback port whether it is the Edge Bridge. The plugin serves
 * `/edge-bridge/ping`, so the extension never needs a hand-typed port even
 * when the preferred one is taken.
 */
async function probeBridge(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/edge-bridge/ping`, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return null;
    const info = await response.json();
    if (!info || info.ok !== true || info.name !== 'dsh-edge-bridge') return null;
    const actualPort = Number.isInteger(info.port) ? info.port : port;
    return `ws://127.0.0.1:${actualPort}${typeof info.path === 'string' && info.path.startsWith('/') ? info.path : '/edge-bridge'}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Scan the plugin's port range in parallel; first match wins. */
async function discoverEndpoint() {
  const probes = [];
  for (let offset = 0; offset < DISCOVERY_PORTS; offset += 1) probes.push(probeBridge(DISCOVERY_FIRST_PORT + offset));
  const found = await Promise.all(probes);
  return found.find((value) => value) ?? null;
}

async function connect(reason) {
  const generation = ++connectGeneration;
  if (state.retryTimer !== null) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  closeSocket(1000, 'reconnect');
  await loadSettings();
  const { token } = state.settings;
  let { endpoint } = state.settings;

  if (!token) {
    setStatus('needs-token', { lastError: 'Paste the pairing token that the edge_bridge tool prints (action "status").' });
    return;
  }

  // Discovery wins: it follows the live port even if the stored endpoint went
  // stale (DSH picks a new Web UI port on some launches). A hand-typed
  // endpoint is only used when discovery finds nothing.
  setStatus(state.attempts > 0 ? 'retrying' : 'connecting', { lastError: '' });
  const discovered = await discoverEndpoint();
  if (generation !== connectGeneration) return;
  if (discovered) {
    if (discovered !== endpoint) log(`discovered ${discovered}${endpoint ? ` (stored ${endpoint} is stale)` : ''}`);
    endpoint = discovered;
    if (state.settings.endpoint) {
      // A stale hand-typed address (typically an old Web GUI port) would keep
      // surfacing in the popup and after every service worker restart. Drop
      // it once discovery proves where the bridge really is, so discovery
      // stays in charge for good.
      state.settings.endpoint = '';
      chrome.storage.local.set({ endpoint: '' }).catch(() => {});
      log('cleared the stale stored endpoint; auto-discovery stays in charge');
    }
  } else if (!endpoint || !/^wss?:\/\//i.test(endpoint)) {
    const lastPort = DISCOVERY_FIRST_PORT + DISCOVERY_PORTS - 1;
    setStatus('retrying', {
      lastError: `No Edge Bridge found on 127.0.0.1:${DISCOVERY_FIRST_PORT}-${lastPort}. Is DeepSeek Harness running with the plugin enabled?`,
    });
    scheduleRetry();
    return;
  }
  state.discoveredEndpoint = endpoint;

  setStatus(state.attempts > 0 ? 'retrying' : 'connecting', { lastError: '' });
  log(`connecting to ${endpoint} (${reason || 'manual'})`);

  let socket;
  try {
    socket = new WebSocket(endpoint);
  } catch (error) {
    setStatus('error', { lastError: `Cannot open ${endpoint}: ${(error && error.message) || error}` });
    scheduleRetry();
    return;
  }
  state.socket = socket;

  const helloTimer = setTimeout(() => {
    if (state.socket === socket && state.status !== 'connected') {
      log('handshake timed out');
      socket.close(4000, 'handshake timed out');
    }
  }, HELLO_TIMEOUT_MS);

  socket.onopen = () => {
    if (generation !== connectGeneration) {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      return;
    }
    log('socket open, authenticating');
    send({
      t: 'hello',
      protocol: PROTOCOL,
      token,
      extension: { name: EXTENSION_NAME, version: VERSION },
      browser: browserInfo(),
      // Declare the methods this build actually dispatches, so the plugin can
      // refuse a call it knows will fail instead of discovering it mid-task.
      caps: Object.keys(HANDLERS),
    });
  };

  socket.onmessage = (event) => {
    state.lastMessageAt = Date.now();
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message === null || typeof message !== 'object') return;
    const kind = message.t;
    if (kind === 'hello') {
      clearTimeout(helloTimer);
      if (message.ok === true) {
        setStatus('connected', {
          server: message.server ?? null,
          caps: Array.isArray(message.caps) ? message.caps : [],
          connectedAt: Date.now(),
          lastError: '',
          attempts: 0,
        });
        log(`paired with ${message.server?.name ?? 'DSH'} ${message.server?.version ?? ''}`);
        announceTabs();
      } else {
        setStatus('error', { lastError: `The DSH plugin rejected the pairing token: ${message.error ?? 'invalid token'}` });
        try {
          socket.close(4003, 'pairing rejected');
        } catch {
          /* ignore */
        }
      }
      return;
    }
    if (kind === 'ping') {
      send({ t: 'pong', ts: Date.now() });
      return;
    }
    if (kind === 'event') {
      handleHostEvent(message);
      return;
    }
    if (kind === 'req') {
      handleRequest(socket, message);
      return;
    }
  };

  socket.onerror = () => {
    if (generation !== connectGeneration) return;
    state.lastError = `Cannot reach ${endpoint}. Is DeepSeek Harness running with the Edge Bridge plugin installed?`;
  };

  socket.onclose = (event) => {
    clearTimeout(helloTimer);
    if (state.socket === socket) state.socket = null;
    if (generation !== connectGeneration) return;
    const wasConnected = state.status === 'connected';
    log(`socket closed (${event.code}${event.reason ? ` ${event.reason}` : ''})`);
    if (event.code === 4003) {
      setStatus('error', { lastError: 'The DSH plugin rejected the pairing token. Copy the current token from edge_bridge(action:"status") in DSH and save it again.' });
      return;
    }
    if (event.code === 1000 && !wasConnected) return; // superseded by a newer attempt
    setStatus(wasConnected ? 'retrying' : 'retrying', {
      lastError: state.lastError || `Connection to ${endpoint} closed (${event.code}); retrying.`,
    });
    scheduleRetry();
  };
}

function disconnect() {
  connectGeneration += 1;
  if (state.retryTimer !== null) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  closeSocket(1000, 'disconnected by user');
  setStatus('idle', { lastError: '', server: null, caps: [] });
  log('disconnected by user');
}

function announceTabs() {
  chrome.tabs
    .query({})
    .then((tabs) => send({ t: 'event', name: 'tabs', data: { count: tabs.length } }))
    .catch(() => {});
}

// ------------------------------------------------------------------ rpc ---

async function handleRequest(socket, message) {
  const id = message.id;
  const method = String(message.method ?? '');
  const params = message.params && typeof message.params === 'object' ? message.params : {};
  state.rpcCount += 1;
  try {
    const handler = HANDLERS[method];
    if (!handler) {
      throw new Error(
        `this extension does not implement "${method}" (protocol ${PROTOCOL}, build ${VERSION}, caps: ${Object.keys(HANDLERS).join(', ')}) — reload the unpacked extension in edge://extensions so it matches the plugin`,
      );
    }
    const value = await handler(params);
    send({ t: 'res', id, ok: true, value: value ?? {} });
  } catch (error) {
    const text = String((error && error.message) || error);
    log(`${method} failed: ${text}`);
    send({ t: 'res', id, ok: false, error: text });
  }
}

// ------------------------------------------------------------- tab helpers ---

function shapeTab(tab) {
  if (!tab) return null;
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    active: tab.active === true,
    pinned: tab.pinned === true,
    discarded: tab.discarded === true,
    status: tab.status,
    title: tab.title ?? '',
    url: tab.url ?? '',
    favIconUrl: tab.favIconUrl ?? '',
  };
}

async function getTab(tabId) {
  if (Number.isInteger(tabId)) {
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      throw new Error(`tab ${tabId} no longer exists; call edge_tabs action=list to pick a live tab`);
    }
  }
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focused) return focused;
  const [any] = await chrome.tabs.query({ active: true });
  if (any) return any;
  throw new Error('no active Edge tab found; call edge_tabs action=open with a url first');
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let tab = null;
  while (Date.now() < deadline) {
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return null;
    }
    if (tab.status === 'complete') return tab;
    await sleep(200);
  }
  return tab;
}

function assertScriptable(tab) {
  const url = String(tab?.url ?? '');
  if (/^(https?|file):/i.test(url)) return;
  throw new Error(
    `Edge does not allow content scripts on ${url || 'this page'} (browser-internal pages are off limits). Open a normal http(s) page instead.`,
  );
}

function explainScriptError(error, tab) {
  const message = String((error && error.message) || error);
  if (/cannot access|extensions gallery|cannot be scripted|The extensions gallery cannot be scripted/i.test(message)) {
    return new Error(
      `Edge refused to script ${tab?.url ?? 'this tab'}. This happens on browser-internal pages (edge://, chrome://, the Web Store) and on file:// URLs unless "Allow access to file URLs" is enabled for this extension.`,
    );
  }
  if (/no tab with id/i.test(message)) {
    return new Error(`tab ${tab?.id} disappeared before it could be scripted`);
  }
  return new Error(message);
}

async function runInTab(tab, func, arg) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func,
      args: arg === undefined ? [] : [arg],
    });
  } catch (error) {
    throw explainScriptError(error, tab);
  }
  const first = Array.isArray(results) ? results[0] : null;
  if (!first) throw new Error('the page returned no result');
  if (first.error) throw new Error(String(first.error.message ?? first.error));
  return first.result;
}

const userSelectorCheck = (selector) => {
  try {
    return document.querySelector(selector) !== null;
  } catch {
    return 'invalid';
  }
};

async function waitForSelectorInTab(tab, selector, timeoutMs) {
  const deadline = Date.now() + Math.max(500, Math.min(120000, timeoutMs || 10000));
  for (;;) {
    const found = await runInTab(tab, userSelectorCheck, selector);
    if (found === true) return true;
    if (found === 'invalid') throw new Error(`invalid CSS selector: ${selector}`);
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
}

// ------------------------------------------------------- debugger sessions ---

const debuggerChains = new Map();

function serializePerTab(tabId, task) {
  const previous = debuggerChains.get(tabId) ?? Promise.resolve();
  const next = previous.then(task, task);
  debuggerChains.set(
    tabId,
    next.catch(() => {}),
  );
  return next;
}

async function withDebugger(tabId, task) {
  return serializePerTab(tabId, async () => {
    const target = { tabId };
    let attached = false;
    try {
      await chrome.debugger.attach(target, '1.3');
      attached = true;
    } catch (error) {
      const message = String((error && error.message) || error);
      if (/already attached/i.test(message)) {
        throw new Error('another debugger is attached to this tab (close DevTools for this tab, then retry)');
      }
      throw new Error(`cannot attach the debugger to tab ${tabId}: ${message}`);
    }
    try {
      return await task(target);
    } finally {
      if (attached) {
        try {
          await chrome.debugger.detach(target);
        } catch {
          /* tab may be gone */
        }
      }
    }
  });
}

/**
 * Helpers every evaluated snippet can use. They are injected because the same
 * five lines (find, read text, wait for a node, wait for text, click by label)
 * were being retyped in almost every call of a real browsing session.
 */
const EVAL_PRELUDE = [
  'const $ = (sel, root) => (root || document).querySelector(sel);',
  'const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));',
  'const text = (el) => (el ? String(el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim() : "");',
  'const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));',
  'const waitFor = async (sel, ms) => { const started = Date.now(); const limit = Math.max(200, Number(ms) || 10000); for (;;) { const el = $(sel); if (el) return el; if (Date.now() - started > limit) return null; await sleep(150); } };',
  'const waitText = async (needle, ms) => { const want = String(needle || "").trim(); const started = Date.now(); const limit = Math.max(200, Number(ms) || 10000); for (;;) { if (want && text(document.body).includes(want)) return true; if (Date.now() - started > limit) return false; await sleep(150); } };',
  'const clickText = (needle) => { const want = String(needle || "").trim(); if (!want) return null; const hits = $$("a,button,li,span,div,td,th,label,input[type=button],input[type=submit]").filter((el) => { const t = text(el); return t === want || t.includes(want); }); const target = hits.sort((a, b) => text(a).length - text(b).length)[0] || null; if (target) { target.scrollIntoView({ block: "center" }); target.click(); } return target; };',
].join('\n');

/** Wrap a snippet so it may use `await` and the helper prelude. */
function evalExpression(code) {
  const looksLikeBody = /\breturn\b/.test(code) || /^\s*(const|let|var|if|for|while|try|switch|class|function|await)\b/.test(code);
  const inner = looksLikeBody ? code : `return (${code});`;
  return `(async () => {\n${EVAL_PRELUDE}\n${inner}\n})()`;
}

async function evaluateInTab(tabId, code, awaitPromise, timeoutMs) {
  const timeout = Math.max(1000, Math.min(120000, timeoutMs || 20000));
  return withDebugger(tabId, async (target) => {
    const run = async (expression) =>
      chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression,
        awaitPromise: awaitPromise !== false,
        returnByValue: true,
        userGesture: true,
        allowUnsafeEvalBlockedByCSP: true,
        timeout,
      });

    let response = await run(evalExpression(code));
    const description = String(response?.exceptionDetails?.exception?.description ?? response?.exceptionDetails?.text ?? '');
    if (response?.exceptionDetails && /SyntaxError|Illegal return|Unexpected token|await is only valid/i.test(description)) {
      // `return` outside a function body, or a statement where an expression
      // was expected: retry with the bare-body wrapper.
      response = await run(`(async () => { ${code} })()`);
    }
    if (response?.exceptionDetails) {
      const message = String(response?.exceptionDetails?.exception?.description ?? response?.exceptionDetails?.text ?? '');
      throw new Error(message || 'the evaluated code threw');
    }
    const remote = response?.result ?? {};
    let value = remote.value;
    if (value === undefined) {
      if (remote.unserializableValue !== undefined) value = String(remote.unserializableValue);
      else if (remote.type === 'undefined') value = null;
      else value = null;
    }
    return { value, type: remote.type ?? typeof value };
  });
}

async function screenshotTab(tabId, fullPage, format, quality) {
  const type = format === 'jpeg' ? 'jpeg' : 'png';
  return withDebugger(tabId, async (target) => {
    let clip;
    if (fullPage) {
      const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics').catch(() => null);
      const size = metrics?.cssContentSize ?? metrics?.contentSize ?? null;
      if (size && size.width > 0 && size.height > 0) {
        clip = {
          x: 0,
          y: 0,
          width: Math.min(Math.ceil(size.width), 4096),
          height: Math.min(Math.ceil(size.height), 20000),
          scale: 1,
        };
      }
    }
    const params = { format: type, captureBeyondViewport: Boolean(fullPage) };
    if (type === 'jpeg') params.quality = Math.max(10, Math.min(100, Number(quality) || 80));
    if (clip) params.clip = clip;
    const shot = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', params);
    if (!shot || typeof shot.data !== 'string') throw new Error('Edge returned an empty screenshot');
    // The clipped size is only known for full-page captures; decode the bitmap
    // so the report is accurate either way.
    let width = clip ? Math.round(clip.width) : 0;
    let height = clip ? Math.round(clip.height) : 0;
    try {
      const binary = atob(shot.data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: type === 'jpeg' ? 'image/jpeg' : 'image/png' }));
      if (bitmap.width > 0 && bitmap.height > 0) {
        width = bitmap.width;
        height = bitmap.height;
      }
      bitmap.close?.();
    } catch {
      /* keep the layout-metric size */
    }
    return {
      base64: shot.data,
      format: type,
      width,
      height,
      fullPage: Boolean(fullPage),
    };
  });
}

// -------------------------------------------------------------- handlers ---

const HANDLERS = {
  async 'tabs.list'(params) {
    let tabs = await chrome.tabs.query({});
    const filter = typeof params.filter === 'string' ? params.filter.trim().toLowerCase() : '';
    if (filter) {
      tabs = tabs.filter(
        (tab) => String(tab.url ?? '').toLowerCase().includes(filter) || String(tab.title ?? '').toLowerCase().includes(filter),
      );
    }
    const limit = Math.max(1, Math.min(200, Number.isInteger(params.limit) ? params.limit : 50));
    const windows = await chrome.windows.getAll({}).catch(() => []);
    const focusedWindow = await chrome.windows.getLastFocused({}).catch(() => null);
    const activeTab = tabs.find((tab) => tab.active && (focusedWindow ? tab.windowId === focusedWindow.id : true)) ?? tabs.find((tab) => tab.active);
    const shaped = tabs
      .slice()
      .sort((left, right) => left.windowId - right.windowId || left.index - right.index)
      .slice(0, limit)
      .map(shapeTab);
    return {
      tabs: shaped,
      activeTabId: activeTab?.id ?? null,
      focusedWindowId: focusedWindow?.id ?? null,
      total: tabs.length,
      windowCount: windows.length,
    };
  },

  async 'tabs.open'(params) {
    if (typeof params.url !== 'string' || !params.url.trim()) throw new Error('tabs.open requires a url');
    let url = params.url.trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
    const active = params.active !== false;
    let tab;
    try {
      tab = await chrome.tabs.create({ url, active });
    } catch (error) {
      // Edge can be running with every window closed ("No current window").
      // Opening a tab has to create the window first, otherwise the whole
      // session starts with a confusing failure.
      if (!/no current window|no window/i.test(String((error && error.message) || error))) throw error;
      const created = await chrome.windows.create({ url, focused: active });
      tab = created?.tabs?.[0] ?? (await chrome.tabs.query({ windowId: created?.id }))?.[0];
      if (!tab) throw new Error('Edge refused to open a window for the requested URL');
    }
    const settled = params.waitForLoad === false ? tab : (await waitForTabComplete(tab.id, 30000)) ?? tab;
    let waited = null;
    if (typeof params.waitForSelector === 'string' && params.waitForSelector.trim()) {
      const found = await waitForSelectorInTab(settled, params.waitForSelector.trim(), params.waitTimeoutMs || 20000);
      waited = { selector: params.waitForSelector.trim(), found };
    }
    return { tab: shapeTab(settled), waited };
  },

  async 'tabs.navigate'(params) {
    if (typeof params.url !== 'string' || !params.url.trim()) throw new Error('tabs.navigate requires a url');
    const tab = await getTab(params.tabId);
    let url = params.url.trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
    await chrome.tabs.update(tab.id, { url });
    const settled = params.waitForLoad === false ? tab : (await waitForTabComplete(tab.id, 30000)) ?? tab;
    let waited = null;
    if (typeof params.waitForSelector === 'string' && params.waitForSelector.trim()) {
      const found = await waitForSelectorInTab(settled, params.waitForSelector.trim(), params.waitTimeoutMs || 20000);
      waited = { selector: params.waitForSelector.trim(), found };
    }
    return { tab: shapeTab(settled), waited };
  },

  async 'tabs.activate'(params) {
    const tab = await getTab(params.tabId);
    await chrome.tabs.update(tab.id, { active: true });
    if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    const fresh = await chrome.tabs.get(tab.id).catch(() => tab);
    return { tab: shapeTab(fresh) };
  },

  async 'tabs.close'(params) {
    const tab = await getTab(params.tabId);
    await chrome.tabs.remove(tab.id);
    announceTabs();
    return { closed: true, tab: shapeTab(tab) };
  },

  async 'tabs.reload'(params) {
    const tab = await getTab(params.tabId);
    await chrome.tabs.reload(tab.id, { bypassCache: params.bypassCache === true });
    const settled = (await waitForTabComplete(tab.id, 30000)) ?? tab;
    return { tab: shapeTab(settled) };
  },

  async 'page.read'(params) {
    const tab = await getTab(params.tabId);
    assertScriptable(tab);
    if (typeof params.waitForSelector === 'string' && params.waitForSelector.trim()) {
      const found = await waitForSelectorInTab(tab, params.waitForSelector.trim(), 10000);
      if (!found) log(`wait_for_selector timed out: ${params.waitForSelector}`);
    }
    const result = await runInTab(tab, readPage, {
      format: params.format,
      scope: params.scope,
      maxChars: params.maxChars,
      includeLinks: params.includeLinks === true,
      dropTags: params.dropTags,
    });
    if (!result || result.ok === false) throw new Error(result?.error || 'failed to read the page');
    const fresh = await chrome.tabs.get(tab.id).catch(() => tab);
    return {
      tabId: tab.id,
      url: result.url || fresh.url,
      title: result.title || fresh.title,
      description: result.description ?? '',
      lang: result.lang ?? '',
      siteName: result.siteName ?? '',
      format: result.format,
      scope: result.scope,
      charCount: result.charCount,
      truncated: result.truncated === true,
      text: result.text,
      outline: result.outline ?? [],
      links: result.links ?? [],
    };
  },

  async 'page.eval'(params) {
    const tab = await getTab(params.tabId);
    assertScriptable(tab);
    if (typeof params.code !== 'string' || !params.code.trim()) throw new Error('page.eval requires code');
    let waited = null;
    const waitTimeout = Number.isInteger(params.waitTimeoutMs) ? params.waitTimeoutMs : 15000;
    if (typeof params.waitForSelector === 'string' && params.waitForSelector.trim()) {
      const found = await waitForSelectorInTab(tab, params.waitForSelector.trim(), waitTimeout);
      waited = { selector: params.waitForSelector.trim(), found };
      if (!found) throw new Error(`waited ${waitTimeout}ms for ${waited.selector} and it never appeared — the page may still be loading, or the selector is wrong`);
    } else if (typeof params.waitForText === 'string' && params.waitForText.trim()) {
      const found = await waitForTextInTab(tab, params.waitForText.trim(), waitTimeout);
      waited = { text: params.waitForText.trim(), found };
      if (!found) throw new Error(`waited ${waitTimeout}ms for the text "${params.waitForText.trim()}" and it never appeared`);
    }
    const result = await evaluateInTab(tab.id, params.code, params.awaitPromise, params.timeoutMs);
    return { tabId: tab.id, value: result.value, type: result.type, waited };
  },

  async 'page.inspect'(params) {
    const tab = await getTab(params.tabId);
    assertScriptable(tab);
    if (typeof params.waitForSelector === 'string' && params.waitForSelector.trim()) {
      await waitForSelectorInTab(tab, params.waitForSelector.trim(), params.waitTimeoutMs || 15000);
    }
    const result = await runInTab(tab, inspectPage, {
      selector: params.selector,
      maxInteractive: params.maxInteractive,
      maxLists: params.maxLists,
    });
    if (!result || result.ok === false) throw new Error(result?.error || 'failed to inspect the page');
    const fresh = await chrome.tabs.get(tab.id).catch(() => tab);
    return { tabId: tab.id, url: result.url || fresh.url, title: result.title || fresh.title, ...result };
  },

  async 'page.act'(params) {
    const tab = await getTab(params.tabId);
    assertScriptable(tab);
    const action = String(params.action ?? '');
    if (!action) throw new Error('page.act requires an action');
    let result;
    if (action === 'wait') {
      const timeout = Number.isInteger(params.timeoutMs) ? params.timeoutMs : 10000;
      if (typeof params.ref === 'string' && params.ref.trim()) {
        const found = await waitForSelectorInTab(tab, `[data-dsh-ref="${params.ref.trim().replace(/["\\]/g, '\\$&')}"]`, timeout);
        result = { found, detail: { ref: params.ref.trim() } };
      } else if (typeof params.selector === 'string' && params.selector.trim()) {
        const found = await waitForSelectorInTab(tab, params.selector.trim(), timeout);
        result = { found, detail: { selector: params.selector.trim() } };
      } else if (typeof params.text === 'string' && params.text.trim()) {
        const found = await waitForTextInTab(tab, params.text, timeout);
        result = { found, detail: { text: params.text.trim() } };
      } else {
        throw new Error('page.act action=wait requires ref, selector or text');
      }
    } else {
      result = await runInTab(tab, actPage, {
        action,
        ref: params.ref,
        expect: params.expect,
        selector: params.selector,
        text: params.text,
        amount: params.amount,
        submit: params.submit === true,
      });
      if (!result || result.ok === false) {
        const effect = result?.effect;
        const suffix = effect?.state ? `\n\neffect_state: ${effect.state}${effect.reason ? ` — ${effect.reason}` : ''}` : '';
        throw new Error(`${result?.error || `${action} failed`}${suffix}`);
      }
    }
    // A click usually starts a request; waiting here is what keeps the model
    // from spending a whole extra turn polling for the result.
    let settled = null;
    const settleTimeout = Number.isInteger(params.timeoutMs) ? params.timeoutMs : 10000;
    if (typeof params.waitFor === 'string' && params.waitFor.trim()) {
      const found = await waitForSelectorInTab(tab, params.waitFor.trim(), settleTimeout);
      settled = { selector: params.waitFor.trim(), found };
    } else if (typeof params.waitForText === 'string' && params.waitForText.trim()) {
      const found = await waitForTextInTab(tab, params.waitForText.trim(), settleTimeout);
      settled = { text: params.waitForText.trim(), found };
    }
    return {
      tabId: tab.id,
      detail: result.detail ?? {},
      effect: result.effect ?? null,
      found: result.found,
      scrollY: result.scrollY,
      scrollHeight: result.scrollHeight,
      settled,
    };
  },

  async 'page.screenshot'(params) {
    const tab = await getTab(params.tabId);
    const shot = await screenshotTab(tab.id, params.fullPage === true, params.format, params.quality);
    return { tabId: tab.id, ...shot };
  },
};

const textPresent = (needle) => {
  const wanted = String(needle || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!wanted) return false;
  const body = document.body ? String(document.body.innerText || '').replace(/\s+/g, ' ').toLowerCase() : '';
  return body.includes(wanted);
};

async function waitForTextInTab(tab, text, timeoutMs) {
  const deadline = Date.now() + Math.max(500, Math.min(120000, timeoutMs || 10000));
  for (;;) {
    const found = await runInTab(tab, textPresent, text);
    if (found === true) return true;
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
}

// ----------------------------------------------------------------- capture ---

const CAPTURE_SOURCE_LABELS = { start: '启动时', load: '浏览时', batch: '批量', manual: '手动' };

function notify(title, message) {
  try {
    chrome.notifications
      .create(`dsh-edge-bridge-${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icons/icon-128.png',
        title,
        message,
        priority: 0,
      })
      .catch((error) => log('notification failed', String((error && error.message) || error)));
  } catch (error) {
    log('notification failed', String((error && error.message) || error));
  }
}

function isCapturable(tab) {
  return Boolean(tab) && typeof tab.url === 'string' && /^(https?|file):/i.test(tab.url) && tab.discarded !== true;
}

function errorText(error) {
  return String((error && error.message) || error);
}

/** Ask DSH to capture one page; false when no bridge is attached. */
function requestCapture(tabId, url, source) {
  return send({ t: 'event', name: 'capture.page', data: { tabId, url, source } });
}

async function captureStart() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!isCapturable(tab)) {
    notify('抓取未启动', '当前标签页不是可抓取的网页（仅支持 http/https 页面）。');
    return { ok: false, error: '当前标签页不是可抓取的网页' };
  }
  if (!requestCapture(tab.id, tab.url, 'start')) {
    notify('抓取未启动', '还没有连接到 DSH。请先在 DSH 里开启桥接，再点“保存并连接”。');
    return { ok: false, error: '没有连接到 DSH' };
  }
  state.capture.active = true;
  state.capture.lastError = '';
  await saveCapture();
  refreshBadge();
  notify('开始抓取页面', `已提交「${tab.title || tab.url}」。之后新打开或刷新的页面会自动抓取，直到点“停止抓取页面”。`);
  return { ok: true, tabId: tab.id };
}

async function captureStop() {
  state.capture.active = false;
  const saved = state.capture.saved;
  const failed = state.capture.failed;
  // Ending the session is also a job: DSH writes the session summary.
  send({ t: 'event', name: 'capture.stop', data: { saved, failed } });
  await saveCapture();
  refreshBadge();
  const failedText = failed > 0 ? `，失败 ${failed} 个` : '';
  notify('已停止抓取页面', `本次共入库 ${saved} 个页面${failedText}；总结已写入 DSH 的 edge页面抓取 工作区。`);
  return { ok: true, saved, failed };
}

async function captureBatch() {
  const tabs = await chrome.tabs.query({});
  const ids = tabs.filter(isCapturable).map((tab) => tab.id);
  if (ids.length === 0) {
    notify('没有可抓取的页面', '当前没有 http/https 标签页。');
    return { ok: false, error: '没有可抓取的页面' };
  }
  if (!send({ t: 'event', name: 'capture.batch', data: { tabIds: ids, source: 'batch' } })) {
    notify('批量抓取失败', '还没有连接到 DSH。请先在 DSH 里开启桥接，再点“保存并连接”。');
    return { ok: false, error: '没有连接到 DSH' };
  }
  notify('开始批量抓取', `正在抓取 ${ids.length} 个已打开的页面，完成后会再通知一次。`);
  return { ok: true, count: ids.length };
}

/** Events DSH broadcasts back: capture outcomes and status snapshots. */
async function handleHostEvent(message) {
  const name = message?.name;
  const data = message?.data ?? {};

  if (name === 'capture.result') {
    if (data.ok === true) {
      state.capture.saved += 1;
      state.capture.lastTitle = typeof data.title === 'string' ? data.title : '';
      state.capture.lastAt = Date.now();
    } else {
      state.capture.failed += 1;
      state.capture.lastError = typeof data.error === 'string' ? data.error : '未知错误';
    }
    await saveCapture();
    refreshBadge();
    // Browsing-time captures only move the counter; notifying every page load
    // would be noise.
    if (data.source === 'load') return;
    if (data.ok === true) {
      const label = CAPTURE_SOURCE_LABELS[data.source] ?? '';
      const id = typeof data.kbId === 'string' && data.kbId !== '' ? ` ${data.kbId}` : '';
      const clipped = data.truncated === true ? '，原文过长已截断' : '';
      notify('抓取成功', `${data.title || data.url}${label ? `（${label}）` : ''} → 已录入知识库${id}（${data.chars} 字${clipped}）`);
    } else {
      notify('抓取失败', String(data.error ?? '未知错误'));
    }
    return;
  }

  if (name === 'capture.batch.result') {
    state.capture.saved += Number.isFinite(data.saved) ? data.saved : 0;
    state.capture.failed += Number.isFinite(data.failed) ? data.failed : 0;
    await saveCapture();
    refreshBadge();
    if (data.ok === true) {
      notify('批量抓取完成', `成功 ${data.saved ?? 0} 个，失败 ${data.failed ?? 0} 个，已录入知识库「页面抓取」；总结已写入 edge页面抓取 工作区。`);
    } else {
      notify('批量抓取失败', String(data.error ?? `成功 ${data.saved ?? 0} 个，失败 ${data.failed ?? 0} 个`));
    }
    return;
  }

  log(`event ${name}`);
}

// While a session is on, every completed page load is a capture candidate.
// The per-tab URL memory stops a single navigation from capturing twice.
const lastCapturedUrl = new Map();
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!state.capture.active || info.status !== 'complete' || !isCapturable(tab)) return;
  if (lastCapturedUrl.get(tabId) === tab.url) return;
  lastCapturedUrl.set(tabId, tab.url);
  if (!requestCapture(tabId, tab.url, 'load')) log('capture skipped: not connected');
});
chrome.tabs.onRemoved.addListener((tabId) => lastCapturedUrl.delete(tabId));

// ------------------------------------------------------------ popup bridge ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;
  if (type === 'state') {
    sendResponse({
      ok: true,
      status: state.status,
      lastError: state.lastError,
      server: state.server,
      caps: state.caps,
      endpoint: state.settings.endpoint,
      discoveredEndpoint: state.discoveredEndpoint ?? '',
      token: state.settings.token,
      verbose: state.settings.verbose,
      connectedAt: state.connectedAt,
      rpcCount: state.rpcCount,
      attempts: state.attempts,
      version: VERSION,
      protocol: PROTOCOL,
      capture: state.capture,
      logs: state.logs.slice(-25),
    });
    return false;
  }
  if (type === 'save') {
    saveSettings(message.settings)
      .then(() => connect('settings saved'))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
    return true;
  }
  if (type === 'connect') {
    connect('popup button')
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
    return true;
  }
  if (type === 'disconnect') {
    disconnect();
    sendResponse({ ok: true });
    return false;
  }
  if (type === 'captureStart') {
    captureStart()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: errorText(error) }));
    return true;
  }
  if (type === 'captureStop') {
    captureStop()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: errorText(error) }));
    return true;
  }
  if (type === 'captureBatch') {
    captureBatch()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: errorText(error) }));
    return true;
  }
  if (type === 'probe') {
    chrome.tabs
      .query({})
      .then((tabs) => sendResponse({ ok: true, tabs: tabs.length, windows: new Set(tabs.map((tab) => tab.windowId)).size }))
      .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
    return true;
  }
  return false;
});

// ------------------------------------------------------------- lifecycle ---

chrome.tabs.onCreated.addListener(() => announceTabs());
chrome.tabs.onRemoved.addListener(() => announceTabs());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  const socket = state.socket;
  if (socket && socket.readyState === WebSocket.OPEN) return;
  connect('alarm').catch((error) => log('alarm connect failed', String(error)));
});

chrome.runtime.onStartup.addListener(() => {
  boot('startup');
});

chrome.runtime.onInstalled.addListener((details) => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 }).catch(() => {});
  if (details.reason === 'install') chrome.storage.local.set({ installedAt: Date.now() }).catch(() => {});
  boot('installed');
});

async function boot(reason) {
  try {
    await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  } catch {
    /* alarms may be unavailable in some builds */
  }
  await loadSettings();
  setStatus('idle', { lastError: '' });
  refreshBadge();
  if (!state.settings.token) {
    setStatus('needs-token', { lastError: 'Paste the pairing token that the edge_bridge tool prints.' });
    return;
  }
  connect(reason).catch((error) => log('boot connect failed', String(error)));
}

boot('service worker start').catch((error) => log('boot failed', String(error)));