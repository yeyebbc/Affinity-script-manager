# 迁移计划：Electron → 本机自托管 Web 服务器（Windows / macOS）

> 依据：`docs/web-hosting-feasibility.md`（可行性分析）。本文件是可执行计划；路由/API 映射以可行性文档 §3.2 为准，不再重复整表，仅记录增量决策与执行顺序。

## 0. 目标与非目标

**目标**：用 Node 服务器替代 Electron 壳，浏览器打开 `http://127.0.0.1:3000` 使用，功能与 v1.4.1 等价；服务器与 Affinity 同机；Windows 与 macOS 均可本机运行。

**非目标**（明确不做，避免范围蔓延）：
- 远程/云托管、隧道代理
- LAN / 多设备访问与认证（本计划默认仅绑定回环；如需则作为独立后续任务，见 §4 风险）
- 多用户/多租户、Electron 打包产物（`electron-builder` 配置移除）

## 1. 最终形态

```
repo/
├── server.js             入口：node:http 服务、静态文件、SSE hub、路由分发、更新检查
├── lib/
│   ├── mcp.js            MCP 桥客户端（连接候选轮换、callTool、preamble prime、断线重连+重试）
│   ├── store.js          数据目录、config 读写、脚本 CRUD、favorites/settings、fs.watch
│   └── community.js      注册表/featured 抓取（fetchFresh）、share issue 载荷、社区下载
├── api-shim.js           前端：实现与 preload 同签名的 window.api（fetch + EventSource）
├── scripts/
│   ├── migrate-legacy.js 从旧 Electron userData 迁移数据（双平台路径）
│   └── smoke.js          冒烟测试（起服务→打接口→退出码）
├── index.html renderer.js styles.css icons.js assets/   （复用）
└── package.json          main→server.js；去除 electron 依赖；engines；scripts 更新
```

**关键决策**

1. **数据目录**：默认 `~/.affinity-script-manager/`（`MyScripts/` + `config.json`），环境变量 `ASM_DATA_DIR` 覆盖。
   - Windows：`%USERPROFILE%\.affinity-script-manager`；macOS：`$HOME/.affinity-script-manager`
   - 理由：与 Electron `userData` 语义一致（按用户隔离），数据不落在仓库内（避免误提交），换机器迁移路径固定。
   - 迁移源路径：Windows `%APPDATA%\affinity-script-manager`；macOS `~/Library/Application Support/affinity-script-manager`。
2. **零新增运行时依赖**：保留 `@modelcontextprotocol/sdk`；事件推送用原生 SSE（浏览器 `EventSource`），不需要 `ws`；HTTP 用 `node:http`。
3. **Node ≥ 20**（全局 fetch、`node:fs/promises`）；package.json 写 `engines`，server.js 启动时校验并给出明确报错。
4. **端口**：默认 3000，`PORT` 环境变量覆盖；`EADDRINUSE` 时输出可操作错误（提示换 PORT），不自动换端口。
5. **绑定**：默认 `127.0.0.1`（`HOST` 环境变量可放开，文档注明风险，但不做认证实现）。
6. **响应契约**：与现有 IPC 完全一致——`{success:true, data|output|image|pushed|...}` / `{success:false, error}`，renderer 无需感知。
7. **前端最小改动原则**：renderer.js 所有 `window.api.*` 调用点保持不变；差异全部吸收进 `api-shim.js`（含文件选择、导出下载、外链打开）。预期 renderer.js 零改动（若个别交互需要 UI 微调，仅作为例外处理，见 §3 M3）。

## 2. 阶段与任务

### M0 骨架与静态服务
验收：`node server.js` 后 `curl http://127.0.0.1:3000/api/meta` 与 `/` 均 200。

- [ ] `server.js`：`http.createServer`；静态文件仅 GET/HEAD，内容类型表（html/js/css/json/webp/jpg/png/svg），路径规范化防穿越（`path.normalize` + 前缀校验），404 兜底
- [ ] 业务路由统一前缀 `/api`；JSON body 解析（限 10MB）；统一 `{success:false,error}` 错误包装（try/catch）
- [ ] `GET /api/meta` → `{version, port, dataDir}`（version 读 package.json）
- [ ] `lib/store.js`：数据目录初始化（`mkdir` MyScripts，config 默认值注入——搬迁 `getConfig` 原逻辑）
- [ ] package.json：`main` → `server.js`；`scripts.start` → `node server.js`；`engines.node` → `>=20`；移除 `electron`、`electron-builder` devDeps 与 `build` 段（electron-builder 配置删除）

### M1 业务路由（按可行性文档 §3.2 映射表搬运）
验收：各路由 curl 走通；MCP 桥离线时返回 `{success:false,error}` 而非崩溃。

