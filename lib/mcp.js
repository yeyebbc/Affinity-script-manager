const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
const { CallToolResultSchema } = require("@modelcontextprotocol/sdk/types.js");

// Affinity's MCP bridge listens on loopback only. Windows resolves localhost to
// ::1 or 127.0.0.1 depending on configuration; macOS reported ::1. Try every
// candidate so no per-platform config is needed. If the bridge ever moves to a
// non-default port, this is the single edit point.
const BRIDGE_URLS = [
  "http://localhost:6767/sse",
  "http://[::1]:6767/sse",
  "http://127.0.0.1:6767/sse",
];

let client;
let transport;
let activeBridgeUrl = null;
let mcpConnected = false;
let mcpConnectPromise = null;

function getTextContent(result) {
  return (result.content || [])
    .filter((i) => i && i.type === "text")
    .map((i) => i.text)
    .join("\n");
}

// A render_* tool returns a base64 JPEG — either as an image content item or as
// text. Normalize both to a data: URL the renderer can drop into an <img>.
function getImageDataUrl(result) {
  const items = (result && result.content) || [];
  const img = items.find((i) => i && i.type === "image" && i.data);
  if (img) return `data:${img.mimeType || "image/jpeg"};base64,${img.data}`;
  const text = getTextContent(result).trim();
  if (!text) return "";
  return text.startsWith("data:") ? text : `data:image/jpeg;base64,${text}`;
}

function parseCsvTextContent(result) {
  const textChunks = (result.content || [])
    .filter((i) => i && i.type === "text")
    .map((i) => i.text);
  return [
    ...new Set(
      textChunks
        .join(",")
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean),
    ),
  ];
}

function isRecoverableMcpSessionError(error) {
  const msg = error && error.message ? error.message : String(error);
  return /session not initialized|session not found|not connected|disconnected|closed|http 404/i.test(
    msg,
  );
}

// Establish (or re-establish) the MCP session. Safe to call multiple times — concurrent callers
// share the same in-flight promise. Throws if the bridge is unreachable so callers can surface
// a real error instead of falling through with a stale client.
async function ensureMcpConnected() {
  if (mcpConnected && client && transport) return;
  if (mcpConnectPromise) return mcpConnectPromise;
  mcpConnectPromise = (async () => {
    // Prefer the URL that worked last time; fall back to the full candidate list.
    const urls = activeBridgeUrl
      ? [activeBridgeUrl, ...BRIDGE_URLS.filter((u) => u !== activeBridgeUrl)]
      : BRIDGE_URLS;
    let lastErr = null;
    try {
      for (const url of urls) {
        if (transport) {
          try {
            await transport.close();
          } catch {}
        }
        client = new Client({ name: "script-mgr-ui", version: "1.0.0" });
        const candidate = new SSEClientTransport(new URL(url));
        transport = candidate;
        try {
          await client.connect(candidate);
        } catch (err) {
          lastErr = err;
          transport = null;
          client = null;
          continue;
        }
        activeBridgeUrl = url;
        // Affinity's MCP requires reading the preamble doc once per session before other
        // SDK-doc tools will return real data — otherwise list_sdk_documentation etc. respond
        // with an "ERROR: Listing failed" payload. Prime it best-effort.
        try {
          await client.request(
            {
              method: "tools/call",
              params: {
                name: "read_sdk_documentation_topic",
                arguments: { filename: "preamble" },
              },
            },
            CallToolResultSchema,
          );
        } catch (primeErr) {
          console.warn("[MCP] preamble prime failed:", primeErr.message);
        }
        mcpConnected = true;
        return;
      }
      throw lastErr || new Error(`MCP bridge unreachable (${BRIDGE_URLS.join(", ")})`);
    } catch (err) {
      mcpConnected = false;
      throw err;
    } finally {
      mcpConnectPromise = null;
    }
  })();
  return mcpConnectPromise;
}

async function callTool(name, args) {
  await ensureMcpConnected();
  try {
    return await client.request(
      { method: "tools/call", params: { name, arguments: args } },
      CallToolResultSchema,
    );
  } catch (err) {
    // If the session dropped (bridge restarted, etc.), reconnect once and retry.
    if (isRecoverableMcpSessionError(err)) {
      mcpConnected = false;
      await ensureMcpConnected();
      return client.request(
        { method: "tools/call", params: { name, arguments: args } },
        CallToolResultSchema,
      );
    }
    throw err;
  }
}

async function fetchSdkDocs() {
  try {
    const listResult = await callTool("list_sdk_documentation", {});
    const rawText = getTextContent(listResult).trim();
    // Affinity's tools occasionally return an error message as content with a successful RPC.
    if (!rawText || /^error[:\s]/i.test(rawText)) {
      return {
        success: false,
        error:
          "Affinity did not return a topic list: " +
          (rawText || "empty response"),
      };
    }
    const fileNames = parseCsvTextContent(listResult).filter(
      (n) => n && !/^error/i.test(n) && n !== "preamble",
    ); // preamble is an init marker, not a user-facing topic
    const docs = [];
    for (const fileName of fileNames) {
      try {
        const readResult = await callTool("read_sdk_documentation_topic", {
          filename: fileName,
        });
        const content = getTextContent(readResult);
        // Skip topics whose content is itself an error response.
        if (content && !/^error[:\s]/i.test(content.trim())) {
          docs.push({ title: fileName, content });
        }
      } catch (e) {}
    }
    return { success: true, data: docs };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function searchSdkDocs(query) {
  try {
    const result = await callTool("search_sdk_hints", { prompt: query });
    return {
      success: true,
      data: getTextContent(result) || JSON.stringify(result, null, 2),
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  ensureMcpConnected,
  callTool,
  fetchSdkDocs,
  searchSdkDocs,
  // Helpers needed by server routes and lib/store (single copy, no duplication).
  getTextContent,
  getImageDataUrl,
  parseCsvTextContent,
  isRecoverableMcpSessionError,
};
