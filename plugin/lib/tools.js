/**
 * Model-facing tools over the Edge bridge.
 *
 * Every tool renders a compact text report, because the useful payload of a
 * browsing step is prose the model can read, not a JSON tree it has to walk.
 *
 * @module dsh-edge-bridge/tools
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const TAB_FIELDS = {
  tab_id: {
    type: 'integer',
    description:
      'Edge tab id from edge_tabs. Omit to use the active tab of the last focused Edge window.',
  },
};

/** Trim a long single-line string for a report header. */
function clip(value, max) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Format a byte count for humans. */
function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Render a tab table that names the ids the model must pass back. */
/** Render one edge_inspect payload as text. */
function formatInspect(value) {
  if (!value || value.ok === false) return `edge_inspect failed: ${value?.error ?? 'unknown error'}`;
  const interactive = Array.isArray(value.interactive) ? value.interactive : [];
  const lists = Array.isArray(value.lists) ? value.lists : [];
  const lines = [
    value.title || '(untitled)',
    value.url ?? '',
    `${value.readyState ?? '?'} · ${interactive.length}/${value.matchedInteractive ?? interactive.length} interactive · ${lists.length} list(s) · height ${value.scrollHeight ?? '?'}${value.canvasCount ? ` · ${value.canvasCount} canvas` : ''}${value.iframeCount ? ` · ${value.iframeCount} iframe` : ''}`,
  ];
  if (Array.isArray(value.outline) && value.outline.length > 0) {
    lines.push('Outline:');
    for (const heading of value.outline.slice(0, 30)) lines.push(`  ${'  '.repeat(Math.max(0, (heading.level || 1) - 1))}${heading.text}`);
  }
  if (lists.length > 0) {
    lines.push('Lists:');
    for (const list of lists) {
      lines.push(`  ${list.kind} ${list.sel} — ${list.rows} row(s)${list.cols ? ` × ${list.cols}` : ''}`);
      for (const row of (list.sample ?? []).slice(0, 2)) {
        const cells = (Array.isArray(row) ? row : [String(row)]).map((cell) => clip(String(cell ?? ''), 60));
        lines.push(`    | ${cells.join(' | ')} |`);
      }
    }
  }
  if (interactive.length > 0) {
    lines.push('Interactive:');
    for (const element of interactive) {
      const bits = [element.ref ? `${element.ref} ${element.sel}` : element.sel];
      if (element.role) bits.push(`role=${element.role}`);
      if (element.type) bits.push(`type=${element.type}`);
      if (element.checked) bits.push('checked');
      if (element.expanded) bits.push('expanded');
      if (element.value) bits.push(`value=${clip(element.value, 40)}`);
      const label = element.text || element.href || '';
      lines.push(`  ${bits.join(' ')}${label ? ` — ${clip(label, 110)}` : ''}`);
    }
    if (interactive.length < (value.matchedInteractive ?? 0)) {
      lines.push(`  … ${value.matchedInteractive - interactive.length} more — raise max_interactive, or pass selector to focus on one region.`);
    }
    lines.push('Pass a ref (the token before the selector) to edge_act rather than a selector when the page may re-render.');
  } else if ((value.matchedInteractive ?? 0) > 0 || (value.hiddenInteractive ?? 0) > 0) {
    const hidden = value.hiddenInteractive ?? value.matchedInteractive ?? 0;
    lines.push(`${hidden} interactive elements hidden by filter — disabled, invisible, or longer than a control label. Raise max_interactive, drop the filter, or open the cross-origin iframe in its own tab and inspect there.`);
  } else {
    lines.push('No interactive elements matched.');
  }
  return lines.join('\n');
}

