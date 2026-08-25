// Standing build-time assertion (wired into `npm run package`) that the
// node-llama-cpp native binaries this extension needs at runtime actually
// made it into the packaged .vsix. Without this, a future dependency bump
// that relocates the binary (a new node-llama-cpp version, a renamed scoped
// package, etc.) would silently ship a broken extension — the .vscodeignore
// un-ignore rules in that file are keyed to exact paths, and paths can move.
//
// .vsix files are ordinary zip archives with everything under a top-level
// "extension/" folder. This extracts to a temp folder using PowerShell's
// Expand-Archive (this project currently targets Windows only — see the
// cross-platform packaging decision in the AI feature plan) and checks that
// every path we expect to ship is actually present.

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// Every path here MUST exist inside the extracted .vsix, or the shipped
// extension will fail at runtime with a confusing "cannot find native
// binding" (or "Cannot find package") error instead of failing the build
// now, loudly, where it's cheap to fix. Keep this list in sync with
// .vscodeignore's un-ignore rules.
//
// node-llama-cpp ships as real node_modules content (not bundled into
// extension.js — see build-extension.js's header comment for why), so its
// own package.json is back in this list. This does NOT yet check every
// pure-JS dependency in its runtime closure (lifecycle-utils and possibly
// others) — only spot-checks node-llama-cpp itself and the native binaries.
// A missing transitive dependency will currently only surface as a runtime
// error in the installed extension, not a build-time failure here.
const REQUIRED = [
  "extension/node_modules/node-llama-cpp/package.json",
  "extension/node_modules/@node-llama-cpp/win-x64/bins/win-x64/llama-addon.node",
  "extension/node_modules/@node-llama-cpp/win-x64-vulkan/bins/win-x64-vulkan/llama-addon.node",
  "extension/node_modules/@reflink/reflink-win32-x64-msvc/reflink.win32-x64-msvc.node",
];

function findLatestVsix() {
  const candidates = fs
    .readdirSync(ROOT)
    .filter((f) => f.endsWith(".vsix"))
    .map((f) => ({ f, mtime: fs.statSync(path.join(ROOT, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) {
    console.error(
      "[verify-vsix-contents] No .vsix file found in the repo root. Run `vsce package` first."
    );
    process.exit(1);
  }
  return path.join(ROOT, candidates[0].f);
}

function extractVsix(vsixPath, destDir) {
  // Expand-Archive refuses to touch a file unless its extension is literally
  // .zip, even though a .vsix is just a zip archive under the hood — so copy
  // it to a same-named .zip in the extraction temp dir first.
  const zipPath = path.join(destDir, "..", path.basename(vsixPath, ".vsix") + ".zip");
  fs.copyFileSync(vsixPath, zipPath);
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`,
      ],
      { stdio: "inherit" }
    );
  } catch (e) {
    console.error(
      "[verify-vsix-contents] Failed to extract the .vsix via PowerShell's Expand-Archive.\n" +
        "If you're running this on a non-Windows machine, swap this step for `unzip` or a JS zip library."
    );
    process.exit(1);
  } finally {
    fs.rmSync(zipPath, { force: true });
  }
}

// Soft sanity ceiling on node_modules/ inside the packaged .vsix. Provisional
// as of 2026-08-25 — node-llama-cpp is back to shipping as real node_modules
// content (~37 MB) on top of the confirmed native-binary total (~140 MB:
// win-x64 ~45 + win-x64-vulkan ~95 + reflink ~0.3), plus its full 91-package
// pure-JS dependency closure (see scripts/generate-native-deps-ignore.js —
// mostly small utility packages like chalk/yargs/semver, but 91 of them
// could plausibly add up to tens of MB). Set generously above the ~180 MB
// known-so-far floor until the real total is confirmed by a clean run;
// tighten it once that figure is in hand. This is a warning, not a failure:
// it flags unexpected bloat without
// blocking the build.
const NODE_MODULES_SIZE_WARNING_MB = 320;

function dirSizeBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

function main() {
  const vsixPath = findLatestVsix();
  console.log(`[verify-vsix-contents] Checking ${path.basename(vsixPath)}...`);

  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-vsix-check-"));
  try {
    extractVsix(vsixPath, extractDir);

    let ok = true;
    for (const rel of REQUIRED) {
      const full = path.join(extractDir, ...rel.split("/"));
      const exists = fs.existsSync(full);
      console.log(`  ${exists ? "OK     " : "MISSING"}  ${rel}`);
      if (!exists) ok = false;
    }

    let overSizeWarning = false;
    const nodeModulesDir = path.join(extractDir, "extension", "node_modules");
    if (fs.existsSync(nodeModulesDir)) {
      const sizeMB = dirSizeBytes(nodeModulesDir) / (1024 * 1024);
      console.log(`\n  node_modules/ inside the .vsix: ${sizeMB.toFixed(1)} MB total`);

      // Always show the per-top-level-package breakdown (not just on the
      // warning) — this is what actually pinpoints which dependency is
      // heavy, instead of leaving that as a separate manual step.
      const entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
      const rows = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const full = path.join(nodeModulesDir, entry.name);
        if (entry.name.startsWith("@")) {
          // Scoped packages: break down one level further (e.g. @node-llama-cpp/win-x64).
          for (const sub of fs.readdirSync(full, { withFileTypes: true })) {
            if (!sub.isDirectory()) continue;
            const subFull = path.join(full, sub.name);
            rows.push({
              name: `${entry.name}/${sub.name}`,
              mb: dirSizeBytes(subFull) / (1024 * 1024),
            });
          }
        } else {
          rows.push({ name: entry.name, mb: dirSizeBytes(full) / (1024 * 1024) });
        }
      }
      rows.sort((a, b) => b.mb - a.mb);
      console.log("  Breakdown by package:");
      for (const row of rows) {
        console.log(`    ${row.mb.toFixed(1).padStart(8)} MB  ${row.name}`);
      }

      if (sizeMB > NODE_MODULES_SIZE_WARNING_MB) {
        overSizeWarning = true;
        console.warn(
          `\n  WARNING: node_modules/ is larger than the ${NODE_MODULES_SIZE_WARNING_MB} MB sanity ceiling — ` +
            `see the breakdown above for which package is heavy. A .vscodeignore un-ignore rule is ` +
            `probably letting through more than the runtime files that package actually needs ` +
            `(e.g. extra prebuilt binary variants, or a vendored source/build folder inside a ` +
            `dependency's own package directory).`
        );
      }
    }

    if (!ok) {
      console.error(
        "\n[verify-vsix-contents] FAILED — one or more required native files are missing from the .vsix.\n" +
          "Check .vscodeignore's un-ignore rules against the current node_modules layout (paths can shift on a dependency bump)."
      );
      process.exit(1);
    }

    console.log("\n[verify-vsix-contents] OK — all required native files are present in the .vsix.");

    if (overSizeWarning) {
      // Leave the extraction around so the breakdown above can be inspected
      // directly on disk instead of re-running and re-extracting again.
      console.log(`\n  Extracted .vsix contents left at: ${extractDir}`);
      console.log("  (delete this folder manually once you're done inspecting it)");
    } else {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  } catch (e) {
    // Any unexpected failure: still clean up the temp extraction, then
    // re-throw so the script exits non-zero and the real error is visible.
    fs.rmSync(extractDir, { recursive: true, force: true });
    throw e;
  }
}

main();
