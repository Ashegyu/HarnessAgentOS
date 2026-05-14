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

// v12 — pipeline binding round-trip. The binding lives on the thread
// row so every TaskRun routes through orchestration with that pipeline.
test("ThreadRepository persists pipelineId on create and reads it back via list/get", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteThreadRepository(db);
    const a = await repo.create({ title: "bound", pipelineId: "pipe_abc" });
    const b = await repo.create({ title: "unbound" });
    assert.equal(a.pipelineId, "pipe_abc");
    assert.equal(b.pipelineId, undefined);

    const fromGet = await repo.get(a.id);
    assert.equal(fromGet?.pipelineId, "pipe_abc");

    const list = await repo.list();
    const aRow = list.find((r) => r.id === a.id);
    const bRow = list.find((r) => r.id === b.id);
    assert.equal(aRow?.pipelineId, "pipe_abc");
    assert.equal(bRow?.pipelineId, undefined);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("ThreadRepository treats empty-string pipelineId as 'no binding'", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteThreadRepository(db);
    const thread = await repo.create({ title: "x", pipelineId: "" });
    assert.equal(thread.pipelineId, undefined);

    const fromGet = await repo.get(thread.id);
    assert.equal(fromGet?.pipelineId, undefined);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("ThreadRepository update sets and clears pipelineId", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteThreadRepository(db);
    const created = await repo.create({ title: "x" });
    assert.equal(created.pipelineId, undefined);

    const bound = await repo.update(created.id, { pipelineId: "pipe_xyz" });
    assert.equal(bound.pipelineId, "pipe_xyz");

    // null clears the binding back to "no pipeline"
    const cleared = await repo.update(created.id, { pipelineId: null });
    assert.equal(cleared.pipelineId, undefined);

    const persisted = await repo.get(created.id);
    assert.equal(persisted?.pipelineId, undefined);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("Thread pipelineId survives a DB close+reopen (legacy rows tolerated)", async () => {
  const t = tmp();
  let db = openDb({ filePath: t.file });
  try {
    let repo = new SqliteThreadRepository(db);
    const bound = await repo.create({ title: "bound", pipelineId: "pipe_keep" });
    const legacy = await repo.create({ title: "legacy" });
    closeDb(db);

    db = openDb({ filePath: t.file });
    repo = new SqliteThreadRepository(db);
    const all = await repo.list();
    const boundReloaded = all.find((r) => r.id === bound.id);
    const legacyReloaded = all.find((r) => r.id === legacy.id);
    assert.equal(boundReloaded?.pipelineId, "pipe_keep");
    assert.equal(legacyReloaded?.pipelineId, undefined);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
