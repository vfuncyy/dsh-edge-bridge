# Usage

The complete guide to `dsh-edge-bridge`. Installation lives in the [README](../README.en.md); this assumes the plugin is installed, the extension is connected, and `edge_status` reports `caps: 11 method(s)`.

---

## 0. Mental model

Three things are enough:

1. **The tools are lazy.** A session starts with one `edge_bridge` control tool. That costs almost nothing, because most sessions never need a browser. Call `start` and the seven browser tools appear **from the next model step**.
2. **You address tabs, not pages.** Every tool takes `tab_id`; omit it and you get the active tab of the last focused window. `edge_tabs(action="list")` is the only reliable entry point — never guess an id.
3. **Look first, act second.** `edge_inspect` gives you structure, `edge_read` gives you prose, `edge_act` is the only thing that touches the page. Skipping the first two and writing a selector from memory is the most common cause of failure.

```
edge_bridge(start)
  └─ edge_tabs(list)                      ← where am I
       └─ edge_read / edge_inspect         ← what is on this page
            └─ edge_act(ref=...) / edge_eval    ← do one thing
                 └─ read effect_state           ← did it happen
```

---

## 1. Control tool: `edge_bridge`

| Parameter | Type | Notes |
| --- | --- | --- |
| `action` | `start` \| `stop` \| `status` | required |

- `start` registers the seven browser tools. They become visible on the **next** model call — calling `edge_tabs` in the same message as `start` reports an unknown tool.
- `stop` unregisters them immediately and removes them from context. The WebSocket stays up and the extension stays connected.
- `status` reports endpoint, connection count, per-connection version and capabilities, pairing token and capture state.

Receipt:

```
Edge browser tools are ON — edge_tabs, edge_inspect, edge_read, edge_eval, edge_act and edge_screenshot become available from the next model step.
```

Three automatic stand-downs, so a forgotten `stop` does not carry context forever:

| Trigger | Default | Key |
| --- | --- | --- |
| Idle timeout | 30 minutes without a call | `idleTimeoutMinutes` |
| Extension disconnect | 60 seconds after the socket drops | `stopWhenDisconnected` |
| DSH exit | immediate | — |

---

## 2. Connection state: `edge_status`

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `include_tabs` | boolean | false | also list every tab |

Connected:

```
Bridge endpoint: ws://127.0.0.1:17333/edge-bridge
Attached extensions: 1

Connection edge-1
  extension: DSH Edge Bridge 0.3.0
  browser:   Microsoft Edge 157.0.0.0
  remote:    127.0.0.1:51822
  since:     2026-11-08T18:58:56.867Z
  caps:      11 method(s)

Pairing
  token: RgUMLbk8DB-gSXIGirDcnLKTNG9Q3pRs
  token file: E:\.dsh\edge-bridge-token
```

The `caps:` line is the diagnostic v0.3.0 added:

| Output | Meaning | Action |
| --- | --- | --- |
| `caps:      11 method(s)` | the extension declares all eleven methods | normal |
| `caps:      11 method(s) — missing page.act` | the extension is older | click **Reload** in `edge://extensions` |
| `caps:      (not reported — …)` | the service worker predates 0.3.0 | same |

Disconnected:

```
Bridge endpoint: ws://127.0.0.1:17333/edge-bridge
Attached extensions: 0
Status: NOT CONNECTED — the DSH plugin is listening, but no Edge extension has completed the handshake.
Last handshake error: the browser extension presented a wrong pairing token
```

`Last handshake error` is only ever one of two things: a wrong token, or nothing ever arrived. For the first, re-paste the token in the popup; for the second, check whether the popup is retrying.

---

## 3. Tabs: `edge_tabs`

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `action` | `list`\|`open`\|`navigate`\|`activate`\|`close`\|`reload` | `list` | |
| `tab_id` | integer | active tab | required for `navigate`/`activate`/`close`/`reload` |
| `url` | string | — | required for `open`/`navigate`; `https://` is added when the scheme is missing |
| `filter` | string | — | case-insensitive substring over title and URL |
| `limit` | integer | 50 (max 200) | |
| `active` | boolean | true | focus the tab after `open` |
| `wait_for_load` | boolean | true | wait for `status === 'complete'` (30s cap) |
| `wait_for_selector` | string | — | wait for an element (20s cap), for SPA first paint |

Receipt:

