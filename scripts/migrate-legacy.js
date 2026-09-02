// Copy a legacy Electron userData directory into the new web-server data dir.
// Run manually: node scripts/migrate-legacy.js
// Never overwrites existing files; never deletes the source.
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
// The migration is a one-way copy; legacy directories are never modified.
// Both platform locations are checked because a shared data drive may contain either layout.
// ASM_DATA_DIR lets tests and advanced users choose an explicit destination.
// Promise-based filesystem calls keep control flow consistent with the server modules.

const TARGET =
  process.env.ASM_DATA_DIR || path.join(os.homedir(), ".affinity-script-manager");

const SOURCES = [
  // Windows: %APPDATA%\<productName> (Electron uses productName from package.json build block)
  process.env.APPDATA
    ? path.join(process.env.APPDATA, "affinity-script-manager")
    : null,
  // macOS: ~/Library/Application Support/<productName>
  path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "affinity-script-manager",
  ),
].filter(Boolean);

// COPYFILE_EXCL combines existence checking and copying into one atomic filesystem operation.
// This avoids the race created by access followed by an ordinary copy.
// Destination parents are created recursively before the exclusive copy.
// EEXIST is an expected skip while every other I/O error remains fatal.
// Returning a small status value keeps reporting separate from copy mechanics.
async function copyIfMissing(src, dst) {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  try {
    await fs.copyFile(src, dst, constants.COPYFILE_EXCL);
    return "copied";
  } catch (error) {
    if (error.code === "EEXIST") return "skip (exists)";
    throw error;
  }
}

// Directory entries are filtered to regular .js files only.
// Existing targets count as skipped and never change their content.
// Sequential copies keep console output deterministic and simplify failure reporting.
// The caller aggregates counts across every discovered legacy source.
async function copyDir(srcDir, dstDir, label) {
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  let copied = 0;
  let skipped = 0;
  for (const entry of entries.filter((e) => e.isFile() && e.name.endsWith(".js"))) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    const status = await copyIfMissing(src, dst);
    if (status === "copied") {
      copied++;
      console.log(`  [copied → ${label}] ${entry.name}`);
    } else {
      skipped++;
      console.log(`  [skip → ${label}]   ${entry.name}`);
    }
  }
  return { copied, skipped };
}

// Source stat failures ignore only ENOENT because absent platform paths are normal.
// Permission and malformed-path errors propagate to the process-level catch.
// MyScripts and config.json are independently optional within an existing source.
// A source is marked found only after its directory has been verified.
// Summary counts distinguish successful copies from deliberate no-overwrite skips.
// Completion explicitly states that source data was left untouched.
async function main() {
  console.log("Legacy migration — Script Manager for Affinity");
  console.log(`Target: ${TARGET}`);
  const targetMyScripts = path.join(TARGET, "MyScripts");
  const targetConfig = path.join(TARGET, "config.json");

  let totalCopied = 0;
  let totalSkipped = 0;
  let foundAny = false;

  for (const source of SOURCES) {
    let stat;
    try {
      stat = await fs.stat(source);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isDirectory()) continue;
    foundAny = true;
    console.log(`\nSource: ${source}`);

    const scriptsDir = path.join(source, "MyScripts");
    try {
      const scriptsStat = await fs.stat(scriptsDir);
      if (scriptsStat.isDirectory()) {
        const r = await copyDir(scriptsDir, targetMyScripts, "MyScripts");
        totalCopied += r.copied;
        totalSkipped += r.skipped;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const configSrc = path.join(source, "config.json");
    try {
      const status = await copyIfMissing(configSrc, targetConfig);
      if (status === "copied") {
        totalCopied++;
        console.log("  [copied] config.json");
      } else {
        totalSkipped++;
        console.log("  [skip]   config.json");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  if (!foundAny) {
    console.log("\nNo legacy userData directory found — nothing to migrate.");
  } else {
    console.log(
      `\nDone: ${totalCopied} file(s) copied, ${totalSkipped} skipped (already present).`,
    );
  }
  console.log("Source directories were left untouched.");
}

// The final catch is reserved for unexpected I/O failures and returns a nonzero status.
// Using process.exit here is safe because no child process or deferred cleanup exists.
main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
