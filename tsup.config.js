// tsup.config.js
import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.js"],
    format: ["esm"],
    outDir: "dist",
    clean: true,
    splitting: true,
  },
  {
    entry: ["src/index.js"],
    format: ["esm"],
    outDir: "dist/browser",
    platform: "browser",
    target: "es2020",
    splitting: false,
    minify: true,
    noExternal: ["jszip"],
  },
]);
