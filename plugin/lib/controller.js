/**
 * Lazy activation of the Edge tool surface.
 *
 * The seven browser tools are expensive to keep in context, so they are NOT
 * registered at load time. Only a single small `edge_bridge` tool is always
 * available; it turns the rest on (`action: "start"`) or off (`action: "stop"`),
 * and reports the pairing state (`action: "status"`).
 *
 * @module dsh-edge-bridge/controller
 */
import { registerEdgeTools } from './tools.js';

const SWEEP_INTERVAL_MS = 30_000;
/** How long a vanished extension keeps the toolset alive, so a reconnect does not flap. */
const DISCONNECT_GRACE_MS = 60_000;

const CONTROL_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['start', 'stop', 'status'],
      description: 'start = register the Edge browser tools, stop = remove them again, status = report the pairing state without registering anything.',
    },
  },
  required: ['action'],
};

/**
 * @param {object} options
 * @param {object} options.ctx Cordis context (needs `tools`).
 * @param {import('./bridge.js').Bridge} options.bridge
 * @param {{ idleTimeoutMinutes?: number, stopWhenDisconnected?: boolean, path?: string }} [options.config]
 * @param {{ status: () => { dir: string, pages: number, failed: number } }} [options.capture]
 */
export function createController({ ctx, bridge, config = {}, capture }) {
  const idleTimeoutMs = Math.max(0, Number(config.idleTimeoutMinutes ?? 30) || 0) * 60_000;
  const stopWhenDisconnected = config.stopWhenDisconnected !== false;

  let releaseTools = null;
  let sweeper = null;
  let disconnectTimer = null;

  const state = {
    active: false,
    since: 0,
    lastUsedAt: 0,
    activations: 0,
    deactivatedBecause: '',
  };

  const endpoint = () => bridge.endpoint ?? `ws://<host>:<port>${config.path ?? '/edge-bridge'}`;

  function connectionSummary() {
    const connections = bridge.list();
    if (connections.length === 0) {
      return 'No Edge extension is connected yet. Open the "DSH Edge Bridge" extension in Microsoft Edge and press Connect (the pairing token is below).';
    }
    return connections
      .map((connection) => {
        const browser = connection.browser ? `Microsoft Edge ${connection.browser.version ?? ''}`.trim() : 'a browser';
        const extension = connection.extension ? `, extension ${connection.extension.name ?? '?'} ${connection.extension.version ?? ''}`.trim() : '';
        return `- ${connection.id}: ${browser}${extension} from ${connection.remote}`;
      })
      .join('\n');
  }

  function pairingText() {
    return [
      `Bridge endpoint: ${endpoint()}`,
      `Pairing token: ${bridge.token ?? '(unknown)'}`,
      `Token file: ${bridge.tokenFile ?? '(in memory only)'}`,
    ].join('\n');
  }

  function captureText() {
    if (!capture) return '';
    const info = capture.status();
    const kb = info.kb ?? {};
    const failed = info.failed > 0 ? `, ${info.failed} failed` : '';
    const sync =
      typeof kb.lastSyncError === 'string' && kb.lastSyncError !== ''
        ? `last KB sync failed: ${kb.lastSyncError}`
        : typeof kb.lastSyncResult === 'string' && kb.lastSyncResult !== ''
          ? `KB: ${kb.lastSyncResult}`
          : 'KB: no capture synced yet';
    return [
      `Capture summaries: ${info.dir} (${info.jobs ?? 0} job(s)${failed})`,
      `Knowledge base: ${kb.root ?? '(not configured)'} → ${kb.collection ?? '页面抓取'}`,
      `Snapshot folder: ${kb.dir ?? '(unavailable)'}${kb.saved > 0 ? ` — ${kb.saved} page(s) synced this session` : ''}`,
      sync,
    ].join('\n');
  }

  function armSweeper() {
    disarmSweeper();
    if (idleTimeoutMs <= 0 && !stopWhenDisconnected) return;
    sweeper = setInterval(() => {
      if (!state.active) return;
      if (idleTimeoutMs > 0 && Date.now() - state.lastUsedAt > idleTimeoutMs) {
        stop(`idle for ${Math.round(idleTimeoutMs / 60_000)} min`);
      }
    }, SWEEP_INTERVAL_MS);
    sweeper.unref?.();
  }

  function disarmSweeper() {
    if (sweeper) clearInterval(sweeper);
    sweeper = null;
    if (disconnectTimer) clearTimeout(disconnectTimer);
    disconnectTimer = null;
  }

  function watchConnections() {
    if (!stopWhenDisconnected) return () => {};
    return bridge.onChange(() => {
      if (!state.active) return;
      if (bridge.list().length > 0) {
        if (disconnectTimer) clearTimeout(disconnectTimer);
        disconnectTimer = null;
        return;
      }
      if (disconnectTimer) return;
      disconnectTimer = setTimeout(() => {
        disconnectTimer = null;
        if (state.active && bridge.list().length === 0) stop('the Edge extension disconnected');
      }, DISCONNECT_GRACE_MS);
      disconnectTimer.unref?.();
    });
  }

  function start() {
    if (state.active) return false;
    releaseTools = registerEdgeTools(ctx, bridge);
    state.active = true;
    state.since = Date.now();
    state.lastUsedAt = Date.now();
    state.activations += 1;
    state.deactivatedBecause = '';
    armSweeper();
    return true;
  }

  function stop(reason = 'stopped on request') {
    if (!state.active) return false;
    try {
      releaseTools?.();
    } catch {
      /* already released */
    }
    releaseTools = null;
    state.active = false;
    state.deactivatedBecause = reason;
    disarmSweeper();
    return true;
  }

  /** Called for every browser round trip so the idle timer tracks real use. */
  function touch() {
    if (state.active) state.lastUsedAt = Date.now();
  }

  const unwatch = watchConnections();

  const controlTool = {
    name: 'edge_bridge',
    description:
      'Turn the Microsoft Edge browser tools on or off. They are NOT registered by default so they cost no context: call edge_bridge(action:"start") only when the user asks to read, scrape, or drive their Edge browser, then use edge_tabs / edge_read / edge_eval / edge_act / edge_screenshot. Call edge_bridge(action:"stop") when the browser work is finished. action:"status" reports the pairing state (endpoint and token) without enabling anything.',
    parameters: CONTROL_SCHEMA,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args) {
      const action = String(args?.action ?? 'status');

      if (action === 'start') {
        let started = false;
        try {
          started = start();
        } catch (error) {
          return { text: `Could not enable the Edge browser tools: ${String((error && error.message) || error)}`, active: state.active };
        }
        const connections = bridge.list().length;
        const head = started
          ? 'Edge browser tools are ON — edge_tabs, edge_inspect, edge_read, edge_eval, edge_act and edge_screenshot become available from the next model step.'
          : 'Edge browser tools were already ON.';
        const extra = [captureText(), started && connections === 0 ? pairingText() : ''].filter((part) => part !== '').join('\n\n');
        return {
          text: `${head}\n\n${connectionSummary()}${extra === '' ? '' : `\n\n${extra}`}`.trim(),
          active: true,
          connections,
        };
      }

      if (action === 'stop') {
        const stopped = stop();
        return {
          text: stopped
            ? 'Edge browser tools are OFF — the seven edge_* tools were removed from context. Call edge_bridge(action:"start") to bring them back; the websocket connection itself stays up.'
            : 'Edge browser tools were already OFF. The extension can stay connected; only the tools were unregistered.',
          active: false,
        };
      }

      const lines = [
        state.active
          ? `Browser tools: ON since ${new Date(state.since).toISOString()} (${state.activations} activation(s) this session)`
          : 'Browser tools: OFF (they are registered only between edge_bridge start and stop, so they cost no context now)',
        state.active ? '' : state.deactivatedBecause ? `Last deactivation: ${state.deactivatedBecause}` : '',
        `Connections: ${bridge.list().length}`,
        connectionSummary(),
        '',
        captureText(),
        '',
        pairingText(),
      ];
      return { text: lines.filter((line, index) => line !== '' || index < 2 || lines[index - 1] !== '').join('\n'), active: state.active };
    },
  };

  const disposeControlTool = ctx.tools.register(controlTool);

  return {
    start,
    stop,
    touch,
    controlTool,
    get active() {
      return state.active;
    },
    get state() {
      return { ...state };
    },
    dispose() {
      unwatch();
      stop('plugin unloaded');
      disarmSweeper();
      try {
        disposeControlTool();
      } catch {
        /* already released */
      }
    },
  };
}