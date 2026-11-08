/**
 * Page capture: turns "the user pressed a button in Edge" into knowledge-base
 * entries plus a readable summary in the `edge页面抓取` workspace.
 *
 * Division of labour:
 *   extension   decides *when* a page should be captured (session toggles, tab
 *               loads, batch requests) and only sends intent;
 *   this module reads the page through the bridge, hands it to the KB sink
 *               (`lib/kb.js` → 补充/原文/页面抓取 + 补充/条目.json + kb.py build),
 *               and writes a per-job summary into the workspace.
 *
 * Every capture is independent: one page that fails (a `chrome://` tab, a page
 * still loading, a site that blocks injection) must not abort the batch.
 *
 * @module dsh-edge-bridge/capture
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TITLE = 'edge页面抓取';
const MAX_PAGE_CHARS = 6_000_000;
const MAX_INDEX_ENTRIES = 2_000;
const SUMMARY_DIR = '总结';

const SOURCE_LABELS = {
  start: '启动抓取页面（当前页）',
  load: '会话期间自动抓取（页面加载）',
  batch: '批量抓取已打开的页面',
  manual: '手动抓取',
  stop: '停止抓取页面（会话总结）',
};

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function localStamp(date) {
  return {
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    clock: `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
    human: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    iso: date.toISOString(),
  };
}

/** A Markdown table cell must not smuggle in pipes or newlines. */
function cell(text, limit = 70) {
  const value = String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * `page.read` in markdown mode prefixes the title heading and the bare URL.
 * The snapshot already prints both, so the body must not repeat them.
 */
/**
 * Site chrome often precedes the article as a run of navigation links
 * ("网页 新闻 贴吧 知道 ..." on 百度百科). Drop such a prefix when it holds
 * several links and no sentence at all.
 */
function trimLeadingNav(text) {
  const lines = text.split('\n');
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s/.test(line));
  if (headingIndex <= 0 || headingIndex > 40) return text;
  const prefix = lines.slice(0, headingIndex).join('\n');
  const links = (prefix.match(/\]\(/g) ?? []).length;
  const flat = prefix.replace(/\]\([^)]*\)/g, ']');
  if (links >= 5 && !/[。！？.!?]/.test(flat)) return lines.slice(headingIndex).join('\n');
  return text;
}

