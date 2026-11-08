/**
 * Capture engine tests: pages go to the knowledge base, summaries go to the
 * workspace. No Edge and no Python involved — the bridge and the knowledge
 * base are both faked on disk.
 *
 *   node edge-bridge/tools/test-capture.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { createCapture } = await import(pathToFileURL(path.join(here, '..', 'plugin', 'lib', 'capture.js')).href);
const { createKbSink } = await import(pathToFileURL(path.join(here, '..', 'plugin', 'lib', 'kb.js')).href);

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
  } else {
    failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

function quietLogger() {
  return { info() {}, warn() {}, debug() {}, error() {} };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-capture-'));
const kbRoot = path.join(tmp, 'kb');
const workDir = path.join(tmp, 'work', 'edge页面抓取');
const base = path.join(tmp, 'work');

function seedKb() {
  fs.mkdirSync(path.join(kbRoot, '补充'), { recursive: true });
  fs.writeFileSync(
    path.join(kbRoot, '补充', '条目.json'),
    `${JSON.stringify({ version: 1, note: 'seed', items: [{ id: 'sup7', type: 'pdf', title: 'seed', collections: ['x'] }] }, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(kbRoot, 'kb.py'), '# fake\n', 'utf8');
}
seedKb();

/** A workspace registry that remembers what it was asked to do. */
function makeRegistry() {
  const created = [];
  const deleted = [];
  const existing = [];
  return {
    created,
    deleted,
    existing,
    async list() {
      return [...existing];
    },
    async create(dir, title) {
      const workspace = { id: `ws-${created.length + 1}`, path: dir, title };
      created.push(workspace);
      existing.push(workspace);
      return workspace;
    },
    async delete(id) {
      deleted.push(id);
      const index = existing.findIndex((workspace) => workspace.id === id);
      if (index >= 0) existing.splice(index, 1);
      return true;
    },
  };
}

function makeCtx(registry) {
  return {
    get(name) {
      if (name === 'workspaceRegistry') return registry;
      if (name === 'workingDirectory') return { defaultDirectory: base };
      return undefined;
    },
  };
}

/** Fake bridge: `pages` maps tabId → page.read result (or an Error to throw). */
function makeBridge(pages) {
  const calls = [];
  const broadcasts = [];
  return {
    calls,
    broadcasts,
    async request(method, params) {
      calls.push({ method, params });
      const value = pages[params?.tabId];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`no fixture for tab ${params?.tabId}`);
      return value;
    },
    broadcast(name, data) {
      broadcasts.push({ name, data });
    },
    list() {
      return [];
    },
    onChange() {
      return () => {};
    },
  };
}

function page(title, url, text, extra = {}) {
  return { tabId: 1, title, url, text, truncated: false, lang: 'zh', ...extra };
}

const registry = makeRegistry();
const ctx = makeCtx(registry);
const kb = createKbSink({ config: { kbRoot, collection: '页面抓取', sync: false }, logger: quietLogger() });
const bridge = makeBridge({});
const capture = createCapture({
  bridge,
  ctx,
  logger: quietLogger(),
  config: { dir: workDir, title: 'edge页面抓取' },
  kb,
});

// ------------------------------------------------------------------ skeleton
await capture.ensure();
check('workspace dir created', fs.existsSync(workDir));
check('总结 dir created', fs.existsSync(path.join(workDir, '总结')));
check('README written', fs.existsSync(path.join(workDir, 'README.md')));
check('index.json written', JSON.parse(fs.readFileSync(path.join(workDir, 'index.json'), 'utf8')).length === 0);
check('index.md written', fs.readFileSync(path.join(workDir, 'index.md'), 'utf8').includes('抓取总结'));
check('workspace registered once', registry.created.length === 1, `created=${registry.created.length}`);
check('workspace registered with the title', registry.created[0]?.title === 'edge页面抓取');
check('workspace registered with the dir', registry.created[0]?.path === path.resolve(workDir));
await capture.ensure();
check('ensure is idempotent for the registry', registry.created.length === 1, `created=${registry.created.length}`);
check('README mentions the knowledge base', fs.readFileSync(path.join(workDir, 'README.md'), 'utf8').includes('页面抓取'));

