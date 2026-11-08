# Troubleshooting

Organised as symptom → cause → fix. Every quoted string can be searched for in `edge_status` output, a tool receipt, or `E:/.dsh/logs/desktop-next.log`.

---

## Connections

### `the Edge extension is not connected. Ask the user to open the "DSH Edge Bridge" extension in Microsoft Edge and press Connect`

The plugin is listening but no extension has completed the handshake. In order:

1. Is DSH running, and is the plugin enabled? `curl http://127.0.0.1:17333/edge-bridge/ping` should return `{"ok":true,"name":"dsh-edge-bridge","protocol":1,...}`.
2. Is the extension installed and enabled (check the toggle in `edge://extensions`)?
3. What does the popup say: `未连接` / `重试中` / `令牌被拒`?

### `No Edge Bridge found on 127.0.0.1:17333-…Is DeepSeek Harness running with the plugin enabled?`

The extension probed twelve ports and found no `/ping`. Three possibilities:

- DSH is not running (most common).
- The plugin is installed but disabled, or `apply()` threw (look for `edge-bridge:` lines in the log).
- The port landed beyond 17344 — only possible if you changed `port` outside the probe range.

### `the browser extension presented a wrong pairing token`

Token mismatch. Note the plugin is **rejecting** the extension: TCP and the WebSocket handshake both succeeded.

- Take the current token from `edge_bridge(action="status")` and re-paste it.
- A token file deleted, or a different profile, invalidates the old token.
- The server closes with `4003`, and the popup shows "token rejected".

### `Last handshake error: …` has a value while `Attached extensions: 0`

`lastError` describes the **previous** failure, not the present. It clears after a successful reconnect; a value that never clears means the extension is still retrying and failing.

---

## Versions and capabilities

### `this extension does not implement "page.inspect" (protocol 1, build 0.2.0, caps: …)`

The extension is old and does not implement that method; the receipt lists the `caps` it does declare.

Fix: `edge://extensions` → `DSH Edge Bridge` → **Reload**.

### `edge bridge: the connected extension does not implement "page.inspect". It reports: … — reload the unpacked extension in edge://extensions …`

The same cause, but **rejected up front by the plugin** (v0.3.0 capability negotiation) instead of waiting 15 seconds for a timeout.

### `edge_status` shows `caps:      (not reported — this extension build predates capability reporting, so calls are attempted blindly)`

The service worker is still a pre-0.3.0 build. This is the most confusing case: **the version in `manifest.json` is already new** (it is re-read on restart) while `background.js` keeps running the old code from memory.

> Remember this rule: after changing any file under `extension/`, click **Reload** in `edge://extensions`. Restarting DSH, or restarting Edge on its own, is not enough.

### The log shows `did not report its capabilities, so it is still running a build from before v0.3.0`

Same as above. That warning exists precisely for this situation: seeing it means the extension was not reloaded.

---

## Acting

### `no element with ref e4 — refs are stamped by the last edge_inspect in this page; re-run edge_inspect and use its ref`

The ref is stale: the page navigated, part of it re-rendered, or the inspect happened long ago.

Fix: inspect again and use the new ref. **Do not retry the old one** — it will almost certainly never succeed.

### `expectation failed: expected text "Delete forever" but the target has "Press me" — nothing was done`

`expect` blocked the action; **nothing ran**. That is usually good news:

- If "Press me" is in fact the target, the selector/ref pointed at the wrong element — inspect again.
- If it really should say "Delete forever", the page is not in the state you assumed — read or inspect first.

`effect_state: none` marks this branch.

### `effect_state: unknown`

Dispatched, but no visible change at receipt time.

**Do not retry.** `edge_read` or `edge_inspect` first to see where the page actually stands. Three usual causes:

| Cause | Sign | Fix |
| --- | --- | --- |
| Submit navigates; the receipt beats the navigation | the URL changes a moment later | wait for the target state with `wait_for` / `wait_for_selector` |
| A request has not returned | a loading state on the page | `wait_for_text` for the result text |
| The action has no visible feedback | the page is unchanged | read internal state with `edge_eval` |

### `effect_state: committed` but the page looks the same

The fingerprint includes a hash of the first 20000 characters of body text, so "the text of an existing node changed" counts as committed even when the change is barely visible. That sensitivity is the point: post-submit toasts, counters ticking up and buttons greying out are all caught.

### `"page.act" timed out after 90000ms`

Two shapes:

- Followed by `effect_state: unknown` — the action was sent and the page may already have changed. **Treat it as unknown.**
- Reading `the page may still be loading` — the target never appeared. Check `wait_for` / `timeout_ms`.

### `NOT settled: #result-table never appeared`

The action succeeded but the follow-up wait timed out. Do not go on to read an empty table — confirm the action took effect first.

### `no focused field to type into: pass a ref or a selector`

`edge_act(action="type")` without `ref` or `selector`, and nothing is focused. Supply a `ref`.

### `another debugger is attached to this tab (close DevTools for this tab, then retry)`

