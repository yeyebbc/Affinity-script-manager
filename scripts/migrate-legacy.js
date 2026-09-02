// Copy a legacy Electron userData directory into the new web-server data dir.
// Run manually: node scripts/migrate-legacy.js
// Never overwrites existing files; never deletes the source.
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");

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

async function copyIfMissing(src, dst) {
  try {
    await fs.access(dst);
    return "skip (exists)";
  } catch {}
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(src, dst);
  return "copied";
}

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

async function main() {
  console.log("Legacy migration — Script Manager for Affinity");
  console.log(`Target: ${TARGET}`);
  const targetMyScripts = path.join(TARGET, "MyScripts");
  const targetConfig = path.join(TARGET, "config.json");

  let totalCopied = 0;
  let totalSkipped = 0;
  let foundAny = false;

  for (const source of SOURCES) {
    try {
      const stat = await fs.stat(source);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    foundAny = true;
    console.log(`\nSource: ${source}`);

    const scriptsDir = path.join(source, "MyScripts");
    try {
      const stat = await fs.stat(scriptsDir);
      if (stat.isDirectory()) {
        const r = await copyDir(scriptsDir, targetMyScripts, "MyScripts");
        totalCopied += r.copied;
        totalSkipped += r.skipped;
      }
    } catch {}

    const configSrc = path.join(source, "config.json");
    try {
      const status = await copyIfMissing(configSrc, targetConfig, null);
      if (status === "copied") {
        totalCopied++;
        console.log("  [copied] config.json");
      } else {
        totalSkipped++;
        console.log("  [skip]   config.json");
      }
    } catch {}
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

main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
