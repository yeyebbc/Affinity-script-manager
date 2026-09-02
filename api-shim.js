// window.api over HTTP — replaces Electron preload.js.
// Every method matches preload.js signatures and return shapes; renderer.js is untouched.
(function () {
  "use strict";
  // The IIFE exposes one global API without leaking helper names into window.
  // Strict mode turns several silent JavaScript mistakes into immediate errors.
  // The shim preserves renderer contracts while changing only the transport.
  // Browser-native fetch, EventSource, File, and Blob APIs remove desktop-shell dependencies.

  const CONTRIBUTE_URL =
    "https://github.com/JiriKrblich/Affinity-Community-Scripts/issues/new?template=contribute-script.md";

  // req is the JSON transport used by every non-download API call.
  // The custom X-ASM header forces cross-origin browser requests through CORS preflight.
  // Content-Type remains explicit even for empty mutation bodies.
  // undefined means no request body while other falsey values remain valid JSON.
  // Network failures reject so existing renderer try/catch paths still work.
  // Server application failures resolve as IPC-shaped objects for normal UI handling.
  // Relative URLs keep all calls bound to the page's own local server origin.
  function req(method, url, body) {
    const options = {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-ASM": "1",
      },
    };
    if (body !== undefined) options.body = JSON.stringify(body);
    return fetch(url, options).then((res) => res.json());
  }

  // Downloads cannot use req because successful responses are raw bytes instead of JSON.
  // Content-Type distinguishes an application error from an attachment.
  // Object URLs let the browser download a Blob without loading it into the page.
  // The temporary anchor supplies a filename through the standard download attribute.
  // Removing the anchor avoids leaving inert DOM nodes after repeated exports.
  // Revoking the object URL releases the Blob reference after the click is dispatched.
  // Browser download helper; JSON responses (errors) are surfaced as objects.
  function download(url, fallbackName) {
    return fetch(url).then(async (res) => {
      const type = res.headers.get("content-type") || "";
      if (type.includes("application/json")) return res.json();
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fallbackName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      return { success: true };
    });
  }

  // One EventSource connection serves every subscription type in the page.
  // The handler Map avoids registering duplicate native listeners for the same event.
  // Each Set prevents the same callback reference from being stored twice.
  // EventSource reconnect behavior is provided by the browser.
  // JSON parsing restores structured update payloads from the text-only SSE wire format.
  // Update callbacks keep their legacy url and version arguments.
  // Change notifications intentionally invoke callbacks without transport-specific arguments.
  // --- EventSource subscriptions ---
  const es = new EventSource("/api/events");
  const handlers = new Map(); // event name -> Set<cb>

  function subscribe(name, cb) {
    if (!handlers.has(name)) {
      handlers.set(name, new Set());
      es.addEventListener(name, (e) => {
        let data = e.data;
        try {
          data = JSON.parse(data);
        } catch {}
        for (const handler of handlers.get(name)) {
          if (name === "update-available") handler(data.url, data.version);
          else handler();
        }
      });
    }
    handlers.get(name).add(cb);
  }

  // The browser file picker replaces Electron's native dialog without server filesystem access.
  // A detached input can retain the selected File long enough for File.text to resolve.
  // The focus fallback handles browsers that emit no change event when selection is canceled.
  // Promise resolution is idempotent, so a late cancel check cannot override a selected file.
  // Only file contents and the basename are sent to the inspect endpoint.
  // --- Hidden file input for selectFile() ---
  function picker() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".js";
      input.style.display = "none";
      document.body.appendChild(input);
      input.addEventListener("change", () => {
        const file = input.files && input.files[0];
        input.remove();
        if (!file) {
          resolve({ success: false, error: "Cancelled" });
          return;
        }
        file
          .text()
          .then((code) => {
            resolve(req("POST", "/api/scripts/inspect", { code, filename: file.name }));
          })
          .catch((err) =>
            resolve({ success: false, error: (err && err.message) || String(err) }),
          );
      });
      // cancel of the native dialog fires a window focus event, not 'change'
      const onFocus = () => {
        setTimeout(() => {
          if (!input.files || !input.files.length) {
            input.remove();
            window.removeEventListener("focus", onFocus);
            resolve({ success: false, error: "Cancelled" });
          }
        }, 500);
      };
      window.addEventListener("focus", onFocus);
      input.click();
    });
  }

  // window.api is a compatibility facade rather than a new renderer-facing design.
  // Path parameters use encodeURIComponent so filenames remain one URL segment.
  // Mutation methods delegate validation and persistence to the server.
  // Event subscription methods register callbacks without exposing the EventSource object.
  window.api = {
    // --- Lokální skripty ---
    listLocalScripts: () => req("GET", "/api/scripts"),
    deleteLocalScript: (filename) =>
      req("DELETE", "/api/scripts/" + encodeURIComponent(filename)),
    renameLocalScript: (filename, newName) =>
      req("POST", "/api/scripts/" + encodeURIComponent(filename) + "/rename", {
        newName,
      }),
    readLocalScript: (filename) =>
      req("GET", "/api/scripts/" + encodeURIComponent(filename) + "/content"),
    saveLocalScript: (filename, code) =>
      req("PUT", "/api/scripts/" + encodeURIComponent(filename) + "/content", {
        code,
      }),
    selectFile: () => picker(),
    exportToDisk: (filename) =>
      download(
        "/api/scripts/" + encodeURIComponent(filename) + "?download=1",
        filename,
      ),
    pushToMcp: (filename) =>
      req("POST", "/api/bridge/push", { file: filename }),

    // --- MCP Cloud ---
    listMcpScripts: () => req("GET", "/api/bridge/library"),
    executeScript: (code) =>
      req("POST", "/api/bridge/execute", { code }),
    runCommunityScript: (downloadUrl) =>
      req("POST", "/api/bridge/run", { url: downloadUrl }),
    renderActivePreview: () => req("POST", "/api/bridge/render-preview", {}),
    saveScript: (title, description, code) =>
      req("POST", "/api/scripts/add", { title, description, code }),
    downloadFromMcp: (mcpTitle, localName) =>
      req("POST", "/api/bridge/download", { title: mcpTitle, localName }),
    exportMcpToDisk: (mcpTitle) =>
      download(
        "/api/bridge/export/" + encodeURIComponent(mcpTitle),
        String(mcpTitle).toLowerCase().replace(/[^a-z0-9_-]/g, "-") + ".js",
      ),
    readMcpMetadata: (mcpTitle) =>
      req("GET", "/api/bridge/metadata/" + encodeURIComponent(mcpTitle)),
    buildShareIssue: (filename) =>
      req("GET", "/api/share/" + encodeURIComponent(filename)),
    buildShareIssueMcp: (mcpTitle) =>
      req("GET", "/api/share-mcp/" + encodeURIComponent(mcpTitle)),
    getFavorites: () => req("GET", "/api/favorites"),
    toggleFavorite: (stem) =>
      req("POST", "/api/favorites/" + encodeURIComponent(stem), {}),

    // --- Komunitní Marketplace ---
    listCommunityScripts: () => req("GET", "/api/community"),
    downloadCommunityScript: (url, filename, metadata) =>
      req("POST", "/api/community/download", { url, filename, metadata }),
    saveCommunityScript: (url, filename, metadata) =>
      req("POST", "/api/community/save", { url, filename, metadata }),
    openExternalRepo: () => window.open(CONTRIBUTE_URL, "_blank", "noopener"),

    // --- Dokumentace a Hledání ---
    fetchDocs: () => req("GET", "/api/docs"),
    searchDocs: (query) => req("POST", "/api/docs/search", { query }),

    // --- Nastavení a repozitáře ---
    getRepos: () => req("GET", "/api/repos"),
    addRepo: (url) => req("POST", "/api/repos", { url }),
    removeRepo: (url) => req("DELETE", "/api/repos/" + encodeURIComponent(url)),
    getSidebarCollapsed: () => req("GET", "/api/settings/sidebar"),
    setSidebarCollapsed: (collapsed) =>
      req("PUT", "/api/settings/sidebar", { collapsed }),
    onReposChanged: (callback) => subscribe("repos-changed", callback),

    // --- Systémové (Aktualizace) ---
    checkUpdates: () => req("GET", "/api/updates"),
    onUpdateAvailable: (callback) => subscribe("update-available", callback),
    // --- Watch mode ---
    onLocalScriptsChanged: (callback) => subscribe("local-scripts-changed", callback),

    openUrl: (url) => window.open(url, "_blank", "noopener"),
  };

  // appVersion parity (renderer does not read it; kept for preload parity).
  req("GET", "/api/meta")
    .then((r) => {
      if (r && r.success && r.data) window.appVersion = r.data.version;
    })
    .catch(() => {});
})();
