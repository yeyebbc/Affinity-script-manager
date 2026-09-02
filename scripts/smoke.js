// Boot the server on a throwaway port + data dir, assert the endpoint surface, exit 0/1.
const path = require("node:path");
const fs = require("node:fs/promises");
const net = require("node:net");
const { spawn } = require("node:child_process");

const repoRoot = path.join(__dirname, "..");
const pkg = require(path.join(repoRoot, "package.json"));

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function fail(msg) {
  console.error(`smoke: FAIL — ${msg}`);
  process.exit(1);
}

(async () => {
  const port = await freePort();
  const tmpDir = await fs.mkdtemp(path.join(require("node:os").tmpdir(), "asm-smoke-"));

  const child = spawn(process.execPath, ["server.js"], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", ASM_DATA_DIR: tmpDir },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverLog = "";
  child.stdout.on("data", (d) => (serverLog += d));
  child.stderr.on("data", (d) => (serverLog += d));

  const base = `http://127.0.0.1:${port}`;

  const getJson = async (url, opts) => {
    const res = await fetch(url, opts);
    return { res, body: await res.json() };
  };

  try {
    // --- wait for boot (poll /api/meta) ---
    const deadline = Date.now() + 10000;
    let meta = null;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${base}/api/meta`);
        if (res.ok) {
          meta = await res.json();
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!meta) fail(`server did not boot. Log: ${serverLog}`);
    if (meta.success !== true) fail(`meta.success !== true (${JSON.stringify(meta)})`);
    if (meta.data.version !== pkg.version)
      fail(`meta.data.version !== ${pkg.version} (got ${meta.data.version})`);

    // --- local scripts: empty initially ---
    const scripts0 = await getJson(`${base}/api/scripts`);
    if (!scripts0.body.success || !Array.isArray(scripts0.body.data))
      fail("GET /api/scripts → success:true with data array expected");
    if (scripts0.body.data.length !== 0) fail("GET /api/scripts initially not empty");

    // --- index.html includes the shim script tag ---
    const index = await fetch(`${base}/`);
    if (!index.ok) fail("GET / not 200");
    if (!(await index.text()).includes('src="api-shim.js"'))
      fail('index.html does not include src="api-shim.js"');

    // --- SSE headers ---
    const sse = await fetch(`${base}/api/events`);
    const sseType = sse.headers.get("content-type") || "";
    if (!sseType.includes("text/event-stream"))
      fail(`GET /api/events content-type ${sseType} — expected text/event-stream`);
    await sse.body.cancel();

    // --- community registry (internet required) ---
    const comm = await getJson(`${base}/api/community`);
    if (!comm.body.success || !Array.isArray(comm.body.data))
      fail(`GET /api/community → ${JSON.stringify(comm.body).slice(0, 200)}`);

    // --- add a script (push to bridge is best-effort; offline → pushError acceptable) ---
    const add = await getJson(`${base}/api/scripts/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-ASM": "1" },
      body: JSON.stringify({
        title: "Smoke Test",
        description: "",
        code: "/**\n * name: Smoke Test\n */\nconsole.log(1);",
      }),
    });
    if (!add.body.success) fail(`POST /api/scripts/add → ${JSON.stringify(add.body)}`);

    // --- one script now ---
    const scripts1 = await getJson(`${base}/api/scripts`);
    if (scripts1.body.data.length !== 1) fail("GET /api/scripts after add → length !== 1");

    // --- CSRF: no X-ASM header → 403 ---
    const csrf = await fetch(`${base}/api/scripts/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Bad", description: "", code: "" }),
    });
    if (csrf.status !== 403)
      fail(`POST /api/scripts/add without X-ASM → HTTP ${csrf.status}, expected 403`);

    console.log("smoke: PASS");
    process.exitCode = 0;
  } catch (err) {
    fail(`unexpected error: ${err.message}`);
  } finally {
    child.kill();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
})();