// ------------------------------------------------------------- single capture
bridge.request = makeBridge({
  11: page(
    '中国经济网 · 非洲贸易',
    'https://www.ce.cn/a/b.html',
    '# 中国经济网 · 非洲贸易\n\n<https://www.ce.cn/a/b.html>\n\n这是正文第一段。\n\n- 一\n- 二',
  ),
}).request;
const first = await capture.captureTab(11, { source: 'start' });
check('capture returns a kb id', /^sup\d+$/.test(first.id), `id=${first.id}`);
check('kb id continues from the existing max', first.id === 'sup8', `id=${first.id}`);
check('record carries the title', first.title === '中国经济网 · 非洲贸易');
check('record char count', first.chars === 17, `chars=${first.chars}`);

const attachDir = path.join(kbRoot, '补充', '原文', '页面抓取');
const kbManifest = path.join(kbRoot, '补充', '条目.json');
const files = fs.existsSync(attachDir) ? fs.readdirSync(attachDir) : [];
check('snapshot html written', files.length === 1, `files=${files.join(',')}`);
check('snapshot is self-contained html', files[0]?.endsWith('.html') === true);
check('snapshot name starts with the day', /^\d{4}-\d{2}-\d{2}_\d{6}-/.test(files[0] ?? ''));
const html = fs.readFileSync(path.join(attachDir, files[0]), 'utf8');
check('snapshot records the url', html.includes('<meta name="dsh:url" content="https://www.ce.cn/a/b.html">'));
check('snapshot records the capture time', html.includes('<meta name="dsh:captured-at"'));
check('snapshot records the source', html.includes('<meta name="dsh:source" content="start">'));
check('snapshot has a title heading', html.includes('<h1>中国经济网 · 非洲贸易</h1>'));
check('snapshot keeps the body text', html.includes('这是正文第一段。'));
check('snapshot body drops the duplicated heading', !html.includes('<pre class="body"># '));
check('snapshot body drops the bare url line', !html.includes('<pre class="body"><https://'));
check('snapshot does not leak script tags', !html.includes('<script'));

const doc = JSON.parse(fs.readFileSync(path.join(kbRoot, '补充', '条目.json'), 'utf8'));
const entry = doc.items.find((item) => item.id === first.id);
check('manifest gained the entry', entry !== undefined);
check('entry type is webpage', entry?.type === 'webpage');
check('entry date is the capture day', /^\d{4}-\d{2}-\d{2}$/.test(entry?.date ?? ''), `date=${entry?.date}`);
check('entry container is the hostname', entry?.container === 'www.ce.cn');
check('entry files point into the collection', entry?.files?.[0]?.name === `页面抓取/${files[0]}`, entry?.files?.[0]?.name);
check('entry collection is 页面抓取', JSON.stringify(entry?.collections) === '["页面抓取"]');
check('entry tags include the hostname', (entry?.tags ?? []).includes('www.ce.cn'));
check('entry abstract is plain text', typeof entry?.abstract === 'string' && !entry.abstract.includes('#') && entry.abstract.length > 0);
check('entry note names the source', String(entry?.note ?? '').includes('start'));
check('manifest kept the unrelated entry', doc.items.some((item) => item.id === 'sup7'));
check('manifest backup written', fs.readdirSync(path.join(kbRoot, '补充')).some((file) => file.includes('.bak-')));

const browse = path.join(kbRoot, '页面抓取', '清单.md');
check('browse index written', fs.existsSync(browse));
const browseText = fs.readFileSync(browse, 'utf8');
check('browse index lists the page', browseText.includes('中国经济网 · 非洲贸易'));
check('browse index links the snapshot', browseText.includes('../补充/原文/') && browseText.includes('.html)'));
check('browse index names the id', browseText.includes('sup8'));

// ------------------------------------------------------- second page, same name
bridge.request = makeBridge({
  12: page('中国经济网 · 非洲贸易', 'https://www.ce.cn/a/c.html', '第二页正文', { lang: 'zh' }),
}).request;
const second = await capture.captureTab(12, { source: 'manual' });
check('second id increments', second.id === 'sup9', `id=${second.id}`);
check('second snapshot gets its own file', fs.readdirSync(attachDir).length === 2);

// -------------------------------------------------------------------- failures
bridge.request = makeBridge({ 13: new Error('tab is gone') }).request;
let failure = null;
try {
  await capture.captureTab(13, { source: 'manual' });
} catch (error) {
  failure = error;
}
check('bridge failure propagates', failure !== null && /tab is gone/.test(failure.message));
check('failure counted', capture.status().failed === 1, `failed=${capture.status().failed}`);

