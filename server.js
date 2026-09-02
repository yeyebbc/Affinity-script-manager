const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const store = require("./lib/store");
const mcp = require("./lib/mcp");
const community = require("./lib/community");
const pkg = require("./package.json");
// Built-in Node modules keep the server dependency surface small.
// The HTTP layer depends on domain modules instead of owning their data.
// store handles persistence, mcp handles Affinity, and community handles remote catalogs.
// This dependency direction keeps transport code separate from business rules.
// CommonJS is used because the existing package and MCP SDK imports already use it.
// package.json is loaded once, so the running process has one stable version value.
// A local server still needs explicit trust boundaries because browsers can reach loopback.
// Route handlers preserve the former IPC result shapes to avoid renderer changes.

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
const INVALID_JSON = Symbol("invalid-json");

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

// startServer is exported so smoke tests can boot the real application server.
// Optional parameters make test ports possible without changing production defaults.
// Environment variables provide deployment configuration without a config package.
// The Node version check fails before any files or sockets are opened.
// parseInt is sufficient here because only the major Node version controls compatibility.
// store.init creates the data directory before routes can receive requests.
// The resolved port is captured by closures and reported through the meta endpoint.
// Host configuration is intentionally retained as an explicit project policy.
// A Set gives constant-time add and delete for connected SSE responses.
// latestUpdate is process-local cache state, not persistent application state.
// SSE frames require a blank line after each event to mark the frame boundary.
// JSON encoding prevents payload newlines from breaking the SSE wire format.
// Broadcasting is synchronous because response.write only queues bytes to each socket.
// Failed client writes are ignored because request close cleanup removes dead clients.
// publishUpdate updates the cache before broadcasting, preventing late-subscriber races.
// store receives only a callback, so it does not depend on HTTP response objects.
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
  let latestUpdate = null;
  const sseBroadcast = (event, data) => {
    const payload = JSON.stringify(data === undefined ? null : data);
    const frame = `event: ${event}\ndata: ${payload}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {}
    }
  };
  const publishUpdate = (update) => {
    latestUpdate = update;
    sseBroadcast("update-available", update);
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
    handleRequest(req, res, {
      sseClients,
      getLatestUpdate: () => latestUpdate,
      publishUpdate,
      port: resolvedPort,
    }).catch(
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
  checkForUpdates(publishUpdate).catch(() => {});

  return server;
}

// handleRequest is the single entry point for both API and static requests.
// URL parsing uses a dummy base because incoming server URLs are normally relative.
// pathname excludes the query string, which keeps route matching deterministic.
// The SSE route runs first because it is the only long-lived API response.
// writeHead commits all stream headers before the first event is sent.
// no-cache prevents intermediaries from replaying stale event data.
// keep-alive communicates that the response intentionally remains open.
// The connected comment is valid SSE and flushes initial bytes without an application event.
// Registering the response before replay closes the broadcast-versus-connect race.
// The request close event is the reliable place to release the response reference.
// Cached updates are replayed only when an update actually exists.
// Custom mutation headers force cross-origin browsers to perform a CORS preflight.
// The X-ASM header is a CSRF barrier, not an authentication credential.
// Body parsing is limited to methods that currently carry JSON payloads.
// Oversize and syntax errors retain HTTP 200 to preserve the former IPC contract.
// Static routing happens only after API dispatch declines the request.
// Unknown paths use a conventional HTTP 404 because they are outside the IPC contract.
// Every early return documents that exactly one response is written per request.
async function handleRequest(req, res, ctx) {
  const { sseClients, getLatestUpdate, publishUpdate } = ctx;
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
    const latestUpdate = getLatestUpdate();
    if (latestUpdate) {
      const payload = JSON.stringify(latestUpdate);
      res.write(`event: update-available\ndata: ${payload}\n\n`);
    }
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
    if (read === INVALID_JSON) {
      sendJson(res, 200, { success: false, error: "Invalid JSON" });
      return;
    }
    body = read;
  }

  if (isApi) {
    const handled = await dispatchApi(req, res, {
      pathname,
      url,
      body,
      publishUpdate,
      port: ctx.port,
    });
    if (handled) return;
  }

  // --- Static whitelist (GET only) ---
  if (req.method === "GET" && (await serveStatic(req, res, pathname))) return;

  // --- 404 ---
  sendJson(res, 404, { success: false, error: "Not found" });
}

// Returns parsed JSON body, {} for empty, null when over the cap.
// Request bodies arrive as chunks and cannot be assumed to fit in one data event.
// Counting bytes instead of characters enforces the limit before UTF-8 decoding.
// The cap protects memory because all accepted chunks are buffered for JSON parsing.
// Breaking immediately avoids allocating the rest of an oversized payload.
// req.resume in the caller drains discarded bytes so the connection can finish cleanly.
// null is reserved for oversize input and a Symbol distinguishes malformed JSON.
// An empty body maps to an empty object because several POST routes need no fields.
// Buffer.concat performs one final allocation after the size has been validated.
// JSON.parse is intentionally centralized so every JSON route has identical behavior.
// Returning a unique Symbol avoids collisions with any valid JSON value.
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
    return INVALID_JSON;
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

function dec(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("Invalid path encoding.");
  }
}

// dispatchApi performs explicit method and pathname matching without a routing framework.
// Explicit routing makes the small API surface auditable in one file.
// Each successful branch returns true to stop static and 404 processing.
// Domain helpers return IPC-shaped objects that ok merges into the HTTP response.
// fail normalizes thrown values so string and Error failures share one shape.
// Path parameters remain encoded until a route has matched their structural position.
// dec converts malformed percent encoding into a controlled application error.
// Route-local try blocks keep expected failures at HTTP 200.
// Download success is the exception because it sends bytes instead of JSON.
// Query parameters are inspected through URLSearchParams rather than manual splitting.
// Method checks prevent read endpoints from accidentally accepting mutations.
// The dispatcher receives only the runtime state needed by route handlers.
async function dispatchApi(req, res, { pathname, url, body, publishUpdate, port }) {
  const method = req.method;

  // --- Meta ---
  if (method === "GET" && pathname === "/api/meta") {
    ok(res, { data: { version: pkg.version, port, dataDir: store.DATA_DIR } });
    return true;
  }

  // Local script routes delegate filename policy to one shared store guard.
  // Basename and .js checks block traversal before filesystem paths are constructed.
  // List results include metadata and filesystem statistics for the existing table UI.
  // Content reads and writes share one route but remain separated by HTTP method.
  // String conversion gives the editor a predictable text payload on save.
  // Rename accepts a display-style name and lets the store derive a safe filename.
  // Inspect parses browser-selected text without granting the server arbitrary file access.
  // Add writes locally before its best-effort MCP installation attempt.
  // The local filename is always decoded before the traversal guard runs.
  // Download responses set attachment metadata so browsers preserve the script filename.
  // Application errors during download still return JSON for the shim to recognize.
  // Keeping raw file access behind store functions centralizes the data directory boundary.
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
    try {
      const file = dec(match[1]);
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
    if (method === "DELETE") {
      try {
        const file = dec(match[1]);
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
        const file = dec(match[1]);
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

  // MCP routes translate HTTP payloads into Affinity tool calls.
  // The MCP module owns connection reuse and reconnect behavior for every route.
  // Library listing text is preserved because the renderer splits the original string.
  // Push reads the authoritative local copy instead of trusting code from the request.
  // Metadata is parsed from that same copy so title and description stay consistent.
  // Execute accepts code directly because running arbitrary Affinity scripts is the feature.
  // Community run fetches the remote source immediately before execution.
  // fetchFresh bypasses stale raw GitHub cache entries for recently updated scripts.
  // Preview first asks Affinity for the active document session identifier.
  // render_spread needs the session identifier rather than a local file path.
  // Image content is normalized to a data URL before crossing the HTTP boundary.
  // MCP download sanitizes the user-selected local name before writing.
  // Export returns bridge content as an attachment without creating a local library copy.
  // Metadata lookup reads the full library script because list_library_scripts exposes titles only.
  // Bridge failures remain ordinary IPC-shaped errors so the UI can show offline state.
  // No MCP client object leaks into server routes; only callTool results cross the module boundary.
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
    try {
      const title = dec(match[1]);
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

  // Share endpoints build issue payloads but never require GitHub credentials.
  // Local sharing reads only guarded filenames from the managed scripts directory.
  // MCP sharing handles scripts that exist only inside the Affinity library.
  // Long issue bodies include a clipboard fallback because browser URLs have practical limits.
  // Returning both baseUrl and body lets the renderer choose the safe fallback flow.
  // Sharing is read-only from the server perspective, so these routes use GET.
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
    try {
      const title = dec(match[1]);
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

  // Community listing reads repository configuration through the serialized store.
  // One failed repository does not discard successful results from other repositories.
  // Download means save locally and then attempt installation into Affinity.
  // Save means keep a local editable copy without activating it in Affinity.
  // Metadata from the registry is merged with metadata already present in source code.
  // Local write failure is authoritative and prevents a misleading MCP-only installation.
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

  // Documentation comes from the MCP bridge because it matches the running Affinity SDK.
  // Topic listing uses GET while search uses POST because the query is request data.
  // The MCP module filters tool-level error text that may arrive in successful RPC responses.
  // Documentation failures preserve their message for the renderer's existing error panel.
  // --- Docs ---
  if (method === "GET" && pathname === "/api/docs") {
    ok(res, await mcp.fetchSdkDocs());
    return true;
  }

  if (method === "POST" && pathname === "/api/docs/search") {
    ok(res, await mcp.searchSdkDocs(String(body.query || "")));
    return true;
  }

  // Favorites, repositories, and sidebar state share one small JSON configuration file.
  // Read-modify-write operations are serialized in store to prevent multi-tab lost updates.
  // Repository URLs are encoded as one path parameter when removed.
  // Boolean coercion belongs in store so callers cannot persist non-boolean sidebar state.
  // Repository-change events notify every open tab only after the config write completes.
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

  // Update checks compare three numeric version components instead of lexical strings.
  // Publishing caches the update before emitting SSE, so later tabs receive the same state.
  // A failed GitHub request returns an error object and never stops the server.
  // Manual and startup checks share one function to keep version semantics identical.
  // --- Updates ---
  if (method === "GET" && pathname === "/api/updates") {
    ok(res, await checkForUpdates(publishUpdate));
    return true;
  }

  return false;
}

async function checkForUpdates(publishUpdate) {
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
      publishUpdate({
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

// Static files are served from an allowlist rather than from arbitrary URL paths.
// The allowlist prevents accidental exposure of config files and server source.
// Asset requests permit one filename segment and reject nested directory traversal.
// Extension-based MIME selection is sufficient because the asset set is controlled.
// path.normalize removes redundant segments before the directory-prefix check.
// Appending path.sep prevents sibling names such as assets-copy from passing the prefix test.
// fs.access distinguishes an allowed but missing file from a valid static response.
// sendFile reads only paths already approved by serveStatic.
// require.main keeps imports side-effect free for tests that call startServer directly.
// Exporting one startup function gives tests the same server behavior as npm start.
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
