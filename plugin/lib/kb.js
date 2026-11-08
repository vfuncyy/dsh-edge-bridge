/**
 * Knowledge-base sink: turns a captured page into an entry in the user's
 * literature knowledge base (`E:\DSH工作区\论文\知识库` by default).
 *
 * What lands where:
 *   <KB>/补充/原文/页面抓取/<date>_<clock>-<slug>.html   self-contained snapshot
 *   <KB>/补充/条目.json                                  one `supNNN` entry, type webpage
 *   <KB>/页面抓取/清单.md                                human-readable index of the topic
 *
 * The snapshot is a real HTML file on purpose: `kb.py` extracts full text from
 * html/pdf/epub/pptx/docx, so the page becomes searchable by `kb.py search`
 * together with everything else in the library. Markdown would not be indexed.
 *
 * `kb.py build` (≈4 s) and `kb.py extract` run in the background, debounced,
 * after the capture job finishes; a failed sync never loses the snapshot.
 *
 * @module dsh-edge-bridge/kb
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_KB_ROOT = 'E:/DSH工作区/论文/知识库';
const DEFAULT_COLLECTION = '页面抓取';
const DEFAULT_PYTHON = 'E:/.dsh/dsh-runtimes/dsh-next-primary-runtime/dependencies/python/python.exe';
const SYNC_DEBOUNCE_MS = 3_000;
const MAX_ABSTRACT = 220;

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function stampOf(date) {
  return {
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    clock: `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
    iso: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    year: String(date.getFullYear()),
  };
}

function slugify(text, fallback) {
  const cleaned = String(text ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
    .replace(/[-.]+$/g, '');
  return cleaned.length > 0 ? cleaned : fallback;
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** First meaningful sentences, for the KB abstract column. */
function abstractOf(body) {
  // Start after the first heading: site navigation often precedes the article.
  const lines = String(body ?? '').split('\n');
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s/.test(line));
  const source = headingIndex > 0 ? lines.slice(headingIndex).join('\n') : lines.join('\n');
  const flat = source
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= MAX_ABSTRACT) return flat;
  const cut = flat.slice(0, MAX_ABSTRACT);
  const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('.'), cut.lastIndexOf('；'));
  return stop > MAX_ABSTRACT * 0.5 ? cut.slice(0, stop + 1) : `${cut}…`;
}

function domainOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** A Markdown table cell must not smuggle in pipes or newlines. */
function cell(text, limit = 90) {
  const value = String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

export function createKbSink({ config = {}, logger } = {}) {
  const root = path.resolve(String(config.kbRoot || DEFAULT_KB_ROOT));
  const collection =
    typeof config.collection === 'string' && config.collection.trim() !== ''
      ? config.collection.trim()
      : DEFAULT_COLLECTION;
  const python = String(config.python || DEFAULT_PYTHON);
  const enabled = config.sync !== false;

  const manifest = path.join(root, '补充', '条目.json');
  const attachDir = path.join(root, '补充', '原文', collection);
  const browseDir = path.join(root, collection);
  const browseIndex = path.join(browseDir, '清单.md');

  const state = {
    saved: 0,
    ids: [],
    backup: '',
    lastSyncAt: 0,
    lastSyncResult: '',
    lastSyncError: '',
    syncing: false,
  };
  const pending = new Set();
  let timer = null;

  function available() {
    try {
      return fs.statSync(manifest).isFile();
    } catch {
      return false;
    }
  }

  function loadManifest() {
    const raw = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (!Array.isArray(raw.items)) raw.items = [];
    return raw;
  }

  function backupOnce() {
    if (state.backup !== '') return state.backup;
    const stamp = `${new Date().getFullYear()}${pad(new Date().getMonth() + 1)}${pad(new Date().getDate())}-${pad(new Date().getHours())}${pad(new Date().getMinutes())}${pad(new Date().getSeconds())}`;
    const target = `${manifest}.bak-${stamp}`;
    try {
      fs.copyFileSync(manifest, target);
      state.backup = target;
      logger?.info?.(`edge-bridge: backed up 条目.json to ${target}`);
    } catch (error) {
      logger?.warn?.(`edge-bridge: could not back up 条目.json: ${messageOf(error)}`);
    }
    return state.backup;
  }

  function nextId(items) {
    let max = 0;
    for (const item of items) {
      const id = String(item?.id ?? '');
      if (!id.startsWith('sup')) continue;
      const digits = id.slice(3);
      if (!/^\d+$/.test(digits)) continue;
      const value = Number.parseInt(digits, 10);
      if (Number.isFinite(value) && value > max) max = value;
    }
    return `sup${max + 1}`;
  }

  function uniqueFile(base) {
    let candidate = `${base}.html`;
    let counter = 2;
    while (fs.existsSync(candidate)) {
      candidate = `${base}-${counter}.html`;
      counter += 1;
    }
    return candidate;
  }

  function snapshotHtml(snapshot, stamps) {
    const title = snapshot.title !== '' ? snapshot.title : snapshot.url;
    const lines = [
      '<!DOCTYPE html>',
      `<html lang="${escapeHtml(snapshot.language || 'zh')}">`,
      '<head>',
      '<meta charset="utf-8">',
      `<title>${escapeHtml(title)}</title>`,
      `<meta name="dsh:url" content="${escapeHtml(snapshot.url)}">`,
      `<meta name="dsh:captured-at" content="${escapeHtml(stamps.iso)}">`,
      `<meta name="dsh:source" content="${escapeHtml(snapshot.source)}">`,
      `<meta name="dsh:tab" content="${escapeHtml(String(snapshot.tabId ?? 0))}">`,
      '</head>',
      '<body>',
      '<article>',
      `<h1>${escapeHtml(title)}</h1>`,
      `<p class="source"><a href="${escapeHtml(snapshot.url)}">${escapeHtml(snapshot.url)}</a></p>`,
      `<p class="meta">抓取于 ${escapeHtml(stamps.iso)}（${escapeHtml(snapshot.source)}），Microsoft Edge 标签页 ${escapeHtml(String(snapshot.tabId ?? 0))}</p>`,
      `<pre class="body">${escapeHtml(snapshot.body.trim())}</pre>`,
      '</article>',
      '</body>',
      '</html>',
      '',
    ];
    return lines.join('\n');
  }

  function renderBrowseIndex(items) {
    const mine = items
      .filter((item) => (item?.collections ?? []).includes(collection))
      .sort((a, b) => String(b?.date ?? '').localeCompare(String(a?.date ?? '')));
    const lines = [
      `# ${collection}`,
      '',
      `由 DSH Edge Bridge 扩展抓取的网页快照，共 ${mine.length} 条，已作为专题「${collection}」录入知识库。`,
      '',
      '快照文件（自包含 HTML，可离线打开）位于 `补充/原文/页面抓取/`；题录、摘要与全文由 `kb.py` 建索引，可直接检索：',
      '',
      '```',
      `kb.py search 关键词 --collection ${collection}`,
      '```',
      '',
      '| 抓取时间 | 入库 ID | 标题 | 来源 | 快照 |',
      '| --- | --- | --- | --- | --- |',
    ];
    for (const item of mine) {
      const file = String(item?.files?.[0]?.name ?? '');
      lines.push(
        `| ${cell(item?.date, 24)} | ${cell(item?.id, 12)} | ${cell(item?.title)} | ${cell(domainOf(item?.url), 32)} | ${file === '' ? '' : `[${cell(path.basename(file), 40)}](../补充/原文/${encodeURI(file)})`} |`,
      );
    }
    lines.push('');
    return lines.join('\n');
  }

  /**
   * Write the HTML snapshot and append one entry to 补充/条目.json.
   * Throws only when the snapshot itself cannot be written.
   */
  function savePage(snapshot) {
    const stamps = stampOf(snapshot.capturedAt ?? new Date());
    const slug = slugify(snapshot.title, slugify(snapshot.url, 'page'));
    fs.mkdirSync(attachDir, { recursive: true });
    const file = uniqueFile(path.join(attachDir, `${stamps.day}_${stamps.clock}-${slug}`));
    fs.writeFileSync(file, snapshotHtml(snapshot, stamps), 'utf8');
    const name = `${collection}/${path.basename(file)}`;

    let id = '';
    if (available()) {
      backupOnce();
      try {
        const doc = loadManifest();
        const items = doc.items;
        id = nextId(items);
        items.push({
          id,
          type: 'webpage',
          title: snapshot.title !== '' ? snapshot.title : snapshot.url,
          authors: [],
          year: stamps.year,
          date: stamps.day,
          container: domainOf(snapshot.url),
          url: snapshot.url,
          language: snapshot.language || 'zh',
          abstract: abstractOf(snapshot.body),
          note: `抓取自 Microsoft Edge（DSH Edge Bridge 扩展，来源：${snapshot.source}），快照为自包含 HTML，正文由页面脚本提取${snapshot.truncated ? '（原文过长已截断）' : ''}。`,
          files: [{ name, label: 'HTML 快照' }],
          collections: [collection],
          tags: [collection].concat(domainOf(snapshot.url) !== '' ? [domainOf(snapshot.url)] : []),
        });
        fs.writeFileSync(manifest, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
        fs.mkdirSync(browseDir, { recursive: true });
        fs.writeFileSync(browseIndex, renderBrowseIndex(items), 'utf8');
        state.saved += 1;
        state.ids.push(id);
        pending.add(id);
        schedule();
      } catch (error) {
        logger?.warn?.(`edge-bridge: could not add "${snapshot.title}" to 条目.json: ${messageOf(error)}`);
        id = '';
      }
    } else {
      logger?.warn?.(`edge-bridge: knowledge base not found at ${manifest}; snapshot kept at ${file}`);
    }

    return { id, file, name, chars: snapshot.body.length };
  }

  /**
   * Drop one capture: the manifest entry, its snapshot, the extracted body and
   * the card, then regenerate the topic listing. Used when a page turned out to
   * be reader chrome instead of an article.
   */
  function removeCapture(id) {
    if (!available()) return { removed: false, reason: 'the knowledge base was not found' };
    const doc = loadManifest();
    const index = doc.items.findIndex((item) => item?.id === id);
    if (index < 0) return { removed: false, reason: `no entry ${id} in 补充/条目.json` };
    const [item] = doc.items.splice(index, 1);
    backupOnce();
    fs.writeFileSync(manifest, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    fs.mkdirSync(browseDir, { recursive: true });
    fs.writeFileSync(browseIndex, renderBrowseIndex(doc.items), 'utf8');
    const removed = [];
    const drop = (target) => {
      try {
        if (fs.existsSync(target)) {
          fs.rmSync(target);
          removed.push(target);
        }
      } catch (error) {
        logger?.warn?.(`edge-bridge: could not delete ${target}: ${messageOf(error)}`);
      }
    };
    const attachments = path.join(root, '补充', '原文');
    for (const file of item.files ?? []) {
      // files[].name already carries the collection prefix ("页面抓取/x.html").
      const abs = path.join(attachments, String(file?.name ?? ''));
      if (abs.startsWith(attachments)) drop(abs);
    }
    for (const group of ['全文', '条目']) {
      const base = path.join(root, group);
      if (!fs.existsSync(base)) continue;
      for (const typeDir of fs.readdirSync(base)) {
        const dir = path.join(base, typeDir);
        if (!fs.statSync(dir).isDirectory()) continue;
        for (const name of fs.readdirSync(dir)) {
          if (name === `${id}.txt` || name === `${id}.md` || name.startsWith(`${id}_`)) drop(path.join(dir, name));
        }
      }
    }
    const stateFile = path.join(root, '全文', '_抽取状态.json');
    if (fs.existsSync(stateFile)) {
      try {
        const doc2 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (doc2 !== null && typeof doc2 === 'object' && Object.prototype.hasOwnProperty.call(doc2, id)) {
          delete doc2[id];
          fs.writeFileSync(stateFile, `${JSON.stringify(doc2, null, 2)}\n`, 'utf8');
        }
      } catch (error) {
        logger?.warn?.(`edge-bridge: could not clean _抽取状态.json: ${messageOf(error)}`);
      }
    }
    pending.delete(id);
    return { removed: true, id, title: String(item.title ?? ''), files: removed };
  }

  function runPython(args) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(python, ['-X', 'utf8', 'kb.py', ...args], {
          cwd: root,
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        });
      } catch (error) {
        resolve({ ok: false, output: messageOf(error) });
        return;
      }
      let output = '';
      const collect = (chunk) => {
        output += String(chunk);
        if (output.length > 20_000) output = output.slice(-20_000);
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.on('error', (error) => resolve({ ok: false, output: `${output}\n${messageOf(error)}` }));
      child.on('close', (code) => resolve({ ok: code === 0, code, output }));
    });
  }

  /** Rebuild the index and extract the new pages; safe to call repeatedly. */
  async function syncNow() {
    if (!enabled || !available() || state.syncing) return state.lastSyncResult;
    if (pending.size === 0) return state.lastSyncResult;
    state.syncing = true;
    const ids = [...pending];
    try {
      const build = await runPython(['build']);
      if (!build.ok) {
        state.lastSyncError = `build 失败：${build.output.trim().split('\n').slice(-3).join(' ')}`;
        logger?.warn?.(`edge-bridge: kb.py build failed: ${state.lastSyncError}`);
        return state.lastSyncError;
      }
      const extract = await runPython(['extract', '--only', ids.join(',')]);
      if (!extract.ok) {
        state.lastSyncError = `extract 失败：${extract.output.trim().split('\n').slice(-3).join(' ')}`;
        logger?.warn?.(`edge-bridge: kb.py extract failed: ${state.lastSyncError}`);
        return state.lastSyncError;
      }
      for (const id of ids) pending.delete(id);
      state.lastSyncAt = Date.now();
      state.lastSyncError = '';
      const summary = build.output
        .split('\n')
        .filter((line) => line.includes('build 完成'))
        .join(' ');
      state.lastSyncResult = `${summary || 'build ok'}（新增 ${ids.length} 条：${ids.join('、')}）`;
      logger?.info?.(`edge-bridge: knowledge base synced — ${state.lastSyncResult}`);
      return state.lastSyncResult;
    } catch (error) {
      state.lastSyncError = messageOf(error);
      return state.lastSyncError;
    } finally {
      state.syncing = false;
      if (pending.size > 0) schedule();
    }
  }

  function schedule(delayMs = SYNC_DEBOUNCE_MS) {
    if (!enabled) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void syncNow();
    }, delayMs);
    timer.unref?.();
  }

  function dispose() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function status() {
    return {
      root,
      collection,
      dir: attachDir,
      saved: state.saved,
      ids: [...state.ids],
      lastSyncAt: state.lastSyncAt,
      lastSyncResult: state.lastSyncResult,
      lastSyncError: state.lastSyncError,
    };
  }

  return {
    root,
    collection,
    attachDir,
    browseDir,
    removeCapture,
    available,
    savePage,
    syncNow,
    schedule,
    dispose,
    status,
  };
}