```
Microsoft Edge — 3 tab(s) in 2 window(s)

Window 1288291366 (focused)
  tab 2039574010 [active] — Fixture Page
      file:///C:/Users/14180/Documents/.../page-fixture.html
  tab 2039573698 [pinned, loading] — GitHub · Where software is built
      https://github.com/

Window 1288291370
  tab 2040000123 — CNKI search results
      https://kns.cnki.net/kns8s/defaultresult/index
```

These phrases are actionable:

- No window: `Microsoft Edge is connected but has no window open. Call edge_tabs action="open" — it creates a window when none exists.`
- `filter` matched nothing: `Microsoft Edge is connected, but no tab matched. Drop "filter" to see every tab.` This is not a disconnect.
- In `[active, pinned, discarded, loading]`, a `discarded` tab is reloaded once on access; `loading` means not ready — add `wait_for_load`.

---

## 4. Read prose: `edge_read`

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `tab_id` | integer | active tab | |
| `format` | `markdown`\|`text`\|`html` | `markdown` | |
| `scope` | `auto`\|`body`\|`main`\|CSS selector | `auto` | content root |
| `max_chars` | integer | 20000 (max 200000) | truncation is marked `(truncated)` |
| `include_links` | boolean | false | append every link |
| `drop_tags` | string | `script,style,noscript,template,svg,canvas,iframe,nav,footer,aside` | stripped tags |
| `wait_for_selector` | string | — | wait first (10s cap; a timeout is logged, not an error) |

Receipt:

```
Microsoft Edge tab 2039574010 — "Fixture Page"
URL: file:///C:/.../page-fixture.html
markdown · 1284 chars

# Fixture Title

## Section one
**bold** and *italic* and a [relative link](file:///.../relative/link) ...

Outline:
  - Fixture Title
    - Section one
      - Subsection

---

<body text>

Links (2):
  - relative link — file:///.../relative/link
  - absolute — https://example.com/absolute
```

How `scope=auto` behaves is worth remembering: it probes `main, article, [role=main], #content, #main, .content, .post, .article` in order and takes the first whose `innerText` exceeds 200 characters. **If that container yields less than half of the page text**, it falls back to `<body>` and reports `scope` as `auto:body(fallback)`. So `auto:main` is not automatically good; `auto:body(fallback)` is the signal that no candidate container held the content.

`format=html` returns cleaned HTML (same `drop_tags`), for cases that need structure but not Markdown.

**Do not use `edge_read` for structured data.** Tables become Markdown tables, but merged cells, multi-row headers and grouping all distort. Use `edge_eval` for data.

---

## 5. Look at structure: `edge_inspect`

The most important tool, and the one most often skipped.

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `tab_id` | integer | active tab | |
| `selector` | string | — | dump only this subtree |
| `max_interactive` | integer | 80 (max 400) | how many clickable elements to list |
| `max_lists` | integer | 12 (max 40) | how many tables/repeated lists to list |
| `wait_for_selector` | string | — | wait first (20s cap) |

Receipt:

```
Fixture Page
file:///C:/.../page-fixture.html
complete · 5/6 interactive · 1 list(s) · height 1284

Outline:
  - Fixture Title
    - Section one
      - Subsection

Lists:
  table #results — 3 row(s) × 2
    | Title | Year |
    | ---- | ---- |

Interactive:
  e1 html > body > nav > a role=a — Navigation should be stripped
  e2 html > body > header > h1 — Fixture Title
  e4 #btn role=button type=button — Press me
  e5 #field role=input type=text
  e6 #about-more role=button type=button — Read more about it
  … 1 more — raise max_interactive, or pass selector to focus on one region.

Pass a ref (the token before the selector) to edge_act rather than a selector when the page may re-render.
```

Five signals to read:

1. **`5/6 interactive` on line three** — the denominator is every element that matched, the numerator is what got listed. The difference is `hiddenInteractive`.
2. **`ref` comes first** (`e4 #btn`). That is what you hand to `edge_act`.
3. **`role=` / `type=`** — distinguishes same-labelled buttons (one `type=submit`, one `type=button`).
4. **`Lists:` row counts and sample rows** — size the data before deciding between `edge_eval` over everything or just the first N.
5. **`height`, `iframe`** — a large height means lazy loading; a non-zero iframe count means key content may live in another origin.

When everything is filtered out:

