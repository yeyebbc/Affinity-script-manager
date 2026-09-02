# 托管为网站服务器的可行性分析

> 目标：把 Script Manager for Affinity 从 Electron 应用改写为"网站服务器 + 浏览器访问"，不在电脑上跑套壳浏览器应用。
> 结论先行：**本机自托管完全可行，功能 100% 保留；远程/云托管对核心功能不可行**。决定性约束是 Affinity 的 MCP 桥接只监听本机回环地址。

---

## 0. TL;DR

| 方案 | 可行性 | 功能保留 | 前提 |
|---|---|---|---|
| A. 本机自托管（Node 服务器 + 任意浏览器） | ✅ 完全可行，改造量中等（约 1–2 人日） | 全部 | 服务器跑在安装 Affinity 的同一台机器上 |
| B. 远程/云托管（服务器在其他机器） | ❌ 核心功能不可行 | 仅剩本地库/社区等纯管理功能 | 除非本机额外跑一个隧道守护进程（违背"不跑本地组件"的初衷，且有安全风险） |

关键数字：preload 暴露 36 个 IPC 方法；其中约 20 个可直接映射为 HTTP 路由，main.js 中对应 handler 的函数体（fs + MCP + fetch 逻辑）约 80% 可原样搬运。前端 index.html / renderer.js / styles.css / icons.js 可完全复用。

---

## 1. 现有架构

```
Electron
├── main.js      Node 主进程：文件系统（userData/MyScripts）、config.json、
│                MCP SDK Client（localhost:6767/sse）、GitHub fetch、fs.watch、
│                原生对话框（dialog）、打开外链（shell）、更新检查
├── preload.js   contextBridge 暴露 window.api（36 个方法）+ window.appVersion
├── renderer.js  前端逻辑，全部通过 window.api 与主进程通信（99KB）
├── index.html   入口，Ace 编辑器 + marked 从 CDN 加载
└── styles.css / icons.js  纯前端资源
```

外部通信面：
- **Affinity MCP 桥**：`http://localhost:6767/sse`（SSE 传输）。安装/运行/预览/从 Affinity 下载/SDK 文档/桥状态全部依赖它。
- **GitHub raw**：社区仓库的 `registry.json` / `featured.json` / 脚本文件（`fetchFresh` 带缓存击穿参数）。
- **GitHub API**：`releases/latest` 更新检查。
- 本地状态：`app.getPath("userData")/MyScripts` + `config.json`（仓库列表、收藏、侧栏折叠状态）；前端还有少量 `localStorage`（仅侧栏旧版迁移用）。

所有"与 Affinity 交互"的通道都收口在 MCP 桥；桥是唯一不可远程化的依赖。

---

## 2. 决定性约束：MCP 桥只监听回环地址

- `SERVER_URL` 硬编码为 `http://localhost:6767/sse`。社区佐证（affinity-mcp-setup、affinity-mcp-bridge 等仓库文档）指出 Affinity 的 MCP 服务器**只绑定回环地址**（IPv6 `::1`），因此**只有同机进程能连接它**。
- 浏览器直接连桥（绕过服务器）同样不可行，两个原因：
  1. 桥不在浏览器发出的跨源请求上加 CORS 头；从其他端口/来源的页面访问 `localhost:6767` 会被浏览器拦截。
  2. 从远程来源（公网页面）访问本机回环地址受浏览器 **Private Network Access** 限制（Chrome 默认阻止公网 → 本机的请求，除非桥明确放行 `Access-Control-Allow-Private-Network`）。
  （以上两点为基于浏览器安全模型的推断，未在本机实测 Affinity 桥的响应头；实际测试方法见附录 B。）

推论：

- **服务器必须与 Affinity 同机**，才能完成"安装到 Affinity / 执行 / 渲染预览 / 从 Affinity 下载 / SDK 文档 / 桥诊断"这一整类功能。
- 纯管理类功能（本地库 CRUD、社区浏览与收藏、代码编辑器、分享、更新检查）与服务器位置无关。

---

## 3. 方案 A：本机自托管（推荐）

### 3.1 目标架构

```
浏览器（任意浏览器打开 http://localhost:3000，或供其他设备经 LAN 访问）
    │  fetch（JSON API） + EventSource（SSE 推送）
    ▼
Node 服务器（与 Affinity 同机）
    ├── fs       data/MyScripts + config.json；fs.watch → SSE 推送
    ├── MCP SDK Client → http://localhost:6767/sse（原样复用现有连接/重试逻辑）
    └── fetch    GitHub registry.json / featured.json / releases API
```

