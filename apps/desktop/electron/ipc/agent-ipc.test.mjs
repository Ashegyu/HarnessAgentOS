import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const readSource = (file) => readFileSync(join(__dirname, file), "utf8");

test("agent IPC preserves pinned observation outcome metadata", () => {
  const source = readSource("agent-ipc.ts");

  assert.match(source, /outcome: \{/);
  assert.match(source, /reuseRisk/);
  assert.match(source, /scoreAdjustment/);
  assert.match(source, /failedCount/);
  assert.match(source, /lastOutcomeSource/);
  assert.match(source, /runnerOutcomeCount/);
  assert.match(source, /pinnedObservationContexts summary is too long/);
});
