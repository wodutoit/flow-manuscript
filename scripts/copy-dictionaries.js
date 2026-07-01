// Copies the Hunspell .aff/.dic files out of the dictionary npm packages into
// a bundled `dictionaries/<pkg>/` folder so they ship inside the packaged
// .vsix. The runtime loader reads from there first, falling back to
// node_modules when running from source.
//
// Run automatically as part of `npm run build` (and vscode:prepublish).

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PACKAGES = ["dictionary-en", "dictionary-en-gb"];
const FILES = ["index.aff", "index.dic"];

function main() {
  for (const pkg of PACKAGES) {
    const srcDir = path.join(ROOT, "node_modules", pkg);
    const destDir = path.join(ROOT, "dictionaries", pkg);

    if (!fs.existsSync(srcDir)) {
      console.error(
        `[copy-dictionaries] source package not found: ${srcDir}\n` +
          `  Did you run "npm install"?`
      );
      process.exitCode = 1;
      return;
    }

    fs.mkdirSync(destDir, { recursive: true });

    for (const file of FILES) {
      const src = path.join(srcDir, file);
      const dest = path.join(destDir, file);
      if (!fs.existsSync(src)) {
        console.error(`[copy-dictionaries] missing ${src}`);
        process.exitCode = 1;
        return;
      }
      fs.copyFileSync(src, dest);
      console.log(`[copy-dictionaries] ${pkg}/${file}`);
    }
  }
  console.log("[copy-dictionaries] done.");
}

main();