要点：

- 依赖不变：`@modelcontextprotocol/sdk` 原样保留（`SSEClientTransport` 是 Node 客户端，天然适配）。
- **无需引入 WebSocket 依赖**：服务端用 `node:http` 即可；服务端 → 前端推送用标准 SSE（浏览器 `EventSource`），非二进制、单通道、够用（当前只有 3 个事件：`local-scripts-changed`、`repos-changed`、`update-available`）。
- 前端四件套（index.html、renderer.js、styles.css、icons.js）**零改造复用**——通过一个 `api-shim.js` 提供与 preload 完全同签名的 `window.api`。
- 浏览器端原生能力替代 Electron 特性：拖拽导入（`wireDropZone` 基于 `dataTransfer`，本就浏览器原生）、剪贴板（`navigator.clipboard`，localhost 属于 secure context，无需 HTTPS）、文件下载（`<a download>`）。

### 3.2 IPC → HTTP / 浏览器 API 完整映射

| window.api | 现行为（Electron） | Web 方案 |
|---|---|---|
| `listLocalScripts` | 读目录 + 元数据 + 大小/时间 | `GET /api/scripts` |
| `deleteLocalScript` | unlink | `DELETE /api/scripts/:file` |
| `renameLocalScript` | rename + 重名检查 | `POST /api/scripts/:file/rename` |
| `readLocalScript` | 读文件 | `GET /api/scripts/:file/content` |
| `saveLocalScript` | 写文件 | `PUT /api/scripts/:file/content` |
| `selectFile` | `dialog.showOpenDialog` | **删除**；前端 `<input type="file" accept=".js">` 读内容，再走 `POST /api/scripts/add` |
| `exportToDisk` | `dialog.showSaveDialog` | `GET /api/scripts/:file?download=1`（`Content-Disposition: attachment`，浏览器原生保存） |
| `pushToMcp` | 读文件 → `save_script_to_library` | `POST /api/bridge/push {file}` |
| `listMcpScripts` | `list_library_scripts` | `GET /api/bridge/library` |
| `executeScript` | `execute_script` | `POST /api/bridge/execute {code}` |
| `runCommunityScript` | fetch URL → `execute_script` | `POST /api/bridge/run {url}` |
| `renderActivePreview` | 取 sessionUuid → `render_spread` → base64 JPEG | `POST /api/bridge/render-preview`（返回 data URL，直接进 `<img>`） |
| `saveScript` | 落盘 + best-effort 推送 | `POST /api/scripts/add {title, description, code}`（服务端做 `upsertMetadataHeader`，返回 `pushed/pushError`） |
| `downloadFromMcp` | 读 Affinity 库 → 落盘 | `POST /api/bridge/download {title, localName}` |
| `exportMcpToDisk` | 读 Affinity 库 → 保存对话框 | `GET /api/bridge/export/:title`（attachment） |
| `readMcpMetadata` | 读 Affinity 库 → 解析头部 | `GET /api/bridge/metadata/:title` |
| `buildShareIssue` | 拼 GitHub issue URL | `GET /api/share/:file` |
| `buildShareIssueMcp` | 同上（Affinity 库来源） | `GET /api/share-mcp/:title` |
| `getFavorites` | 读 config | `GET /api/favorites` |
| `toggleFavorite` | 写 config | `POST /api/favorites/:stem` |
| `listCommunityScripts` | 逐仓库 fetch registry + featured | `GET /api/community`（含 repoErrors 结构原样保留） |
| `downloadCommunityScript` | 下载 + 落盘 + 推送 | `POST /api/community/download {url, name, metadata}` |
| `saveCommunityScript` | 下载 + 落盘（不推送） | `POST /api/community/save {url, name, metadata}` |
| `openExternalRepo` | `shell.openExternal` | 前端 `window.open(url)`（无需 API） |
| `fetchDocs` | 经桥拉 SDK 文档列表 + 逐篇 | `GET /api/docs`（注意：**依赖 MCP 桥**） |
| `searchDocs` | 经桥 `search_sdk_hints` | `POST /api/docs/search {query}`（**依赖 MCP 桥**） |
| `getRepos` / `addRepo` / `removeRepo` | 读/写 config + 事件 | `GET/POST /api/repos`、`DELETE /api/repos/:url`（URL 需编码） |
| `getSidebarCollapsed` / `setSidebarCollapsed` | 读/写 config | `GET/PUT /api/settings/sidebar` |
| `onReposChanged` / `onLocalScriptsChanged` / `onUpdateAvailable` | `webContents.send` | SSE 事件（`GET /api/events`，EventSource 订阅） |
| `checkUpdates` | fetch GitHub releases + `dialog.showMessageBox` | `GET /api/updates`（服务端检查，返回版本/URL；**弹窗改为前端 modal**，复用现有 modal 样式） |
| `openUrl` | `shell.openExternal` | 前端 `window.open(url)`（现有调用点全部在 click 回调内，可安全通过弹窗拦截） |
| `appVersion` | `app.getVersion()` 同步注入 | 服务端注入到 HTML 或 `GET /api/meta`（实际 renderer 已把版本位替换为 "for Affinity"，几乎无感） |

