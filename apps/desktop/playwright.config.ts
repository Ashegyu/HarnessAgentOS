import { defineConfig } from "@playwright/test";

/**
 * Electron smoke harness. The tests launch the already-built bundle in
 * `out/`, so `npm run build` must complete before `npm run e2e` (the
 * pretest hook handles that).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: "list",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    trace: "retain-on-failure",
  },
});
