// Boot the server on a throwaway port + data dir, assert the endpoint surface, exit 0/1.
const path = require("node:path");
const fs = require("node:fs/promises");
const net = require("node:net");
const { spawn } = require("node:child_process");
// The smoke test uses only Node built-ins and the same installed production dependencies.
// It launches the real server instead of mocking route handlers.
// Temporary ports and data directories isolate runs from the user's application state.
// A single process coordinates setup, assertions, child shutdown, and cleanup.

const repoRoot = path.join(__dirname, "..");
const pkg = require(path.join(repoRoot, "package.json"));

// Binding port zero asks the operating system for an unused local port.
// The temporary listener reserves that port while its number is read.
// Closing before server startup avoids keeping an unrelated socket open.
// A later bind race is theoretically possible but negligible for this local smoke test.
// Promise conversion makes the callback-based net.Server lifecycle awaitable.
// Listener errors reject setup before any child process is created.
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

// Assertion failures throw so the surrounding finally block always runs.
// One failure stops later assertions and preserves the first useful cause.
// The catch block owns user-facing formatting and the final exit code.
// Avoiding process.exit here prevents leaked child processes and temp directories.
function fail(msg) {
  throw new Error(msg);
}

// Child exit can be represented by either exitCode or signalCode.
// waitForExit resolves true when the child stops before the deadline.
// The exit listener is removed on timeout to avoid retaining stale closures.
// Clearing the timer lets a successful smoke test terminate immediately.
// Returning a boolean keeps timeout policy separate from event wiring.
// The helper handles a child that exited before cleanup began.
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

// Graceful termination is attempted before a forced kill.
// Five seconds allows pending HTTP responses and filesystem handles to close.
// SIGKILL is a bounded fallback when the child ignores normal termination.
// A second timeout converts an unrecoverable process leak into a test failure.
// Waiting before directory removal avoids cleanup races on Windows.
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  if (await waitForExit(child, 5000)) return;
  child.kill("SIGKILL");
  if (!(await waitForExit(child, 5000))) {
    throw new Error("server child did not exit");
  }
}

