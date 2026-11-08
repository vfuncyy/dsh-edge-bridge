# 变更日志

遵循语义化版本：`MAJOR.MINOR.PATCH`。补丁修 bug，次版本加能力但保持协议向后兼容，主版本改协议帧或移除方法。

## 未发布

### 变更

- **知识库默认路径改为可移植**：`plugin/lib/kb.js` 的 `DEFAULT_KB_ROOT` 不再硬编码某一台机器的路径，改为先读环境变量 `DSH_KB_ROOT`，否则回落 `$DSH_HOME/knowledge-base`；`kbRoot` 配置项仍可覆盖两者。`DEFAULT_PYTHON` 改为 `DSH_KB_PYTHON` 或直接 `python`。`tools/migrate-captures.mjs` 的默认参数同步改为同样的解析顺序。
- **`tools/probe-live.mjs`** 的默认端点从已废弃的端口改回 `ws://127.0.0.1:17333/edge-bridge`。

### 文档

- **全仓脱敏**：配对令牌、本机绝对路径、真实标签页 ID、个人知识库路径、本机端口演进等取值，全部替换为占位符或通用默认值（`YOUR-PAIRING-TOKEN`、`$DSH_HOME/knowledge-base` 等）。
- README 中英双语各新增四节：开发缘由、参考与致谢、AI（DSH）参与说明、免责与侵权删除声明。

> 升级提示：如果你此前依赖默认的知识库路径，请显式设置 `kbRoot` 或导出 `DSH_KB_ROOT`，否则抓取只会保存快照、跳过入库。

## 0.3.0 — 2026-11-09

这一版的共同主题：**让失败可判断**。四个能力都来自对比 Tencent/BrowserSkill 之后的取舍——借它的机制，不借它的重量。

### 新增

- **稳定 `ref`**：`edge_inspect` 给每个列出的可见控件写入 `data-dsh-ref="e12"`，条目里以 ref 开头输出（`e4 #btn — Press me`）。`edge_act` 新增 `ref` 参数，定位顺序变为 `ref → selector → text`。同一页面重复 inspect 复用已有 ref；页面重渲染后旧 ref 会明确报错并提示重新 inspect。
- **动作前断言 `expect`**：`edge_act` 新增 `expect` 参数，支持 `text`（精确）、`value`、`checked`（布尔）、`attribute:{name,value}` 四类断言。不匹配时**一步都不执行**，回执写明 `expectation failed: expected X but the target has Y — nothing was done`。
- **`effect_state` 三值回执**：每次 `edge_act` 末尾追加 `committed` / `unknown` / `none`。超时会明确标注 `unknown` 并写明"不要盲目重试"。指纹由 `标题 | URL | 元素数 | 正文长度 | 正文前 20000 字符哈希` 组成，能抓到"只改了一段已有节点的文字"这类最常见的点击效果。
- **能力位协商**：扩展在 hello 帧里声明 `caps: Object.keys(HANDLERS)`；插件用 `HOST_CAPS`（11 个 method 名）比对并把结果回传。插件在 `request()` 前拦截未实现的方法，`edge_status` 的 `caps:` 行显示 `11 method(s)` / `— missing page.act` / `(not reported — …)` 三种状态。
- `edge_status` 新增每连接的 `caps:` 行与 `hostCaps` 字段。
- 新增 `edge-bridge/tools/test-contract.mjs`（34 项）：断言工具计数、`HOST_CAPS` ≡ `HANDLERS`、ref/effect 链路跨四个文件连通、插件与扩展版本一致、README 与 SKILL 文档口径。

### 修复