DevTools already holds `chrome.debugger` on that tab, which `edge_eval` and full-page screenshots need exclusively. Close DevTools and retry.

---

## Reading

### `edge_inspect` prints `No interactive elements matched.`

There genuinely is nothing clickable: content may be inside a canvas, the page may be the built-in PDF viewer, or the whole page may be an image.

Contrast with `N interactive elements hidden by filter — …`, which means matches **did** exist and were excluded by `max_interactive`, `selector` or the visibility test. Loosen the parameters.

### `edge_inspect` reports a non-zero `iframe` count but the contents are invisible

Cross-origin iframes are out of reach: content scripts and `Runtime.evaluate` act on the main frame only.

Fix: `edge_tabs(action="open")` the iframe's URL in its own tab and inspect it there.

### `edge_read` returns very little and `scope` is `auto:body(fallback)`

Not an error but an automatic fallback: the candidate container (`main`/`article`/`#content`…) held less than half the page text, so `<body>` was used. Common on sites that scatter the body across sibling `div`s.

If the body is still missing it may be lazily loaded: `edge_act(action="scroll")` first, or pass `wait_for_selector`.

### `(truncated)` appears in the body

`max_chars` was exceeded (default 20000, max 200000). Raise it, or narrow with `scope`.

### Tables come out misaligned

`edge_read`'s Markdown tables distort merged cells, multi-row headers and grouping. Use `edge_eval` for data:

```
edge_eval(code="$$('#table tbody tr').map(tr => [...tr.cells].map(td => text(td)))")
```

For `rowspan` / `colspan`, read `td.rowSpan` / `td.colSpan` directly inside `edge_eval`.

---

## Pages and permissions

### `Cannot access a chrome:// URL` / restricted page

`edge://*`, `chrome://*`, the extension store and `about:blank` cannot be scripted. That is a browser restriction, not a plugin defect.

### A `file://` page is inaccessible

In `edge://extensions` → the extension's details → enable **Allow access to file URLs**.

### The "…is debugging this browser" banner appears

`edge_eval` and full-page screenshots go through CDP because MV3 forbids `eval` inside an extension, so the banner inevitably appears. The debugger detaches when the call finishes and the banner goes away. **Not a fault, and it cannot be suppressed.**

### `tab N no longer exists; call edge_tabs action=list to pick a live tab`

The tab was closed. Call `edge_tabs(action="list")` for a fresh id.

---

## Capture

### The capture buttons do nothing

Capture runs in the **host plugin** (only it has filesystem access). Check:

1. DSH is running, the plugin is enabled, the extension is connected.
2. The popup shows no error.
3. Look for `edge-bridge:` lines in the log.

### Captured a page but the knowledge base is unchanged

Check the mtime of `<kbRoot>/补充/条目.json`. If it did not change:

- `kbRoot` is wrong (default `DSH_KB_ROOT`, else `$DSH_HOME/knowledge-base`; a non-existent path fails).
- `kb.py` is not under `kbRoot`, or `kbPython` points at a missing interpreter.
- The session summary records the failure reason and the first lines of stderr.

### A page was "refused"

See the four rejection rules in section 10 of the usage guide. The two most common:

- **`data:image` dominates** (image-only scans).
- **A reader shell**: `- Page N` markers or viewer chrome with too little real text.

That is deliberate: **better to record nothing than to write a junk entry.** Download the PDF and run the literature ingest flow instead.

### Removed the wrong entry

```
node edge-bridge/tools/remove-capture.mjs sup123
```

Removes the record, snapshot, full text and card, then rebuilds the index, backing up `条目.json.bak-<timestamp>` first.

---

## Tooling

### There is no `node` on this machine

The DSH desktop build ships an Electron runtime. Run tests with:

```
export ELECTRON_RUN_AS_NODE=1
"D:/DeepSeek Harness/DSH NEXT/DSH NEXT.exe" edge-bridge/tools/test-bridge.mjs
```

### Plugin code changes do not take effect

The module cache does not refresh by itself. Toggle the bundle:

```
plugin_manager(action="set_bundle", target="dsh-edge-bridge", enabled=false)
plugin_manager(action="set_bundle", target="dsh-edge-bridge", enabled=true)
```

### Extension code changes do not take effect

**Reload** in `edge://extensions`. See "Versions and capabilities" above.

### `test-page-in-edge.mjs` prints `SKIP`

Headless Edge could not start here (or is not at a standard path). It exits 0, so this is not a failure. To verify by hand, open `file:///.../tools/fixture/page-fixture.html` — **do not** start a local http server for the browser, because some sandboxed environments block loopback outbound and you get `Frame is showing error page`.

---

## Still stuck?

Collect four things and the problem is usually obvious:

1. The full output of `edge_bridge(action="status")`.
2. The result of `curl http://127.0.0.1:17333/edge-bridge/ping`.
3. The popup's state and most recent error.
4. The last 20 lines starting with `edge-bridge:` in `E:/.dsh/logs/desktop-next.log`.
