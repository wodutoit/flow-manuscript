// Deletes node-llama-cpp platform-binary variants this extension doesn't
// need, right before packaging.
//
// Why this exists instead of just excluding them in .vscodeignore: an
// explicit re-ignore rule placed AFTER the un-ignore block (which should
// win per normal gitignore "last matching rule wins" semantics) had ZERO
// effect under @vscode/vsce 2.32.0 — confirmed 2026-08-25 by two
// consecutive `npm run package` runs producing byte-identical output before
// and after adding the re-ignore lines. Whatever vsce's ignore engine is
// doing with negation precedence for a path under an already-un-ignored
// ancestor directory, it isn't standard gitignore behavior, and fighting it
// further in .vscodeignore isn't worth it. Physically removing the
// directories sidesteps the question entirely: a vsix packager can't
// include a folder that isn't on disk, no matter how its ignore-file engine
// resolves precedence.
//
// This must be re-run before every package build, since a fresh
// `npm install` re-creates all optionalDependencies platform variants
// (that's why this is wired into `npm run package`, not left as a one-off
// manual step, and NOT run from `postinstall` — the dev/debug F5 path
// intentionally keeps every variant present in case a different backend
// ever needs local testing).

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// Confirmed unnecessary for this project's actual deployment targets: all
// machines are Windows x64, none with a CUDA GPU (2026-08-25). Update this
// list — and the corresponding REQUIRED checks in verify-vsix-contents.js —
// if that ever changes (e.g. an ARM64 machine joins the fleet).
const UNUSED_VARIANTS = [
  "node_modules/@node-llama-cpp/win-arm64",
  "node_modules/@node-llama-cpp/win-x64-cuda",
  "node_modules/@node-llama-cpp/win-x64-cuda-ext",
];

for (const rel of UNUSED_VARIANTS) {
  const full = path.join(ROOT, rel);
  if (fs.existsSync(full)) {
    fs.rmSync(full, { recursive: true, force: true });
    console.log(`[prune-unused-native-variants] Removed ${rel}`);
  } else {
    console.log(`[prune-unused-native-variants] Already absent: ${rel}`);
  }
}
