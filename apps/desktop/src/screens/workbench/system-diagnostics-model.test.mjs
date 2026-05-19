import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diagnosticsHasWarnings,
  diagnosticsTone,
  formatDiagnosticBytes,
  providerAvailabilityDetail,
  providerAvailabilityLabel,
} from "./system-diagnostics-model.ts";

test("diagnosticsTone maps status to status pill tone", () => {
  assert.equal(diagnosticsTone("ok"), "passed");
  assert.equal(diagnosticsTone("warning"), "warning");
  assert.equal(diagnosticsTone("error"), "failed");
});

test("formatDiagnosticBytes formats fixed byte units", () => {
  assert.equal(formatDiagnosticBytes(0), "0 B");
  assert.equal(formatDiagnosticBytes(512), "512 B");
  assert.equal(formatDiagnosticBytes(2048), "2.0 KiB");
  assert.equal(formatDiagnosticBytes(5 * 1024 * 1024), "5.00 MiB");
});

test("diagnosticsHasWarnings detects any non-ok subsystem", () => {
  const base = {
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
    queue: { claude: 0, codex: 0, total: 0, status: "ok" },
    providers: {
      status: "ok",
      items: {
        claude: { available: true, queueDepth: 0 },
        codex: { available: false, queueDepth: 0 },
      },
    },
    runner: { inflightCount: 0, status: "ok" },
  };
  assert.equal(diagnosticsHasWarnings(base), false);
  assert.equal(
    diagnosticsHasWarnings({
      ...base,
      queue: { ...base.queue, status: "warning" },
    }),
    true,
  );
});

test("providerAvailabilityLabel prefers version when available", () => {
  assert.equal(providerAvailabilityLabel(true, "codex 1.2.3"), "codex 1.2.3");
  assert.equal(providerAvailabilityLabel(true), "available");
  assert.equal(providerAvailabilityLabel(false, "ignored"), "unavailable");
});

test("providerAvailabilityDetail includes command path for diagnostics", () => {
  assert.equal(
    providerAvailabilityDetail({
      available: true,
      version: "codex-cli 0.131.0",
      command:
        "C:\\Users\\GC\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe",
      queueDepth: 0,
    }),
    [
      "codex-cli 0.131.0",
      "command: C:\\Users\\GC\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe",
    ].join("\n"),
  );
  assert.equal(
    providerAvailabilityDetail({
      available: false,
      error: "spawn ENOENT",
      command: "C:\\missing\\codex.exe",
      queueDepth: 0,
    }),
    ["unavailable", "error: spawn ENOENT", "command: C:\\missing\\codex.exe"].join(
      "\n",
    ),
  );
});
