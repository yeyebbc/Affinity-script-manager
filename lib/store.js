const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const mcp = require("./mcp");

const DEFAULT_REPO =
  "https://raw.githubusercontent.com/JiriKrblich/Affinity-Community-Scripts/refs/heads/main/registry.json";

let DATA_DIR;
let SCRIPTS_DIR;
let CONFIG_PATH;
let broadcast = null;
let writeQueue = Promise.resolve();

async function init() {
  DATA_DIR =
    process.env.ASM_DATA_DIR || path.join(os.homedir(), ".affinity-script-manager");
  SCRIPTS_DIR = path.join(DATA_DIR, "MyScripts");
  CONFIG_PATH = path.join(DATA_DIR, "config.json");
  await fs.mkdir(SCRIPTS_DIR, { recursive: true });
  await getConfig(); // normalize defaults so config.json exists
}

function setBroadcast(fn) {
  broadcast = fn;
}

// --- Bezpečná správa konfigurace ---
async function getConfig() {
  let config = {};
  let needsSave = false;

  try {
    const data = await fs.readFile(CONFIG_PATH, "utf8");
    config = JSON.parse(data);
  } catch (e) {
    needsSave = true;
  }

  if (!config.repositories || !Array.isArray(config.repositories)) {
    config.repositories = [DEFAULT_REPO];
    needsSave = true;
  } else if (!config.repositories.includes(DEFAULT_REPO)) {
    config.repositories.unshift(DEFAULT_REPO);
    needsSave = true;
  }

  // Unified favorites keyed by script stem — shared by My Scripts and Community
  // (favoriting a community script marks its local copy, and vice versa).
  if (!config.favoriteScripts || !Array.isArray(config.favoriteScripts)) {
    const migrated = Array.isArray(config.favoriteLocalScripts)
      ? config.favoriteLocalScripts.map((f) =>
          String(f).replace(/\.js$/i, "").toLowerCase(),
        )
      : [];
    config.favoriteScripts = [...new Set(migrated)];
    needsSave = true;
  }
  if (config.favoriteCommunityScripts || config.favoriteLocalScripts) {
    delete config.favoriteCommunityScripts;
    delete config.favoriteLocalScripts;
    needsSave = true;
  }

  if (typeof config.sidebarCollapsed !== "boolean") {
    config.sidebarCollapsed = false;
    needsSave = true;
  }

  if (needsSave) await saveConfig(config);
  return config;
}

// Serialize config writes through a promise queue so concurrent requests
// (multiple tabs) never interleave or lose a write.
async function saveConfig(config) {
  const snapshot = JSON.stringify(config, null, 2);
  writeQueue = writeQueue.then(
    () => fs.writeFile(CONFIG_PATH, snapshot, "utf8"),
    () => fs.writeFile(CONFIG_PATH, snapshot, "utf8"),
  );
  return writeQueue;
}

function assertLocalScriptFilename(filename) {
  if (!filename || typeof filename !== "string") {
    throw new Error("Missing script filename.");
  }
  if (path.basename(filename) !== filename || path.extname(filename) !== ".js") {
    throw new Error("Invalid script filename.");
  }
  return filename;
}

function localScriptFilenameFromInput(input) {
  const base = String(input || "")
    .trim()
    .replace(/\.js$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!base) throw new Error("Please enter a valid script name.");
  return `${base}.js`;
}

function readMetadataField(header, field) {
  const re = new RegExp(`^\\s*\\*?\\s*${field}:\\s*(.*)$`, "im");
  const match = header.match(re);
  return match ? match[1].trim() : "";
}