bridge.request = makeBridge({ 14: page('空白页', 'https://example.com/blank', '   ') }).request;
let emptyError = null;
try {
  await capture.captureTab(14, { source: 'manual' });
} catch (error) {
  emptyError = error;
}
check('empty page is a readable failure', /produced no text/.test(String(emptyError?.message ?? '')));
check('empty failure counted', capture.status().failed === 2, `failed=${capture.status().failed}`);

// A canvas-rendered PDF reader (CNKI 原版阅读) has UI text but no article body.
bridge.request = makeBridge({
  15: page(
    '原版阅读-中国内外资企业参与全球价值链的差异',
    'https://kns.cnki.net/reader/flowpdf?x=1',
    '# 原版阅读\n\n提示\n\n登录个人账号\n\n## 全部目录\n\n- Page 1\n- Page 2\n- Page 3\n\n您还没有添加过笔记',
    { canvasCount: 15 },
  ),
}).request;
let readerError = null;
try {
  await capture.captureTab(15, { source: 'manual' });
} catch (error) {
  readerError = error;
}
check('canvas reader pages are refused', /canvas/.test(String(readerError?.message ?? '')), String(readerError?.message));
check('reader refusal explains the way out', /下载 PDF|HTML/.test(String(readerError?.message ?? '')));
check('reader refusal counted', capture.status().failed === 3, `failed=${capture.status().failed}`);

// A reader page rendered by an older build (icons as inline data: images).
const icon = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const iconBody = ['# 原版阅读', '', '提示', '登录个人账号', '全部目录', '- Page 1', '- Page 2']
  .concat(Array.from({ length: 8 }, (_value, index) => `![icon${index}](data:image/png;base64,${icon}${icon})`))
  .join('\n\n');
bridge.request = makeBridge({ 16: page('原版阅读-画布页', 'https://kns.cnki.net/reader/flowpdf?y=1', iconBody) }).request;
let iconError = null;
try {
  await capture.captureTab(16, { source: 'manual' });
} catch (error) {
  iconError = error;
}
check('image-dominated pages are refused', /内联图片数据/.test(String(iconError?.message ?? '')), String(iconError?.message).slice(0, 160));
check('image refusal names the way out', /下载 PDF|重新加载扩展/.test(String(iconError?.message ?? '')));
check('image refusal counted', capture.status().failed === 4, `failed=${capture.status().failed}`);

// A normal page with one small inline icon still saves, minus the icon markup.
const withIcon = page('带图标的页面', 'https://mixed.example.org/a', `# 带图标的页面\n\n${'正文内容。'.repeat(400)}\n\n![dot](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==)`);
bridge.request = makeBridge({ 17: withIcon }).request;
const savedWithIcon = await capture.captureTab(17, { source: 'manual' });
const iconSnapshot = fs.readFileSync(savedWithIcon.path, 'utf8');
check('small inline icons are stripped before saving', !iconSnapshot.includes('data:image/gif'));
check('page with a small icon still saves', savedWithIcon.id !== '');

// Site navigation before the first heading is dropped.
const navPrefix = [
  '[网页](https://www.baidu.com/s) [新闻](http://news.baidu.com/ns)',
  '[贴吧](https://tieba.baidu.com/f) [知道](https://zhidao.baidu.com/search)',
  '[网盘](https://pan.baidu.com/) [图片](http://image.baidu.com/)',
  '',
  '# 非洲（世界七大洲之一）_百度百科',
  '',
  '非洲，全称阿非利加洲，位于东半球西部。',
].join('\n');
bridge.request = makeBridge({ 18: page('非洲_百度百科', 'https://baike.baidu.com/item/非洲', navPrefix) }).request;
const trimmedSave = await capture.captureTab(18, { source: 'manual' });
const trimmedSnapshot = fs.readFileSync(trimmedSave.path, 'utf8');
check('leading navigation is trimmed', !trimmedSnapshot.includes('pan.baidu.com'), trimmedSnapshot.slice(0, 200));
check('article heading survives the trim', trimmedSnapshot.includes('# 非洲（世界七大洲之一）_百度百科'));

