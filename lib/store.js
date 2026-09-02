const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const mcp = require("./mcp");
// This module is the only owner of persistent application state.
// os provides a portable home directory for Windows and macOS.
// path joins segments with platform-correct separators.
// Promise-based filesystem APIs keep disk operations off the main call stack.
// MCP is used only for optional synchronization after local persistence succeeds.
// Keeping persistence here prevents HTTP route code from constructing data paths.

const DEFAULT_REPO =
  "https://raw.githubusercontent.com/JiriKrblich/Affinity-Community-Scripts/refs/heads/main/registry.json";

let DATA_DIR;
let SCRIPTS_DIR;
let CONFIG_PATH;
let broadcast = null;
let configQueue = Promise.resolve();

// DATA_DIR is selected once during initialization and then treated as process state.
// SCRIPTS_DIR and CONFIG_PATH are derived values, not user-controlled paths.
// broadcast is injected by the server so this module remains transport-agnostic.
// configQueue serializes all configuration reads and writes across browser tabs.
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
// A promise chain is a lightweight mutex for asynchronous JavaScript operations.
// Each operation starts only after the previous queue entry settles.
// Passing operation to both then branches lets the queue recover after a failure.
// result is returned separately so the caller still observes its own rejection.
// The queue tail converts success or failure to undefined before the next operation.
// Serialization covers the full read-modify-write transaction, not only writeFile.
// This avoids lost updates when two tabs mutate different config fields together.
// A process-local queue is sufficient because the server is intentionally single-process.
function runConfigTransaction(operation) {
  const result = configQueue.then(operation, operation);
  configQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// loadConfig reads and normalizes data but does not acquire the transaction lock itself.
// Separating load from locking allows updateConfig to compose both under one lock.
// Missing or malformed config starts from an empty object and restores defaults.
// needsSave records whether normalization changed the on-disk representation.
// The default repository is always first and cannot be permanently removed.
// Array checks reject structurally invalid JSON values before methods such as includes run.
// Favorite migration removes the .js suffix so local and community keys can match.
// Set removes duplicate migrated favorites while preserving their first-seen order.
// Legacy favorite fields are deleted only after their useful values have been migrated.
// sidebarCollapsed receives an explicit boolean default for predictable rendering.
async function loadConfig() {
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

  return { config, needsSave };
}

function writeConfig(config) {
  return fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

// getConfig locks the read so it cannot observe another transaction halfway through.
// Normalized defaults are written only when the loaded document required repair.
// saveConfig snapshots JSON before queuing so later object mutation cannot alter the write.
// updateConfig loads, mutates, and writes while holding one queue position.
// The mutator may return route data after the durable write completes.
// Small config files make serialized whole-document writes simple and appropriate.
function getConfig() {
  return runConfigTransaction(async () => {
    const { config, needsSave } = await loadConfig();
    if (needsSave) await writeConfig(config);
    return config;
  });
}

function saveConfig(config) {
  const snapshot = JSON.stringify(config, null, 2);
  return runConfigTransaction(() => fs.writeFile(CONFIG_PATH, snapshot, "utf8"));
}

function updateConfig(mutator) {
  return runConfigTransaction(async () => {
    const { config } = await loadConfig();
    const result = await mutator(config);
    await writeConfig(config);
    return result;
  });
}

// Filename validation is a security boundary, not only input cleanup.
// path.basename rejects both parent traversal and nested path segments.
// Requiring .js limits managed files to the application's script contract.
// Validation happens before joining a filename with SCRIPTS_DIR.
// localScriptFilenameFromInput converts display names into portable filenames.
// Removing a trailing .js prevents accidental names such as example-js.js.
// The allowed character set avoids platform-specific reserved punctuation.
// Trimming generated dashes makes invalid all-punctuation input detectable.
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

// Script metadata lives in an optional leading documentation comment.
// readMetadataField accepts either starred or plain lines inside that header.
// Case-insensitive matching preserves compatibility with existing community scripts.
// parseScriptMetadata always returns a complete object with empty fallback fields.
// Limiting parsing to the first documentation block avoids matching code examples later.
// fallbackName keeps scripts usable even when no metadata header exists.
// metadataValue collapses line breaks because header fields are one logical line.
// upsertMetadataHeader preserves source code while adding or replacing known fields.
// Only non-empty metadata fields are written, so missing values do not erase source text.
// A new header is prepended only when useful metadata exists.
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

// Local script listing reads directory entries before inspecting each file.
// Only .js entries participate in the managed library.
// stat supplies byte size and modification time without reading file contents twice.
// Reading only the first 4096 characters bounds metadata work for large scripts.
// A metadata read failure falls back to the filename instead of failing the whole list.
// CRUD functions return IPC-shaped results so routes can forward them unchanged.
// getLocalScriptCode throws because download routes need to select JSON or byte responses.
// All local operations remain relative to the initialized scripts directory.
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

// Rename validates both the stored filename and the requested replacement.
// The no-op branch avoids filesystem work when normalization produces the same name.
// The existence check returns a domain-specific conflict message before fs.rename.
// Broadcasting after rename lets every open tab refresh its local list.
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

// Add Script treats the local write as the authoritative operation.
// The normalized title becomes both metadata and a safe local filename.
// MCP installation is best-effort so offline Affinity never loses the local script.
// pushed and pushError let the renderer distinguish partial success from total failure.
// "Add Script" — saves to disk and auto-installs into Affinity via the bridge.
// The local save is authoritative; pushing to the bridge is best-effort so an
// offline bridge still saves the file (reported via `pushed`/`pushError`).
async function addScript(title, description, code) {
  try {
    const normalizedTitle = String(title || "").trim();
    const safeFilename = localScriptFilenameFromInput(normalizedTitle);
    const codeWithMetadata = upsertMetadataHeader(code, {
      name: normalizedTitle,
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
        title: normalizedTitle,
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

// Favorites use lowercase filename stems as stable cross-screen identifiers.
// toggleFavorite runs inside updateConfig so simultaneous settings changes survive.
// The returned favorite array reflects the state that was durably written.
// Repository reads share the same transaction queue as repository mutations.
// Sidebar state is persisted centrally instead of relying only on browser localStorage.
// Boolean conversion ensures the config schema remains stable across callers.
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
    return await updateConfig((config) => {
      const index = config.favoriteScripts.indexOf(key);
      if (index >= 0) config.favoriteScripts.splice(index, 1);
      else config.favoriteScripts.push(key);
      return { success: true, data: config.favoriteScripts };
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function getRepos() {
  const config = await getConfig();
  return { success: true, data: config.repositories };
}

// GitHub repository pages are converted to raw registry.json URLs for direct fetching.
// The regular expression captures only owner and repository path components.
// Duplicate repositories are harmless no-ops and do not trigger an SSE refresh.
// addRepo broadcasts only after updateConfig has completed its disk write.
// The default repository guard runs before opening a write transaction.
// removeRepo preserves existing behavior by broadcasting after every allowed request.
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

    let added = false;
    await updateConfig((config) => {
      if (!config.repositories.includes(rawUrl)) {
        config.repositories.push(rawUrl);
        added = true;
      }
    });
    if (added && broadcast) broadcast("repos-changed");
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function removeRepo(url) {
  if (url === DEFAULT_REPO)
    return { success: false, error: "Cannot remove default repository." };
  try {
    await updateConfig((config) => {
      config.repositories = config.repositories.filter((r) => r !== url);
    });
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
    return await updateConfig((config) => {
      config.sidebarCollapsed = Boolean(collapsed);
      return { success: true, data: config.sidebarCollapsed };
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// fs.watch provides low-cost notifications instead of repeatedly scanning the directory.
// The per-filename timer coalesces editor save bursts into one synchronization attempt.
// A 300 ms delay balances responsive UI updates with stable completed file writes.
// Deleted files still trigger a list refresh but cannot be pushed to Affinity.
// Existing files are synchronized only when Affinity already lists the same stem.
// This rule prevents newly created local files from being installed without user action.
// MCP listing text is normalized to lowercase for case-insensitive stem comparison.
// Metadata is reread after a disk change so Affinity receives the latest title and description.
// Bridge failures are intentionally isolated from local filesystem notifications.
// broadcast runs even when Affinity is offline, keeping browser tabs consistent.
// The async iterator keeps the watcher alive until the process exits.
// Watcher setup errors are logged because watch mode is useful but not required for startup.
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