function parseScriptMetadata(code, fallbackName = "") {
  const meta = {
    name: fallbackName,
    description: "",
    version: "",
    author: "",
  };
  const headerMatch = String(code || "").match(/^\s*\/\*\*([\s\S]*?)\*\//);
  if (!headerMatch) return meta;

  const header = headerMatch[1];
  meta.name = readMetadataField(header, "name") || meta.name;
  meta.description = readMetadataField(header, "description");
  meta.version = readMetadataField(header, "version");
  meta.author = readMetadataField(header, "author");
  return meta;
}

function metadataValue(value) {
  return String(value || "").replace(/\s*\n+\s*/g, " ").trim();
}

function upsertMetadataHeader(code, metadata) {
  const fields = {
    name: metadataValue(metadata.name),
    description: metadataValue(metadata.description),
    version: metadataValue(metadata.version),
    author: metadataValue(metadata.author),
  };
  const presentFields = Object.entries(fields).filter(([, value]) => value);
  if (presentFields.length === 0) return code;

  const source = String(code || "");
  const headerMatch = source.match(/^\s*\/\*\*([\s\S]*?)\*\//);
  if (!headerMatch) {
    const header =
      "/**\n" +
      presentFields.map(([key, value]) => ` * ${key}: ${value}`).join("\n") +
      "\n */\n\n";
    return header + source.replace(/^\s+/, "");
  }

  let header = headerMatch[1];
  for (const [key, value] of presentFields) {
    const re = new RegExp(`(^\\s*\\*?\\s*${key}:\\s*).*$`, "im");
    if (re.test(header)) {
      header = header.replace(re, (line, prefix) => `${prefix}${value}`);
    } else {
      header += `\n * ${key}: ${value}`;
    }
  }
  return source.replace(headerMatch[0], `/**${header}*/`);
}

// --- LOCAL SCRIPTS ---
async function listLocalScripts() {
  const files = (await fs.readdir(SCRIPTS_DIR)).filter((f) => f.endsWith(".js"));
  const out = [];
  for (const file of files) {
    const full = path.join(SCRIPTS_DIR, file);
    const stat = await fs.stat(full);
    let metadata = {
      name: path.parse(file).name,
      description: "",
      version: "",
    };
    try {
      const head = (await fs.readFile(full, "utf8")).slice(0, 4096);
      metadata = parseScriptMetadata(head, metadata.name);
    } catch {}
    out.push({
      file,
      name: metadata.name,
      description: metadata.description,
      version: metadata.version,
      size: stat.size,
      modified: stat.mtimeMs,
    });
  }
  return { success: true, data: out };
}

async function deleteLocalScript(filename) {
  try {
    await fs.unlink(path.join(SCRIPTS_DIR, filename));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function readLocalScript(filename) {
  try {
    const code = await fs.readFile(path.join(SCRIPTS_DIR, filename), "utf8");
    return { success: true, data: { code } };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function saveLocalScript(filename, code) {
  try {
    await fs.writeFile(path.join(SCRIPTS_DIR, filename), code, "utf8");
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Raw string for download routes (server sends the file bytes directly).
async function getLocalScriptCode(filename) {
  return fs.readFile(path.join(SCRIPTS_DIR, filename), "utf8");
}

async function renameLocalScript(filename, newName) {
  try {
    const oldFilename = assertLocalScriptFilename(filename);
    const nextFilename = localScriptFilenameFromInput(newName);
    if (oldFilename === nextFilename) {
      return { success: true, data: { filename: nextFilename } };
    }

    const oldPath = path.join(SCRIPTS_DIR, oldFilename);
    const nextPath = path.join(SCRIPTS_DIR, nextFilename);

    try {
      await fs.access(nextPath);
      return {
        success: false,
        error: `A script named ${nextFilename} already exists.`,
      };
    } catch {}

    await fs.rename(oldPath, nextPath);
    if (broadcast) broadcast("local-scripts-changed");
    return { success: true, data: { filename: nextFilename } };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Replaces select-file's metadata derivation; the file picker itself moves to the shim.
function inspectScriptText(code, filename) {
  return parseScriptMetadata(code, path.parse(filename || "").name);
}

// "Add Script" — saves to disk and auto-installs into Affinity via the bridge.
// The local save is authoritative; pushing to the bridge is best-effort so an
// offline bridge still saves the file (reported via `pushed`/`pushError`).
async function addScript(title, description, code) {
  try {
    const safeFilename = title.toLowerCase().replace(/[^a-z0-9_-]/g, "-") + ".js";
    const codeWithMetadata = upsertMetadataHeader(code, {
      name: title,
      description,
    });
    await fs.writeFile(
      path.join(SCRIPTS_DIR, safeFilename),
      codeWithMetadata,
      "utf8",
    );

    let pushed = false;
    let pushError = null;
    try {
      await mcp.callTool("save_script_to_library", {
        title,
        description,
        code: codeWithMetadata,
      });
      pushed = true;
    } catch (err) {
      pushError = err && err.message ? err.message : String(err);
    }
    return { success: true, pushed, pushError };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// --- FAVORITES / REPOS / SETTINGS ---
async function getFavorites() {
  try {
    const config = await getConfig();
    return { success: true, data: config.favoriteScripts };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function toggleFavorite(stem) {
  try {
    const key = String(stem || "")
      .replace(/\.js$/i, "")
      .toLowerCase();
    if (!key) return { success: false, error: "Missing script key." };
    const config = await getConfig();
    const index = config.favoriteScripts.indexOf(key);
    if (index >= 0) config.favoriteScripts.splice(index, 1);
    else config.favoriteScripts.push(key);
    await saveConfig(config);
    return { success: true, data: config.favoriteScripts };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function getRepos() {
  const config = await getConfig();
  return { success: true, data: config.repositories };
}

async function addRepo(url) {
  try {
    let rawUrl = url;

    if (url.includes("github.com")) {
      const match = url.match(/github\.com\/([^\/]+\/[^\/\?#]+)/);
      if (match) {
        const cleanRepo = match[1].replace(".git", "");
        rawUrl = `https://raw.githubusercontent.com/${cleanRepo}/refs/heads/main/registry.json`;
      } else {
        return {
          success: false,
          error: "Invalid GitHub URL format. Use https://github.com/user/repo",
        };
      }
    } else if (!url.includes("raw.githubusercontent.com")) {
      return {
        success: false,
        error: "Please provide a valid GitHub repository URL.",
      };
    }

    const config = await getConfig();
    if (!config.repositories.includes(rawUrl)) {
      config.repositories.push(rawUrl);
      await saveConfig(config);
      if (broadcast) broadcast("repos-changed");
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function removeRepo(url) {
  if (url === DEFAULT_REPO)
    return { success: false, error: "Cannot remove default repository." };
  try {
    const config = await getConfig();
    config.repositories = config.repositories.filter((r) => r !== url);
    await saveConfig(config);
    if (broadcast) broadcast("repos-changed");
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function getSidebarCollapsed() {
  try {
    const config = await getConfig();
    return { success: true, data: config.sidebarCollapsed };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function setSidebarCollapsed(collapsed) {
  try {
    const config = await getConfig();
    config.sidebarCollapsed = Boolean(collapsed);
    await saveConfig(config);
    return { success: true, data: config.sidebarCollapsed };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// --- Watch mode: re-push edited scripts to the bridge and notify the renderer ---
async function startWatcher() {
  const pending = new Map(); // filename -> timer (debounce)

  const handleChange = async (filename) => {
    if (!filename || !filename.endsWith(".js")) return;
    const full = path.join(SCRIPTS_DIR, filename);
    let exists = false;
    try {
      await fs.stat(full);
      exists = true;
    } catch {}

    if (exists) {
      // Only auto-sync if the script is already installed in Affinity. New or
      // newly-saved files stay local until the user explicitly clicks the
      // install dot in My Scripts.
      try {
        const listResult = await mcp.callTool("list_library_scripts", {});
        const titles = mcp.parseCsvTextContent(listResult).map((t) =>
          t.toLowerCase(),
        );
        const stem = path.parse(filename).name.toLowerCase();
        if (titles.includes(stem)) {
          const code = await fs.readFile(full, "utf8");
          const metadata = parseScriptMetadata(code, path.parse(filename).name);
          await mcp.callTool("save_script_to_library", {
            title: metadata.name || path.parse(filename).name,
            description: metadata.description,
            code,
          }).catch(() => {});
        }
      } catch {} // bridge offline or not installed — renderer still gets the change ping
    }
    if (broadcast) broadcast("local-scripts-changed");
  };

  const debounced = (filename) => {
    const prev = pending.get(filename);
    if (prev) clearTimeout(prev);
    pending.set(
      filename,
      setTimeout(() => {
        pending.delete(filename);
        handleChange(filename);
      }, 300),
    );
  };

  try {
    const watcher = fs.watch(SCRIPTS_DIR);
    for await (const { filename } of watcher) {
      debounced(filename);
    }
  } catch (err) {
    console.warn("watch mode error:", err.message);
  }
}

module.exports = {
  init,
  setBroadcast,
  get DATA_DIR() { return DATA_DIR; },
  getConfig,
  saveConfig,
  listLocalScripts,
  deleteLocalScript,
  renameLocalScript,
  readLocalScript,
  saveLocalScript,
  getLocalScriptCode,
  inspectScriptText,
  addScript,
  getFavorites,
  toggleFavorite,
  getRepos,
  addRepo,
  removeRepo,
  getSidebarCollapsed,
  setSidebarCollapsed,
  startWatcher,
  // Shared helpers / guards (single copy, used by server routes + lib/community).
  DEFAULT_REPO,
  assertLocalScriptFilename,
  localScriptFilenameFromInput,
  parseScriptMetadata,
  upsertMetadataHeader,
};
