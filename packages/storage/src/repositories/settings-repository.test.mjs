import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import { SqliteSettingsRepository } from "./settings-repository.ts";
import {
  DEFAULT_AGENT_STALL_TIMEOUT_MS,
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_CODEX_MODEL,
} from "@harness/core";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-settings-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

test("SettingsRepository returns DEFAULT_HARNESS_SETTINGS when no row exists", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSettingsRepository(db);
    const settings = await repo.get();
    assert.equal(settings.agent.provider, "codex");
    assert.equal(settings.agent.model, DEFAULT_CODEX_MODEL);
    assert.equal(settings.agent.timeoutMs, DEFAULT_AGENT_TIMEOUT_MS);
    assert.equal(settings.agent.stallTimeoutMs, DEFAULT_AGENT_STALL_TIMEOUT_MS);
    assert.equal(settings.agent.contextDepth, 5);
    assert.equal(settings.ui.language, "ko");
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("harness_settings");
    assert.equal(JSON.parse(row.value).ui.language, "ko");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SettingsRepository persists the UI language and normalizes malformed values", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSettingsRepository(db);
    const current = await repo.get();
    const updated = await repo.update({ ...current, ui: { language: "en" } });
    assert.equal(updated.ui.language, "en");
    assert.equal((await repo.get()).ui.language, "en");

    db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
      JSON.stringify({ ...current, ui: { language: "invalid" } }),
      "harness_settings",
    );
    assert.equal((await repo.get()).ui.language, "ko");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SettingsRepository persists the Korean UI default into legacy DB rows", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSettingsRepository(db);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      "harness_settings",
      JSON.stringify({ agent: { provider: "codex" } }),
    );

    assert.equal((await repo.get()).ui.language, "ko");
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("harness_settings");
    assert.equal(JSON.parse(row.value).ui.language, "ko");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SettingsRepository normalizes legacy providers and models to Codex", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSettingsRepository(db);
    // values >= defaults are preserved verbatim by get()
    const updated = await repo.update({ agent: { provider: "claude", timeoutMs: DEFAULT_AGENT_TIMEOUT_MS + 60_000, stallTimeoutMs: DEFAULT_AGENT_STALL_TIMEOUT_MS + 60_000, model: "sonnet", contextDepth: 7 } });
    assert.equal(updated.agent.provider, "codex");
    assert.equal(updated.agent.model, DEFAULT_CODEX_MODEL);
    assert.equal(updated.agent.reasoningEffort, "medium");
    assert.equal(updated.agent.timeoutMs, DEFAULT_AGENT_TIMEOUT_MS + 60_000);
    const retrieved = await repo.get();
    assert.equal(retrieved.agent.provider, "codex");
    assert.equal(retrieved.agent.timeoutMs, DEFAULT_AGENT_TIMEOUT_MS + 60_000);
    assert.equal(retrieved.agent.stallTimeoutMs, DEFAULT_AGENT_STALL_TIMEOUT_MS + 60_000);
    assert.equal(retrieved.agent.model, DEFAULT_CODEX_MODEL);
    assert.equal(retrieved.agent.reasoningEffort, "medium");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SettingsRepository.get() upgrades legacy timeout values below defaults", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSettingsRepository(db);
    // simulate a row left over from before the streaming-adapter fix
    await repo.update({ agent: { provider: "auto", timeoutMs: 120_000, stallTimeoutMs: 30_000, model: "", contextDepth: 5 } });
    const retrieved = await repo.get();
    assert.equal(retrieved.agent.timeoutMs, DEFAULT_AGENT_TIMEOUT_MS, "legacy timeoutMs upgraded");
    assert.equal(retrieved.agent.stallTimeoutMs, DEFAULT_AGENT_STALL_TIMEOUT_MS, "legacy stallTimeoutMs upgraded");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SettingsRepository.get() upgrades the previous Codex default model", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSettingsRepository(db);
    await repo.update({
      agent: {
        provider: "codex",
        timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
        stallTimeoutMs: DEFAULT_AGENT_STALL_TIMEOUT_MS,
        model: "gpt-5.5",
        contextDepth: 5,
      },
      orchestration: {
        enabled: false,
        defaultMode: "single_worker",
        defaultInstructions: "",
        workerProfiles: [],
        defaultPipelineId: "",
      },
      approval: {
        autoApprove: false,
        autoExecuteWorkerFileActions: true,
      },
    });

    const retrieved = await repo.get();
    assert.equal(retrieved.agent.model, "gpt-5.6-sol");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SettingsRepository.get() fills orchestration defaults for legacy rows without the field", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSettingsRepository(db);
    // Write a row that has no orchestration field (simulates pre-orchestration DB row)
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run("harness_settings", JSON.stringify({ agent: { provider: "auto", timeoutMs: 300_000, stallTimeoutMs: 60_000, model: "", contextDepth: 5 } }));
    const retrieved = await repo.get();
    assert.equal(retrieved.orchestration.enabled, false, "legacy row defaults orchestration to false");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SettingsRepository round-trips orchestration.enabled=true", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSettingsRepository(db);
    await repo.update({ agent: { provider: "auto", timeoutMs: 300_000, stallTimeoutMs: 60_000, model: "", contextDepth: 5 }, orchestration: { enabled: true } });
    const retrieved = await repo.get();
    assert.equal(retrieved.orchestration.enabled, true, "orchestration.enabled preserved");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SettingsRepository.get() coerces malformed orchestration to default", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSettingsRepository(db);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run("harness_settings", JSON.stringify({ agent: { provider: "auto", timeoutMs: 300_000, stallTimeoutMs: 60_000, model: "", contextDepth: 5 }, orchestration: "bad_value" }));
    const retrieved = await repo.get();
    assert.equal(retrieved.orchestration.enabled, false, "malformed orchestration coerced to false");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SettingsRepository defaults approval.autoApprove to false and worker file auto-run to true when missing", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSettingsRepository(db);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run("harness_settings", JSON.stringify({ agent: { provider: "auto", timeoutMs: 300_000, stallTimeoutMs: 60_000, model: "", contextDepth: 5 } }));
    const retrieved = await repo.get();
    assert.equal(retrieved.approval.autoApprove, false, "legacy row defaults approval.autoApprove to false");
    assert.equal(
      retrieved.approval.autoExecuteWorkerFileActions,
      true,
      "legacy row defaults approval.autoExecuteWorkerFileActions to true",
    );
    assert.equal(
      retrieved.approval.workerFileAutoExecutionConfigured,
      false,
      "legacy row has not configured the worker file auto-run toggle",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SettingsRepository defaults Codex runtime options when missing", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSettingsRepository(db);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run("harness_settings", JSON.stringify({ agent: { provider: "codex", timeoutMs: 300_000, stallTimeoutMs: 60_000, model: "", contextDepth: 5 } }));
    const retrieved = await repo.get();
    assert.equal(retrieved.agent.codexWorkspaceWrite, false);
    assert.equal(retrieved.agent.codexAutoReview, false);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SettingsRepository round-trips GPT-6 Astra selections", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSettingsRepository(db);
    const current = await repo.get();
    const updated = await repo.update({
      ...current,
      agent: { ...current.agent, model: "gpt-6-astra" },
    });

    assert.equal(updated.agent.model, "gpt-6-astra");
    assert.equal((await repo.get()).agent.model, "gpt-6-astra");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SettingsRepository defaults and clamps the parallel worker limit", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSettingsRepository(db);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run("harness_settings", JSON.stringify({
        agent: { provider: "codex", timeoutMs: 300_000, stallTimeoutMs: 60_000, model: "", contextDepth: 5 },
        orchestration: { maxParallelWorkers: 99 },
      }));
    assert.equal((await repo.get()).orchestration.maxParallelWorkers, 8);
    const normalizedRow = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("harness_settings");
    assert.equal(
      JSON.parse(normalizedRow.value).orchestration.maxParallelWorkers,
      8,
      "normalized concurrency limit is persisted back to SQLite",
    );

    const current = await repo.get();
    const updated = await repo.update({
      ...current,
      orchestration: { ...current.orchestration, maxParallelWorkers: 0 },
    });
    assert.equal(updated.orchestration.maxParallelWorkers, 1);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SettingsRepository round-trips Codex runtime options", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSettingsRepository(db);
    await repo.update({
      agent: {
        provider: "codex",
        timeoutMs: 300_000,
        stallTimeoutMs: 60_000,
        model: "",
        contextDepth: 5,
        codexWorkspaceWrite: true,
        codexAutoReview: true,
      },
      orchestration: { enabled: false, defaultMode: "single_worker", defaultInstructions: "", workerProfiles: [], defaultPipelineId: "" },
      approval: { autoApprove: false, autoExecuteWorkerFileActions: false },
    });
    const retrieved = await repo.get();
    assert.equal(retrieved.agent.codexWorkspaceWrite, true);
    assert.equal(retrieved.agent.codexAutoReview, true);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SettingsRepository round-trips approval automation flags", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSettingsRepository(db);
    await repo.update({
      agent: { provider: "auto", timeoutMs: 300_000, stallTimeoutMs: 60_000, model: "", contextDepth: 5 },
      orchestration: { enabled: false, defaultMode: "single_worker", defaultInstructions: "", workerProfiles: [] },
      approval: {
        autoApprove: true,
        autoExecuteWorkerFileActions: true,
        workerFileAutoExecutionConfigured: true,
      },
    });
    const retrieved = await repo.get();
    assert.equal(retrieved.approval.autoApprove, true, "approval.autoApprove preserved");
    assert.equal(
      retrieved.approval.autoExecuteWorkerFileActions,
      true,
      "approval.autoExecuteWorkerFileActions preserved",
    );
    assert.equal(
      retrieved.approval.workerFileAutoExecutionConfigured,
      true,
      "approval.workerFileAutoExecutionConfigured preserved",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SettingsRepository preserves explicit worker file auto-run opt-out", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSettingsRepository(db);
    await repo.update({
      agent: {
        provider: "auto",
        timeoutMs: 300_000,
        stallTimeoutMs: 60_000,
        model: "",
        contextDepth: 5,
      },
      orchestration: {
        enabled: false,
        defaultMode: "single_worker",
        defaultInstructions: "",
        workerProfiles: [],
      },
      approval: {
        autoApprove: false,
        autoExecuteWorkerFileActions: false,
        workerFileAutoExecutionConfigured: true,
      },
    });
    const retrieved = await repo.get();
    assert.equal(
      retrieved.approval.autoExecuteWorkerFileActions,
      false,
      "explicit opt-out is preserved",
    );
    assert.equal(
      retrieved.approval.workerFileAutoExecutionConfigured,
      true,
      "explicit opt-out marker is preserved",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SettingsRepository.get() coerces malformed approval to default", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSettingsRepository(db);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run("harness_settings", JSON.stringify({ agent: { provider: "auto", timeoutMs: 300_000, stallTimeoutMs: 60_000, model: "", contextDepth: 5 }, approval: "bad_value" }));
    const retrieved = await repo.get();
    assert.equal(retrieved.approval.autoApprove, false, "malformed approval coerced to false");
    assert.equal(
      retrieved.approval.autoExecuteWorkerFileActions,
      true,
      "malformed approval autoExecuteWorkerFileActions coerced to default true",
    );
    assert.equal(
      retrieved.approval.workerFileAutoExecutionConfigured,
      false,
      "malformed approval autoExecuteWorkerFileActions is unconfigured",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
