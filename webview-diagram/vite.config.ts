import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Single-file output: exactly one index.js + one index.css so the webview
// CSP (which whitelists only those two) can load the bundle. No async chunks.
export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname),
  base: "./",
  build: {
    outDir: resolve(__dirname, "../dist-diagram"),
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: "index.js",
        assetFileNames: "index.[ext]",
      },
    },
  },
});