- **`background.js` 的 `page.act` 漏传 `effect`**，导致 `effect_state` 行永远不出现；失败分支还会丢掉 effect 信息。现已透传并在错误信息里带上。
- **`fingerprint()` 漏算正文内容**：点击后只改已有节点文字的情况被误报成 `unknown`。现加入 20000 字符的 djb2 哈希。
- **`edge_inspect` 过滤为空时的措辞**：`matchedInteractive > 0` 但全部被 `max_interactive` / 可见性过滤时，原来输出容易与"页面真没有可点元素"混淆。现在输出 `N interactive elements hidden by filter — …`。
- **hello 回包的 `caps` 漏了 `page.inspect`**，且 `version` 硬编码 `'0.2.0'`。现在 `caps` 是完整的 11 个 method 名，版本运行时读 `package.json`。
- **能力位为空的告警文案**：caps 为空曾被报成"缺全部能力"，实际是"旧构建不报能力"。两种情形现在分两支告警。
- `test-page-in-edge.mjs` 的启动竞态：CDP 连上时导航可能尚未 commit（`about:blank` 的 `readyState` 已是 `complete`），导致读到空页。改为轮询页面是否真的活着（URL、`readyState`、`body.children`、`#btn` 存在）。

### 变更

- 测试从五套 247 项增至六套 318 项（test-bridge 27 / test-plugin 76 / test-server 11 / test-capture 111 / test-page-in-edge 59 / test-contract 34）。
- `edge_act` 的 `type` 分支在无 `ref`/`selector` 时写入当前聚焦元素；没有聚焦时报 `no focused field to type into: pass a ref or a selector`（旧文案是 "pass a selector"）。
- `edge_act` 的参数错误文案统一为 `pass ref, selector or text to identify the target element`。
- 插件与扩展版本号同步升到 0.3.0。

### 兼容性

- 0.3.0 插件 + 0.2.x 扩展：可用，但没有 `ref` / `effect_state`，插件会 warn 缺能力。
- 0.2.x 插件 + 0.3.0 扩展：可用，扩展多声明能力不被读取。
- 协议帧格式未变，`protocol` 仍为 1。

---

## 0.2.0 — 2026-11-06

### 新增

- `edge_inspect`：一次转储 `readyState`、标题大纲、每个可点元素的 CSS 选择器与文字、表格与重复列表的行数和样例行。
- `edge_eval` 内置七个页面助手：`$`、`$$`、`text`、`sleep`、`waitFor`、`waitText`、`clickText`；支持顶层 `await` 自动包裹。
- `edge_act` 支持 `wait_for` / `wait_for_text`，回执带 `settled` / `NOT settled`。
- 页面抓取入知识库：扩展 popup 三个按钮（启动 / 停止 / 批量），快照 + 条目 + 清单三处落盘，自动 `kb.py build/extract`。
- 抓取质量四条：600 万字上限、`scope` 自动回退、导航裁剪、阅读器外壳拒收。
- `tools/remove-capture.mjs` 与 `tools/migrate-captures.mjs` 运维脚本。
- 失败隔离：单页抓取失败不影响批量任务，原因记进会话总结。

### 变更

- 浏览器工具从五个增至七个（新增 `edge_status` 与 `edge_screenshot` 的整页模式）。
- 测试增至五套 247 项。

---

## 0.1.0 — 2026-11-03

首个可用版本。

### 新增

- 手写 RFC6455 WebSocket 服务端（`lib/ws.js`），零第三方依赖。
- 固定端口 17333 + 自动顺延到 17344；扩展通过 `GET /edge-bridge/ping` 自动发现。
- 配对令牌握手：自动生成并持久化到 `<DSH_HOME>\edge-bridge-token`，错误令牌以 `4003` 关闭。
- 懒注册：默认只有 `edge_bridge` 控制工具，`start` 后注册浏览器工具，空闲 30 分钟 / 断线 60 秒 / DSH 退出三种自动收起。
- 五个浏览器工具：`edge_tabs`、`edge_read`、`edge_eval`、`edge_act`、`edge_screenshot`。
- 每个工具渲染紧凑文本报告而非 JSON 树。
- 四套测试（test-bridge / test-server / test-plugin / test-capture）。
