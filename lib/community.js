const store = require("./store");
const mcp = require("./mcp");

// DEFAULT_REPO lives in store (config defaults + remove guards); re-exported
// here so the community module owns its constant surface without a require cycle.
const DEFAULT_REPO = store.DEFAULT_REPO;
const COMMUNITY_ISSUES_URL =
  "https://github.com/JiriKrblich/Affinity-Community-Scripts/issues/new";

// GitHub's raw CDN (raw.githubusercontent.com) caches files for ~5 minutes, so a
// freshly pushed registry.json / script can otherwise look stale when the app is
// reopened. Bust the edge cache with a unique query param + no-cache headers so we
// always pull the latest. Callers keep the clean URL for anything else (asset
// resolution, _source), passing it here only at the fetch call site.
function fetchFresh(url, options = {}) {
  const sep = url.includes("?") ? "&" : "?";
  const bustedUrl = `${url}${sep}_cb=${Date.now()}`;
  return fetch(bustedUrl, {
    cache: "no-store",
    ...options,
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      ...(options.headers || {}),
    },
  });
}

// Build a GitHub "new issue" URL whose body mirrors the community repo's
// contribute-script template fields (Script Name / Author / Description /
// Preview image / Version / Code), pre-filled from the script's metadata.
function shareIssuePayload(code, nameHint) {
  const meta = store.parseScriptMetadata(code, nameHint);
  const name = meta.name || nameHint;
  const title = `New script: ${name}`;
  const body =
    `**Script Name:** ${name}\n\n` +
    `**Author:** ${meta.author || ""}\n\n` +
    `**Contact:** _(your email, website, …)_\n\n` +
    `**Description:** ${meta.description || ""}\n\n` +
    `**Preview image:** _(drag and drop a 16:9 preview image here)_\n\n` +
    `**Version:** ${meta.version || ""}\n\n` +
    "**Code:**\n\n```js\n" +
    code +
    "\n```\n";
  const baseUrl = `${COMMUNITY_ISSUES_URL}?title=${encodeURIComponent(title)}`;
  const url = `${baseUrl}&body=${encodeURIComponent(body)}`;
  return { url, baseUrl, body, tooLong: url.length > 7000 };
}

function resolveCommunityAssetUrl(registryUrl, assetUrl) {
  if (!assetUrl) return "";
  try {
    return new URL(assetUrl, registryUrl).toString();
  } catch {
    return assetUrl;
  }
}

// Resolve a file sitting next to registry.json in the same repo folder, e.g.
// ".../main/registry.json" + "featured.json" -> ".../main/featured.json".
function deriveRepoFileUrl(registryUrl, filename) {
  try {
    return new URL(filename, registryUrl).toString();
  } catch {
    return "";
  }
}

// Normalize the many shapes a featured.json may take into a Set of script ids:
//   ["id1", "id2"]
//   { "featured": ["id1", "id2"] }
//   { "featured": [{ "id": "id1" }, ...] }
function parseFeaturedIds(data) {
  const list = Array.isArray(data)
    ? data
    : data && Array.isArray(data.featured)
      ? data.featured
      : [];
  const ids = new Set();
  for (const entry of list) {
    if (typeof entry === "string") {
      ids.add(entry.trim());
    } else if (entry && typeof entry === "object" && entry.id) {
      ids.add(String(entry.id).trim());
    }
  }
  ids.delete("");
  return ids;
}

// Best-effort fetch of a repo's featured.json. Missing/invalid file is not an
// error — featured is an optional, additive layer on top of registry.json.
async function fetchFeaturedIds(registryUrl) {
  const featuredUrl = deriveRepoFileUrl(registryUrl, "featured.json");
  if (!featuredUrl) return new Set();
  try {
    const res = await fetchFresh(featuredUrl);
    if (!res.ok) return new Set();
    return parseFeaturedIds(await res.json());
  } catch {
    return new Set();
  }
}

