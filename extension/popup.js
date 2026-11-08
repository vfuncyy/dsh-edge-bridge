/**
 * Popup control surface for the bridge service worker.
 * The popup is a thin client: every mutation goes through a message.
 */
const $ = (id) => document.getElementById(id);

const LABELS = {
  idle: '未连接',
  connecting: '连接中',
  connected: '已连接',
  retrying: '重连中',
  error: '出错',
  'needs-token': '需要令牌',
};

let editing = false;

async function ask(type, extra) {
  try {
    return await chrome.runtime.sendMessage({ type, ...(extra ?? {}) });
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

function renderCapture(capture) {
  const active = capture.active === true;
  const saved = Number(capture.saved ?? 0);
  const failed = Number(capture.failed ?? 0);

  $('capture').classList.toggle('active', active);
  $('cap-state').textContent = active
    ? `抓取中 · 已存 ${saved} 页${failed > 0 ? ` · 失败 ${failed}` : ''}`
    : saved > 0
      ? `已停止 · 共 ${saved} 页${failed > 0 ? ` · 失败 ${failed}` : ''}`
      : '未开始';
  $('cap-start').disabled = active;
  $('cap-stop').disabled = !active;

  const note = $('cap-note');
  if (capture.lastError && !active) {
    note.className = 'cap-note bad';
    note.textContent = `上次抓取出错：${capture.lastError}`;
  } else if (capture.lastTitle) {
    note.className = 'cap-note';
    note.textContent = `最近一次：${capture.lastTitle}`;
  } else {
    note.className = 'cap-note';
    note.textContent = '页面原文与快照录入知识库专题「页面抓取」，每次作业在 edge页面抓取 工作区留一份总结。';
  }
}

function formatSince(timestamp) {
  if (!timestamp) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  return `${Math.round(seconds / 3600)} 小时`;
}

function render(state) {
  const status = LABELS[state.status] ?? state.status ?? '未知';
  const pill = $('status');
  pill.textContent = status;
  pill.className = `pill ${state.status}`;

  $('version').textContent = `v${state.version ?? '?'} · protocol ${state.protocol ?? '?'}`;

  const hint = $('hint');
  const server = state.server;
  if (state.status === 'connected') {
    hint.className = 'hint';
    hint.textContent = server
      ? `已配对 ${server.name ?? 'DSH'} ${server.version ?? ''}，DSH 现在可以读取并操作这个浏览器。`
      : '已配对，DSH 现在可以读取并操作这个浏览器。';
  } else if (state.lastError) {
    hint.className = 'hint bad';
    hint.textContent = state.lastError;
  } else if (state.status === 'needs-token') {
    hint.className = 'hint bad';
    hint.textContent = '请粘贴 DSH 中 edge_bridge 工具给出的配对令牌。';
  } else {
    hint.className = 'hint';
    hint.textContent = '尚未配对。';
  }

  if (!editing) {
    $('endpoint').value = state.endpoint || '';
    $('endpoint').placeholder = state.discoveredEndpoint
      ? `自动发现：${state.discoveredEndpoint}`
      : '留空自动发现，或填 ws://127.0.0.1:17333/edge-bridge';
    $('token').value = state.token ?? '';
  }

  $('fact-server').textContent = server ? `${server.name ?? 'DSH'} ${server.version ?? ''}`.trim() : '—';
  $('fact-rpc').textContent = String(state.rpcCount ?? 0);
  $('fact-since').textContent = state.status === 'connected' ? formatSince(state.connectedAt) : '—';
  renderCapture(state.capture ?? {});
  $('log').textContent = Array.isArray(state.logs) && state.logs.length > 0 ? state.logs.join('\n') : '暂无事件';
}

async function refresh() {
  const state = await ask('state');
  if (!state || state.ok !== true) return;
  render(state);
  const probe = await ask('probe');
  $('fact-tabs').textContent = probe?.ok ? `${probe.tabs} / ${probe.windows}` : '—';
}

for (const id of ['endpoint', 'token']) {
  const field = $(id);
  field.addEventListener('focus', () => {
    editing = true;
  });
  field.addEventListener('blur', () => {
    editing = false;
  });
}

$('connect').addEventListener('click', async () => {
  const button = $('connect');
  button.disabled = true;
  button.textContent = '连接中…';
  const result = await ask('save', {
    settings: { endpoint: $('endpoint').value.trim(), token: $('token').value.trim() },
  });
  button.disabled = false;
  button.textContent = '保存并连接';
  if (result?.ok === false) {
    $('hint').className = 'hint bad';
    $('hint').textContent = result.error ?? '无法保存设置';
  }
  setTimeout(refresh, 400);
});

$('disconnect').addEventListener('click', async () => {
  await ask('disconnect');
  setTimeout(refresh, 200);
});

function captureButton(id, type, busy) {
  $(id).addEventListener('click', async () => {
    const button = $(id);
    const label = button.textContent;
    button.disabled = true;
    button.textContent = busy;
    const result = await ask(type);
    button.textContent = label;
    if (result?.ok === false) {
      $('hint').className = 'hint bad';
      $('hint').textContent = result.error ?? '抓取没有开始';
    }
    setTimeout(refresh, 300);
  });
}

captureButton('cap-start', 'captureStart', '启动中…');
captureButton('cap-stop', 'captureStop', '停止中…');
captureButton('cap-batch', 'captureBatch', '抓取中…');

refresh();
setInterval(refresh, 1000);