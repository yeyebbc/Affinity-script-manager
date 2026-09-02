const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const store = require("./lib/store");
const mcp = require("./lib/mcp");
const community = require("./lib/community");
const pkg = require("./package.json");

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function startServer({ port, host } = {}) {
  // Node version guard (global fetch + node:fs/promises APIs).
  if (parseInt(process.versions.node, 10) < 20) {
    console.error(
      `Script Manager requires Node.js >= 20 (found ${process.version}). Install a newer Node and restart.`,
    );
    process.exit(1);
  }

  await store.init();

  const resolvedPort = port || Number(process.env.PORT) || 3000;
  const resolvedHost = host || process.env.HOST || "127.0.0.1";

  // --- SSE hub ---
  const sseClients = new Set(); // open SSE responses
  const sseBroadcast = (event, data) => {
    const payload = JSON.stringify(data === undefined ? null : data);
    const frame = `event: ${event}\ndata: ${payload}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {}
    }
  };
  store.setBroadcast(sseBroadcast);

  // SSE heartbeat keeps proxies/browsers from closing idle connections.
  const heartbeat = setInterval(() => {
    for (const res of sseClients) {
      try {
        res.write(": ping\n\n");
      } catch {}
    }
  }, 25000);

  const server = http.createServer((req, res) => {
    handleRequest(req, res, { sseClients, sseBroadcast, port: resolvedPort }).catch(
      (err) => {
        console.error("unhandled request error:", err);
        if (!res.headersSent) {
          sendJson(res, 500, { success: false, error: "Internal server error" });
        } else {
          res.end();
        }
      },
    );
  });

  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`Port ${resolvedPort} is in use — set PORT env var and restart.`);
      process.exit(1);
    }
    throw e;
  });

  server.on("close", () => clearInterval(heartbeat));

  server.listen(resolvedPort, resolvedHost, () => {
    console.log(`Script Manager for Affinity v${pkg.version}`);
    console.log(`Open http://${resolvedHost}:${resolvedPort} in your browser`);
    console.log(`Data directory: ${store.DATA_DIR}`);
  });

  // Watch mode: re-push edited files + notify renderers (never-resolving loop;
  // handled like main.js — fire-and-forget, errors logged internally).
  store.startWatcher();

  // Fire-and-forget startup update check (silently ignore failure).
  checkForUpdates(sseBroadcast).catch(() => {});

  return server;
}

async function handleRequest(req, res, ctx) {
  const { sseClients, sseBroadcast } = ctx;
  const url = new URL(req.url, "http://x");
  const pathname = url.pathname;

  // --- SSE stream ---
  if (req.method === "GET" && pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  const isApi = pathname.startsWith("/api/");

  // --- CSRF guard: every non-GET /api/* request needs the custom header ---
  if (isApi && req.method !== "GET" && req.headers["x-asm"] !== "1") {
    sendJson(res, 403, { success: false, error: "Forbidden" });
    return;
  }

  // --- Read JSON body (10 MB cap) for POST/PUT ---
  let body = {};
  if (req.method === "POST" || req.method === "PUT") {
    const read = await readBody(req);
    if (read === null) {
      sendJson(res, 200, { success: false, error: "Payload too large" });
      req.resume(); // drain the rest so the socket can be reused
      return;
    }
    body = read;
  }

  if (isApi) {
    const handled = await dispatchApi(req, res, { pathname, url, body, sseBroadcast, port: ctx.port });
    if (handled) return;
  }

  // --- Static whitelist (GET only) ---
  if (req.method === "GET" && (await serveStatic(req, res, pathname))) return;

  // --- 404 ---
  sendJson(res, 404, { success: false, error: "Not found" });
}

// Returns parsed JSON body, {} for empty/invalid, null when over the cap.
async function readBody(req) {
  const chunks = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      tooLarge = true;
      break;
    }
    chunks.push(chunk);
  }
  if (tooLarge) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function ok(res, payload) {
  sendJson(res, 200, { success: true, ...payload });
}

function fail(res, err) {
  sendJson(res, 200, { success: false, error: (err && err.message) || String(err) });
}

const dec = (s) => decodeURIComponent(s);

