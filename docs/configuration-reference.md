# Configuration reference

Plugin configuration lives in the bundle's `cordis.patch.yml`, or is overridden through the profile's plugin config. Ten keys in total.

## Full table

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `port` | integer | `17333` | listener port |
| `token` | string | auto-generated | pairing token |
| `autoStart` | boolean | `false` | register browser tools at load |
| `idleTimeoutMinutes` | number | `30` | idle auto-stand-down |
| `stopWhenDisconnected` | boolean | `true` | stand down when the extension drops |
| `captureTitle` | string | `edge页面抓取` | capture session workspace name |
| `captureDir` | string | automatic | capture artefact directory |
| `kbRoot` | string | `E:/DSH工作区/论文/知识库` | knowledge base root |
| `kbCollection` | string | `页面抓取` | knowledge base collection |
| `kbPython` | string | DSH bundled python | interpreter for `kb.py` |

## `port`

Listener port, bound to `127.0.0.1` only.

- Default 17333.
- If taken, walks forward within **17344** (twelve candidates).
- The extension probes `GET /edge-bridge/ping` across those ports, so **changing the port requires no extension change**.

Validation: a non-integer or out-of-range value (`1..65535`) falls back to the default with a warning.

When to change it: something else occupies the whole 17333–17344 range (rare), or you need a port allowlist.

```yaml
port: 17400
```

> The extension's probe range is fixed in `background.js` (`DISCOVERY_FIRST_PORT` / `DISCOVERY_PORTS`, twelve ports from 17333). Going outside it needs an extension change plus a reload.

## `token`

The pairing token the extension must present.

- When unset, a 32-character URL-safe random string is generated on first start and written to `E:\.dsh\edge-bridge-token` (mode `0600`).
- An existing token file is read rather than regenerated, so restarting DSH does not disconnect the extension.
- An explicit `token` wins, and is still written to the file so `edge_status` can show it.
- Changing it means re-pasting in the popup.

```yaml
token: "RgUMLbk8DB-gSXIGirDcnLKTNG9Q3pRs"
```

Do not commit it; `.gitignore` already excludes `edge-bridge-token` and `*.local.json`.

## `autoStart`

| Value | Behaviour |
| --- | --- |
| `false` (default) | a session starts with just the `edge_bridge` control tool; the model calls `start` when it needs the rest |
| `true` | the seven browser tools are registered as soon as the plugin loads |

**Defaulting to false is the central trade-off of this plugin**: the seven tool descriptions total roughly two thousand tokens, and most sessions never touch a browser. `autoStart: true` suits a browse-only profile, or a TUI where multi-turn `start` calls are awkward.

## `idleTimeoutMinutes`

Idle minutes before an automatic `stop` (unregistering tools, keeping the connection).

- Default `30`.
- `0` disables the timeout — tools stay registered until an explicit `stop` or DSH exit.
- Swept every 30 seconds; "idle" means no `edge_*` call at all (the plugin wraps `bridge.request` and calls `touch()`) .

Note that the clock starts at `start`, even if the tools are then never used.

## `stopWhenDisconnected`

Whether to stand down when the extension disconnects.

- Default `true`, with a **60-second** grace period, so a brief reconnect (an Edge service-worker restart, for example) does not drop the tools.
- With `false`, the tools stay registered and calls fail with `the Edge extension is not connected`.

## `captureTitle`

The workspace that receives capture session summaries. Default `edge页面抓取`.

The plugin calls `ensure()` on it at load (creating it when missing) and retries four seconds later, because the `workingDirectory` service can come up after the plugin loads.

```yaml
captureTitle: capture-sessions
```

## `captureDir`

Directory for capture artefacts (summaries, `index.json`). Defaults to the workspace named by `captureTitle`.

Use an absolute path when overriding; relative paths resolve against the workspace.

## `kbRoot`

Knowledge base root, default `E:/DSH工作区/论文/知识库`.

Three writes happen here:

```
<kbRoot>/补充/原文/<kbCollection>/<date>_<time>-<slug>.html
<kbRoot>/补充/条目.json
<kbRoot>/<kbCollection>/清单.md
```

It can be ignored when you do not capture; if `kbRoot` does not exist, capture fails and the reason is recorded in the session summary.

## `kbCollection`

The collection name written into the knowledge base, default `页面抓取`.

It determines:

- the snapshot subdirectory (`补充/原文/页面抓取/`)
- the manifest location (`页面抓取/清单.md`)
- one entry in the record's `collections` array
- the `--collection` argument when searching

Change it to separate purposes inside one knowledge base:

```yaml
kbCollection: 法规原文
```

## `kbPython`

The interpreter used to run `kb.py`. Defaults to the DSH bundled runtime:

```
E:/.dsh/dsh-runtimes/dsh-next-primary-runtime/dependencies/python/python.exe
```

Invocations are `spawn(kbPython, ['-X', 'utf8', 'kb.py', ...])` with `cwd` set to `kbRoot` and `PYTHONIOENCODING=utf-8` in the environment, which keeps Chinese paths and console encoding from corrupting output.

If `kb.py` is not under `kbRoot`, capture fails and prints the first lines of stderr — it never drops data silently.

## Complete example

```yaml
# cordis.patch.yml
- insert:
    - id: edge-bridge
      name: dsh-edge-bridge
      config:
        port: 17333
        autoStart: false
        idleTimeoutMinutes: 30
        stopWhenDisconnected: true
        captureTitle: edge页面抓取
        kbCollection: 页面抓取
        kbRoot: E:/DSH工作区/论文/知识库
```

## Compatibility

| Plugin | Extension | Notes |
| --- | --- | --- |
| 0.3.x | 0.3.x | full support for `ref` / `expect` / `effect_state` / capabilities |
| 0.3.x | 0.2.x | connects; `edge_act` has no `effect_state` line; `edge_inspect` returns no `ref` |
| 0.2.x | 0.3.x | connects; the extension declares more than the plugin reads |

A mismatch is called out directly on the `caps:` line of `edge_status`, and logged as a warning by `edge_bridge`. **After any extension change, click Reload in `edge://extensions`** — restarting DSH does not replace the service worker's code.