- [ ] `lib/mcp.js`（从 main.js 搬迁，逻辑原文保留）：`ensureMcpConnected`（含 preamble prime）、`isRecoverableMcpSessionError`、`callTool`（断线重连+重试一次）
- [ ] scripts 组：`GET /api/scripts`、`DELETE /api/scripts/:file`、`POST /api/scripts/:file/rename`、`GET /api/scripts/:file/content`、`PUT /api/scripts/:file/content`、`GET /api/scripts/:file?download=1`（`Content-Disposition: attachment`）
- [ ] bridge 组：`GET /api/bridge/library`、`POST /api/bridge/push`、`POST /api/bridge/execute`、`POST /api/bridge/run`、`POST /api/bridge/render-preview`、`POST /api/bridge/download`、`GET /api/bridge/export/:title`（attachment）、`GET /api/bridge/metadata/:title`、`GET /api/share-mcp/:title`
- [ ] scripts/add 组：`POST /api/scripts/add`（落盘 + `upsertMetadataHeader` + best-effort 推送，返回 `pushed/pushError`）——承接原 `save-script`
- [ ] 新增 `POST /api/scripts/inspect`：接收文件文本，服务端 `parseScriptMetadata` 返回 `{name, description, code}`——替代原 `selectFile`（前端 `input[type=file]` 由 shim 提供，解析逻辑留在服务端，避免浏览器端复制元数据解析）
- [ ] community 组：`GET /api/community`（含 `repoErrors` 结构）、`POST /api/community/download`、`POST /api/community/save`；`fetchFresh`、`fetchFeaturedIds`、`resolveCommunityAssetUrl` 原样搬迁
- [ ] share 组：`GET /api/share/:file`（返回 `{url, baseUrl, body, tooLong}`）
- [ ] docs 组：`GET /api/docs`、`POST /api/docs/search`
- [ ] 配置组：`GET/POST /api/repos`、`DELETE /api/repos/:url`（encodeURIComponent）、`GET /api/favorites`、`POST /api/favorites/:stem`、`GET/PUT /api/settings/sidebar`
- [ ] 更新检查：`GET /api/updates`（GitHub releases 版本比较，逻辑搬迁）；服务启动后自动检查一次
- [ ] 不再实现（从 IPC 面移除）：`selectFile`、`exportToDisk/exportMcpToDisk` 对话框版、`openUrl/openExternalRepo`、`app-version-sync`
- [ ] config 并发写：进程内 promise 队列串行化写操作（多标签页/多请求交错安全）

### M2 实时通道与 Watch Mode
验收：两个浏览器标签页同时打开，一边保存脚本另一边自动刷新列表。

- [ ] `GET /api/events`：SSE；`Content-Type: text/event-stream`；25s 心跳注释行；连接关闭清理订阅者
- [ ] `broadcast(event, payload)`，事件名与原一致：`local-scripts-changed`、`repos-changed`、`update-available`
- [ ] `fs.watch(MyScripts)` + 300ms debounce 搬迁（"仅当脚本已在 Affinity 库中才自动重推"逻辑保留）；变更 → 广播 `local-scripts-changed`
- [ ] 更新检查命中 → 广播 `update-available`（替代 `win.webContents.send`）

### M3 前端：api-shim.js
验收：`window.api` 36 方法全部可用；renderer.js 无 diff（或仅针对异常交互的最小例外并逐条说明）。

- [ ] `api-shim.js`（约 200 行）：与 preload 同名的 `window.api` 面
  - 业务调用：fetch → `/api/*`，响应直通（保持 `{success,...}` 形状）
  - `selectFile()`：内部创建隐藏 `<input type="file" accept=".js">`，change 后读文本 → `POST /api/scripts/inspect` → 返回与原来相同的 `{success, data:{name, description, code}}`
  - `exportToDisk` / `exportMcpToDisk`：fetch blob → 创建 `<a download>` 触发浏览器保存（renderer 调用点零改动）
  - `openUrl` / `openExternalRepo`：`window.open(url, "_blank", "noopener")`（所有调用点均在 click 手势内，无弹窗拦截风险）
  - 事件：单个 `EventSource("/api/events")`，映射 `onLocalScriptsChanged` / `onReposChanged` / `onUpdateAvailable`
- [ ] `index.html`：`<script src="api-shim.js" defer>` 排在 renderer.js 之前
- [ ] 更新提示：去掉主进程 `dialog.showMessageBox`；启动检查命中后经 SSE 触发既有侧栏更新按钮（renderer 现有 `onUpdateAvailable` 逻辑已覆盖，无需新 UI）
- [ ] （可选项，列入 backlog）CDN 本地化：ace + marked 下载至 `assets/vendor/`，index.html 改本地路径——用于离线部署；默认先保留 CDN 与原版一致

### M4 双平台加固
验收：Windows 与 macOS 各自可跑通全部流程。