async function dispatchApi(req, res, { pathname, url, body, sseBroadcast, port }) {
  const method = req.method;

  // --- Meta ---
  if (method === "GET" && pathname === "/api/meta") {
    ok(res, { data: { version: pkg.version, port, dataDir: store.DATA_DIR } });
    return true;
  }

  // --- Local scripts ---
  if (method === "GET" && pathname === "/api/scripts") {
    try {
      ok(res, await store.listLocalScripts());
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  let match;

  if ((match = pathname.match(/^\/api\/scripts\/([^/]+)\/content$/)) && (method === "GET" || method === "PUT")) {
    const file = dec(match[1]);
    try {
      store.assertLocalScriptFilename(file);
      if (method === "GET") ok(res, await store.readLocalScript(file));
      else ok(res, await store.saveLocalScript(file, String(body.code || "")));
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  if ((match = pathname.match(/^\/api\/scripts\/([^/]+)\/rename$/)) && method === "POST") {
    try {
      const file = dec(match[1]);
      store.assertLocalScriptFilename(file);
      ok(res, await store.renameLocalScript(file, body.newName));
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  if (method === "POST" && pathname === "/api/scripts/inspect") {
    try {
      const meta = store.inspectScriptText(body.code || "", body.filename || "");
      ok(res, { data: { name: meta.name, description: meta.description, code: body.code || "" } });
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  if (method === "POST" && pathname === "/api/scripts/add") {
    try {
      ok(res, await store.addScript(body.title || "", body.description || "", body.code || ""));
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  if ((match = pathname.match(/^\/api\/scripts\/([^/]+)$/))) {
    const file = dec(match[1]);
    if (method === "DELETE") {
      try {
        store.assertLocalScriptFilename(file);
        ok(res, await store.deleteLocalScript(file));
        return true;
      } catch (err) {
        fail(res, err);
        return true;
      }
    }
    if (method === "GET" && url.searchParams.get("download") === "1") {
      try {
        store.assertLocalScriptFilename(file);
        const code = await store.getLocalScriptCode(file);
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${file}"`,
        });
        res.end(code, "utf8");
        return true;
      } catch (err) {
        fail(res, err);
        return true;
      }
    }
  }

  // --- MCP bridge ---
  if (method === "GET" && pathname === "/api/bridge/library") {
    try {
      const result = await mcp.callTool("list_library_scripts", {});
      ok(res, { data: mcp.getTextContent(result) || result });
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  if (method === "POST" && pathname === "/api/bridge/push") {
    try {
      const file = String(body.file || "");
      store.assertLocalScriptFilename(file);
      const code = await store.getLocalScriptCode(file);
      const metadata = store.parseScriptMetadata(code, path.parse(file).name);
      await mcp.callTool("save_script_to_library", {
        title: metadata.name || path.parse(file).name,
        description: metadata.description,
        code,
      });
      ok(res, {});
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  if (method === "POST" && pathname === "/api/bridge/execute") {
    try {
      const result = await mcp.callTool("execute_script", { script: String(body.code || "") });
      ok(res, { output: mcp.getTextContent(result) });
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  if (method === "POST" && pathname === "/api/bridge/run") {
    try {
      const response = await community.fetchFresh(String(body.url || ""));
      if (!response.ok) throw new Error("Couldn't download the script.");
      const code = await response.text();
      const result = await mcp.callTool("execute_script", { script: code });
      ok(res, { output: mcp.getTextContent(result) });
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  if (method === "POST" && pathname === "/api/bridge/render-preview") {
    try {
      const uuidRes = await mcp.callTool("execute_script", {
        script:
          "const { Document } = require('/document'); console.log(Document.current.sessionUuid);",
      });
      const uuid = mcp.getTextContent(uuidRes).trim();
      if (!uuid) throw new Error("No active document to preview.");
      const render = await mcp.callTool("render_spread", {
        document_session_uuid: uuid,
        spread_index: 0,
      });
      const image = mcp.getImageDataUrl(render);
      if (!image) throw new Error("Nothing was rendered.");
      ok(res, { image });
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  if (method === "POST" && pathname === "/api/bridge/download") {
    try {
      const result = await mcp.callTool("read_library_script", {
        title: String(body.title || ""),
      });
      const code = mcp.getTextContent(result);
      if (!code) throw new Error("Empty script.");
      const safeFilename =
        String(body.localName || "").toLowerCase().replace(/[^a-z0-9_-]/g, "-") + ".js";
      ok(res, await store.saveLocalScript(safeFilename, code));
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  if ((match = pathname.match(/^\/api\/bridge\/export\/([^/]+)$/)) && method === "GET") {
    const title = dec(match[1]);
    try {
      const result = await mcp.callTool("read_library_script", { title });
      const code = mcp.getTextContent(result);
      if (!code) throw new Error("Empty script.");
      const safeName =
        String(title).toLowerCase().replace(/[^a-z0-9_-]/g, "-") + ".js";
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${safeName}"`,
      });
      res.end(code, "utf8");
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  if ((match = pathname.match(/^\/api\/bridge\/metadata\/([^/]+)$/)) && method === "GET") {
    try {
      const title = dec(match[1]);
      const result = await mcp.callTool("read_library_script", { title });
      const code = mcp.getTextContent(result);
      ok(res, { data: store.parseScriptMetadata(code, title) });
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  // --- Share ---
  if ((match = pathname.match(/^\/api\/share\/([^/]+)$/)) && method === "GET") {
    try {
      const filename = dec(match[1]);
      store.assertLocalScriptFilename(filename);
      const code = await store.getLocalScriptCode(filename);
      ok(res, community.shareIssuePayload(code, path.parse(filename).name));
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  if ((match = pathname.match(/^\/api\/share-mcp\/([^/]+)$/)) && method === "GET") {
    const title = dec(match[1]);
    try {
      const result = await mcp.callTool("read_library_script", { title });
      const code = mcp.getTextContent(result);
      if (!code) throw new Error("Empty script.");
      ok(res, community.shareIssuePayload(code, title));
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  // --- Community ---
  if (method === "GET" && pathname === "/api/community") {
    try {
      const config = await store.getConfig();
      const r = await community.listCommunityScripts(config.repositories);
      if (r.success) ok(res, { data: r.data, errors: r.errors });
      else ok(res, r);
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  if (method === "POST" && pathname === "/api/community/download") {
    try {
      ok(res, await community.downloadCommunityScript(
        String(body.url || ""),
        String(body.filename || ""),
        body.metadata || {},
      ));
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  if (method === "POST" && pathname === "/api/community/save") {
    try {
      ok(res, await community.saveCommunityScript(
        String(body.url || ""),
        String(body.filename || ""),
        body.metadata || {},
      ));
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  // --- Docs ---
  if (method === "GET" && pathname === "/api/docs") {
    ok(res, await mcp.fetchSdkDocs());
    return true;
  }

  if (method === "POST" && pathname === "/api/docs/search") {
    ok(res, await mcp.searchSdkDocs(String(body.query || "")));
    return true;
  }

  // --- Favorites / repos / settings ---
  if (method === "GET" && pathname === "/api/favorites") {
    try {
      ok(res, await store.getFavorites());
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  if ((match = pathname.match(/^\/api\/favorites\/([^/]+)$/)) && method === "POST") {
    try {
      ok(res, await store.toggleFavorite(dec(match[1])));
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  if (method === "GET" && pathname === "/api/repos") {
    try {
      ok(res, await store.getRepos());
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  if (method === "POST" && pathname === "/api/repos") {
    try {
      ok(res, await store.addRepo(String(body.url || "")));
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  if ((match = pathname.match(/^\/api\/repos\/(.+)$/)) && method === "DELETE") {
    try {
      ok(res, await store.removeRepo(dec(match[1])));
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  if (method === "GET" && pathname === "/api/settings/sidebar") {
    try {
      ok(res, await store.getSidebarCollapsed());
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  if (method === "PUT" && pathname === "/api/settings/sidebar") {
    try {
      ok(res, await store.setSidebarCollapsed(body.collapsed));
      return true;
    } catch (err) {
      fail(res, err);
      return true;
    }
  }

  // --- Updates ---
  if (method === "GET" && pathname === "/api/updates") {
    ok(res, await checkForUpdates(sseBroadcast));
    return true;
  }

  return false;
}

async function checkForUpdates(sseBroadcast) {
  try {
    const currentVersion = pkg.version;
    const response = await fetch(
      `https://api.github.com/repos/JiriKrblich/Affinity-Script-Manager/releases/latest`,
    );
    if (!response.ok) throw new Error("Could not connect to GitHub.");

    const release = await response.json();
    const latestVersion = release.tag_name.replace("v", "");

    const v1 = latestVersion.split(".").map(Number);
    const v2 = currentVersion.split(".").map(Number);
    let isNewer = false;

    for (let i = 0; i < 3; i++) {
      if ((v1[i] || 0) > (v2[i] || 0)) {
        isNewer = true;
        break;
      }
      if ((v1[i] || 0) < (v2[i] || 0)) {
        break;
      }
    }

    if (isNewer) {
      sseBroadcast("update-available", {
        url: release.html_url,
        version: latestVersion,
      });
      return { success: true, hasUpdate: true };
    }
    return { success: true, hasUpdate: false };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

const STATIC_ROUTES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/renderer.js": ["renderer.js", "text/javascript"],
  "/api-shim.js": ["api-shim.js", "text/javascript"],
  "/styles.css": ["styles.css", "text/css"],
  "/icons.js": ["icons.js", "text/javascript"],
};

const ASSETS_DIR = path.join(__dirname, "assets");

async function serveStatic(req, res, pathname) {
  const assetMatch = pathname.match(/^\/assets\/([^/]+)$/);
  if (assetMatch) {
    const name = assetMatch[1];
    if (name.includes("/") || name.includes("\\")) return false;
    const type = MIME[path.extname(name).toLowerCase()];
    if (!type) return false;
    const full = path.normalize(path.join(ASSETS_DIR, name));
    if (!full.startsWith(path.normalize(ASSETS_DIR) + path.sep)) return false;
    try {
      await fs.access(full);
    } catch {
      return false;
    }
    await sendFile(res, full, type);
    return true;
  }

  const route = STATIC_ROUTES[pathname];
  if (!route) return false;
  try {
    await fs.access(path.join(__dirname, route[0]));
  } catch {
    return false;
  }
  await sendFile(res, path.join(__dirname, route[0]), route[1]);
  return true;
}

async function sendFile(res, filePath, contentType) {
  try {
    const buf = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(buf);
  } catch (err) {
    sendJson(res, 200, { success: false, error: err.message });
  }
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error("failed to start server:", err);
    process.exit(1);
  });
}

module.exports = { startServer };
