/**
 * The dedicated loopback listener the Edge extension dials.
 *
 * It is separate from the Host's Web UI server on purpose: the GUI port can
 * change between launches (2556 → 4590 → …), which would silently break every
 * paired extension. A small fixed port keeps the address stable, and the
 * `/edge-bridge/ping` route lets the extension discover it even when the first
 * choice was taken.
 *
 * @module dsh-edge-bridge/server
 */
import http from 'node:http';

export const DEFAULT_PORT = 17333;
/** How many consecutive ports to try when the preferred one is busy. */
const SCAN_RANGE = 12;

/**
 * @param {object} options
 * @param {import('./bridge.js').Bridge} options.bridge
 * @param {number} [options.port]
 * @param {string} [options.host]
 * @param {string} [options.path]
 * @param {{ info?: Function, warn?: Function, error?: Function }} [options.logger]
 */
export function createBridgeServer({ bridge, port = DEFAULT_PORT, host = '127.0.0.1', path = '/edge-bridge', logger, scanRange = SCAN_RANGE }) {
  const routePath = path.startsWith('/') ? path : `/${path}`;
  const pingPath = `${routePath}/ping`;

  let server = null;
  let actualPort = port;

  function handleRequest(req, res) {
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname !== pingPath && pathname !== '/') {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }
    const body = JSON.stringify({ ok: true, name: 'dsh-edge-bridge', protocol: 1, path: routePath, port: actualPort });
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(body);
  }

  function handleUpgrade(req, socket, head) {
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname !== routePath) {
      socket.destroy();
      return;
    }
    try {
      bridge.handleUpgrade(req, socket, head);
    } catch (error) {
      logger?.warn?.(`edge-bridge: upgrade failed: ${String((error && error.message) || error)}`);
      socket.destroy();
    }
  }

  async function listenOnce(candidate) {
    const candidateServer = http.createServer(handleRequest);
    candidateServer.on('upgrade', handleUpgrade);
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        candidateServer.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        candidateServer.removeListener('error', onError);
        resolve();
      };
      candidateServer.once('error', onError);
      candidateServer.once('listening', onListening);
      candidateServer.listen({ port: candidate, host, exclusive: true });
    });
    candidateServer.on('error', (error) => logger?.error?.(`edge-bridge: listener error: ${String((error && error.message) || error)}`));
    return candidateServer;
  }

  const server_ = {
    get port() {
      return actualPort;
    },
    get endpoint() {
      return `ws://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}${routePath}`;
    },
    get path() {
      return routePath;
    },
    /** Bind the first free port in `[port, port + scanRange)`. */
    async listen() {
      let lastError;
      for (let offset = 0; offset < Math.max(1, scanRange); offset += 1) {
        const candidate = port === 0 ? 0 : port + offset;
        try {
          server = await listenOnce(candidate);
          actualPort = server.address().port;
          bridge.endpoint = server_.endpoint;
          bridge.port = actualPort;
          logger?.info?.(`edge-bridge: extension endpoint ${server_.endpoint}${offset > 0 ? ` (port ${port} was busy)` : ''}`);
          return server_;
        } catch (error) {
          lastError = error;
          if (error?.code !== 'EADDRINUSE') break;
        }
      }
      logger?.error?.(`edge-bridge: could not bind a loopback port near ${port}: ${String((lastError && lastError.message) || lastError)}`);
      throw lastError ?? new Error(`could not bind a port near ${port}`);
    },
    async close() {
      if (!server) return;
      const closing = server;
      server = null;
      await new Promise((resolve) => closing.close(() => resolve()));
    },
  };

  return server_;
}