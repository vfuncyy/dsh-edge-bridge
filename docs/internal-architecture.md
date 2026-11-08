# Internal architecture

This explains *why* things are built this way, not the API. For usage see [usage.md](usage.md).

## 1. Two processes, one loopback connection

```
┌──────────────────── DSH process ────────────────────┐
│  index.js  apply(ctx, config)                        │
│    ├─ token.js    → pairing token                    │
│    ├─ server.js   → http/ws listener 127.0.0.1:17333 │
│    │    ├─ GET /edge-bridge/ping   ← extension probes│
│    │    └─ GET /edge-bridge  (Upgrade) ← ext dials   │
│    ├─ bridge.js   → pool / auth / request-reply      │
│    ├─ controller.js → edge_bridge tool + lazy load   │
│    ├─ tools.js    → seven tools + text rendering     │
│    ├─ capture.js  → capture engine                   │
│    └─ kb.js       → knowledge base writes + kb.py    │
└──────────────────────────────────────────────────────┘
                     ▲ ws://127.0.0.1:17333/edge-bridge
                     │
┌──────────────────── browser ─────────────────────────┐
│  Edge MV3 extension                                  │
│    ├─ background.js  service worker: dial/reconnect/ │
│    │                 dispatch                       │
│    ├─ page.js        three functions injected into   │
│    │                 the page                        │
│    └─ popup          pairing, diagnostics, capture   │
│         └─ chrome.scripting.executeScript / CDP      │
└──────────────────────────────────────────────────────┘
```

**No third-party dependencies.** `ws.js` is a hand-written RFC6455 server (handshake, framing, masking, ping/pong, close frames), about 346 lines. In exchange: no `npm install` to enable the plugin, no dependency-version breakage when DSH upgrades, and it works offline.

The cost is that WebSocket edge cases are ours to handle: fragmented messages, oversized frames, half-closes. A single frame is capped at 4 MB (base64 screenshots approach it); beyond that the connection is closed.

## 2. Ports and discovery

```
plugin: listen(17333) fails → 17334 → … → 17344
ext:    parallel GET http://127.0.0.1:<port>/edge-bridge/ping (12 ports, 700ms)
        take the first returning {"ok":true,"name":"dsh-edge-bridge"}
        build ws://127.0.0.1:<port>/edge-bridge and dial
```

Why not a fixed port with configuration: the DSH web UI port changes between launches. If the bridge port moved with it, you would reconfigure the extension every time. Now **the plugin finds a free slot and the extension finds the plugin**, with no configuration on either side.

Why not mDNS or broadcast: unreliable on Windows, and twelve loopback HTTP probes cost a few milliseconds in total.

## 3. Frames

JSON Lines over WebSocket, five kinds:

| Direction | Frame | Notes |
| --- | --- | --- |
| ext → host | `{t:"hello", protocol, token, extension:{name,version}, browser:{name,version}, caps:[...]}` | first frame, must carry the token |
| host → ext | `{t:"hello", ok:true, protocol, server:{name,version}, caps:[...]}` or `{ok:false, error}` | auth result + capability negotiation |
| host → ext | `{t:"req", id, method, params}` | request |
| ext → host | `{t:"res", id, ok, value \| error}` | reply |
| both | `{t:"ping"}` / `{t:"pong"}` | heartbeat, every 20s |
| ext → host | `{t:"event", name, data}` | one-way events (tab count, `capture.page`, `capture.stop`) |

Handshake:

1. The extension sends `hello` on `onopen`.
2. The plugin checks the token: mismatch → `{ok:false,error:"invalid pairing token"}` and `close(4003)`.
3. Match → record `extension` / `browser` / `protocol` / `caps`, reply `{ok:true, caps: HOST_CAPS}`, clear the 15-second auth timer.
4. Any later unauthenticated non-hello frame closes with `4003, "hello required before any other message"`.

Close codes:

| Code | Meaning |
| --- | --- |
| `1000` | normal |
| `1001` | host shutting down (DSH exit) |
| `4001` | heartbeat timeout (120s without a pong) |
| `4003` | wrong token / not authenticated |
| `4008` | no `hello` within 15s |

## 4. Capability negotiation

This is the mechanism v0.3.0 borrowed from BrowserSkill.

**The problem**: the plugin and the extension are separate deployment units. Upgrade the plugin, forget to reload the extension, and you get a state that looks connected but where some methods always fail. The old implementation discovered that only on first call — `this extension does not implement "page.inspect"` — usually mid-task.

**The current design**:

```
extension: caps: Object.keys(HANDLERS)        ← what this build actually dispatches
plugin:    HOST_CAPS = 11 method names        ← what this build needs
```

Both sides compare at handshake time:

- Fewer `caps` than `HOST_CAPS` → the plugin logs a warning naming the gaps, and `edge_status` shows `— missing page.act`.
- Pre-call interception: `request()` checks the target method against `conn.caps` and rejects immediately with the extension's own capability list and the "reload in edge://extensions" instruction.
- Empty `caps` (pre-0.3.0 build) → **allowed through**, falling back to the extension-side error. A deliberate degradation: old extensions keep working, just as before.

The contract is guarded by `tools/test-contract.mjs`: `HOST_CAPS` and the `HANDLERS` key set must be identical or it fails. Add a method and forget the other side, and it is the only thing that complains right away.

## 5. Lazy loading

```
session start: [edge_bridge]                       ← 1 tool, ~30 lines
after start:   [edge_bridge, edge_status, edge_tabs,
                edge_inspect, edge_read, edge_eval,
                edge_act, edge_screenshot]         ← 8 tools, 2000+ tokens
after stop:    [edge_bridge]                       ← back to 1
```

Three automatic stand-downs (30 idle minutes, 60 seconds after disconnect, DSH exit) work together with `edge_bridge`'s `touch()`: `index.js` wraps `bridge.request`, so any browser call resets the idle timer.

Why not a dynamic tool schema: DSH tool registration is an explicit `ctx.tools.register()`. `start` pushes seven definitions in; `stop` invokes the matching dispose closures. There is no cleverer option, and none is needed.

## 6. How `ref` works

`page.js` runs inside the page, so it can touch the DOM:

```js
function refFor(element) {
  const existing = element.getAttribute('data-dsh-ref');
  if (existing) { usedRefs.add(existing); return existing; }
  const token = `e${++refSeq}`;
  try { element.setAttribute('data-dsh-ref', token); } catch { /* some shadow roots refuse */ }
  usedRefs.add(token);
  return token;
}
```

Three details:

- **Existing refs are collected first** (`usedRefs`) and new numbering continues past them, avoiding collisions with an earlier inspect.
- **A second inspect reuses an element's ref**, so "inspect → act → inspect → act" never makes refs churn.
- A failed `setAttribute` is swallowed: it only affects that element's ref stability, nothing else.

Resolution order `ref → selector → text` lives in `resolveTarget()`. A ref is looked up as an attribute selector (`[data-dsh-ref="e12"]`), so it is as fast as a selector but means "that node" rather than "that position".

## 7. How `effect_state` works

A snapshot is taken before and after the action:

```js
function snapshot(element) {
  return {
    value: element.value,
    checked: element.checked || element.getAttribute('aria-checked') === 'true',
    text: (element.innerText || '').slice(0, 120),
  };
}

function fingerprint() {
  const body = document.body;
  const elements = body ? body.getElementsByTagName('*').length : 0;
  const text = body ? (body.innerText || '') : '';
  const limit = Math.min(text.length, 20000);
  let hash = 5381;
  for (let i = 0; i < limit; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${document.title}|${location.href}|${elements}|${text.length}|${hash}`;
}
```

Decision table:

| Condition | Result |
| --- | --- |
| fingerprint changed | `committed`, `the page changed immediately` |
| `value` changed | `committed`, `the field value changed` |
| `checked` changed | `committed`, `the checked state changed` |
| element text changed | `committed`, `the element text changed` |
| none of the above | `unknown`, with advice not to retry blindly |

**Why the fingerprint includes a body hash**: the first v0.3.0 implementation used only `title|URL|element count`. In real use, clicking `#btn` changed `#readout` from `idle` to `clicked!` — same element count, same title, same URL — so every such click reported `unknown`. Adding a djb2 hash over 20000 characters (roughly 0.5 ms, acceptable) catches this "rewrite an existing node" class of change.

