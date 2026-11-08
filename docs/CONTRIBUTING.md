# Contributing

## Run the tests first

Confirm the baseline is green before changing anything:

```
node edge-bridge/tools/test-bridge.mjs
node edge-bridge/tools/test-plugin.mjs
node edge-bridge/tools/test-server.mjs
node edge-bridge/tools/test-capture.mjs
node edge-bridge/tools/test-contract.mjs
node edge-bridge/tools/test-page-in-edge.mjs
```

318 assertions in total. The first five need no browser; `test-page-in-edge` needs Edge 116+ and prints `SKIP` with exit code 0 where it cannot start.

Without a `node` on the machine, use the DSH runtime (Electron):

```
export ELECTRON_RUN_AS_NODE=1
"D:/DeepSeek Harness/DSH NEXT/DSH NEXT.exe" edge-bridge/tools/test-bridge.mjs
```

## Layout rules

| Location | Goes there |
| --- | --- |
| `plugin/index.js` | assembly only: token, listener, controller, capture engine, dispose |
| `plugin/lib/` | single-responsibility modules; `ws.js` imports nothing else, `bridge.js` does not import `tools.js` |
| `plugin/lib/tools.js` | tool definitions and text rendering; no DOM work, no network calls |
| `extension/page.js` | only self-contained injected functions. **No** references to outer variables — one `options` parameter and page globals |
| `extension/background.js` | dial, reconnect, dispatch. The `HANDLERS` keys are the public method names |
| `tools/` | tests, fixture, maintenance scripts. Tests share no state |

## Three hard rules for changes

### 1. A new method must be declared on both sides

Adding a browser method touches four places:

1. `HANDLERS` in `extension/background.js` (implementation).
2. `HOST_CAPS` in `plugin/lib/bridge.js` (declaration).
3. `plugin/lib/tools.js` (if it is exposed to the model).
4. The expectations in `tools/test-contract.mjs` (if asserted).

`HOST_CAPS` and the `HANDLERS` key set must be identical; `test-contract` blocks a commit that drifts.

### 2. Functions in `page.js` must be self-contained

The three functions (`readPage` / `actPage` / `inspectPage`) are serialised with `Function.prototype.toString()` and injected into the page. That means:

- No references to closure variables or modules.
- Helpers must live inside the function body or be siblings injected alongside it.
- No `import`.
- Tests inject the same way (`(${readPage.toString()})(options)`), so a local change is verifiable immediately.

### 3. Every tool renders text, not JSON

`output.render` compresses the structured result into a passage the model can read directly. Do not hand the model a JSON tree to walk — that is the core design of this plugin, and there are assertions for it.

## Before committing

```
# syntax
node --check edge-bridge/plugin/lib/tools.js
node --check edge-bridge/extension/page.js
node --check edge-bridge/extension/background.js

# contract
node edge-bridge/tools/test-contract.mjs
```

If you changed the extension, **reload it in `edge://extensions`** before verifying by hand; restarting DSH does not replace the service worker's code. That is the single most common one-off mistake in this project.

## Keeping docs in sync

When tool counts, parameters, capabilities or versions change, update these (the first two are checked by `test-contract`):

- the tool table and test counts in `README.md` and `README.en.md`
- the parameter tables in `docs/使用指南.md` and `docs/usage.md`
- one entry in `docs/CHANGELOG.md`
- `docs/内部架构.md` / `docs/internal-architecture.md` for architecture changes

## Writing tests

Accumulate results with `check(name, condition, detail)` rather than throwing on `assert` — running every assertion beats stopping at the first failure:

```js
check('edge_act reports the ref it used', /clicked ref e1/.test(text), text);
```

Name it after the behaviour you expect, not the function under test. `detail` is printed on failure, so pass the relevant text.

## Opening a PR

State three things:

1. **Which failure it fixes** (not "which feature it adds").
2. **How to reproduce it** (which step, which receipt).
3. **Which assertion proves it is fixed**.

If a change cannot be expressed in the six existing suites, it may need a new test layer first — that itself is a fine standalone PR.

## License

By submitting you agree to release your contribution under the MIT license.
