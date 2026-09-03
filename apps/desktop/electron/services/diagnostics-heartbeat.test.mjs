import { test } from "node:test";
import assert from "node:assert/strict";
import { startDiagnosticsHeartbeat } from "./diagnostics-heartbeat.ts";

test("startDiagnosticsHeartbeat emits and cleans up interval", async () => {
  let callback = null;
  let cleared = false;
  const emitted = [];
  const heartbeat = startDiagnosticsHeartbeat({
    intervalMs: 10,
    collect: async () => ({
      generatedAt: "2026-05-18T00:00:00.000Z",
      thresholds: { dbWarnBytes: 1, queueDepthWarn: 1 },
      db: {
        mainBytes: 0,
        walBytes: 0,
        shmBytes: 0,
        totalBytes: 0,
        walCheckpoint: { busy: 0, log: 0, checkpointed: 0 },
        status: "ok",
      },
      queue: { codex: 0, total: 0, status: "ok" },
      providers: {
        status: "ok",
        items: {
          codex: { available: false, queueDepth: 0 },
        },
      },
      runner: { inflightCount: 0, status: "ok" },
      capabilities: { status: "ok" },
    }),
    emit: (diagnostics) => emitted.push(diagnostics),
    setIntervalFn: (cb) => {
      callback = cb;
      return "timer";
    },
    clearIntervalFn: (timer) => {
      assert.equal(timer, "timer");
      cleared = true;
    },
  });

  assert.equal(typeof callback, "function");
  callback();
  await heartbeat.emitNow();
  assert.equal(emitted.length, 1);
  heartbeat.stop();
  assert.equal(cleared, true);
  await heartbeat.emitNow();
  assert.equal(emitted.length, 1);
});
