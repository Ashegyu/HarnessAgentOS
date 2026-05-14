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
    assert.equal(settings.agent.provider, "auto");
    assert.equal(settings.agent.timeoutMs, DEFAULT_AGENT_TIMEOUT_MS);
    assert.equal(settings.agent.stallTimeoutMs, DEFAULT_AGENT_STALL_TIMEOUT_MS);
    assert.equal(settings.agent.contextDepth, 5);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SettingsRepository upserts and retrieves a partial update", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSettingsRepository(db);
    // values >= defaults are preserved verbatim by get()
    const updated = await repo.update({ agent: { provider: "claude", timeoutMs: DEFAULT_AGENT_TIMEOUT_MS + 60_000, stallTimeoutMs: DEFAULT_AGENT_STALL_TIMEOUT_MS + 60_000, model: "sonnet", contextDepth: 7 } });
    assert.equal(updated.agent.provider, "claude");
    assert.equal(updated.agent.timeoutMs, DEFAULT_AGENT_TIMEOUT_MS + 60_000);
    const retrieved = await repo.get();
    assert.equal(retrieved.agent.provider, "claude");
    assert.equal(retrieved.agent.timeoutMs, DEFAULT_AGENT_TIMEOUT_MS + 60_000);
    assert.equal(retrieved.agent.stallTimeoutMs, DEFAULT_AGENT_STALL_TIMEOUT_MS + 60_000);
    assert.equal(retrieved.agent.model, "sonnet");
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

test("SettingsRepository defaults approval.autoApprove to false when missing", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSettingsRepository(db);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run("harness_settings", JSON.stringify({ agent: { provider: "auto", timeoutMs: 300_000, stallTimeoutMs: 60_000, model: "", contextDepth: 5 } }));
    const retrieved = await repo.get();
    assert.equal(retrieved.approval.autoApprove, false, "legacy row defaults approval.autoApprove to false");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SettingsRepository round-trips approval.autoApprove=true", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSettingsRepository(db);
    await repo.update({
      agent: { provider: "auto", timeoutMs: 300_000, stallTimeoutMs: 60_000, model: "", contextDepth: 5 },
      orchestration: { enabled: false, defaultMode: "single_worker", defaultInstructions: "", workerProfiles: [] },
      approval: { autoApprove: true },
    });
    const retrieved = await repo.get();
    assert.equal(retrieved.approval.autoApprove, true, "approval.autoApprove preserved");
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
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