```
42 interactive elements hidden by filter — disabled, invisible, or longer than a control label. Raise max_interactive, drop the filter, or open the cross-origin iframe in its own tab and inspect there.
```

That is a different statement from `No interactive elements matched.` — the latter means there genuinely is nothing clickable (the content may be in a canvas).

---

## 6. Stable `ref`: why not selectors

`edge_inspect` writes `data-dsh-ref="e12"` onto every visible element it lists. The attribute really is stamped into the live DOM (check DevTools), which means:

- When the page re-renders, React/Vue may replace `#btn` with a different node and the selector now points elsewhere. `data-dsh-ref` moves with the node, or is destroyed with it — both are what you want.
- Inspecting the same page twice **reuses** existing refs rather than minting new ones.

When a ref goes stale the error is explicit:

```
no element with ref e4 — refs are stamped by the last edge_inspect in this page; re-run edge_inspect and use its ref
```

That means the page changed. **Inspect again**; do not keep retrying the old ref.

Selectors still work, for two cases: a page that has not changed in years (`#search-input`), and hand-written `querySelector` inside `edge_eval`.

---

## 7. Act: `edge_act`

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `action` | `click`\|`type`\|`hover`\|`scroll`\|`wait`\|`select`\|`press` | required | |
| `ref` | string | — | from `edge_inspect`, e.g. `e12`; **highest priority** |
| `selector` | string | — | CSS selector, used when there is no `ref` |
| `text` | string | — | target text when neither ref nor selector is given (shortest match wins) |
| `expect` | object | — | pre-action assertion, see below |
| `amount` | integer | — | `scroll` distance in pixels; omitted means to the bottom |
| `submit` | boolean | false | `type`: press Enter and submit the form |
| `timeout_ms` | integer | 10000 | how long to wait for the target |
| `wait_for` | string | — | after acting, wait for this selector |
| `wait_for_text` | string | — | after acting, wait for this text |
| `wait_timeout_ms` | integer | 15000 (max 120000) | cap for the two waits above |

### 7.1 Basic actions

```
edge_act(action="click", ref="e4")
→ Microsoft Edge tab 2039574010 — clicked ref e4
  effect_state: committed — the page changed immediately

edge_act(action="type", ref="e5", text="hello world")
→ Microsoft Edge tab 2039574010 — typed "hello world" into ref e5
  effect_state: committed — the field value changed

edge_act(action="select", selector="#city", text="Hangzhou")
→ … selected "Hangzhou" in #city
  effect_state: committed

edge_act(action="press", selector="#q", text="Enter", submit=true)
edge_act(action="scroll", amount=1200)
→ … scrolled 1200px; y=1200 of 8400
edge_act(action="hover", ref="e7")
```

`type` without `ref`/`selector` writes into **the currently focused field**. With nothing focused it fails with `no focused field to type into: pass a ref or a selector` rather than typing into `body`.

### 7.2 `expect`: stop before touching anything

```json
{
  "action": "click",
  "ref": "e12",
  "expect": { "text": "Delete" }
}
```

Four assertion kinds; all must pass before anything runs:

| Key | Compared against | Semantics |
| --- | --- | --- |
| `text` | `innerText` | **exact** equality (whitespace normalised first) |
| `value` | the `value` property | exact |
| `checked` | `checked` | boolean |
| `attribute` | `{ name, value }` | that attribute equals the value; reported as `@name` |

On mismatch:

```
Error: expectation failed: expected text "Delete forever" but the target has "Press me" — nothing was done

effect_state: none — the expectation failed before the click
```

Two points:

- **"nothing was done" is literal**: the element was not clicked, not focused, and received no events. It is safe to inspect again and retry.
- **`expect` applies to this call only.** Nothing is remembered, and nothing is skipped because it passed last time.

The idiomatic use is expressing "I mean the button that says X", so that failure happens on the side with no side effects.

### 7.3 `effect_state`: the three-valued receipt

Every `edge_act` ends with one line:

| Value | Meaning | What to do |
| --- | --- | --- |
| `committed` | the page demonstrably changed by receipt time (fingerprint, field value, checked state or element text) | continue |
| `unknown` | dispatched, but **no change observed at receipt time** | **do not retry.** `edge_read` or `edge_inspect` first, then decide |
| `none` | blocked by `expect`; nothing ran | fix the assertion or the target and retry |

