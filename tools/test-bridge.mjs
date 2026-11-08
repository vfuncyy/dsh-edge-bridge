/**
 * Transport test for the bridge, without DSH and without Edge.
 *
 *   node edge-bridge/tools/test-bridge.mjs
 *
 * Starts a loopback upgrade server wired to `Bridge` and drives it with a
 * fake extension client written against the global WebSocket.
 */
import http from 'node:http';
import { Bridge } from '../plugin/lib/bridge.js';

const TOKEN = 'test-token-0f9c3a';
const results = [];

function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  <- ${detail ?? ''}`}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeExtension {
  constructor(url, token = TOKEN, caps = null) {
    this.url = url;
    this.token = token;
    this.caps = caps;
    this.messages = [];
    this.pings = 0;
    this.closedCode = null;
    this.closedReason = '';
    this.replyPings = true;
    this.onRequest = null;
    this.socket = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      let settled = false;
      socket.onopen = () => {
        const hello = {
          t: 'hello',
          protocol: 1,
          token: this.token,
          extension: { name: 'Fake Edge Bridge', version: '0.0.0-test' },
          browser: { name: 'Microsoft Edge', version: '156.0.0.0' },
        };
        if (Array.isArray(this.caps)) hello.caps = this.caps;
        socket.send(JSON.stringify(hello));
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        this.messages.push(message);
        if (message.t === 'hello') {
          if (!settled) {
            settled = true;
            resolve(message);
          }
          return;
        }
        if (message.t === 'ping') {
          this.pings += 1;
          if (this.replyPings) this.send({ t: 'pong', ts: Date.now() });
          return;
        }
        if (message.t === 'req') this.onRequest?.(message, this);
      };
      socket.onclose = (event) => {
        this.closedCode = event.code;
        this.closedReason = event.reason;
        if (!settled) {
          settled = true;
          resolve(null);
        }
      };
      socket.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error('the websocket failed to open'));
        }
      };
    });
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  stop() {
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
  }
}

const bridge = new Bridge({
  token: TOKEN,
  logger: { info: () => {}, warn: () => {} },
  timing: { helloTimeoutMs: 400, pingIntervalMs: 120, idleTimeoutMs: 420, requestTimeoutMs: 500 },
});

const server = http.createServer((_req, res) => {
  res.writeHead(404).end('not a websocket endpoint');
});
server.on('upgrade', (req, socket, head) => {
  if ((req.url ?? '').split('?')[0] === '/edge-bridge') bridge.handleUpgrade(req, socket, head);
  else socket.destroy();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `ws://127.0.0.1:${server.address().port}/edge-bridge`;
console.log(`bridge listening on ${endpoint}\n`);

// 1. a wrong token is rejected before any request runs
{
  const client = new FakeExtension(endpoint, 'not-the-token');
  const hello = await client.connect();
  check('wrong token -> hello ok=false', hello && hello.ok === false, JSON.stringify(hello));
  await sleep(150);
  check('wrong token -> close 4003', client.closedCode === 4003, `code=${client.closedCode}`);
  check('wrong token -> nothing listed', bridge.list().length === 0, JSON.stringify(bridge.list()));
  client.stop();
}

// 2. a correct token is authorized and described
const client = new FakeExtension(endpoint);
const hello = await client.connect();
check('hello ok=true', hello?.ok === true, JSON.stringify(hello));
check('caps include page.read', Array.isArray(hello?.caps) && hello.caps.includes('page.read'), JSON.stringify(hello?.caps));
check('caps include page.inspect', Array.isArray(hello?.caps) && hello.caps.includes('page.inspect'), JSON.stringify(hello?.caps));
check('caps are method names, not groups', Array.isArray(hello?.caps) && hello.caps.includes('tabs.list') && hello.caps.includes('page.screenshot'), JSON.stringify(hello?.caps));
check('server version is reported', typeof hello?.server?.version === 'string' && /^\d+\.\d+\.\d+$/.test(hello.server.version), JSON.stringify(hello?.server));
check('bridge.connected', bridge.connected === true);
const listed = bridge.list();
check('one authorized connection', listed.length === 1 && listed[0].authorized, JSON.stringify(listed));
check('extension identity captured', listed[0]?.extension?.name === 'Fake Edge Bridge', JSON.stringify(listed[0]?.extension));