- [ ] **MCP 桥地址轮换**：候选 `["http://localhost:6767/sse", "http://[::1]:6767/sse", "http://127.0.0.1:6767/sse"]`（社区资料：macOS 上桥绑 `::1`；现有代码用 `localhost` 在 Windows 可用）。规则：连接尝试按序 fallback，进程内记忆首个成功 URL；断线重连时重新轮换
- [ ] `fs.watch` 只监听平铺目录（现状即如此，Windows/macOS 均不需要 recursive）；异常时降级为不自动刷新（保留 `local-scripts-changed` 广播尝试，与原行为一致）
- [ ] `scripts/migrate-legacy.js`：检测双平台旧 userData 路径 → 复制 `MyScripts/` 与 `config.json` 到新数据目录（已存在文件跳过，不覆盖）；打印报告；**不自动删除**旧目录
- [ ] 启动方式文档（README 简短章节）：`npm start`；常驻示例各一条——Windows（任务计划程序或 NSSM）、macOS（launchd plist）
- [ ] 版本号显示：`/api/meta` 注入；renderer 现有 `brand-version` 逻辑保持（其当前显示 "for Affinity"，不做额外工作）

### M5 验证
验收 = 可行性文档附录 B 清单 + 下方冒烟全过。

- [ ] `scripts/smoke.js`：随机端口起服务 → 断言 `/api/meta` 200 且含 version、`/api/scripts` 200、`/` 200 且含 `api-shim.js`、`GET /api/events` 返回 `text/event-stream` 头、`/api/community` 200（默认仓库）→ 退出码 0/非 0（CI 可复用）
- [ ] 手动清单：附录 B 全部 10 项，核心为——安装 dot 状态翻转、Watch Mode 自动重推、Run without install 的输出 + 渲染预览、Just in Affinity 下载、社区安装/更新徽标、文档/搜索、分享剪贴板、双标签 SSE 互刷
- [ ] 双平台各跑一轮 smoke + 核心流手测（MCP 功能需本机 Affinity 开启 MCP）
- [ ] 残留检查：仓库内无 `electron`/`ipcRenderer`/`contextBridge`/`BrowserWindow`/`dialog.`/`shell.` 引用（main.js、preload.js 删除前确认其逻辑已全部搬迁）
- [ ] 主仓库 `.gitignore` 无需变更（数据在用户主目录）；如用 `ASM_DATA_DIR` 指向仓库内，需自担并加 ignore——文档注明

## 3. 变更文件清单

| 操作 | 文件 |
|---|---|
| 新增 | `server.js`、`lib/mcp.js`、`lib/store.js`、`lib/community.js`、`api-shim.js`、`scripts/migrate-legacy.js`、`scripts/smoke.js` |
| 修改 | `package.json`（main/scripts/engines/去 electron 依赖与 build）、`index.html`（加 api-shim.js） |
| 删除 | `preload.js`；`main.js`（逻辑搬迁完成后删除）；`assets/icon.png`、`DMG_Background.jpg`、`build.sh` 可随 electron-builder 配置一并移除（不影响运行时） |
| 保留不动 | `renderer.js`、`styles.css`、`icons.js`、`assets/updatescript.png`（若引用） |
| 文档 | README 增"本机自托管"章节（启动、常驻、数据迁移、端口/环境变量）；本计划与其后可行性文档互相引用 |

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| macOS 桥绑定 `::1`，`localhost` 解析失败 | M4 候选地址轮换 + 失败 fallback |
| 用户 Node 版本过低（无全局 fetch） | engines + 启动校验，明确报错 |
| 端口占用 | 明确错误 + `PORT` 提示 |
| 多标签页并发写 config | 进程内写队列 |
| 浏览器安全差异：`window.open` 弹窗拦截 | 现有调用点均在用户手势内；shim 统一 `noopener` |
| `fs.watch` 平台抖动（Windows 偶发） | 维持 300ms debounce；失败仅退化为不自动刷新，不阻塞主流程 |
| 静态文件路径穿越 | M0 规范化 + 前缀校验（沿用 `assertLocalScriptFilename` 思路） |
| 若后续放开 `HOST` 做 LAN 访问：无认证即暴露脚本库与 Affinity 桥 | 只读文档警示；认证实现列为独立后续任务，不在本计划内 |

## 5. 完成定义（DoD）

- [ ] Windows 与 macOS 上 `npm start` 均可启动，浏览器 `http://127.0.0.1:3000` 全功能可用
- [ ] 零新增运行时依赖（仅保留 `@modelcontextprotocol/sdk`）
- [ ] `scripts/smoke.js` 双平台通过
- [ ] 可行性文档附录 B 手测清单 10 项通过（MCP 相关项需本机 Affinity 开启）
- [ ] 旧 Electron 数据迁移脚本实测通过（Windows + macOS 各一次）
- [ ] 仓库无 electron/ipcRenderer/contextBridge/BrowserWindow 残留引用；`preload.js`、`main.js` 已删除
- [ ] README 更新完成
