/**
 * Minimal RFC 6455 WebSocket server side, dependency free.
 *
 * The Host composition already owns a loopback HTTP listener, so the bridge
 * rides it through `webServer.registerUpgrade` instead of binding a port of
 * its own. Only what a browser extension peer needs is implemented: the
 * opening handshake, masked client frames, text/binary messages with
 * fragmentation, ping/pong, and a clean close handshake.
 *
 * @module dsh-edge-bridge/ws
 */
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CODE = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

/** Compute the `Sec-WebSocket-Accept` value for a client key. */
export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** A websocket upgrade request is only meaningful on GET with version 13. */
export function isWebSocketRequest(req) {
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  return req.method === 'GET' && upgrade === 'websocket';
}

/** Refuse a malformed handshake without leaving the socket half-open. */
function rejectHandshake(socket, status, reason, extraHeaders = {}) {
  const lines = [
    `HTTP/1.1 ${status} ${reason}`,
    'Connection: close',
    'Content-Length: 0',
    'Content-Type: text/plain',
    ...Object.entries(extraHeaders).map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ];
  try {
    socket.write(lines.join('\r\n'));
  } catch {
    /* the peer may already be gone */
  }
  socket.destroy();
}

/**
 * One accepted peer connection.
 *
 * Emits exactly two events: `message` (a string for text frames, a Buffer for
 * binary frames) and `close` (`{ code, reason }`).
 */
export class WsConnection {
  /**
   * @param {import('node:net').Socket} socket the upgraded TCP socket
   * @param {import('node:http').IncomingMessage} req the handshake request
   * @param {Buffer} head bytes that arrived with the handshake
   * @param {{ maxMessageBytes?: number }} [options]
   */
  constructor(socket, req, head, options = {}) {
    this.socket = socket;
    this.req = req;
    this.maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
    /** @type {Map<string, Function[]>} */
    this.listeners = { message: [], close: [], error: [] };
    this.closed = false;
    this.closeSent = false;
    this.closeEmitted = false;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragOpcode = null;
    this.fragSize = 0;
    this.lastSeenAt = Date.now();

    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (error) => this.#emit('error', error));
    socket.on('close', () => this.#onSocketClose());
    socket.setTimeout(0);
    socket.setNoDelay?.(true);
    if (head && head.length > 0) this.#onData(head);
  }

  /** Complete the opening handshake and return the live connection. */
  static accept(req, socket, head, options = {}) {
    if (!isWebSocketRequest(req)) {
      rejectHandshake(socket, 400, 'Bad Request');
      return undefined;
    }
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    if (typeof key !== 'string' || key.length === 0) {
      rejectHandshake(socket, 400, 'Bad Request');
      return undefined;
    }
    if (String(version) !== '13') {
      rejectHandshake(socket, 426, 'Upgrade Required', { 'Sec-WebSocket-Version': '13' });
      return undefined;
    }
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '\r\n',
    ];
    socket.write(headers.join('\r\n'));
    return new WsConnection(socket, req, head, options);
  }

  /** @param {'message'|'close'|'error'} name */
  on(name, listener) {
    const bucket = this.listeners[name];
    if (bucket === undefined) throw new Error(`ws: unknown event ${name}`);
    bucket.push(listener);
    return () => {
      const at = bucket.indexOf(listener);
      if (at !== -1) bucket.splice(at, 1);
    };
  }