### 3.3 前端改造策略：先写 shim，再动 renderer

1. **新增 `api-shim.js`（约 200 行）**：以 fetch + EventSource 实现与 preload 完全一致的 `window.api` 接口，返回值保持 `{success, data|error}` 包装。renderer.js 中 36 个调用点**逐字不需要改**。
2. **仅 3 处 renderer 局部改动**：
   - `Add Script`（`selectFile`，renderer.js 约 2297 行）：隐藏 `<input type="file">` 替换原生对话框；
   - `exportToDisk` / `exportMcpToDisk`：`<a download>` 或 `fetch → blob → objectURL`；
   - 更新提示（`dialog.showMessageBox`）：前端 modal（复用现有 modal-backdrop 组件）。
3. **零改动项**：拖拽导入、剪贴板（已是 `navigator.clipboard`）、Bridge 诊断弹窗（纯 API 调用）、社区/文档/编辑器全部交互。
4. CDN 依赖（Ace、marked、Google Fonts）：需要联网；如需离线部署，把三个 CDN 资源下载到 `assets/` 本地化。

### 3.4 服务端骨架（示意）

```js
// server.js — 复用 main.js 中现成函数：parseScriptMetadata、upsertMetadataHeader、
// assertLocalScriptFilename、fetchFresh、callTool/ensureMcpConnected 几乎原样搬迁。
const http = require("node:http");
const fs = require("node:fs/promises");
const { pathToFileURL } = require("node:url"); // 可选

const DATA_DIR = path.join(__dirname, "data");      // 取代 app.getPath("userData")
const SCRIPTS_DIR = path.join(DATA_DIR, "MyScripts");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

// SSE 广播：订阅者集合 + 三个事件名
const sseClients = new Set();
function broadcast(event, payload) { /* 写 `event: …\ndata: …\n\n` 给所有已连接 EventSource */ }

http.createServer(async (req, res) => {
  // 1) GET /api/events → 挂 SSE（heartbeat 每 25s 发注释行保活）
  // 2) 其余按上表路由；每个 handler 内 try/catch 返回 {success:false,error}
  // 3) 静态文件：index.html / renderer.js / styles.css / icons.js / api-shim.js
}).listen(3000, "127.0.0.1");
```

### 3.5 数据与配置迁移

- Electron 版数据在 `%APPDATA%/affinity-script-manager/`（Windows；macOS/Linux 为 app.getPath("userData") 对应路径）：`MyScripts/` + `config.json`。
- Web 版把这些目录指向服务器工作目录（`./data/`），结构不变，**旧数据直接复制即可迁移**（收藏、仓库列表全部在 config.json 中）。
- 多标签页：SSE 广播天然支持多客户端；单用户假设不变（config.json 无锁，注意避免并发写——与现在单窗口语义一致，可在服务端加简单串行化）。

### 3.6 运行方式

- `npm start` → `node server.js`；`package.json` 去掉 electron/electron-builder 依赖与 build 配置，`main` 指向 server.js。
- 常驻：PM2 / Windows 计划任务 / 服务方式注册开机自启。
- **容器化需 `--network host`**：容器内回环 ≠ 宿主机回环，默认网络模式下容器连不上宿主机的 `::1:6767`。

---

## 4. 方案 B：远程/云托管

### 4.1 降级能力矩阵

| 功能 | 远程可用 |
|---|---|
| 本地库 CRUD、代码编辑器、收藏、分享、更新检查 | ✅（数据存服务器） |
| 社区浏览、下载到库 | ✅ |
| 安装到 Affinity、运行脚本、渲染预览、从 Affinity 下载、SDK 文档/搜索、桥诊断 | ❌（必须经桥，桥只在本地回环） |

