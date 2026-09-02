const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
const { CallToolResultSchema } = require("@modelcontextprotocol/sdk/types.js");
// Client implements the MCP request protocol while transport owns the wire connection.
// SSEClientTransport matches the loopback bridge exposed by Affinity.
// CallToolResultSchema validates tool responses at the SDK boundary.
// Schema validation prevents malformed bridge data from silently reaching route handlers.
// This module presents one callTool API so callers never manage MCP sessions directly.

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

// Module-level connection state is shared by every HTTP request in the process.
// activeBridgeUrl remembers the successful address to make reconnects faster.
// mcpConnected describes protocol readiness, not merely the existence of an object.
// mcpConnectPromise acts as a single-flight guard for concurrent connection attempts.
// Text helpers normalize MCP content arrays into renderer-friendly values.
// Keeping normalization here avoids repeated content-shape checks in server routes.
// Empty content intentionally becomes an empty string rather than undefined.
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

// Recoverable errors describe a dead session rather than an invalid tool request.
// The error matcher is conservative so ordinary tool failures are not retried.
// ensureMcpConnected returns immediately while a healthy session remains available.
// Concurrent callers await the same promise instead of opening competing sessions.
// The previous transport is closed before any reconnect attempt.
// A new Client is created per attempt because failed clients may retain invalid state.
// Candidate URLs handle operating-system differences in localhost resolution.
// Failed candidates clear client and transport references before the next attempt.
// The first successful URL is moved to the front of future reconnect attempts.
// Reading the preamble primes Affinity documentation tools for the new session.
// Preamble failure is logged but does not invalidate otherwise working script tools.
// finally clears the single-flight promise after both success and failure.
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

// callTool connects lazily so the web UI can start while Affinity is offline.
// Tool arguments are nested under the protocol's arguments field.
// Response schema validation occurs on both the first request and retry.
// A recoverable session failure triggers exactly one reconnect and one retry.
// Limiting retries prevents persistent bridge failures from creating request loops.
// Non-session errors preserve their original message for the UI.
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

// Documentation listing may report an application error inside successful MCP content.
// CSV parsing supports bridge responses split across several text content items.
// Preamble is an initialization marker and is not shown as a user-facing topic.
// Individual topic failures are skipped so one bad topic does not discard the rest.
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

// Exports expose connection operations and pure content helpers as one bridge boundary.
// Internal client state remains private so no caller can bypass reconnect logic.
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
