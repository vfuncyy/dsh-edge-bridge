#!/usr/bin/env node
/**
 * Remove one captured page from the knowledge base.
 *
 *   node edge-bridge/tools/remove-capture.mjs sup383
 *
 * Deletes the 补充/条目.json entry, its HTML snapshot, the extracted body under
 * 全文/, the card under 条目/, then rebuilds the index with `kb.py build`.
 * Useful when a capture turned out to be reader chrome instead of an article.
 */
import { createKbSink } from '../plugin/lib/kb.js';

const id = String(process.argv[2] ?? '').trim();
if (id === '') {
  console.error('usage: node edge-bridge/tools/remove-capture.mjs <supNNN>');
  process.exit(2);
}

const logger = {
  info: (message) => console.log(`[kb] ${message}`),
  warn: (message) => console.warn(`[kb] ${message}`),
};

const sink = createKbSink({ config: {}, logger });
const result = sink.removeCapture(id);
console.log(JSON.stringify(result, null, 2));
if (!result.removed) process.exit(1);

const sync = await sink.syncNow();
console.log(`sync: ${sync}`);