// 3. request/response round trip
{
  const seen = [];
  client.onRequest = (message, peer) => {
    seen.push(message.method);
    peer.send({ t: 'res', id: message.id, ok: true, value: { tabs: [{ id: 7, windowId: 1, title: 'Example', url: 'https://example.com' }], activeTabId: 7 } });
  };
  const value = await bridge.request('tabs.list', { filter: 'exam' });
  check('request returns the extension value', value?.activeTabId === 7, JSON.stringify(value));
  check('params reach the extension', seen[0] === 'tabs.list', JSON.stringify(seen));

  // 3b. an error answer becomes a rejected promise with the extension's text
  client.onRequest = (message, peer) => peer.send({ t: 'res', id: message.id, ok: false, error: 'tab 99 no longer exists' });
  let errorText = '';
  try {
    await bridge.request('page.read', { tabId: 99 });
  } catch (error) {
    errorText = String(error.message);
  }
  check('error answer rejects', errorText.includes('tab 99 no longer exists'), errorText);
}

// 4. a silent extension times out
{
  client.onRequest = () => {};
  let errorText = '';
  try {
    await bridge.request('page.eval', { code: '1' }, { timeoutMs: 250 });
  } catch (error) {
    errorText = String(error.message);
  }
  check('unanswered request times out', /timed out after 250ms/.test(errorText), errorText);
}

// 4b. a peer that advertises fewer methods is refused up front
{
  const legacy = new FakeExtension(endpoint, TOKEN, ['tabs.list', 'page.read']);
  const legacyHello = await legacy.connect();
  check('a cap-limited peer still connects', legacyHello?.ok === true, JSON.stringify(legacyHello));
  let errorText = '';
  try {
    await bridge.request('page.inspect', {}, { timeoutMs: 500 });
  } catch (error) {
    errorText = String(error.message);
  }
  check('missing cap is refused before the round trip', /does not implement "page.inspect"/.test(errorText), errorText);
  check('missing cap error says how to fix it', /edge:\/\/extensions/.test(errorText), errorText);
  let allowed = null;
  legacy.onRequest = (message, peer) => peer.send({ t: 'res', id: message.id, ok: true, value: { ok: true } });
  try {
    allowed = await bridge.request('page.read', { tabId: 11 }, { timeoutMs: 500 });
  } catch (error) {
    allowed = String(error.message);
  }
  check('a declared cap still runs', allowed?.ok === true, JSON.stringify(allowed));
  legacy.stop();
  await sleep(150);
}

// 5. heartbeats keep a responsive peer attached
{
  await sleep(700);
  check('heartbeat keeps the peer connected', bridge.connected === true, `pings=${client.pings} code=${client.closedCode}`);
  check('pings were sent', client.pings >= 2, `pings=${client.pings}`);
}

// 6. a peer that ignores heartbeats is dropped
{
  const silent = new FakeExtension(endpoint);
  silent.replyPings = false;
  silent.onRequest = () => {};
  const silentHello = await silent.connect();
  check('second peer authorized', silentHello?.ok === true, JSON.stringify(silentHello));
  await sleep(900);
  check('idle peer closed with 4001', silent.closedCode === 4001, `code=${silent.closedCode} reason=${silent.closedReason}`);
  check('disconnected peer is forgotten', bridge.list().every((connection) => connection.extension?.name === 'Fake Edge Bridge') && bridge.list().length <= 1, JSON.stringify(bridge.list()));
  silent.stop();
}

// 7. a disconnect rejects the call in flight
{
  const flaky = new FakeExtension(endpoint);
  flaky.onRequest = () => {};
  await flaky.connect();
  const pending = bridge.request('page.screenshot', {}, { timeoutMs: 5000 }).then(
    () => 'resolved',
    (error) => String(error.message),
  );
  await sleep(80);
  flaky.stop();
  const outcome = await pending;
  check('disconnect rejects the in-flight call', /disconnected while running "page.screenshot"/.test(outcome), outcome);
}

// 8. an unknown connection id is refused
{
  let errorText = '';
  try {
    bridge.request('tabs.list', {}, { connectionId: 'edge-999' });
  } catch (error) {
    errorText = String(error.message);
  }
  check('unknown connection id refused', /unknown connection/.test(errorText), errorText);
}

// 9. dispose closes everything
{
  bridge.dispose();
  await sleep(100);
  check('dispose detaches peers', bridge.list().length === 0, JSON.stringify(bridge.list()));
}

server.close();
server.closeAllConnections?.();

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
process.exit(process.exitCode ?? 0);