function formatTabs(value) {
  const tabs = Array.isArray(value?.tabs) ? value.tabs : [];
  if (tabs.length === 0) {
    if (value?.windowCount === 0) {
      return 'Microsoft Edge is connected but has no window open. Call edge_tabs action="open" — it creates a window when none exists.';
    }
    return 'Microsoft Edge is connected, but no tab matched. Drop "filter" to see every tab.';
  }
  const windows = new Map();
  for (const tab of tabs) {
    const bucket = windows.get(tab.windowId) ?? [];
    bucket.push(tab);
    windows.set(tab.windowId, bucket);
  }
  const lines = [`Microsoft Edge — ${tabs.length} tab(s) in ${windows.size} window(s)`];
  for (const [windowId, bucket] of windows) {
    lines.push('');
    lines.push(`Window ${windowId}${value?.focusedWindowId === windowId ? ' (focused)' : ''}`);
    for (const tab of bucket) {
      const marks = [tab.active ? 'active' : '', tab.pinned ? 'pinned' : '', tab.discarded ? 'discarded' : '', tab.status === 'loading' ? 'loading' : '']
        .filter(Boolean)
        .join(', ');
      lines.push(`  tab ${tab.id}${marks ? ` [${marks}]` : ''} — ${clip(tab.title || '(untitled)', 90)}`);
      lines.push(`      ${clip(tab.url, 200)}`);
    }
  }
  return lines.join('\n');
}

