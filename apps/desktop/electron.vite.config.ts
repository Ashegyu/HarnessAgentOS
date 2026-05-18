import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/**
 * Workspace packages publish their source as `./src/index.ts` (no build step
 * for shared types). They MUST be bundled into main/preload, otherwise Node
 * sees `.ts` files at runtime and refuses to load them. Renderer is bundled
 * by Vite which handles TS natively, so this only matters for main/preload.
 */
const HARNESS_WORKSPACE_PACKAGES = [
  "@harness/agent",
  "@harness/core",
  "@harness/evals",
  "@harness/storage",
  "@harness/runners",
  "@harness/quality",
  "@harness/skillify-adapter",
  "@harness/learner",
  "@harness/orchestration",
];

const harnessAliases = Object.fromEntries(
  HARNESS_WORKSPACE_PACKAGES.map((pkg) => [
    pkg,
    resolve(
      __dirname,
      `../../packages/${pkg.replace("@harness/", "")}/src/index.ts`,
    ),
  ]),
);

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({ exclude: HARNESS_WORKSPACE_PACKAGES }),
    ],
    build: {
      outDir: "out/main",
      rollupOptions: {
        input: { main: resolve(__dirname, "electron/main.ts") },
        output: { entryFileNames: "[name].js" },
      },
    },
    resolve: { alias: harnessAliases },
  },
  preload: {
    plugins: [
      externalizeDepsPlugin({ exclude: HARNESS_WORKSPACE_PACKAGES }),
    ],
    build: {
      outDir: "out/preload",
      rollupOptions: {
        input: { preload: resolve(__dirname, "electron/preload.ts") },
        output: {
          entryFileNames: "[name].cjs",
          format: "cjs",
        },
      },
    },
    resolve: { alias: harnessAliases },
  },
  renderer: {
    root: resolve(__dirname, "."),
    plugins: [react()],
    // Renderer assets are loaded via file:// at runtime (no dev server).
    // base must be relative so HTML asset paths resolve from disk.
    base: "./",
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: { index: resolve(__dirname, "index.html") },
      },
    },
    resolve: { alias: harnessAliases },
  },
});