The three usual causes of `unknown`: a submit that navigates and takes time; a network request still in flight; an action with no visible feedback (analytics pings, for instance). **None of them should be retried** — a retry may submit twice.

Timeouts also report `unknown` explicitly:

```
edge_act: "page.act" timed out after 90000ms (the page may still be loading, or the extension stopped responding)

effect_state: unknown — the action was sent and may have committed. Do NOT repeat it blindly; call edge_inspect or edge_read first to see where the page stands.
```

How the fingerprint is computed: `title | URL | element count | body text length | hash of the first 20000 characters of body text`. That is why "clicked something and only the text of an existing node changed" — the most common real case — is detected; v0.3.0 fixed exactly that bug.

### 7.4 Settling waits

When an action triggers asynchronous updates, use the trailing waits instead of making the model sleep:

```
edge_act(action="click", ref="e12", wait_for="#result-table", wait_timeout_ms=30000)
→ … clicked ref e12
  settled: #result-table
  effect_state: committed
```

A miss is not a failure — the receipt says `NOT settled: #result-table never appeared`. **Take that seriously**: the action may not have taken effect, or may be slower than expected. Do not go on to read an empty table.

---

## 8. Extract data: `edge_eval`

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `code` | string | required | JS evaluated in the page context |
| `await_promise` | boolean | true | await returned promises |
| `timeout_ms` | integer | 20000 (max 120000) | |
| `wait_for_selector` | string | — | wait for an element first |
| `wait_for_text` | string | — | wait for text first |

Seven helpers are pre-injected:

| Helper | Purpose |
| --- | --- |
| `$(sel)` / `$$(sel)` | `querySelector` / `querySelectorAll` (as an array) |
| `text(el)` | normalised `innerText` |
| `sleep(ms)` | wait |
| `waitFor(sel, ms)` | poll for an element, throws on timeout |
| `waitText(str, ms)` | poll for text |
| `clickText(label)` | find the shortest match by text and click it (scrolls into view) |

Typical uses:

```
edge_eval(code="$$('#results tbody tr').map(tr => [...tr.cells].map(td => text(td)))")
```

```
edge_eval(code="({ title: document.title, rows: $$('table').length, canvas: $$('canvas').length })")
```

```
edge_eval(code="await waitFor('#data-ready', 15000); return $$('.row').length")
```

All three shapes work: an expression (`document.title`), a function body (containing `return`), or an async body starting with `await`. `undefined` and unserialisable values are normalised to their type name rather than silently dropped.

**Two caveats**: `edge_eval` goes through `chrome.debugger`, so Edge shows its "is debugging this browser" banner; and results above 100000 characters are truncated and marked `(truncated)`.

---

## 9. Screenshots: `edge_screenshot`

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `tab_id` | integer | active tab | |
| `full_page` | boolean | false | stitched full page (max 20000px tall, 4096px wide) |
| `format` | `png`\|`jpeg` | `png` | |
| `quality` | integer | 80 | jpeg only |
| `path` | string | `edge-artifacts/edge-<tab>-<timestamp>.<ext>` | relative to the workspace; absolute paths used as-is |

Receipt:

```
Saved PNG screenshot of Edge tab 2039574010 (1280×1284, 184 KB) to:
C:\Users\14180\Documents\deepseek-harness\default-workspace\edge-artifacts\edge-2039574010-2026-11-09T03-12-44.png

Call read_image with that path to inspect the image.
```

Full-page capture **does not steal focus**, works on background tabs, and restores the previous scroll position. Nested scroll containers and virtual lists only capture what was rendered — an inherent limit of CDP's `captureBeyondViewport`.

---

## 10. Capture into the knowledge base

This is not one of the `edge_*` tools; it is the three popup buttons:

| Button | Behaviour |
| --- | --- |
| **Start capturing** | listen; every time a page finishes loading (`tabs.onUpdated` reaching `complete`) it is captured |
| **Stop capturing** | stop listening and write a session summary to the workspace (pages saved, failures, reasons) |
| **Capture open tabs** | capture every capturable tab once |

**Only the host plugin has filesystem access**; the extension sends intent. So this needs DSH running, the plugin enabled and pairing complete.

Each capture writes three places (`<KB>` defaults to `E:/DSH工作区/论文/知识库`):