// process.execPath guarantees the child uses the same Node runtime as the test.
// The child working directory matches npm start behavior.
// Environment overrides keep the server on loopback with disposable persistence.
// Captured output is included when startup fails before the meta endpoint responds.
// The base URL is built from the actual temporary port.
// getJson returns both transport status and the parsed IPC body.
// The top-level async function provides structured try/catch/finally control.
// No assertion depends on files from a previous test run.
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
    // Startup polling tests observable readiness rather than assuming a fixed launch delay.
    // The deadline bounds failures caused by syntax errors, port errors, or early process exit.
    // Static, SSE, JSON, download, mutation, and remote-registry paths are all exercised.
    // Bridge installation remains best-effort because Affinity is optional during smoke tests.
    // Assertions check public response contracts rather than implementation details.
    // Each mutation includes the same CSRF header used by api-shim.js.
    // Failed assertions flow to one cleanup path regardless of their location.
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

    const download = await fetch(`${base}/api/scripts/smoke-test.js?download=1`);
    if (
      download.status !== 200 ||
      !(download.headers.get("content-type") || "").includes(
        "application/octet-stream",
      ) ||
      !(await download.text()).includes("console.log(1)")
    ) {
      fail("GET local script download did not return the saved script");
    }

    // --- CSRF: no X-ASM header → 403 ---
    const csrf = await fetch(`${base}/api/scripts/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Bad", description: "", code: "" }),
    });
    if (csrf.status !== 403)
      fail(`POST /api/scripts/add without X-ASM → HTTP ${csrf.status}, expected 403`);

    // --- malformed JSON and empty titles are rejected without creating files ---
    const malformed = await getJson(`${base}/api/scripts/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-ASM": "1" },
      body: "{",
    });
    if (malformed.res.status !== 200 || malformed.body.success)
      fail(`malformed JSON was not rejected in IPC shape: ${JSON.stringify(malformed.body)}`);
    if (malformed.body.error !== "Invalid JSON")
      fail(`malformed JSON error was ${JSON.stringify(malformed.body.error)}`);


    const malformedPath = await getJson(
      `${base}/api/scripts/%E0%A4%A/content`,
    );
    if (malformedPath.res.status !== 200 || malformedPath.body.success)
      fail(`malformed path was not rejected in IPC shape: ${JSON.stringify(malformedPath.body)}`);
    if (malformedPath.body.error !== "Invalid path encoding.")
      fail(`malformed path error was ${JSON.stringify(malformedPath.body.error)}`);
    const emptyTitle = await getJson(`${base}/api/scripts/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-ASM": "1" },
      body: JSON.stringify({ title: "   ", description: "", code: "" }),
    });
    if (emptyTitle.body.success) fail("empty script title was accepted");

    const scriptsAfterRejectedAdds = await getJson(`${base}/api/scripts`);
    if (scriptsAfterRejectedAdds.body.data.length !== 1)
      fail("rejected script add created a file");

    // Concurrent requests target both different fields and repeated collection updates.
    // Eight repository additions make the former lost-update race reliably observable.
    // Final reads verify durable combined state rather than only successful response codes.
    // Fake raw GitHub URLs are stored after community fetching, so no extra network calls occur.
    // --- concurrent config mutations preserve every successful update ---
    const mutationHeaders = {
      "Content-Type": "application/json",
      "X-ASM": "1",
    };
    const [favoriteMutation, sidebarMutation] = await Promise.all([
      getJson(`${base}/api/favorites/concurrent-config`, {
        method: "POST",
        headers: mutationHeaders,
        body: "{}",
      }),
      getJson(`${base}/api/settings/sidebar`, {
        method: "PUT",
        headers: mutationHeaders,
        body: JSON.stringify({ collapsed: true }),
      }),
    ]);
    if (!favoriteMutation.body.success || !sidebarMutation.body.success)
      fail("concurrent favorite/sidebar mutations did not both succeed");

    const [favorites, sidebar] = await Promise.all([
      getJson(`${base}/api/favorites`),
      getJson(`${base}/api/settings/sidebar`),
    ]);
    if (!favorites.body.data.includes("concurrent-config"))
      fail("concurrent favorite mutation was lost");
    if (sidebar.body.data !== true) fail("concurrent sidebar mutation was lost");

    const concurrentRepos = Array.from(
      { length: 8 },
      (_, i) =>
        `https://raw.githubusercontent.com/asm-smoke/concurrent-${i}/refs/heads/main/registry.json`,
    );
    const repoMutations = await Promise.all(
      concurrentRepos.map((url) =>
        getJson(`${base}/api/repos`, {
          method: "POST",
          headers: mutationHeaders,
          body: JSON.stringify({ url }),
        }),
      ),
    );
    if (repoMutations.some(({ body }) => !body.success))
      fail("a concurrent repository mutation failed");

    const repos = await getJson(`${base}/api/repos`);
    const missingRepos = concurrentRepos.filter(
      (url) => !repos.body.data.includes(url),
    );
    if (missingRepos.length)
      fail(`concurrent repository mutations lost ${missingRepos.length} update(s)`);

    // PASS is printed only after every behavioral assertion has completed.
    // process.exitCode allows finally cleanup to finish before Node exits.
    console.log("smoke: PASS");
    process.exitCode = 0;
  } catch (err) {
    console.error(`smoke: FAIL — ${err.message}`);
    process.exitCode = 1;
  } finally {
    try {
      await stopChild(child);
    } catch (err) {
      console.error(`smoke: FAIL — cleanup: ${err.message}`);
      process.exitCode = 1;
    }
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`smoke: FAIL — cleanup: ${err.message}`);
      process.exitCode = 1;
    }
  }
})();