async function listCommunityScripts(repositories) {
  try {
    let allScripts = [];
    let communityOrder = 0;
    // Per-repo failures, distinguished by cause so the UI can explain *why*:
    //   unreachable  — network/DNS/connection error (fetch threw)
    //   unavailable  — reached the server but got a non-OK HTTP status (e.g. 404)
    //   invalid-json — downloaded but the body is not valid JSON (bad syntax)
    const repoErrors = [];

    for (const url of repositories) {
      const isDefault = url === DEFAULT_REPO;

      let response;
      try {
        response = await fetchFresh(url);
      } catch (err) {
        repoErrors.push({
          url,
          isDefault,
          reason: "unreachable",
          detail: err && err.message ? err.message : String(err),
        });
        continue;
      }

      if (!response.ok) {
        repoErrors.push({
          url,
          isDefault,
          reason: "unavailable",
          detail: `HTTP ${response.status}${response.statusText ? " " + response.statusText : ""}`,
        });
        continue;
      }

      let registry;
      try {
        registry = await response.json();
      } catch (err) {
        repoErrors.push({
          url,
          isDefault,
          reason: "invalid-json",
          detail: err && err.message ? err.message : String(err),
        });
        continue;
      }

      // Featured is an optional sibling file; fetch it in parallel-safe,
      // non-fatal fashion so a repo without featured.json still works.
      const featuredIds = await fetchFeaturedIds(url);
      const scriptsWithSource = (registry.scripts || []).map((script) => ({
        ...script,
        _source: url,
        _featured: featuredIds.has(script.id),
        _imageUrl: resolveCommunityAssetUrl(
          url,
          script.image ||
            script.image_url ||
            script.preview_image ||
            script.screenshot,
        ),
        _communityOrder: communityOrder++,
      }));
      allScripts = allScripts.concat(scriptsWithSource);
    }
    return { success: true, data: allScripts, errors: repoErrors };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function downloadCommunityScript(downloadUrl, filename, metadata = {}) {
  try {
    const response = await fetchFresh(downloadUrl);
    if (!response.ok) throw new Error("Error downloading file from server.");
    const code = await response.text();
    const downloadedMetadata = store.parseScriptMetadata(code, filename);
    const finalMetadata = {
      ...downloadedMetadata,
      name: metadata.name || filename,
      description: metadata.description || downloadedMetadata.description,
      version: metadata.version || downloadedMetadata.version,
      author: metadata.author || downloadedMetadata.author,
    };
    const codeWithMetadata = store.upsertMetadataHeader(code, finalMetadata);
    const safeName =
      filename.toLowerCase().replace(/[^a-z0-9_-]/g, "-") + ".js";

    await store.saveLocalScript(safeName, codeWithMetadata);

    try {
      await mcp.callTool("save_script_to_library", {
        title: finalMetadata.name || filename,
        description: finalMetadata.description,
        code: codeWithMetadata,
      });
    } catch (mcpErr) {}

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Save-only: download to disk without pushing to the MCP bridge. Used by the "save" icon
// next to Install on community cards, for users who want to inspect / edit before activating.
async function saveCommunityScript(downloadUrl, filename, metadata = {}) {
  try {
    const response = await fetchFresh(downloadUrl);
    if (!response.ok) throw new Error("Error downloading file from server.");
    const code = await response.text();
    const downloadedMetadata = store.parseScriptMetadata(code, filename);
    const finalMetadata = {
      ...downloadedMetadata,
      name: metadata.name || filename,
      description: metadata.description || downloadedMetadata.description,
      version: metadata.version || downloadedMetadata.version,
      author: metadata.author || downloadedMetadata.author,
    };
    const codeWithMetadata = store.upsertMetadataHeader(code, finalMetadata);
    const safeName =
      filename.toLowerCase().replace(/[^a-z0-9_-]/g, "-") + ".js";
    await store.saveLocalScript(safeName, codeWithMetadata);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  DEFAULT_REPO,
  COMMUNITY_ISSUES_URL,
  fetchFresh,
  listCommunityScripts,
  saveCommunityScript,
  downloadCommunityScript,
  shareIssuePayload,
};