// A reader shell with "- Page N" thumbnails and a toolbar, no canvas attribute
// (the reloaded extension strips icons, so the body is plain UI text).
const shellBody = [
  '# 某篇文章（期刊）*统计研究*2026 (10)',
  '',
  '提示',
  '登录个人账号',
  '- [展开 全部目录](javascript:;)',
  ...Array.from({ length: 15 }, (_value, index) => `- Page ${index + 1}`),
  '',
  '划词笔记 高亮 摘录',
].join('\n');
bridge.request = makeBridge({ 19: page('原版阅读-外壳页', 'https://kns.cnki.net/reader/flowpdf?z=1', shellBody) }).request;
let shellError = null;
try {
  await capture.captureTab(19, { source: 'manual' });
} catch (error) {
  shellError = error;
}
check('reader shells are refused', /PDF 阅读器外壳/.test(String(shellError?.message ?? '')), String(shellError?.message).slice(0, 160));
check('shell refusal points at the PDF route', /下载 PDF/.test(String(shellError?.message ?? '')));
check('shell refusal counted', capture.status().failed === 5, `failed=${capture.status().failed}`);

// The real CNKI 原版阅读 page: page.read flattens the thumbnail strip into one
// line ("目录对比阅读 - Page 1 - Page 2 … - Page 15") and the reader toolbar is
// plain text with no canvas. This is the shape that swallowed sup385.
const inlineShellBody = [
  '# 原版阅读-中国内外资企业参与全球价值链的差异何在',
  '',
  '提示 登录个人账号 用户头像欢迎来到浙江财经大学 - 展开 全部目录',
  `目录对比阅读 目录对比阅读 ${Array.from({ length: 15 }, (_value, index) => `- Page ${index + 1}`).join(' ')}`,
  '',
  '划词笔记 高亮 播报 编辑 讨论 收藏 赞',
].join('\n');
const snapshotsBeforeInline = fs.readdirSync(attachDir).length;
const entriesBeforeInline = JSON.parse(fs.readFileSync(kbManifest, 'utf8')).items.length;
bridge.request = makeBridge({ 20: page('原版阅读-内联缩略页', 'https://kns.cnki.net/reader/flowpdf?w=1', inlineShellBody) }).request;
let inlineError = null;
try {
  await capture.captureTab(20, { source: 'manual' });
} catch (error) {
  inlineError = error;
}
check('inline "- Page N" reader shells are refused', /PDF 阅读器外壳/.test(String(inlineError?.message ?? '')), String(inlineError?.message).slice(0, 200));
check('inline refusal counts all 15 thumbnails', /15 个/.test(String(inlineError?.message ?? '')), String(inlineError?.message).slice(0, 200));
check('inline refusal says nothing was stored', /未入库/.test(String(inlineError?.message ?? '')));
check('inline refusal offers PDF/CAJ route', /下载 PDF/.test(String(inlineError?.message ?? '')) && /CAJ/.test(String(inlineError?.message ?? '')));
check('inline shell leaves no snapshot', fs.readdirSync(attachDir).length === snapshotsBeforeInline);
check('inline shell leaves no manifest entry', JSON.parse(fs.readFileSync(kbManifest, 'utf8')).items.length === entriesBeforeInline);
check('inline shell refusal counted', capture.status().failed === 6, `failed=${capture.status().failed}`);

// Toolbar-only reader shell (no thumbnails, no canvas): two reader-only labels
// are enough — the article body is not in the DOM either way.
const toolbarShellBody = [
  '# 某篇文章',
  '',
  '目录对比阅读 划词笔记 高亮 摘录',
  '',
  '摘要：这篇文章的正文在阅读器里。',
].join('\n');
bridge.request = makeBridge({ 30: page('原版阅读-工具条页', 'https://kns.cnki.net/reader/flowpdf?v=1', toolbarShellBody) }).request;
let toolbarError = null;
try {
  await capture.captureTab(30, { source: 'manual' });
} catch (error) {
  toolbarError = error;
}
check('reader toolbar without canvas is refused', /PDF 阅读器外壳/.test(String(toolbarError?.message ?? '')), String(toolbarError?.message).slice(0, 200));
check('toolbar-only refusal counted', capture.status().failed === 7, `failed=${capture.status().failed}`);

