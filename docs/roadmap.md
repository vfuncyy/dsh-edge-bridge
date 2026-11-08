# Roadmap

Principle: **add capabilities that reduce failure, not capabilities that add feature count.** The value of this plugin is "zero dependencies, one process, token-efficient". Anything that widens the deployment surface is out by default.

## Next (0.4.0)

In priority order:

### 1. Failure aggregation for batch actions

Batch clicking currently means one `edge_act` call per element, and a mid-way failure aborts. The plan is a `steps` array form of `edge_act`: execute in order, stop in place on an `expect` failure or an `effect_state: unknown`, and return what completed and what did not run. The goal is turning "click a hundred confirm buttons" from a hundred round trips into one or two.

### 2. Stable ordering in `edge_inspect`

Ref numbering is already reused when the page is unchanged, but `Interactive` sorts strictly by `y`, so elements sharing a `y` fall back to DOM order. The plan is `y`, then `x`, then DOM order, to stop ordering from jittering in two-column layouts.

### 3. Structural duplicate detection before capture

Capturing the same URL twice currently produces two `sup` entries. The plan is to deduplicate in `kb.js` on `url + hash of the first N characters`, updating the snapshot and `capturedAt` in place instead of appending.

## Later (0.5.0 or beyond)

- **Chunked reading in `edge_read`**: very long pages can only be truncated today. A `chunk` parameter with `chunk_index` continuation would replace raising `max_chars`.
- **Ref stability in Shadow DOM**: `setAttribute` is refused in some shadow roots and currently skipped silently. A WeakMap could cover the page's lifetime.
- **Volume control in `edge_eval`**: only a flat 100000-character truncation exists. A `max_chars` parameter plus advice ("use `.slice(0, 50)`") would help.
- **Headless coverage for the extension**: `test-page-in-edge` covers the three `page.js` functions; `background.js` dispatch is covered by a fake extension. Running the real extension under `--load-extension` is possible but not yet worth the complexity.

## Explicitly out of scope

| Item | Reason |
| --- | --- |
| Cloud browser / remote hosting | Loopback is the premise of the simplicity; handing over accounts is what this design avoids |
| Agent Window / dedicated controlled window | The point is driving the window you are looking at |
| Operation audit and video recording | Single local user; recording directly conflicts with saving tokens |
| Network capture / request replay | That is DevTools' job |
| Publishing to the Edge store | Brings signing, review and an auto-update chain; source-as-distribution fits this project's size |
| Self-update | Same reason |
| Multilingual UI | One user; Chinese is enough |
| Supporting Chrome/Firefox alongside Edge | There is no Edge-specific logic and it may load in Chrome directly, but only Edge is verified — no promise |

## Filing a request

An issue should say three things: **what you are trying to do, where it gets stuck, and the most telling lines of the receipt**. If it can be reproduced in `test-contract` or one of the behavioural suites, better still — this project decides whether a request is worth doing by asking "does it make a class of failure decidable".
