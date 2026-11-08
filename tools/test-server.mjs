/**
 * The dedicated listener: port fallback, discovery ping, path routing.
 *
 *   node edge-bridge/tools/test-server.mjs
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { Bridge } from '../plugin/lib/bridge.js';
import { createBridgeServer } from '../plugin/lib/server.js';

const results = [];
const check = (name, condition, detail) => {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  <- ${String(detail).slice(0, 400)}`}`);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const listening = (port) =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });

/** First port whose successor is also free, so the fallback path is testable. */
async function adjacentFreePorts() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const port = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const { port: picked } = probe.address();
        probe.close(() => resolve(picked));
      });
    });
    if ((await listening(port)) && (await listening(port + 1))) return port;
  }
  throw new Error('could not find two adjacent free ports');
}

const port = await adjacentFreePorts();
const bridge = new Bridge({ token: 'test-token', logger: { info() {}, warn() {}, error() {} } });

// Occupy the preferred port so the server has to move one up.
const squatter = net.createServer();
await new Promise((done) => squatter.listen(port, '127.0.0.1', done));

const server = createBridgeServer({ bridge, port, logger: { info() {}, warn() {}, error() {} } });
try {
  await server.listen();
  check('falls back to the next port when the first is busy', server.port === port + 1, `${server.port} vs ${port + 1}`);
  check('endpoint reflects the bound port', server.endpoint === `ws://127.0.0.1:${port + 1}/edge-bridge`, server.endpoint);
  check('bridge knew the final endpoint', bridge.endpoint === server.endpoint, bridge.endpoint);

  const ping = await fetch(`http://127.0.0.1:${server.port}/edge-bridge/ping`).then((response) => response.json());
  check('ping identifies the bridge', ping.ok === true && ping.name === 'dsh-edge-bridge' && ping.protocol === 1, JSON.stringify(ping));
  check('ping reports the real port', ping.port === server.port && ping.path === '/edge-bridge', JSON.stringify(ping));

  const unknown = await fetch(`http://127.0.0.1:${server.port}/nope`);
  check('unknown http path is a 404', unknown.status === 404, String(unknown.status));

  const squatted = await fetch(`http://127.0.0.1:${port}/edge-bridge/ping`, { signal: AbortSignal.timeout(1000) }).then(
    (response) => `answered ${response.status}`,
    (error) => String(error.cause?.code ?? error.name ?? error.message),
  );
  check('a foreign listener does not look like the bridge', !squatted.startsWith('answered'), squatted);

  // ---- websocket routing --------------------------------------------------
  const upgrade = (path) =>
    new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port: server.port,
        path,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': Buffer.from('dsh-edge-bridge-test').toString('base64'),
        },
      });
      req.on('upgrade', (response, socket) => {
        socket.destroy();
        resolve({ status: response.statusCode, accept: response.headers['sec-websocket-accept'] });
      });
      req.on('response', (response) => resolve({ status: response.statusCode }));
      req.on('error', (error) => resolve({ status: 'error', error: String(error.message) }));
      req.end();
    });

  const good = await upgrade('/edge-bridge');
  const sentKey = Buffer.from('dsh-edge-bridge-test').toString('base64');
  const expected = createHash('sha1')
    .update(`${sentKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  check('upgrade on the bridge path is accepted', good.status === 101, JSON.stringify(good));
  check('handshake key is correct', good.accept === expected, `${good.accept} vs ${expected}`);

  const wrongPath = await upgrade('/other');
  check('upgrade on another path is refused', wrongPath.status !== 101, JSON.stringify(wrongPath));

  await sleep(50);
  check('rejected socket never became a connection', bridge.list().length === 0, String(bridge.list().length));
} finally {
  await server.close();
  // The squatter may still hold an aborted probe socket; dropping it is enough.
  squatter.closeAllConnections?.();
  squatter.close();
  squatter.unref?.();
  bridge.dispose();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);