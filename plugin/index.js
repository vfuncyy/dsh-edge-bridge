/**
 * dsh-edge-bridge — attach DeepSeek Harness to the user's real Microsoft Edge.
 *
 * The plugin owns one small websocket listener on a FIXED loopback port
 * (default 17333). A small MV3 extension in Edge dials it, and every `edge_*`
 * tool becomes an ordinary request/response call over that socket.
 *
 * The browser tools are registered LAZILY: only the tiny `edge_bridge` control
 * tool exists until the user asks for browser access, so an idle session pays
 * no context cost for a bridge it is not using.
 *
 * @module dsh-edge-bridge
 */
import { Bridge } from './lib/bridge.js';
import { createCapture } from './lib/capture.js';
import { createKbSink } from './lib/kb.js';
import { createController } from './lib/controller.js';
import { DEFAULT_PORT, createBridgeServer } from './lib/server.js';
import { ensureToken } from './lib/token.js';

/** Cordis plugin name. */
export const name = 'edge-bridge';

/** The tool registry is the only Host service this plugin needs. */
export const inject = ['tools'];

const BRIDGE_PATH = '/edge-bridge';

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{
 *   port?: number,
 *   token?: string,
 *   autoStart?: boolean,
 *   idleTimeoutMinutes?: number,
 *   stopWhenDisconnected?: boolean,
 *   captureDir?: string,
 *   captureTitle?: string,
 *   kbRoot?: string,
 *   kbCollection?: string,
 *   kbPython?: string,
 * }} [config]
 */
export function apply(ctx, config = {}) {
  const port = Number.isInteger(config.port) && config.port >= 0 ? config.port : DEFAULT_PORT;
  const tokenInfo = ensureToken(config.token, ctx.logger);
  const bridge = new Bridge({ token: tokenInfo.token, logger: ctx.logger });
  bridge.path = BRIDGE_PATH;
  bridge.tokenFile = tokenInfo.file;
  bridge.port = port;
  // Provisional until the listener reports the port it actually bound.
  bridge.endpoint = `ws://127.0.0.1:${port}${BRIDGE_PATH}`;

  const server = createBridgeServer({ bridge, port, path: BRIDGE_PATH, logger: ctx.logger });
  const listening = server.listen().catch(() => {
    /* already logged by the server */
  });

  // Captured pages belong in the literature knowledge base; the workspace keeps
  // only the per-job summaries.
  const kb = createKbSink({
    config: { kbRoot: config.kbRoot, collection: config.kbCollection, python: config.kbPython },
    logger: ctx.logger,
  });

  // Buttons in the extension only send intent; the capture engine does the work.
  const capture = createCapture({
    bridge,
    ctx,
    logger: ctx.logger,
    config: { dir: config.captureDir, title: config.captureTitle },
    kb,
  });
  const unsubscribeCapture = bridge.onEvent((event) => {
    capture.handleEvent(event).catch((error) => {
      ctx.logger?.warn?.(`edge-bridge: capture event failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  // Materialise the summary workspace up front so it is browsable before the
  // first button press. `workingDirectory` may be provided after this bundle
  // loads, so re-check once: a provisional location is then moved and the
  // workspace re-registered at the deployment's own workspace area.
  capture.ensure().catch(() => {
    /* logged inside the engine */
  });
  const captureRecheck = setTimeout(() => {
    capture.ensure().catch(() => {
      /* logged inside the engine */
    });
  }, 4000);
  captureRecheck.unref?.();

  const controller = createController({ ctx, bridge, config, capture });

  // Every browser round trip counts as activity for the idle timer.
  const request = bridge.request.bind(bridge);
  bridge.request = (...args) => {
    controller.touch();
    return request(...args);
  };

  if (config.autoStart === true) controller.start();

  ctx.logger?.info?.(
    `edge-bridge: pairing token ${tokenInfo.source === 'config' ? 'from config' : `in ${tokenInfo.file ?? 'memory'}`}; browser tools ${controller.active ? 'on' : 'off until edge_bridge start'}; captures → ${kb.attachDir}${kb.available() ? '' : ' (knowledge base not found)'}`,
  );

  ctx.effect(() => () => {
    clearTimeout(captureRecheck);
    try {
      controller.dispose();
    } catch {
      /* already released */
    }
    try {
      unsubscribeCapture();
    } catch {
      /* already released */
    }
    try {
      kb.dispose();
    } catch {
      /* already released */
    }
    listening.then(() => server.close()).catch(() => {});
    bridge.dispose();
  });
}