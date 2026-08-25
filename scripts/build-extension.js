// Bundles the extension host into a single CommonJS file so it has no runtime
// dependency on node_modules (which is excluded from the .vsix) for anything
// that CAN be bundled. Everything the host imports — gray-matter, etc. — is
// compiled in. `vscode` is external since it's provided by the VS Code
// runtime, never npm.
//
// node-llama-cpp is ALSO external, and must stay that way — not just because
// it ships native .node addons (which esbuild can never bundle), but because
// its own compiled JS uses top-level `await` in a genuine ES module
// (confirmed 2026-08-25: node_modules/node-llama-cpp/dist/bindings/utils/
// binariesGithubRelease.js). esbuild refuses to bundle that into this file's
// "cjs" output format — CJS module semantics can't support top-level await,
// since a require()'d file has to finish running synchronously. Switching
// this whole bundle to ESM output would fix that, but is a much bigger,
// riskier change (VS Code's extension host, the "main" field, activate/
// deactivate export shape) than this warrants.
//
// A brief attempt (2026-08-25) tried bundling node-llama-cpp normally and
// only externalizing its native @node-llama-cpp/*, @reflink/* leaf packages
// — that's what hit the top-level-await error above. Reverted.
//
// Since node-llama-cpp stays external, it ships as real node_modules content
// in the .vsix, which means EVERY pure-JS package in its runtime dependency
// closure (lifecycle-utils, confirmed 2026-08-25; likely others) must be
// individually un-ignored in .vscodeignore too — see that file's own comment
// for the discovery approach (a recursive dependency walk, not one broken
// install at a time).

const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "dist-extension", "extension");

// Clean any previous output (e.g. the old per-file tsc build) so the package
// ships only the single bundled file.
fs.rmSync(path.join(ROOT, "dist-extension"), { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const options = {
  entryPoints: [path.join(ROOT, "src", "extension", "extension.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: path.join(OUT_DIR, "extension.js"),
  // node-llama-cpp stays external as a whole package — see the file header
  // comment above for why (top-level await, not just native binaries).
  external: ["vscode", "node-llama-cpp"],
  sourcemap: true,
  logLevel: "info",
};

const watch = process.argv.includes("--watch");

if (watch) {
  esbuild
    .context(options)
    .then((ctx) => ctx.watch())
    .then(() => console.log("[build-extension] watching…"));
} else {
  esbuild.build(options).catch(() => process.exit(1));
}