  #emit(name, ...args) {
    for (const listener of [...this.listeners[name]]) {
      try {
        listener(...args);
      } catch {
        /* a peer listener must not break framing */
      }
    }
  }

  /** Send one JSON-serialisable text message. */
  sendText(text) {
    if (this.closed || !this.socket.writable) return false;
    const payload = Buffer.from(text, 'utf8');
    this.#writeFrame(OP_CODE.TEXT, payload);
    return true;
  }

  /** Send one JavaScript value as JSON. */
  sendJson(value) {
    try {
      return this.sendText(JSON.stringify(value));
    } catch {
      return false;
    }
  }

  /** Send a protocol-level ping; a peer pong refreshes {@link lastSeenAt}. */
  ping() {
    if (this.closed) return;
    this.#writeFrame(OP_CODE.PING, Buffer.alloc(0));
  }

  /** Start the closing handshake and stop accepting frames afterwards. */
  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    if (!this.closeSent) {
      this.closeSent = true;
      try {
        const reasonBytes = Buffer.from(String(reason), 'utf8').subarray(0, 123);
        const payload = Buffer.alloc(2 + reasonBytes.length);
        payload.writeUInt16BE(Number.isInteger(code) ? code : 1000, 0);
        reasonBytes.copy(payload, 2);
        this.#writeFrame(OP_CODE.CLOSE, payload);
      } catch {
        /* ignore */
      }
    }
    try {
      this.socket.end();
      setTimeout(() => this.socket.destroy(), 1000).unref?.();
    } catch {
      /* ignore */
    }
  }

  /** Drop the socket immediately, without a closing handshake. */
  terminate() {
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
  }

  #writeFrame(opcode, payload) {
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(length, 6);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this.terminate();
    }
  }

  #onSocketClose() {
    this.closed = true;
    this.#emitClose({ code: 1006, reason: 'socket closed' });
  }

  #emitClose(info) {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.#emit('close', info);
  }

  #onData(chunk) {
    this.lastSeenAt = Date.now();
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    // Parse as many complete frames as the buffer currently holds.
    while (!this.closed && this.#parseFrame()) {
      /* drained below */
    }
  }

  #parseFrame() {
    const buffer = this.buffer;
    if (buffer.length < 2) return false;
    const b0 = buffer[0];
    const b1 = buffer[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let offset = 2;
    if (rsv !== 0) {
      this.close(1002, 'reserved bits must be zero');
      return false;
    }
    if (length === 126) {
      if (buffer.length < 4) return false;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return false;
      const high = buffer.readUInt32BE(2);
      const low = buffer.readUInt32BE(6);
      if (high !== 0) {
        this.close(1009, 'message too big');
        return false;
      }
      length = low;
      offset = 10;
    }
    if (opcode >= 0x8 && (length > 125 || !fin)) {
      this.close(1002, 'invalid control frame');
      return false;
    }
    if (!masked) {
      this.close(1002, 'client frames must be masked');
      return false;
    }
    if (length > this.maxMessageBytes) {
      this.close(1009, 'message too big');
      return false;
    }
    if (buffer.length < offset + 4 + length) return false;
    const mask = buffer.subarray(offset, offset + 4);
    const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index & 3];
    this.buffer = buffer.subarray(offset + 4 + length);
    this.#handleFrame(fin, opcode, payload);
    return true;
  }

  #handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case OP_CODE.PING:
        this.#writeFrame(OP_CODE.PONG, payload);
        return;
      case OP_CODE.PONG:
        return;
      case OP_CODE.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        this.closed = true;
        this.closeSent = true;
        try {
          this.socket.end();
        } catch {
          /* ignore */
        }
        this.#emitClose({ code, reason });
        return;
      }
      case OP_CODE.TEXT:
      case OP_CODE.BINARY:
        if (this.fragOpcode !== null) {
          this.close(1002, 'new data frame inside a fragmented message');
          return;
        }
        if (fin) {
          this.#deliver(opcode, payload);
          return;
        }
        this.fragOpcode = opcode;
        this.fragments = [payload];
        this.fragSize = payload.length;
        return;
      case OP_CODE.CONT: {
        if (this.fragOpcode === null) {
          this.close(1002, 'continuation frame without a start frame');
          return;
        }
        this.fragments.push(payload);
        this.fragSize += payload.length;
        if (this.fragSize > this.maxMessageBytes) {
          this.close(1009, 'message too big');
          return;
        }
        if (!fin) return;
        const started = this.fragOpcode;
        const whole = Buffer.concat(this.fragments);
        this.fragOpcode = null;
        this.fragments = [];
        this.fragSize = 0;
        this.#deliver(started, whole);
        return;
      }
      default:
        this.close(1002, `unsupported opcode ${opcode}`);
    }
  }

  #deliver(opcode, payload) {
    if (opcode === OP_CODE.TEXT) this.#emit('message', payload.toString('utf8'));
    else this.#emit('message', payload, true);
  }
}