| Location | Content |
| --- | --- |
| `<KB>/补充/原文/<collection>/<date>_<time>-<title>.html` | self-contained snapshot (inline styles, readable offline) |
| `<KB>/补充/条目.json` | one appended `supNNN`: `type=webpage`, `container=<domain>`, `abstract=<first 220 chars>`, `tags` include the domain |
| `<KB>/<collection>/清单.md` | human-readable manifest, one line each |

Then `kb.py build` and `kb.py extract` run automatically, so it is searchable immediately:

```
kb.py search <keyword> --collection <collection>
```

The session summary lands in `edge页面抓取/`:

```
edge页面抓取/
├─ 总结/2026-11-09_0312-session.md
├─ index.json
├─ index.md
└─ README.md
```

**Four quality guarantees**:

1. Body text is capped at six million characters (`MAX_PAGE_CHARS`); genuine truncation is annotated in the snapshot.
2. When the `auto` scope container holds less than half the page, it falls back to `<body>`.
3. Site navigation is trimmed only when it sits before the first heading, consists of five or more links, and has no sentence-ending punctuation — so link lists in the body survive.
4. **Reader shells are refused**: text that is almost entirely `data:image`, a canvas with fewer than 1200 characters of real text, or three or more `- Page N` markers / two or more viewer-chrome markers. **Better to record nothing than to write a junk entry.** PDF.js, journal readers and image-only scans all fall here; the right move is to download the PDF and run the literature ingest flow, not to capture HTML.

Undo a bad capture:

```
node edge-bridge/tools/remove-capture.mjs sup123
```

It removes the entry, the snapshot, the full text and the card, then rebuilds the index, backing up `条目.json.bak-<timestamp>` first.

---

## 11. Configuration

Nine keys, set in `cordis.patch.yml` or the profile's plugin config:

| Key | Default | Notes |
| --- | --- | --- |
| `port` | `17333` | listener port; walks forward within 17344 when taken |
| `token` | auto-generated | pairing token; defaults to `E:\.dsh\edge-bridge-token` |
| `autoStart` | `false` | register the seven tools at load (i.e. pay the context cost every session) |
| `idleTimeoutMinutes` | `30` | idle minutes before auto-stop; `0` disables |
| `stopWhenDisconnected` | `true` | auto-stop 60 seconds after the extension drops |
| `captureTitle` | `edge页面抓取` | workspace name for capture summaries |
| `captureDir` | automatic | where capture artefacts go |
| `kbRoot` | `E:/DSH工作区/论文/知识库` | knowledge base root |
| `kbCollection` | `页面抓取` | knowledge base collection name |
| `kbPython` | DSH bundled python | interpreter used to run `kb.py` |

Full details in [Configuration reference](configuration-reference.md).

---

## 12. One complete workflow

Goal: export the ten records on page two of a back-office list.

```
1. edge_bridge(action="start")
2. edge_tabs(action="list", filter="back office")
3. edge_inspect(tab_id=123)
      → e8 is "Next page", e10..e19 are the ten records, Lists shows 10 row(s)
4. edge_act(action="click", ref="e8", expect={text:"Next page"}, wait_for="#list-body")
      → effect_state: committed
5. edge_inspect(tab_id=123, selector="#list-body")
      → still ten rows, but the refs changed
6. edge_eval(code="$$('#list-body tr').map(tr => [...tr.cells].map(td => text(td)))")
      → a 2-D array
7. edge_bridge(action="stop")
```

The `expect={text:"Next page"}` in step 4 is not decoration: if the page refreshed itself between steps 3 and 4, `e8` may have been reused for "Clear all data". The assertion turns that accident into a harmless failure.

---

## 13. Limits

| Situation | Behaviour |
| --- | --- |
| Cross-origin iframe | content scripts and `Runtime.evaluate` act on the main frame only. `edge_inspect` reports `iframeCount`; open the iframe URL in its own tab |
| `file://` | requires "Allow access to file URLs" for the extension in `edge://extensions` |
| `edge://*`, `chrome://*`, the extension store, built-in PDF viewer, `about:blank` | explicit error, never a silent failure |
| Anything needing `chrome.debugger` | `edge_eval` and full-page screenshots raise the "is debugging this browser" banner |
| The user switches tabs | not followed; `tab_id` is stable and calls already in flight are unaffected |
| Multiple Edge windows | all visible, grouped by window in `edge_tabs`; `tab_id` is globally unique |
| Multiple extensions connected | the pool keeps them all but defaults to the **most recently handshaked**; check `edge_status` explicitly in multi-browser setups |