function stripPreamble(text, title, url) {
  const lines = String(text ?? '').replace(/^\s+/, '').split('\n');
  const plain = (line) =>
    line
      .replace(/^#{1,6}\s*/, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const wanted = plain(title);
  const bare = (value) => String(value).split(' | ')[0].trim();
  // The page title as a leading heading (`# <title>`, sometimes with a byline link).
  while (lines.length > 0 && /^#{1,6}\s/.test(lines[0])) {
    const heading = plain(lines[0]);
    const near =
      wanted === '' ||
      heading === wanted ||
      wanted.startsWith(heading) ||
      heading.startsWith(wanted) ||
      (bare(heading) !== '' && (bare(wanted).startsWith(bare(heading)) || bare(heading).startsWith(bare(wanted))));
    if (!near) break;
    lines.shift();
  }
  // Blank lines and the bare `<url>` line that markdown mode emits.
  while (lines.length > 0 && (lines[0].trim() === '' || /^<https?:\/\/[^>]+>$/.test(lines[0].trim()) || lines[0].trim() === url)) {
    lines.shift();
  }
  return lines.join('\n').trim();
}

export function createCapture({ bridge, ctx, logger, config = {}, kb }) {
  const title = typeof config.title === 'string' && config.title.trim() !== '' ? config.title.trim() : DEFAULT_TITLE;
  const state = {
    dir: config.dir !== undefined && config.dir !== '' ? path.resolve(config.dir) : null,
    migratedFrom: '',
    ready: false,
    workspaceId: null,
    registeredPath: '',
    pages: 0,
    failed: 0,
    lastError: '',
    lastCaptureAt: 0,
    session: null,
  };

  /**
   * Best guess without touching the filesystem registry: next to the
   * deployment's fallback workspace, else the user's Documents.
   */
  function provisionalBase() {
    const service = ctx.get?.('workingDirectory');
    const base = typeof service?.defaultDirectory === 'string' ? service.defaultDirectory.trim() : '';
    if (base !== '') return path.dirname(path.resolve(base));
    const home = process.env.USERPROFILE ?? process.env.HOME ?? process.cwd();
    return path.join(home, 'Documents');
  }

  /**
   * Where the summary workspace should live: an explicit config wins, then the
   * sibling of whatever directory the user actually works in (the workspace
   * registry knows it), and only then the static guesses. The registry is
   * authoritative because `workingDirectory` may not be provided yet when the
   * Host loads bundles — and once it appears the workspace is moved to the
   * better location instead of staying in the fallback.
   */
  async function resolveBase() {
    if (config.dir !== undefined && config.dir !== '') return path.resolve(config.dir);
    const registry = ctx.get?.('workspaceRegistry');
    if (registry !== undefined && registry !== null && typeof registry.list === 'function') {
      try {
        const workspaces = await registry.list();
        if (Array.isArray(workspaces)) {
          const home = workspaces.find(
            (workspace) => typeof workspace?.path === 'string' && path.basename(workspace.path).toLowerCase() === 'default-workspace',
          );
          if (home !== undefined) return path.dirname(path.resolve(home.path));
        }
      } catch (error) {
        logger?.debug?.(`edge-bridge: workspace registry unavailable: ${messageOf(error)}`);
      }
    }
    return provisionalBase();
  }

  function move(oldDir, newDir) {
    if (!fs.existsSync(oldDir)) return;
    try {
      fs.mkdirSync(path.dirname(newDir), { recursive: true });
      fs.cpSync(oldDir, newDir, { recursive: true, force: true });
      fs.rmSync(oldDir, { recursive: true, force: true });
      state.migratedFrom = oldDir;
      logger?.info?.(`edge-bridge: moved the capture workspace from ${oldDir} to ${newDir}`);
    } catch (error) {
      logger?.warn?.(`edge-bridge: could not move the capture workspace to ${newDir}: ${messageOf(error)}`);
    }
  }

  function adopt(next) {
    if (state.dir === next) return;
    if (state.dir !== null) move(state.dir, next);
    state.dir = next;
  }

  function directory() {
    if (state.dir === null) state.dir = path.join(provisionalBase(), title);
    return state.dir;
  }

  function summaryDir() {
    return path.join(directory(), SUMMARY_DIR);
  }

  function indexFile() {
    return path.join(directory(), 'index.json');
  }

  function loadIndex() {
    try {
      const parsed = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
      return Array.isArray(parsed) ? parsed.filter((entry) => entry !== null && typeof entry === 'object') : [];
    } catch {
      return [];
    }
  }

  function renderIndex(entries) {
    const lines = [
      `# ${title} · 抓取总结`,
      '',
      `共 ${entries.length} 次抓取作业。页面本身已录入知识库专题「${kb?.collection ?? '页面抓取'}」，本工作区只保留每次作业的总结，方便你直接在这里继续整理与写作。`,
      '',
      `- 快照：\`${kb?.attachDir ?? ''}\``,
      `- 题录与全文：知识库 \`补充/条目.json\`，由 \`kb.py\` 建索引`,
      '',
      '| 时间 | 方式 | 成功 | 失败 | 总结 |',
      '| --- | --- | --- | --- | --- |',
    ];
    for (const entry of entries) {
      const href = encodeURI(String(entry.file ?? '').split(path.sep).join('/'));
      lines.push(
        `| ${cell(entry.at, 20)} | ${cell(entry.label, 26)} | ${entry.saved ?? 0} | ${entry.failed ?? 0} | [${cell(path.basename(String(entry.file ?? '')))}](${href}) |`,
      );
    }
    lines.push('');
    return lines.join('\n');
  }

  function renderReadme() {
    return [
      `# ${title}`,
      '',
      'DSH Edge Bridge 每次抓取作业的**总结**工作区：抓到的页面本身不在这个目录里，已经录入你的文献知识库。',
      '',
      '## 抓取去向',
      '',
      `- 快照（自包含 HTML，含标题、原文链接、正文）：\`${kb?.attachDir ?? '<知识库>/补充/原文/页面抓取/'}\``,
      '- 题录 / 摘要 / 全文索引：知识库 `补充/条目.json` + `索引.json`（`kb.py build` 生成）',
      `- 知识库专题：\`${kb?.collection ?? '页面抓取'}\`，可直接 \`kb.py search 关键词 --collection ${kb?.collection ?? '页面抓取'}\``,
      '',
      '## 本目录结构',
      '',
      `- \`${SUMMARY_DIR}/<日期>_<时刻>-<方式>.md\` — 每次作业的总结：抓了什么、入库 ID、失败原因、下一步建议`,
      '- `index.json` — 机器可读的作业索引（最新在前）',
      '- `index.md` — 人可读的作业索引表',
      '- `README.md` — 本说明',
      '',
    ].join('\n');
  }

  function writeIndex(entries) {
    const trimmed = entries.slice(0, MAX_INDEX_ENTRIES);
    fs.writeFileSync(indexFile(), `${JSON.stringify(trimmed, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(directory(), 'index.md'), renderIndex(trimmed), 'utf8');
    state.pages = trimmed.length;
  }

  function appendSummary(entry) {
    const entries = loadIndex();
    entries.unshift(entry);
    writeIndex(entries);
  }

  /** Create the directory skeleton and register it as a DSH workspace once. */
  async function ensure() {
    if (config.dir === undefined || config.dir === '') {
      adopt(path.join(await resolveBase(), title));
    }
    const dir = directory();
    fs.mkdirSync(summaryDir(), { recursive: true });
    const readme = path.join(dir, 'README.md');
    const wantedReadme = renderReadme();
    if (!fs.existsSync(readme) || fs.readFileSync(readme, 'utf8') !== wantedReadme) {
      fs.writeFileSync(readme, wantedReadme, 'utf8');
    }
    // The first version of this feature wrote the pages themselves here; they
    // live in the knowledge base now, so an empty leftover directory goes away.
    const legacy = path.join(dir, 'pages');
    try {
      if (fs.existsSync(legacy) && fs.readdirSync(legacy).length === 0) fs.rmdirSync(legacy);
    } catch {
      /* a non-empty legacy directory is left alone */
    }
    if (!fs.existsSync(indexFile())) writeIndex([]);
    state.ready = true;

    const registry = ctx.get?.('workspaceRegistry');
    if (registry === undefined || registry === null) return dir;
    const wanted = path.resolve(dir).toLowerCase();
    if (state.registeredPath === wanted) return dir;
    try {
      const existing = typeof registry.list === 'function' ? await registry.list() : [];
      const known = Array.isArray(existing)
        ? existing.find((workspace) => typeof workspace?.path === 'string' && path.resolve(workspace.path).toLowerCase() === wanted)
        : undefined;
      if (known !== undefined) {
        state.registeredPath = wanted;
        state.workspaceId = known.id ?? null;
        return dir;
      }
      const stale = Array.isArray(existing)
        ? existing.filter((workspace) => {
            if (typeof workspace?.path !== 'string') return false;
            const resolved = path.resolve(workspace.path).toLowerCase();
            if (resolved === wanted) return false;
            // Ours by title, or a placeholder left over from a previous location.
            return workspace.title === title || workspace.path === state.migratedFrom || (state.registeredPath !== '' && resolved === state.registeredPath);
          })
        : [];
      if (typeof registry.create === 'function') {
        const created = await registry.create(dir, title);
        state.registeredPath = wanted;
        state.workspaceId = created?.id ?? null;
        logger?.info?.(`edge-bridge: registered workspace "${title}" (${created?.id ?? 'unknown id'}) at ${dir}`);
      }
      // Drop the placeholder workspace left behind before the relocation.
      for (const workspace of stale) {
        if (workspace.id === undefined || workspace.id === state.workspaceId) continue;
        if (typeof registry.delete !== 'function') continue;
        try {
          await registry.delete(workspace.id);
          logger?.info?.(`edge-bridge: removed stale capture workspace ${workspace.id} at ${workspace.path}`);
        } catch (error) {
          logger?.warn?.(`edge-bridge: could not remove the stale capture workspace: ${messageOf(error)}`);
        }
      }
    } catch (error) {
      logger?.warn?.(`edge-bridge: could not register the capture workspace: ${messageOf(error)}`);
    }
    return dir;
  }

  function renderSummary(kind, records, failures, at) {
    const stamp = localStamp(at);
    const label = SOURCE_LABELS[kind] ?? kind;
    const lines = [
      `# 抓取总结 · ${stamp.human}`,
      '',
      `- 方式：${label}`,
      `- 结果：成功 ${records.length}，失败 ${failures.length}`,
      `- 知识库专题：\`${kb?.collection ?? '页面抓取'}\``,
      `- 快照目录：\`${kb?.attachDir ?? ''}\``,
      '',
      '## 已入库页面',
      '',
      '| 入库 ID | 标题 | 来源 | 字数 |',
      '| --- | --- | --- | --- |',
    ];
    if (records.length === 0) lines.push('| — | （无） | — | — |');
    for (const record of records) {
      lines.push(`| ${cell(record.id || '—', 10)} | ${cell(record.title, 46)} | ${cell(hostOf(record.url), 28)} | ${record.chars ?? 0} |`);
    }
    lines.push('', '## 原文链接', '');
    if (records.length === 0) lines.push('- （无）');
    for (const record of records) lines.push(`- ${record.title}：${record.url}`);
    if (failures.length > 0) {
      lines.push('', '## 失败', '');
      for (const failure of failures) lines.push(`- 标签页 ${failure.tabId ?? '—'}：${failure.error}`);
    }
    const ids = records.map((record) => record.id).filter((id) => typeof id === 'string' && id !== '');
    lines.push(
      '',
      '## 下一步',
      '',
      ids.length > 0
        ? `- 已建索引的条目：${ids.join('、')}；检索用 \`kb.py search 关键词 --collection ${kb?.collection ?? '页面抓取'}\``
        : '- 本批没有成功入库的条目，先看上面的失败原因',
      '- 需要基于这些页面写东西时，直接在本工作区继续（快照与全文都在知识库里，随时可查）',
      '',
    );
    return lines.join('\n');
  }

  function writeSummary(kind, records, failures, at = new Date()) {
    const stamp = localStamp(at);
    const slug = kind === 'stop' ? 'stop' : kind;
    let file = path.join(summaryDir(), `${stamp.day}_${stamp.clock}-${slug}.md`);
    let counter = 2;
    while (fs.existsSync(file)) {
      file = path.join(summaryDir(), `${stamp.day}_${stamp.clock}-${slug}-${counter}.md`);
      counter += 1;
    }
    fs.mkdirSync(summaryDir(), { recursive: true });
    fs.writeFileSync(file, renderSummary(kind, records, failures, at), 'utf8');
    const entry = {
      at: stamp.human,
      kind,
      label: SOURCE_LABELS[kind] ?? kind,
      saved: records.length,
      failed: failures.length,
      ids: records.map((record) => record.id).filter((id) => typeof id === 'string' && id !== ''),
      file: path.relative(directory(), file).split(path.sep).join('/'),
    };
    appendSummary(entry);
    return { ...entry, path: file };
  }

  /**
   * Capture one tab: read the page, write the KB snapshot + entry, return the
   * record. Throws with a readable reason when the page cannot be read.
   */
  async function captureTab(tabId, meta = {}) {
    const source = typeof meta.source === 'string' && meta.source !== '' ? meta.source : 'manual';
    const id = Number.isInteger(tabId) ? tabId : undefined;
    await ensure();
    let read;
    try {
      read = await bridge.request(
        'page.read',
        { tabId: id, format: 'markdown', maxChars: MAX_PAGE_CHARS, includeLinks: true },
        { timeoutMs: 60_000 },
      );
    } catch (error) {
      state.failed += 1;
      state.lastError = messageOf(error);
      throw error;
    }
    const raw = typeof read?.text === 'string' ? read.text : '';
    const url = typeof read?.url === 'string' ? read.url : '';
    const pageTitle = typeof read?.title === 'string' ? read.title.trim() : '';
    const body = stripPreamble(raw, pageTitle, url);
    if (body.trim() === '') {
      state.failed += 1;
      state.lastError = 'the page produced no text';
      throw new Error(`"${pageTitle !== '' ? pageTitle : url}" produced no text — it may be empty, still loading, or blocked by another extension`);
    }
    // A PDF/viewer page draws the article into <canvas>: the DOM holds reader
    // chrome only (page thumbnails, toolbars, "log in" hints), never the text.
    const meaningful = body
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (Number(read?.canvasCount) > 0 && meaningful.length < 1200) {
      state.failed += 1;
      state.lastError = 'the page renders its content into a canvas';
      throw new Error(
        `"${pageTitle !== '' ? pageTitle : url}" 用 canvas 渲染正文（${read.canvasCount} 个 canvas），DOM 里只有阅读器界面文字，抓不到文章。请改用该站的「下载 PDF」或 HTML 版页面再抓。`,
      );
    }
    // Defensive: older builds of page.js rendered inline icons as
    // ![alt](data:image/png;base64,...) — tens of kilobytes each. Strip them and
    // refuse a page whose body is mostly image data (a reader/canvas page whose
    // text never reaches the DOM).
    const inlineImages = body.match(/!\[[^\]]*\]\(data:[^)]*\)/g) ?? [];
    const inlineChars = inlineImages.reduce((total, item) => total + item.length, 0);
    const textShare = body.length === 0 ? 0 : (body.length - inlineChars) / body.length;
    if (inlineImages.length >= 3 && textShare < 0.5) {
      state.failed += 1;
      state.lastError = 'the page body is mostly inline image data';
      throw new Error(
        `"${pageTitle !== '' ? pageTitle : url}" 的正文几乎全是内联图片数据（${inlineImages.length} 张 data: 图片，占 ${Math.round((1 - textShare) * 100)}%），DOM 里没有可读的文章正文；这类 PDF 阅读器/画布渲染页面请改用「下载 PDF」或 HTML 版页面再抓（也可在 edge://extensions 重新加载扩展以获得更精确的检测）。`,
      );
    }
    const cleanBody = trimLeadingNav(
      body.replace(/!\[([^\]]*)\]\(data:[^)]*\)/g, '$1').replace(/\n{3,}/g, '\n\n'),
    );
    // Reader chrome: a PDF reader lists its pages as "- Page 1 … - Page N" and
    // shows a recognisable toolbar. The article itself never reaches the DOM.
    // page.read flattens the thumbnail strip onto one line on CNKI's reader
    // ("目录对比阅读 - Page 1 - Page 2 … - Page 15"), so count inline marks too.
    const pageNumbers = new Set();
    for (const match of cleanBody.matchAll(/(?:^|[\s|｜,，;；、])-\s*Page\s+(\d{1,4})\b/g)) pageNumbers.add(match[1]);
    const thumbnails = pageNumbers.size;
    // Reader-only toolbar words. Generic article chrome (播报/编辑/讨论/收藏/赞)
    // is deliberately excluded: normal articles carry those too.
    const chromeWords = ['全部目录', '目录对比阅读', '划词', '划词笔记', '高亮', '摘录', '登录个人账号'];
    const chromeMarkers = chromeWords.filter((marker) => cleanBody.includes(marker)).length;
    if (thumbnails >= 3 || chromeMarkers >= 2) {
      state.failed += 1;
      state.lastError = 'the page is a PDF reader shell, not the article';
      throw new Error(
        `"${pageTitle !== '' ? pageTitle : url}" 抓到的是 PDF 阅读器外壳（${thumbnails} 个 "- Page N" 缩略条目、${chromeMarkers} 个阅读器工具条标记），正文在画布/PDF 中，DOM 拿不到，未入库。请在该站「下载 PDF」或「下载 CAJ」后按知识库常规流程入库，或换 HTML 版页面重抓。`,
      );
    }
    const capturedAt = new Date();
    const saved = kb.savePage({
      title: pageTitle !== '' ? pageTitle : url,
      url,
      body: cleanBody,
      tabId: id ?? 0,
      capturedAt,
      truncated: read?.truncated === true,
      source,
      language: typeof read?.lang === 'string' ? read.lang : '',
    });
    const record = {
      id: saved.id,
      title: pageTitle !== '' ? pageTitle : url,
      url,
      file: saved.name,
      path: saved.file,
      capturedAt: capturedAt.toISOString(),
      chars: cleanBody.length,
      source,
      tab: id ?? 0,
      truncated: read?.truncated === true,
    };
    state.lastCaptureAt = Date.now();
    // Everything captured while a session is running belongs to its summary —
    // the page that started the session included, not just later page loads.
    if (state.session !== null && source !== 'stop') {
      state.session.pages.push(record);
    }
    return record;
  }

  async function captureMany(tabIds, meta = {}) {
    const saved = [];
    const failed = [];
    for (const tabId of tabIds) {
      try {
        saved.push(await captureTab(tabId, meta));
      } catch (error) {
        failed.push({ tabId, error: messageOf(error) });
      }
    }
    return { saved, failed };
  }

  function status() {
    return {
      dir: directory(),
      ready: state.ready,
      jobs: state.pages,
      failed: state.failed,
      lastError: state.lastError,
      lastCaptureAt: state.lastCaptureAt,
      kb: kb.status(),
    };
  }

  /**
   * Handle one `event` frame from the extension. Buttons on the browser side
   * only send intent; the work and the notification text happen here.
   */
  async function handleEvent(event) {
    const name = event?.name;
    const data = event?.data ?? {};

    if (name === 'capture.page') {
      const tabId = Number.isInteger(data.tabId) ? data.tabId : undefined;
      const source = typeof data.source === 'string' ? data.source : 'manual';
      if (source === 'start') state.session = { startedAt: Date.now(), pages: [] };
      try {
        const record = await captureTab(tabId, { source });
        if (source !== 'load') writeSummary(source, [record], [], new Date());
        bridge.broadcast('capture.result', {
          ok: true,
          tabId: tabId ?? null,
          title: record.title,
          url: record.url,
          file: record.file,
          chars: record.chars,
          kbId: record.id,
          kbDir: kb.attachDir,
          source,
        });
        return record;
      } catch (error) {
        const reason = messageOf(error);
        const failed = [{ tabId: tabId ?? null, error: reason }];
        if (source !== 'load') writeSummary(source, [], failed, new Date());
        bridge.broadcast('capture.result', {
          ok: false,
          tabId: tabId ?? null,
          title: typeof data.url === 'string' ? data.url : '',
          error: reason,
          source,
        });
        return { ok: false, error: reason };
      }
    }

    if (name === 'capture.batch') {
      const ids = Array.isArray(data.tabIds) ? data.tabIds.filter((id) => Number.isInteger(id)) : [];
      if (ids.length === 0) {
        bridge.broadcast('capture.batch.result', { ok: false, saved: 0, failed: 0, error: '没有可抓取的页面（只支持 http/https 标签页）' });
        return { ok: false, error: 'no capturable tabs' };
      }
      const result = await captureMany(ids, { source: 'batch' });
      const summary = writeSummary('batch', result.saved, result.failed, new Date());
      bridge.broadcast('capture.batch.result', {
        ok: result.saved.length > 0,
        saved: result.saved.length,
        failed: result.failed.length,
        files: result.saved.map((record) => ({ title: record.title, file: record.file, url: record.url, id: record.id })),
        errors: result.failed,
        kbDir: kb.attachDir,
        summary: summary.file,
      });
      return result;
    }

    if (name === 'capture.stop') {
      const pages = state.session?.pages ?? [];
      const failures = [];
      const summary = writeSummary('stop', pages, failures, new Date());
      state.session = null;
      bridge.broadcast('capture.stop.result', { ok: true, pages: pages.length, summary: summary.file, kbDir: kb.attachDir });
      return { ok: true, pages: pages.length, summary: summary.file };
    }

    if (name === 'capture.status') {
      bridge.broadcast('capture.status.result', status());
      return status();
    }

    return undefined;
  }

  return { ensure, captureTab, captureMany, handleEvent, status, directory, summaryDir };
}