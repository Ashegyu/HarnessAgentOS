import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SYSTEM_DIAGNOSTICS_THRESHOLDS,
  SystemDiagnosticsService,
  diagnosticsStatusTone,
} from "./system-diagnostics-service.ts";

const providers = (overrides = {}) => ({
  codex: { available: true, version: "codex 1.0", queueDepth: 0 },
  ...overrides,
});

test("SystemDiagnosticsService marks DB and queue thresholds as warnings", async () => {
  const service = new SystemDiagnosticsService({
    now: () => "2026-05-18T00:00:00.000Z",
    database: {
      getDatabaseDiagnostics: () => ({
        mainBytes: SYSTEM_DIAGNOSTICS_THRESHOLDS.dbWarnBytes + 1,
        walBytes: 0,
        shmBytes: 0,
        totalBytes: SYSTEM_DIAGNOSTICS_THRESHOLDS.dbWarnBytes + 1,
        walCheckpoint: { busy: 0, log: 0, checkpointed: 0 },
      }),
    },
    agentPlanning: {
      getQueueDepths: () => ({
        codex: 6,
        total: SYSTEM_DIAGNOSTICS_THRESHOLDS.queueDepthWarn + 1,
      }),
    },
    runner: { getInflightCount: () => 2 },
    probeProviders: async () => providers(),
  });

  const diagnostics = await service.collect();
  assert.equal(diagnostics.generatedAt, "2026-05-18T00:00:00.000Z");
  assert.equal(diagnostics.db.status, "warning");
  assert.equal(diagnostics.queue.status, "warning");
  assert.equal(diagnostics.providers.status, "ok");
  assert.equal(diagnostics.runner.inflightCount, 2);
  assert.equal(diagnostics.capabilities.status, "ok");
});

test("SystemDiagnosticsService marks providers warning when none are available", async () => {
  const service = new SystemDiagnosticsService({
    database: {
      getDatabaseDiagnostics: () => ({
        mainBytes: 1,
        walBytes: 0,
        shmBytes: 0,
        totalBytes: 1,
        walCheckpoint: { busy: 0, log: 0, checkpointed: 0 },
      }),
    },
    agentPlanning: {
      getQueueDepths: () => ({ codex: 0, total: 0 }),
    },
    runner: { getInflightCount: () => 0 },
    probeProviders: async () =>
      providers({
        codex: { available: false, error: "missing", queueDepth: 0 },
      }),
  });

  const diagnostics = await service.collect();
  assert.equal(diagnostics.providers.status, "warning");
  assert.match(diagnostics.providers.warning ?? "", /Codex CLI/);
});

test("SystemDiagnosticsService exposes capability refresh failures", async () => {
  const service = new SystemDiagnosticsService({
    database: {
      getDatabaseDiagnostics: () => ({
        mainBytes: 1,
        walBytes: 0,
        shmBytes: 0,
        totalBytes: 1,
        walCheckpoint: { busy: 0, log: 0, checkpointed: 0 },
      }),
    },
    agentPlanning: {
      getQueueDepths: () => ({ codex: 0, total: 0 }),
    },
    runner: { getInflightCount: () => 0 },
    capabilities: {
      getLastRefreshAt: () => "2026-05-18T00:00:00.000Z",
      getLastRefreshFailure: () => ({
        failedAt: "2026-05-18T00:01:00.000Z",
        message: "scan failed",
      }),
    },
    probeProviders: async () => providers(),
  });

  const diagnostics = await service.collect();
  assert.equal(diagnostics.capabilities.status, "warning");
  assert.equal(
    diagnostics.capabilities.lastRefreshFailureAt,
    "2026-05-18T00:01:00.000Z",
  );
  assert.match(diagnostics.capabilities.warning ?? "", /scan failed/);
});

test("diagnosticsStatusTone maps status to UI tone", () => {
  assert.equal(diagnosticsStatusTone("ok"), "passed");
  assert.equal(diagnosticsStatusTone("warning"), "warning");
  assert.equal(diagnosticsStatusTone("error"), "failed");
});