即：云端的 Script Manager 退化为"纯脚本库管理工具"，恰好丢掉这个项目最有价值的部分。

### 4.2 隧道绕过：技术上可行，但不推荐

本机跑一个出站隧道守护进程（类似 Tailscale / ngrok 形态）把 `localhost:6767` 暴露给远程服务器，可以补全功能。但：

1. **又要在本机跑组件**——虽然是小守护进程而非浏览器套壳，但与本意相悖；
2. **安全风险高**：桥能对 Affinity 里的当前文档执行任意脚本（`execute_script`），等于任意代码注入 + 文档导出能力；公网隧道必须有强认证（token/mTLS）+ TLS，且攻击面落在你最小维护的基础设施上；
3. 复杂度与收益不成比例。

---

## 5. 安全考虑（方案 A 落地时）

- 默认绑定 `127.0.0.1`，仅本机浏览器可访问。
- 若想从手机/平板等其他设备访问（服务器仍在 Affinity 同机，功能完整）：绑定 `0.0.0.0` 前**必须加认证**（简单 token 或密码即可，客户端 header/query 传入）。否则 LAN 上任意设备可：读写脚本库、向 Affinity 推送任意脚本、触发脚本执行。
- 服务端保持"不接触 GitHub 凭据"的现有设计（分享只是拼 issue URL）。
- 沿用现有文件名校验（`assertLocalScriptFilename` / `localScriptFilenameFromInput`），防止路径穿越；新增静态文件服务时注意 content-type 与路径转义。
- 可加基础安全头（CSP 收紧 CDN 白名单、`X-Content-Type-Options`）。

---

## 6. 工作量估算

| 项 | 量 | 说明 |
|---|---|---|
| 服务端路由 | ~250–350 行 | main.js 的 handler 主体大多原样搬迁（fs / MCP / fetch） |
| api-shim.js | ~150–250 行 | 36 方法 + SSE 订阅 |
| renderer 微调 | 3 处 | selectFile、export×2、更新弹窗 |
| package.json / 打包 | 小改 | 去掉 electron 相关 |
| 测试 | 半天 | 现有桥 + 本机 Affinity 手动验证 |

合计约 1–2 人日（单人），无需新增第三方运行时依赖（Node ≥ 18 自带 fetch）。

---

## 7. 结论

- **推荐方案 A（本机自托管）**：这是"去 Electron 套壳"的最直接路径，功能完全等价，且浏览器体验（拖拽、剪贴板、编辑器）与现在一致。服务器必须与 Affinity 同机——这是 MCP 桥回环绑定决定的，任何方案都绕不开，除非接受额外本机隧道组件。
- **不建议方案 B（远程托管）**：核心功能（与 Affinity 交互）不可用；加隧道则引入本机组件与高风险暴露面。
- 若"不跑本地组件"是硬约束且不接受同机 Node 进程，则这个应用的价值主张（管理 + 推送到 Affinity）本身不成立——只能以静态单页 + IndexedDB 存储做只读浏览社区脚本的降级形态，且仍无法与本机桥通信（浏览器 CORS/PNA 限制）。

---

## 附录 A：与 MCP 桥交互的功能清单（依赖本地回环）

`pushToMcp`、`listMcpScripts`、`executeScript`、`runCommunityScript`、`renderActivePreview`、`saveScript`（推送部分）、`downloadFromMcp`、`exportMcpToDisk`、`readMcpMetadata`、`buildShareIssueMcp`、`fetchDocs`、`searchDocs`、Watch Mode 的自动重推、Bridge 诊断弹窗。

## 附录 B：改造前后端到端验证清单

1. 本机启动 `node server.js`，浏览器打开 `http://localhost:3000`。
2. My Scripts：添加（input[type=file]）、编辑、重命名、删除、导出下载、拖拽导入。
3. 安装/卸载（dot 状态翻转）、Watch Mode（外部改文件 → 自动重推 + 列表刷新）。
4. Bridge 诊断：状态、延迟。
5. Run without install：控制台输出 + 渲染预览。
6. Just in Affinity：下载到库 / 导出到文件夹。
7. 社区：浏览、收藏、安装、更新徽标、featured 轮播、repo 增删。
8. 文档/搜索（经桥）。
9. 分享：issue URL + 剪贴板。
10. 两标签页同时打开：事件推送（SSE）双方刷新。