/** Tool definitions bound to one bridge instance. */
export function createEdgeTools({ bridge, ctx }) {
  /** Resolve a writable directory for artifacts such as screenshots. */
  async function artifactDir(exec) {
    try {
      const service = ctx.get?.('workingDirectory');
      const directory = await service?.ensure?.(exec.agent, exec.signal);
      if (typeof directory === 'string' && directory.length > 0) return join(directory, 'edge-artifacts');
    } catch {
      /* fall back to the process directory */
    }
    return join(process.cwd(), 'edge-artifacts');
  }

  const statusTool = {
    name: 'edge_status',
    description:
      'Report whether DeepSeek Harness is attached to the user\'s Microsoft Edge browser. Shows the connected extension version, the attach endpoint, the pairing token the extension needs, and a per-connection summary. Call this first when another edge_* tool says the browser is not connected, or when the user asks whether browser access works.',
    parameters: {
      type: 'object',
      properties: {
        include_tabs: {
          type: 'boolean',
          description: 'Also list open tabs (same output as edge_tabs action=list).',
        },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => [{ type: 'text', text: value.text }] },
    async execute(args) {
      const connections = bridge.list();
      const lines = [];
      lines.push(`Bridge endpoint: ${bridge.endpoint ?? `ws://<host>:<port>${bridge.path ?? '/edge-bridge'}`}`);
      lines.push(`Attached extensions: ${connections.length}`);
      if (connections.length === 0) {
        lines.push('');
        lines.push('Status: NOT CONNECTED — the DSH plugin is listening, but no Edge extension has completed the handshake.');
        if (bridge.error) lines.push(`Last handshake error: ${bridge.error}`);
      }
      for (const connection of connections) {
        lines.push('');
        lines.push(`Connection ${connection.id}${connection.authorized ? '' : ' (unauthenticated)'}`);
        lines.push(`  extension: ${connection.extension?.name ?? 'unknown'} ${connection.extension?.version ?? ''}`.trimEnd());
        lines.push(`  browser:   ${connection.browser?.name ?? 'unknown'} ${connection.browser?.version ?? ''}`.trimEnd());
        lines.push(`  remote:    ${connection.remote}`);
        lines.push(`  since:     ${new Date(connection.connectedAt).toISOString()}`);
        const caps = Array.isArray(connection.caps) ? connection.caps : [];
        if (caps.length === 0) {
          lines.push('  caps:      (not reported — this extension build predates capability reporting, so calls are attempted blindly)');
        } else {
          const missing = connection.hostCaps.filter((cap) => !caps.includes(cap));
          lines.push(`  caps:      ${caps.length} method(s)${missing.length > 0 ? ` — missing ${missing.join(', ')}` : ''}`);
          if (missing.length > 0) {
            lines.push('             Reload the unpacked extension in edge://extensions so it matches this plugin.');
          }
        }
      }
      lines.push('');
      lines.push('Pairing');
      lines.push(`  token: ${bridge.token}`);
      lines.push(`  token file: ${bridge.tokenFile ?? '(configured inline)'}`);
      if (args?.include_tabs === true && connections.length > 0) {
        const value = await bridge.request('tabs.list', {}, { timeoutMs: 20_000 });
        lines.push('');
        lines.push(formatTabs(value));
      }
      return { text: lines.join('\n'), connected: connections.length > 0, connections, token: bridge.token };
    },
  };

  const tabsTool = {
    name: 'edge_tabs',
    description:
      'Work with the user\'s real Microsoft Edge tabs. action=list returns every open tab with the numeric tab id that every other edge_* tool accepts. action=open opens a URL in a new tab (use this before edge_read on a site the user has not opened). action=navigate points an existing tab at a URL, action=activate focuses a tab, action=reload reloads it, action=close closes it. Windows are real browser windows, not an automation sandbox.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'open', 'navigate', 'activate', 'close', 'reload'],
          description: 'Operation to perform. Defaults to list.',
        },
        ...TAB_FIELDS,
        url: { type: 'string', description: 'Target URL for action=open or action=navigate. Include the scheme, e.g. https://example.com.' },
        filter: { type: 'string', description: 'action=list only: keep tabs whose title or URL contains this text (case-insensitive).' },
        limit: { type: 'integer', description: 'action=list only: maximum tabs to return (default 50, max 200).' },
        active: { type: 'boolean', description: 'action=open only: focus the new tab immediately (default true).' },
        wait_for_load: { type: 'boolean', description: 'Wait until the page fires its load event before answering (default true).' },
        wait_for_selector: {
          type: 'string',
          description:
            'action=open or action=navigate: after load, also wait up to 20s for this CSS selector before answering. Use it for pages that render results or content after the load event — it replaces hand-written polling loops.',
        },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => [{ type: 'text', text: value.text }] },
    async execute(args) {
      const action = typeof args?.action === 'string' ? args.action : 'list';
      if (action === 'list') {
        const value = await bridge.request('tabs.list', { filter: args?.filter, limit: args?.limit }, { timeoutMs: 20_000 });
        return { ...value, text: formatTabs(value) };
      }
      if (action === 'open') {
        if (typeof args?.url !== 'string' || args.url.trim().length === 0) throw new Error('edge_tabs action=open requires "url"');
        const value = await bridge.request(
          'tabs.open',
          {
            url: args.url.trim(),
            active: args?.active !== false,
            waitForLoad: args?.wait_for_load !== false,
            waitForSelector: typeof args?.wait_for_selector === 'string' ? args.wait_for_selector : undefined,
          },
          { timeoutMs: 45_000 },
        );
        const tab = value?.tab ?? {};
        const waited = value?.waited;
        const lines = [`Opened tab ${tab.id}${tab.active ? ' (focused)' : ''} — ${clip(tab.title || '(loading)', 90)}`, tab.url ?? args.url];
        if (waited) lines.push(waited.found ? `settled: ${waited.selector} present` : `NOT settled: ${waited.selector} never appeared`);
        return { ...value, text: lines.join('\n') };
      }
      if (action === 'navigate') {
        if (typeof args?.url !== 'string' || args.url.trim().length === 0) throw new Error('edge_tabs action=navigate requires "url"');
        const value = await bridge.request(
          'tabs.navigate',
          {
            tabId: args?.tab_id,
            url: args.url.trim(),
            waitForLoad: args?.wait_for_load !== false,
            waitForSelector: typeof args?.wait_for_selector === 'string' ? args.wait_for_selector : undefined,
          },
          { timeoutMs: 45_000 },
        );
        const tab = value?.tab ?? {};
        const waited = value?.waited;
        const lines = [`Tab ${tab.id} navigated — ${clip(tab.title || '(loading)', 90)}`, tab.url ?? args.url];
        if (waited) lines.push(waited.found ? `settled: ${waited.selector} present` : `NOT settled: ${waited.selector} never appeared`);
        return { ...value, text: lines.join('\n') };
      }
      if (action === 'activate') {
        if (!Number.isInteger(args?.tab_id)) throw new Error('edge_tabs action=activate requires "tab_id"');
        const value = await bridge.request('tabs.activate', { tabId: args.tab_id }, { timeoutMs: 20_000 });
        const tab = value?.tab ?? {};
        return { ...value, text: `Focused tab ${tab.id} — ${clip(tab.title || '', 90)}` };
      }
      if (action === 'close') {
        if (!Number.isInteger(args?.tab_id)) throw new Error('edge_tabs action=close requires "tab_id"');
        const value = await bridge.request('tabs.close', { tabId: args.tab_id }, { timeoutMs: 20_000 });
        return { ...value, text: `Closed tab ${args.tab_id}.` };
      }
      if (action === 'reload') {
        const value = await bridge.request('tabs.reload', { tabId: args?.tab_id, bypassCache: false }, { timeoutMs: 45_000 });
        const tab = value?.tab ?? {};
        return { ...value, text: `Reloaded tab ${tab.id ?? args?.tab_id} — ${clip(tab.title || '', 90)}` };
      }
      throw new Error(`edge_tabs: unsupported action "${action}"`);
    },
  };

  const readTool = {
    name: 'edge_read',
    description:
      'Read the live content of a tab in the user\'s Microsoft Edge browser and return it as Markdown (default), plain text, or HTML, plus title, URL, meta description, a heading outline, and optionally every link. This is the main scraping tool: it sees what the user sees, including content rendered by JavaScript, so use it instead of web_fetch for pages behind a login, for pages the user already has open, or when the exact rendered page matters. Images, scripts, styles, navigation and footers are stripped by default. Content is capped by max_chars.',
    parameters: {
      type: 'object',
      properties: {
        ...TAB_FIELDS,
        format: {
          type: 'string',
          enum: ['markdown', 'text', 'html'],
          description: 'Output format. markdown keeps headings, lists, links, code blocks and tables (default); text is a flat whitespace-normalised read; html returns the raw inner HTML of the chosen scope.',
        },
        scope: {
          type: 'string',
          description: 'CSS selector limiting the read, or one of "auto" (default: main/article content when it holds enough text, otherwise the whole body), "body", "main".',
        },
        max_chars: { type: 'integer', description: 'Maximum characters of content to return (default 20000, max 200000).' },
        include_links: { type: 'boolean', description: 'Append the page links (text, href) after the content, up to 200. Useful for crawling and navigation.' },
        drop_tags: { type: 'string', description: 'Comma-separated tag names to strip before rendering (default "script,style,noscript,template,svg,canvas,iframe,nav,footer,aside").' },
        wait_for_selector: { type: 'string', description: 'Wait up to 10s for this CSS selector before reading, for pages that fill in content after load.' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => [{ type: 'text', text: value.text }] },
    async execute(args) {
      const value = await bridge.request(
        'page.read',
        {
          tabId: args?.tab_id,
          format: args?.format ?? 'markdown',
          scope: args?.scope ?? 'auto',
          maxChars: Number.isInteger(args?.max_chars) ? args.max_chars : undefined,
          includeLinks: args?.include_links === true,
          dropTags: args?.drop_tags,
          waitForSelector: args?.wait_for_selector,
        },
        { timeoutMs: 60_000 },
      );
      const body = String(value?.text ?? '');
      const header = [
        `Microsoft Edge tab ${value?.tabId ?? args?.tab_id ?? '(active)'} — "${clip(value?.title ?? '', 120)}"`,
        `URL: ${value?.url ?? ''}`,
        `${value?.format ?? 'markdown'} · ${body.length} chars${value?.truncated ? ' (truncated)' : ''}`,
      ];
      if (value?.description) header.push(`Description: ${clip(value.description, 300)}`);
      const outline = Array.isArray(value?.outline) ? value.outline : [];
      if (outline.length > 0) {
        header.push('');
        header.push('Outline:');
        for (const heading of outline.slice(0, 40)) header.push(`  ${'  '.repeat(Math.max(0, (heading.level ?? 1) - 1))}- ${clip(heading.text, 120)}`);
      }
      const parts = [header.join('\n'), '---', body];
      const links = Array.isArray(value?.links) ? value.links : [];
      if (links.length > 0) {
        parts.push('', `Links (${links.length}):`);
        for (const link of links.slice(0, 200)) parts.push(`  - ${clip(link.text || '(no text)', 100)} — ${link.href}`);
      }
      return { ...value, text: parts.join('\n') };
    },
  };

  const evalTool = {
    name: 'edge_eval',
    description:
      "Evaluate JavaScript inside a live tab of the user's Microsoft Edge browser and return the JSON value. The snippet runs in the page context with its DOM available, which makes it the right tool for structured extraction such as document.querySelectorAll('tr').length, or for gathering several fields at once by returning an object. Pass a single expression, or a body that uses `return` and `await`. Helpers are injected, so do not hand-roll waiting or clicking: $ (querySelector), $$ (querySelectorAll), text(el) (normalised innerText), sleep(ms), waitFor(selector, ms), waitText(string, ms), clickText(label). When the page fills in after load, pass wait_for_selector or wait_for_text instead of writing a polling loop. Results are converted with JSON.parse(JSON.stringify(...)), so DOM nodes return {}.",
    parameters: {
      type: 'object',
      properties: {
        ...TAB_FIELDS,
        code: { type: 'string', description: "JavaScript expression, e.g. document.title, or a body such as \"const rows=$$('tr'); return rows.slice(0,5).map((tr)=>text(tr));\"." },
        await_promise: { type: 'boolean', description: 'Await the result when it is a promise (default true).' },
        timeout_ms: { type: 'integer', description: 'Evaluation timeout (default 20000, max 120000).' },
        wait_for_selector: {
          type: 'string',
          description: 'Before evaluating, wait up to wait_timeout_ms for this CSS selector. Fails with a clear message when it never appears. Replaces hand-written polling loops.',
        },
        wait_for_text: { type: 'string', description: 'Before evaluating, wait until this text appears anywhere in the page body.' },
        wait_timeout_ms: { type: 'integer', description: 'How long wait_for_selector / wait_for_text may wait (default 15000, max 120000).' },
      },
      required: ['code'],
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => [{ type: 'text', text: value.text }] },
    async execute(args) {
      const value = await bridge.request(
        'page.eval',
        {
          tabId: args?.tab_id,
          code: String(args.code),
          awaitPromise: args?.await_promise !== false,
          timeoutMs: Number.isInteger(args?.timeout_ms) ? args.timeout_ms : undefined,
          waitForSelector: typeof args?.wait_for_selector === 'string' ? args.wait_for_selector : undefined,
          waitForText: typeof args?.wait_for_text === 'string' ? args.wait_for_text : undefined,
          waitTimeoutMs: Number.isInteger(args?.wait_timeout_ms) ? args.wait_timeout_ms : undefined,
        },
        { timeoutMs: 120_000 },
      );
      let rendered;
      try {
        rendered = JSON.stringify(value?.value ?? null, null, 2);
      } catch {
        rendered = String(value?.value);
      }
      if (rendered === undefined) rendered = 'null';
      const truncated = rendered.length > 100_000;
      if (truncated) rendered = `${rendered.slice(0, 100_000)}\n… (truncated)`;
      const waited = value?.waited;
      const note = waited ? ` (after waiting for ${waited.selector ?? waited.text})` : '';
      return { ...value, text: `Microsoft Edge tab ${value?.tabId ?? '(active)'} — ${value?.type ?? 'value'}${note}\n${rendered}`, truncated };
    },
  };

  const actTool = {
    name: 'edge_act',
    description:
      'Interact with a live tab in the user\'s Microsoft Edge browser so more content can be read: click an element, type into a field, hover, scroll, wait for a selector, select an option, or press a key. Use click on "load more"/pagination/consent buttons, scroll to trigger infinite loading, and wait before edge_read on pages that render after load. Elements resolve by ref (from edge_inspect, survives re-renders), CSS selector, or visible text. Pass expect to assert the target before acting: if the assertion fails nothing is executed. Every action reports effect_state: committed (the page changed), unknown (dispatched but nothing changed yet — do NOT blindly retry; read or inspect first), or none (blocked by expect).',
    parameters: {
      type: 'object',
      properties: {
        ...TAB_FIELDS,
        action: { type: 'string', enum: ['click', 'type', 'hover', 'scroll', 'wait', 'select', 'press'], description: 'Interaction to perform.' },
        ref: {
          type: 'string',
          description: 'Element ref from edge_inspect (e.g. e12). Preferred over a selector: refs stay valid across re-renders and cannot drift onto a different element.',
        },
        expect: {
          type: 'object',
          description: 'Assert the target before acting. Any failing check aborts the action and reports what was expected vs found.',
          properties: {
            text: { type: 'string', description: 'Exact visible text the target must have.' },
            value: { type: 'string', description: 'Exact value the target input must have.' },
            checked: { type: 'boolean', description: 'Checked state the target must have.' },
            attribute: {
              type: 'object',
              description: 'Attribute the target must have, e.g. {"name":"aria-expanded","value":"true"}.',
              properties: { name: { type: 'string' }, value: { type: 'string' } },
              required: ['name'],
            },
          },
        },
        selector: { type: 'string', description: 'CSS selector of the target element (used by click, type, hover, wait, select).' },
        text: { type: 'string', description: 'For click/hover: visible text to match when selector is omitted. For type: the text to enter. For select: the option value or label. For press: the key name, e.g. Enter or Escape.' },
        amount: { type: 'integer', description: 'For scroll: pixels to scroll; omit to jump to the bottom of the page.' },
        submit: { type: 'boolean', description: 'For type: press Enter afterwards (default false).' },
        timeout_ms: { type: 'integer', description: 'For wait: how long to wait for the selector (default 10000).' },
        wait_for: {
          type: 'string',
          description: 'After the action, wait up to wait_timeout_ms for this CSS selector (e.g. the result list a search fills in). Answers `settled:` or `NOT settled:` — this replaces hand-written polling after click/type/submit.',
        },
        wait_for_text: { type: 'string', description: 'After the action, wait until this text appears in the page body.' },
        wait_timeout_ms: { type: 'integer', description: 'How long wait_for / wait_for_text may wait (default 15000, max 120000).' },
      },
      required: ['action'],
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => [{ type: 'text', text: value.text }] },
    async execute(args) {
      const action = String(args.action);
      let value;
      try {
        value = await bridge.request(
          'page.act',
          {
            tabId: args?.tab_id,
            action,
            ref: typeof args?.ref === 'string' ? args.ref : undefined,
            expect: args?.expect && typeof args.expect === 'object' ? args.expect : undefined,
            selector: args?.selector,
            text: args?.text,
            amount: Number.isInteger(args?.amount) ? args.amount : undefined,
            submit: args?.submit === true,
            timeoutMs: Number.isInteger(args?.timeout_ms) ? args.timeout_ms : undefined,
            waitFor: typeof args?.wait_for === 'string' ? args.wait_for : undefined,
            waitForText: typeof args?.wait_for_text === 'string' ? args.wait_for_text : undefined,
            waitTimeoutMs: Number.isInteger(args?.wait_timeout_ms) ? args.wait_timeout_ms : undefined,
          },
          { timeoutMs: 90_000 },
        );
      } catch (error) {
        const message = String(error?.message ?? error);
        // A timeout is the one case where the click may or may not have landed.
        if (/timed out/i.test(message)) {
          throw new Error(`${message}\n\neffect_state: unknown — the action was sent and may have committed. Do NOT repeat it blindly; call edge_inspect or edge_read first to see where the page stands.`);
        }
        throw error;
      }
      const detail = value?.detail ?? {};
      const where = detail.ref ? `ref ${detail.ref}` : detail.selector || detail.tag || '';
      const quoted = detail.text ? `"${clip(detail.text, 60)}"` : '';
      let report;
      if (action === 'wait') report = `${value?.found ? 'Found' : 'Not found'} ${where || quoted}`.trim();
      else if (action === 'scroll') report = detail.text || 'scrolled';
      else if (action === 'type') report = `typed ${quoted || '(empty)'} into ${where}`;
      else if (action === 'press') report = `pressed ${detail.text || args?.text || 'Enter'}`;
      else if (action === 'select') report = `selected ${quoted} in ${where}`.trim();
      else if (action === 'hover') report = `hovered ${where || quoted}`.trim();
      else report = `clicked ${where || quoted}`.trim();
      const settled = value?.settled;
      const suffix = settled
        ? `\n${settled.found ? 'settled:' : 'NOT settled:'} ${settled.selector ?? settled.text}${settled.found ? '' : ' never appeared'}`
        : '';
      const effect = value?.effect;
      const effectLine = effect?.state ? `\neffect_state: ${effect.state}${effect.reason ? ` — ${effect.reason}` : ''}` : '';
      return { ...value, text: `Microsoft Edge tab ${value?.tabId ?? '(active)'} — ${report}${suffix}${effectLine}` };
    },
  };

  const inspectTool = {
    name: 'edge_inspect',
    description:
      "Dump the structure of one live tab in a single call: ready state, headings, a stable CSS selector plus label for every clickable/interactive element, and every table or repeated list on the page with its row count and a sample row. Call it FIRST on an unfamiliar page instead of guessing selectors one edge_eval probe at a time, and call it after a search to learn where the results land and how many rows arrived. Visible elements only, ordered top to bottom.",
    parameters: {
      type: 'object',
      properties: {
        ...TAB_FIELDS,
        selector: { type: 'string', description: 'Restrict the dump to the descendants of this CSS selector (default: whole page).' },
        max_interactive: { type: 'integer', description: 'How many interactive elements to list (default 80, max 400).' },
        max_lists: { type: 'integer', description: 'How many tables/repeated lists to report (default 12, max 40).' },
        wait_for_selector: {
          type: 'string',
          description: 'Before inspecting, wait up to 20s for this CSS selector (e.g. the results container a search fills in).',
        },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => [{ type: 'text', text: value.text }] },
    async execute(args) {
      const value = await bridge.request(
        'page.inspect',
        {
          tabId: args?.tab_id,
          selector: typeof args?.selector === 'string' ? args.selector : undefined,
          maxInteractive: Number.isInteger(args?.max_interactive) ? args.max_interactive : undefined,
          maxLists: Number.isInteger(args?.max_lists) ? args.max_lists : undefined,
          waitForSelector: typeof args?.wait_for_selector === 'string' ? args.wait_for_selector : undefined,
        },
        { timeoutMs: 90_000 },
      );
      return { ...value, text: formatInspect(value) };
    },
  };

  const screenshotTool = {
    name: 'edge_screenshot',
    description:
      'Capture a screenshot of a live tab in the user\'s Microsoft Edge browser and save it inside the session workspace. Works for background tabs and for full-page captures. The file is written as a PNG (or JPEG) and its path is returned; call read_image on that path to actually look at it. Use it to verify layout, read canvas/webgl content, or check what a click did.',
    parameters: {
      type: 'object',
      properties: {
        ...TAB_FIELDS,
        full_page: { type: 'boolean', description: 'Capture the whole scrollable page instead of the visible viewport (default false).' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format (default png).' },
        quality: { type: 'integer', description: 'JPEG quality 10-100 (default 80, ignored for png).' },
        path: { type: 'string', description: 'Optional output path (relative to the session workspace). Defaults to edge-artifacts/edge-<tab>-<timestamp>.<ext>.' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => [{ type: 'text', text: value.text }] },
    async execute(args, exec) {
      const value = await bridge.request(
        'page.screenshot',
        {
          tabId: args?.tab_id,
          fullPage: args?.full_page === true,
          format: args?.format ?? 'png',
          quality: Number.isInteger(args?.quality) ? args.quality : undefined,
        },
        { timeoutMs: 90_000 },
      );
      if (typeof value?.base64 !== 'string' || value.base64.length === 0) throw new Error('edge_screenshot: the extension returned no image data');
      const bytes = Buffer.from(value.base64, 'base64');
      const extension = value.format === 'jpeg' ? '.jpg' : '.png';
      const directory = await artifactDir(exec);
      const workspace = resolve(directory, '..');
      const requested = typeof args?.path === 'string' && args.path.trim().length > 0 ? args.path.trim() : '';
      const target = requested.length > 0
        ? requested
        : join('edge-artifacts', `edge-${value?.tabId ?? 'active'}-${new Date().toISOString().replace(/[:.]/g, '-')}${extension}`);
      const finalPath = isAbsolute(target) ? target : resolve(workspace, target);
      mkdirSync(resolve(finalPath, '..'), { recursive: true });
      writeFileSync(finalPath, bytes);
      const size = `${value?.width ?? '?'}×${value?.height ?? '?'}`;
      return {
        ...value,
        path: finalPath,
        bytes: bytes.length,
        text: `Saved ${value.format === 'jpeg' ? 'JPEG' : 'PNG'} screenshot of Edge tab ${value?.tabId ?? '(active)'} (${size}, ${humanBytes(bytes.length)}) to:\n${finalPath}\n\nCall read_image with that path to inspect the image.`,
      };
    },
  };

  return [statusTool, tabsTool, readTool, inspectTool, evalTool, actTool, screenshotTool];
}

/** Register the tools into the host tool registry. */
export function registerEdgeTools(ctx, bridge, options = {}) {
  const tools = createEdgeTools({ bridge, ctx });
  const disposers = tools.map((tool) => ctx.tools.register(tool));
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        /* already released */
      }
    }
  };
}