// ------------------------------------------------------------- capture events
const startBridge = makeBridge({
  21: page('非洲新闻', 'https://africa.example.org/n/1', '非洲新闻正文'),
});
const startCapture = createCapture({
  bridge: startBridge,
  ctx,
  logger: quietLogger(),
  config: { dir: path.join(tmp, 'work2', 'edge页面抓取'), title: 'edge页面抓取' },
  kb,
});
await startCapture.ensure();

await startCapture.handleEvent({ name: 'capture.page', data: { tabId: 21, url: 'https://africa.example.org/n/1', source: 'start' } });
const started = startBridge.broadcasts.find((item) => item.name === 'capture.result');
check('capture.page broadcasts a result', started !== undefined);
check('result is ok', started?.data.ok === true);
check('result carries the kb id', typeof started?.data.kbId === 'string' && started.data.kbId !== '');
check('result carries the title and chars', started?.data.title === '非洲新闻' && started.data.chars > 0);

// session summary on stop
await startCapture.handleEvent({ name: 'capture.stop', data: { saved: 1, failed: 0 } });
const stopResult = startBridge.broadcasts.find((item) => item.name === 'capture.stop.result');
check('capture.stop broadcasts a summary', stopResult?.data.ok === true);
check('capture.stop summary file exists', fs.existsSync(path.join(tmp, 'work2', 'edge页面抓取', '总结', path.basename(String(stopResult?.data.summary ?? '')))));
const stopText = fs.readFileSync(path.join(tmp, 'work2', 'edge页面抓取', '总结', path.basename(String(stopResult?.data.summary ?? ''))), 'utf8');
check('session summary lists the captured page', stopText.includes('非洲新闻'));
check('session summary names the collection', stopText.includes('页面抓取'));
check('session summary suggests a search', stopText.includes('kb.py search'));

// batch event
const batchBridge = makeBridge({
  31: page('页面一', 'https://one.example.com/', '正文一'),
  32: page('页面二', 'https://two.example.com/', '正文二'),
  33: new Error('blocked by policy'),
});
const batchCapture = createCapture({
  bridge: batchBridge,
  ctx,
  logger: quietLogger(),
  config: { dir: path.join(tmp, 'work3', 'edge页面抓取'), title: 'edge页面抓取' },
  kb,
});
await batchCapture.ensure();
await batchCapture.handleEvent({ name: 'capture.batch', data: { tabIds: [31, 32, 33], source: 'batch' } });
const batchResult = batchBridge.broadcasts.find((item) => item.name === 'capture.batch.result');
check('batch broadcasts a result', batchResult !== undefined);
check('batch saved count', batchResult?.data.saved === 2, `saved=${batchResult?.data.saved}`);
check('batch failed count', batchResult?.data.failed === 1, `failed=${batchResult?.data.failed}`);
check('batch lists the files', Array.isArray(batchResult?.data.files) && batchResult.data.files.length === 2);
check('batch reports the failure reason', JSON.stringify(batchResult?.data.errors ?? []).includes('blocked by policy'));
check('batch writes a summary', /总结/.test(String(batchResult?.data.summary ?? '')));
const batchDir = path.join(tmp, 'work3', 'edge页面抓取');
const batchSummaries = fs.readdirSync(path.join(batchDir, '总结'));
check('batch summary is a batch job', batchSummaries.some((file) => file.includes('-batch')), batchSummaries.join(','));
const batchSummary = fs.readFileSync(path.join(batchDir, '总结', batchSummaries.find((file) => file.includes('-batch'))), 'utf8');
check('batch summary counts both outcomes', batchSummary.includes('成功 2，失败 1'));
check('batch summary lists the failure', batchSummary.includes('blocked by policy'));
check('job index has one row', JSON.parse(fs.readFileSync(path.join(batchDir, 'index.json'), 'utf8')).length === 1);
check('job index md has a table row', fs.readFileSync(path.join(batchDir, 'index.md'), 'utf8').includes('| 批量抓取已打开的页面'));
const batchStatus = await batchCapture.handleEvent({ name: 'capture.status' });
check('status reports the kb collection', batchStatus.kb.collection === '页面抓取');
check('status reports the snapshot dir', batchStatus.kb.dir === attachDir);
check('status reports the job count', batchStatus.jobs === 1, `jobs=${batchStatus.jobs}`);

// empty batch
const emptyBatch = await batchCapture.handleEvent({ name: 'capture.batch', data: { tabIds: [] } });
check('empty batch is refused', emptyBatch.ok === false);
const emptyReply = batchBridge.broadcasts.filter((item) => item.name === 'capture.batch.result').pop();
check('empty batch explains itself', /没有可抓取的页面/.test(String(emptyReply?.data.error ?? '')));

