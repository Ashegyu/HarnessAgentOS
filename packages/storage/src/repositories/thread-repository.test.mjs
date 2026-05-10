import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import { SqliteThreadRepository } from "./thread-repository.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-thread-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

test("ThreadRepository creates with id, timestamps, optional targetDir", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteThreadRepository(db);
    const thread = await repo.create({ title: "first" });
    assert.match(thread.id, /^thr_/);
    assert.equal(thread.title, "first");
    assert.ok(typeof thread.createdAt === "string" && thread.createdAt.length > 0);
    assert.ok(typeof thread.updatedAt === "string");
    assert.equal(thread.targetDir, undefined);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("ThreadRepository list returns most-recently-updated first", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteThreadRepository(db);
    const a = await repo.create({ title: "a" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await repo.create({ title: "b" });
    const list = await repo.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, b.id);
    assert.equal(list[1].id, a.id);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("ThreadRepository get returns null for missing id", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteThreadRepository(db);
    assert.equal(await repo.get("thr_nope"), null);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("ThreadRepository update patches title and bumps updatedAt", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteThreadRepository(db);
    const created = await repo.create({ title: "old" });
    await new Promise((r) => setTimeout(r, 5));
    const updated = await repo.update(created.id, { title: "new" });
    assert.equal(updated.title, "new");
    assert.notEqual(updated.updatedAt, created.updatedAt);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("Threads survive a DB close+reopen (canonical state restored)", async () => {
  const t = tmp();
  let db = openDb({ filePath: t.file });
  try {
    let repo = new SqliteThreadRepository(db);
    const created = await repo.create({ title: "persistent", targetDir: "/tmp/x" });
    closeDb(db);

    db = openDb({ filePath: t.file });
    repo = new SqliteThreadRepository(db);
    const all = await repo.list();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, created.id);
    assert.equal(all[0].targetDir, "/tmp/x");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
