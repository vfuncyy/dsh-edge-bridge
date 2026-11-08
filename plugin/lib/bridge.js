/**
 * The DSH side of the browser bridge.
 *
 * One websocket endpoint accepts Edge extension peers, authenticates the
 * pairing token, and multiplexes request/response calls plus unsolicited
 * events. Whatever survives here must behave like a service: no per-tool
 * connection state, and a clear failure when no browser is attached.
 *
 * @module dsh-edge-bridge/bridge
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WsConnection } from './ws.js';
import { tokenMatches } from './token.js';

const HELLO_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 20_000;
const IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = 1;

/** Read the plugin version from its own package.json so it cannot drift. */
function readServerVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' && manifest.version ? manifest.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const SERVER_VERSION = readServerVersion();

/**
 * Every method this host knows how to drive. Sent in the hello reply so an
 * older extension can see what it will be asked for, and so a mismatch shows
 * up at handshake time instead of as a mystery failure mid-task.
 */
const HOST_CAPS = [
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
];

/** Stable public view of one attached extension. */
function describe(conn) {
  return {
    id: conn.id,
    authorized: conn.authorized,
    extension: conn.extension ?? null,
    browser: conn.browser ?? null,
    remote: conn.remote,
    connectedAt: conn.connectedAt,
    lastSeenAt: conn.lastSeenAt,
    protocol: conn.protocol ?? null,
    pending: conn.pending.size,
    tabs: conn.tabCount ?? null,
    caps: Array.isArray(conn.caps) ? conn.caps.slice() : [],
    hostCaps: HOST_CAPS.slice(),
  };
}

export class Bridge {
  /**
   * @param {{ token: string, logger?: { warn: Function, info?: Function }, timing?: object }} options
   */
  constructor({ token, logger, timing }) {
    this.token = token;
    this.logger = logger;
    // Timings are injectable so the transport can be exercised without waiting
    // a full heartbeat interval.
    this.timing = {
      helloTimeoutMs: HELLO_TIMEOUT_MS,
      pingIntervalMs: PING_INTERVAL_MS,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      ...(timing ?? {}),
    };
    /** @type {Set<object>} */
    this.conns = new Set();
    /** @type {Map<string, { resolve: Function, reject: Function, timer: any, method: string }>} */
    this.pending = new Map();
    this.seq = 0;
    this.connSeq = 0;
    this.disposed = false;
    /** @type {Set<Function>} */
    this.listeners = new Set();
    /** @type {Set<Function>} */
    this.eventListeners = new Set();
    this.lastError = '';
    this.acceptedConnections = 0;
  }