Correspondingly, one assertion in `test-page-in-edge.mjs` was tightened from "committed or unknown both pass" to "must be committed" — a loose assertion was hiding exactly this bug.

## 8. Capture pipeline

```
popup: "start capturing"
  → background.js listens on tabs.onUpdated (status === 'complete')
  → sends {t:"event", name:"capture.page", data:{tabId, url, source}}
  → plugin capture.js receives the event
      → requests page.read over the bridge (maxChars 6,000,000)
      → cleans: scope fallback, nav trimming, reader rejection
      → kb.js writes three places (snapshot / entries.json / manifest)
      → after a 3-second debounce runs kb.py build + extract
  → writes the count back to the popup and the badge
```

**Why the plugin writes files, not the extension**: MV3 extensions have no arbitrary filesystem access — only `downloads` or File System Access (which needs a user gesture). Letting the extension write the knowledge base would mean either a pile of save dialogs or downloading into `downloads` and moving files afterwards. The host already writes files directly.

**Why reader rejection exists**: Chinese journal readers (CNKI, Wanfang, Chaoxing) render through PDF.js or canvas, so the captured HTML is only a shell. Any of four rules rejects the capture and records the reason in the summary:

1. The body is almost entirely inline `data:image`.
2. A canvas is present and the effective text is under 1200 characters.
3. Three or more `- Page N` markers, or two or more viewer-chrome markers.
4. (Implicit) the text is still unusable after `scope` fallback.

Better to record nothing than to leave an entry that will mislead later searches and need manual cleanup.

## 9. Test layering

| Suite | Layer | Depends on | Count |
| --- | --- | --- | --- |
| `test-bridge` | transport + protocol | nothing (real WebSocket fake extension) | 27 |
| `test-server` | ports + discovery | nothing | 11 |
| `test-plugin` | full `apply()` path | nothing (temp DSH_HOME + fake KB) | 76 |
| `test-capture` | capture engine | nothing | 111 |
| `test-page-in-edge` | injected functions | headless Edge | 59 |
| `test-contract` | cross-file contract | nothing (reads files) | 34 |

Principles:

- **Fake extension first.** The first four suites use a real WebSocket client impersonating the extension, replying to each method with fixed values. That covers protocol, timeouts, disconnects and capabilities without a browser.
- **Injected functions are tested in place.** The three functions in `page.js` are serialised with `Function.prototype.toString()` and injected, so the tests build the same string and eval it in a real browser — the production path itself.
- **The contract test is the backstop.** Behavioural tests cannot catch "changed one place, forgot the other"; `test-contract` does text-level assertions only.

318 assertions; green across the board is the release gate.

## 10. What is deliberately not here

All of these exist in BrowserSkill and **deliberately not** here:

| Not implemented | Why |
| --- | --- |
| Agent Window (a dedicated controlled window) | The goal is driving the window you are looking at; an extra window means switching back and forth |
| session / borrow concepts | The DSH session is enough; another session layer is just more state |
| Persistent ref store | Refs live on the DOM, so they die with the page — which is the intended semantics |
| Network capture / request replay | That is a debugging tool, not a browsing capability; use DevTools |
| Video recording | Directly opposed to saving tokens |
| Operation audit | Single local user; the log is enough |
| Remote server mode | Loopback is the premise of the simplicity; use an SSH tunnel to go remote |
| Self-update | Not in a store, so source is the distribution; upgrade is `git pull` + reload |
| Multilingual UI | One user; Chinese is enough (the locale files only carry the plugin manager's two strings) |
