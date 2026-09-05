import { defineConfig } from "tsdown";

export default defineConfig([
  // the extension itself, running in the node extension host
  {
    entry: "src/index.ts",
    platform: "node",
    outDir: "lib",
    format: "esm",
    minify: false,
    deps: {
      neverBundle: ["vscode"],
    },
    inputOptions: {
      resolve: {
        // Prefer a package's ESM build. A UMD build calls require() at runtime, and those calls
        // survive bundling as broken paths.
        mainFields: ["module", "main"],
      },
    },
    // The regex engine behind TextMate tokenizing. It is read at runtime, not imported.
    copy: [{ from: "node_modules/vscode-oniguruma/release/onig.wasm", to: "lib" }],
  },

  // the page inside the sidebar view
  {
    entry: "webview/main.ts",
    platform: "browser",
    outDir: "lib/webview",
    format: "esm",
    minify: false,
    copy: [
      { from: "webview/style.css", to: "lib/webview" },
      { from: "webview/syntax-panel.css", to: "lib/webview" },
    ],
  },
]);