// failure result broadcast
const failingBridge = makeBridge({ 41: new Error('not scriptable') });
const failingCapture = createCapture({
  bridge: failingBridge,
  ctx,
  logger: quietLogger(),
  config: { dir: path.join(tmp, 'work4', 'edge页面抓取'), title: 'edge页面抓取' },
  kb,
});
await failingCapture.ensure();
await failingCapture.handleEvent({ name: 'capture.page', data: { tabId: 41, url: 'https://edge.example/', source: 'start' } });
const failedResult = failingBridge.broadcasts.find((item) => item.name === 'capture.result');
check('failure is broadcast as ok:false', failedResult?.data.ok === false);
check('failure broadcast carries the reason', /not scriptable/.test(String(failedResult?.data.error ?? '')));
const failedSummaries = fs.readdirSync(path.join(tmp, 'work4', 'edge页面抓取', '总结')).filter((file) => file.includes('-start'));
check('failure still writes a summary', failedSummaries.length === 1);
const failedText = fs.readFileSync(path.join(tmp, 'work4', 'edge页面抓取', '总结', failedSummaries[0]), 'utf8');
check('failure summary records the reason', failedText.includes('not scriptable'));
check('failure summary has no bogus id', failedText.includes('| — |'));

// --------------------------------------------------------- removal (cleanup)
const beforeRemoval = JSON.parse(fs.readFileSync(kbManifest, 'utf8'));
const target = beforeRemoval.items.find((item) => item.type === 'webpage');
check('removal target exists', target !== undefined);
const snapshotOfTarget = path.join(kbRoot, '补充', '原文', String(target.files[0].name));
check('removal target snapshot on disk', fs.existsSync(snapshotOfTarget));
const removed = kb.removeCapture(target.id);
check('removeCapture reports success', removed.removed === true, JSON.stringify(removed).slice(0, 200));
check('removeCapture deletes the snapshot', !fs.existsSync(snapshotOfTarget));
const afterRemoval = JSON.parse(fs.readFileSync(kbManifest, 'utf8'));
check('removed entry left 条目.json', !afterRemoval.items.some((item) => item.id === target.id));
check('other entries survived', afterRemoval.items.length === beforeRemoval.items.length - 1);
const listingAfter = fs.readFileSync(browse, 'utf8');
check('listing dropped the removed page', !listingAfter.includes(target.id));
check('removeCapture on an unknown id is refused', kb.removeCapture('sup99999').removed === false);

// ------------------------------------------------------------- relocation
const relocated = createCapture({
  bridge: makeBridge({}),
  ctx,
  logger: quietLogger(),
  config: { dir: path.join(tmp, 'work5', 'edge页面抓取'), title: 'edge页面抓取' },
  kb,
});
await relocated.ensure();
fs.writeFileSync(path.join(tmp, 'work5', 'edge页面抓取', 'marker.txt'), 'x');
// A new engine whose config points at the same title but no dir adopts the registry base.
const registryBase = makeRegistry();
registryBase.existing.push({ id: 'ws-home', path: path.join(base, 'default-workspace'), title: 'default-workspace' });
const adopted = createCapture({
  bridge: makeBridge({}),
  ctx: makeCtx(registryBase),
  logger: quietLogger(),
  config: { title: 'edge页面抓取' },
  kb,
});
await adopted.ensure();
check('adopted location follows the registry', adopted.directory() === path.resolve(path.join(base, 'edge页面抓取')), adopted.directory());
check('adopted workspace registered', registryBase.created.length === 1);

// --------------------------------------------------------------- summary shape
const summaries = fs.readdirSync(path.join(batchDir, '总结'));
const summaryBody = fs.readFileSync(path.join(batchDir, '总结', summaries[0]), 'utf8');
check('summary has a heading', summaryBody.startsWith('# 抓取总结 · '));
check('summary has the four columns', summaryBody.includes('| 入库 ID | 标题 | 来源 | 字数 |'));
check('summary lists original links', summaryBody.includes('https://one.example.com/'));

// ------------------------------------------------------------------- verdict
for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(`\n${passed}/${passed + failures.length} checks passed`);
if (failures.length > 0) process.exitCode = 1;