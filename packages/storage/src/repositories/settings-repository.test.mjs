import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import { SqliteSettingsRepository } from "./settings-repository.ts";

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
    assert.equal(settings.agent.timeoutMs, 300_000);
    assert.equal(settings.agent.stallTimeoutMs, 60_000);
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
    const updated = await repo.update({ agent: { provider: "claude", timeoutMs: 600_000, stallTimeoutMs: 120_000, model: "sonnet", contextDepth: 7 } });
    assert.equal(updated.agent.provider, "claude");
    assert.equal(updated.agent.timeoutMs, 600_000);
    const retrieved = await repo.get();
    assert.equal(retrieved.agent.provider, "claude");
    assert.equal(retrieved.agent.timeoutMs, 600_000);
    assert.equal(retrieved.agent.stallTimeoutMs, 120_000);
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
    assert.equal(retrieved.agent.timeoutMs, 300_000, "legacy timeoutMs upgraded");
    assert.equal(retrieved.agent.stallTimeoutMs, 60_000, "legacy stallTimeoutMs upgraded");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
