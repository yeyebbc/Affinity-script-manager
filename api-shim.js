// window.api over HTTP — replaces Electron preload.js.
// Every method matches preload.js signatures and return shapes; renderer.js is untouched.
(function () {
  "use strict";

  const CONTRIBUTE_URL =
    "https://github.com/JiriKrblich/Affinity-Community-Scripts/issues/new?template=contribute-script.md";

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
