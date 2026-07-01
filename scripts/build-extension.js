// Bundles the extension host into a single CommonJS file so it has no runtime
// dependency on node_modules (which is excluded from the .vsix). Everything
// the host imports — gray-matter, etc. — is compiled in. `vscode` is the only
// external, since it's provided by the VS Code runtime, not npm.

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
  external: ["vscode"],
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