  /** Subscribe to connection-state changes. */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Subscribe to unsolicited events the extension pushes (capture buttons,
   * tab announcements). Listeners are called with `{ name, data, connectionId }`
   * and must not throw: a broken listener may not drop the frame.
   */
  onEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  #notify() {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* observers must not break the bridge */
      }
    }
  }

  /** Handle one HTTP upgrade on the bridge path. */
  handleUpgrade(req, socket, head) {
    if (this.disposed) {
      socket.destroy();
      return;
    }
    let conn;
    try {
      conn = WsConnection.accept(req, socket, head);
    } catch (error) {
      this.logger?.warn?.(`edge-bridge: handshake failed: ${error instanceof Error ? error.message : String(error)}`);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      return;
    }
    if (conn === undefined) return; // the helper already answered and closed
    this.#attach(conn, req);
  }

  #attach(ws, req) {
    this.acceptedConnections += 1;
    const conn = {
      id: `edge-${++this.connSeq}`,
      ws,
      req,
      authorized: false,
      extension: null,
      browser: null,
      protocol: null,
      caps: [],
      remote: req.socket?.remoteAddress ?? 'unknown',
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      lastPongAt: Date.now(),
      pending: new Map(),
      tabCount: null,
      authTimer: null,
      pingTimer: null,
    };
    this.conns.add(conn);
    conn.authTimer = setTimeout(() => {
      if (!conn.authorized) ws.close(4008, 'hello timeout');
    }, this.timing.helloTimeoutMs);
    conn.authTimer.unref?.();

    ws.on('message', (raw) => this.#onMessage(conn, raw));
    ws.on('close', (info) => this.#detach(conn, info));
    ws.on('error', () => {
      /* a peer error is reported through close */
    });

    conn.pingTimer = setInterval(() => {
      if (conn.ws.closed) return;
      if (Date.now() - conn.lastPongAt > this.timing.idleTimeoutMs) {
        conn.ws.close(4001, 'idle timeout');
        return;
      }
      // Browser JS cannot observe protocol-level ping frames, so liveness is
      // probed with an application-level heartbeat as well.
      conn.ws.sendJson({ t: 'ping', ts: Date.now() });
      conn.ws.ping();
    }, this.timing.pingIntervalMs);
    conn.pingTimer.unref?.();
    this.#notify();
    return conn;
  }

  #detach(conn, info) {
    if (conn.authTimer !== null) clearTimeout(conn.authTimer);
    if (conn.pingTimer !== null) clearInterval(conn.pingTimer);
    this.conns.delete(conn);
    for (const [id, entry] of conn.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`edge bridge: the browser extension disconnected while running "${entry.method}" (${info?.code ?? 'closed'})`));
      conn.pending.delete(id);
    }
    this.#notify();
  }

  #onMessage(conn, raw) {
    conn.lastSeenAt = Date.now();
    if (typeof raw !== 'string') return;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message === null || typeof message !== 'object') return;
    const kind = message.t;

    if (kind === 'hello') {
      if (conn.authorized) return;
      const supplied = typeof message.token === 'string' ? message.token : '';
      if (!tokenMatches(this.token, supplied)) {
        this.lastError = 'the browser extension presented a wrong pairing token';
        conn.ws.sendJson({ t: 'hello', ok: false, error: 'invalid pairing token' });
        conn.ws.close(4003, 'invalid pairing token');
        return;
      }
      conn.authorized = true;
      conn.extension = message.extension ?? null;
      conn.browser = message.browser ?? null;
      conn.protocol = typeof message.protocol === 'number' ? message.protocol : PROTOCOL_VERSION;
      conn.caps = Array.isArray(message.caps) ? message.caps.filter((cap) => typeof cap === 'string') : [];
      if (conn.authTimer !== null) clearTimeout(conn.authTimer);
      conn.authTimer = null;
      conn.ws.sendJson({
        t: 'hello',
        ok: true,
        protocol: PROTOCOL_VERSION,
        server: { name: 'dsh-edge-bridge', version: SERVER_VERSION },
        caps: HOST_CAPS,
      });
      this.lastError = '';
      const missing = HOST_CAPS.filter((cap) => !conn.caps.includes(cap));
      if (conn.caps.length === 0) {
        // An extension built before capability reporting still works: it just
        // cannot be checked up front, so a stale build only shows up the first
        // time an unsupported method is called. Say so precisely instead of
        // claiming every capability is missing.
        this.logger?.warn?.(
          `edge-bridge: the connected extension did not report its capabilities, so it is still running a build from before v0.3.0 (a service-worker restart re-reads manifest.json but keeps the old background.js). Calls work; the first unimplemented method will fail with "does not implement". Reload the unpacked extension in edge://extensions to pick up the new build.`,
        );
      } else if (missing.length > 0) {
        this.logger?.warn?.(
          `edge-bridge: the connected extension does not implement ${missing.join(', ')} — reload the unpacked extension in edge://extensions. Calls to those methods will fail with "does not implement".`,
        );
      }
      this.logger?.info?.(`edge-bridge: ${conn.extension?.name ?? 'extension'} ${conn.extension?.version ?? ''} connected from ${conn.remote}`);
      this.#notify();
      return;
    }

    if (!conn.authorized) {
      conn.ws.close(4003, 'hello required before any other message');
      return;
    }

    if (kind === 'pong') {
      conn.lastPongAt = Date.now();
      return;
    }

    if (kind === 'event') {
      if (message.name === 'tabs') conn.tabCount = Number.isFinite(message.data?.count) ? message.data.count : conn.tabCount;
      for (const listener of [...this.eventListeners]) {
        try {
          listener({ name: message.name, data: message.data, connectionId: conn.id });
        } catch (error) {
          this.logger?.warn?.(`edge-bridge: event listener failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return;
    }

    if (kind === 'res') {
      const entry = conn.pending.get(message.id);
      if (entry === undefined) return;
      conn.pending.delete(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.value);
      else entry.reject(new Error(String(message.error ?? 'the browser extension reported an error')));
      return;
    }
  }

  /** Attached peers, authorized first, newest first. */
  list() {
    return [...this.conns]
      .filter((conn) => conn.authorized)
      .sort((left, right) => right.connectedAt - left.connectedAt)
      .map(describe);
  }

  /** The peer a tool call should use, or undefined when none is attached. */
  primary() {
    return this.list()[0];
  }

  /** True when at least one paired extension is attached. */
  get connected() {
    return this.list().length > 0;
  }

  /** Human-readable reason for the last rejected handshake. */
  get error() {
    return this.lastError;
  }

  #connection(id) {
    if (id === undefined || id === null) {
      const first = this.primary();
      if (first === undefined) {
        throw new Error(
          'the Edge extension is not connected. Ask the user to open the "DSH Edge Bridge" extension in Microsoft Edge and press Connect (the pairing token is shown by edge_bridge action:"status").',
        );
      }
      return [...this.conns].find((conn) => conn.id === first.id);
    }
    const found = [...this.conns].find((conn) => conn.id === id);
    if (found === undefined) throw new Error(`edge bridge: unknown connection "${id}"`);
    return found;
  }

  /**
   * Call one method on the extension and await its answer.
   * @param {string} method
   * @param {object} [params]
   * @param {{ timeoutMs?: number, connectionId?: string }} [options]
   */
  request(method, params = {}, options = {}) {
    const conn = this.#connection(options.connectionId);
    if (Array.isArray(conn.caps) && conn.caps.length > 0 && !conn.caps.includes(method)) {
      return Promise.reject(
        new Error(
          `edge bridge: the connected extension does not implement "${method}". It reports: ${conn.caps.join(', ') || '(none)'} — reload the unpacked extension in edge://extensions so it matches this plugin (v${SERVER_VERSION}).`,
        ),
      );
    }
    const id = String(++this.seq);
    const timeoutMs = options.timeoutMs ?? this.timing.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        this.pending.delete(id);
        reject(new Error(`edge bridge: "${method}" timed out after ${timeoutMs}ms (the page may still be loading, or the extension stopped responding)`));
      }, timeoutMs);
      timer.unref?.();
      const entry = { resolve, reject, timer, method };
      conn.pending.set(id, entry);
      this.pending.set(id, entry);
      const sent = conn.ws.sendJson({ t: 'req', id, method, params });
      if (!sent) {
        clearTimeout(timer);
        conn.pending.delete(id);
        this.pending.delete(id);
        reject(new Error('edge bridge: the browser extension connection is closing'));
      }
    });
  }

  /** Send an unsolicited event to every authorized peer. */
  broadcast(name, data) {
    for (const conn of this.conns) {
      if (!conn.authorized) continue;
      conn.ws.sendJson({ t: 'event', name, data });
    }
  }

  /** Release every peer and timer owned by this bridge. */
  dispose() {
    this.disposed = true;
    for (const conn of [...this.conns]) {
      conn.ws.close(1001, 'host shutting down');
      if (conn.authTimer !== null) clearTimeout(conn.authTimer);
      if (conn.pingTimer !== null) clearInterval(conn.pingTimer);
      this.conns.delete(conn);
    }
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('edge bridge: the host is shutting down'));
      this.pending.delete(id);
    }
    this.#notify();
  }
}