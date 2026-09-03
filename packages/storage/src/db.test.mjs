import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, openDb } from "./db.ts";

test("openDb readonly reopens a migrated database without attempting migrations", () => {
  const directory = mkdtempSync(join(tmpdir(), "hgos-readonly-db-"));
  const filePath = join(directory, "app.db");
  let writable;
  let readonly;
  try {
    writable = openDb({ filePath });
    writable
      .prepare("INSERT INTO schema_meta(key, value) VALUES (?, ?)")
      .run("readonly_probe", "preserved");
    closeDb(writable);
    writable = undefined;

    readonly = openDb({ filePath, readonly: true });
    assert.equal(
      readonly
        .prepare("SELECT value FROM schema_meta WHERE key = ?")
        .pluck()
        .get("readonly_probe"),
      "preserved",
    );
    assert.throws(
      () =>
        readonly
          .prepare("UPDATE schema_meta SET value = ? WHERE key = ?")
          .run("changed", "readonly_probe"),
      /readonly/i,
    );
  } finally {
    if (readonly?.open) closeDb(readonly);
    if (writable?.open) closeDb(writable);
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // A failed readonly open can leave the native handle alive until the
      // test process exits; do not let cleanup hide the original assertion.
    }
  }
});
