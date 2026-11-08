/**
 * One-off (and re-runnable) import: the pages captured into the workspace
 * before the knowledge-base sink existed become ordinary `webpage` entries.
 *
 *   node edge-bridge/tools/migrate-captures.mjs [workspaceDir] [kbRoot]
 *
 * Idempotent: a URL already present in 补充/条目.json under the collection is
 * skipped, so running it twice never duplicates an entry.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const workspace = path.resolve(process.argv[2] ?? 'C:/Users/14180/Documents/deepseek-harness/edge页面抓取');
const kbRoot = path.resolve(process.argv[3] ?? 'E:/DSH工作区/论文/知识库');
const collection = '页面抓取';

const { createKbSink } = await import(pathToFileURL(path.join(here, '..', 'plugin', 'lib', 'kb.js')).href);

const logger = { info: (line) => console.log(line), warn: (line) => console.warn(line), debug() {}, error() {} };
const sink = createKbSink({ config: { kbRoot, collection }, logger });

if (!sink.available()) {
  console.error(`knowledge base not found at ${kbRoot}`);
  process.exit(1);
}

/** Minimal YAML front-matter reader for the keys the capture engine writes. */
function parsePage(file) {
  const text = readFileSync(file, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (match === null) return null;
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (pair === null) continue;
    meta[pair[1]] = pair[2].replace(/^"(.*)"$/, '$1');
  }
  let body = match[2];
  // The engine prefixes the snapshot with `# title`, then `<url>`.
  body = body.replace(/^#\s+.*\r?\n+/, '');
  body = body.replace(/^<https?:\/\/[^>]*>\r?\n+/, '');
  return { meta, body: body.trim() };
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}

const manifest = JSON.parse(readFileSync(path.join(kbRoot, '补充', '条目.json'), 'utf8'));
const known = new Set((manifest.items ?? []).filter((item) => (item.collections ?? []).includes(collection)).map((item) => item.url));

const files = walk(path.join(workspace, 'pages'));
if (files.length === 0) {
  console.log('no legacy pages found — nothing to import');
  process.exit(0);
}

let imported = 0;
let skipped = 0;
for (const file of files) {
  const page = parsePage(file);
  if (page === null || page.meta.url === undefined) {
    console.warn(`skipped (no front matter): ${file}`);
    skipped += 1;
    continue;
  }
  if (known.has(page.meta.url)) {
    skipped += 1;
    continue;
  }
  const saved = sink.savePage({
    title: page.meta.title ?? page.meta.url,
    url: page.meta.url,
    body: page.body,
    tabId: Number(page.meta.tab ?? 0),
    capturedAt: page.meta.captured_at !== undefined ? new Date(page.meta.captured_at) : new Date(),
    truncated: page.meta.truncated === 'true',
    source: page.meta.source ?? 'manual',
    language: '',
  });
  known.add(page.meta.url);
  imported += 1;
  console.log(`imported ${saved.id || '(no entry)'} ← ${path.basename(file)} → ${saved.name}`);
}

console.log(`\nimported ${imported}, skipped ${skipped}`);
console.log(`status: ${JSON.stringify(sink.status())}`);
await sink.syncNow();
console.log(`sync: ${sink.status().lastSyncResult || sink.status().lastSyncError}`);
sink.dispose();