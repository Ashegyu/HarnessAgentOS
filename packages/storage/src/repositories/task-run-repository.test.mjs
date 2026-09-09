import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import { SqliteThreadRepository } from "./thread-repository.ts";
import { SqliteTaskRunRepository } from "./task-run-repository.ts";
import { applyMigrations } from "../migrations.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-tr-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

test("TaskContract survives reopen and migration, preserving user-selected scope", async () => {
  const t = tmp();
  let db = openDb({ filePath: t.file });
  try {
    const thread = await new SqliteThreadRepository(db).create({ title: "contract" });
    const task = await new SqliteTaskRunRepository(db).create({
      threadId: thread.id, userRequest: "implement x", intent: "review", targetDir: "/tmp/x",
    });
    closeDb(db);
    db = openDb({ filePath: t.file });
    applyMigrations(db);
    const repo = new SqliteTaskRunRepository(db);
    assert.deepEqual((await repo.get(task.id)).contract, task.contract);
    assert.equal((await repo.listByThread(thread.id))[0].contract.authorization.mode, "read_only");
    await repo.delete(task.id);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_contracts").get().n, 0);
  } finally { closeDb(db); t.cleanup(); }
});

test("v39 additive migration preserves legacy tasks and corrupt contracts fail closed", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const thread = await new SqliteThreadRepository(db).create({ title: "legacy" });
    const repo = new SqliteTaskRunRepository(db);
    const task = await repo.create({ threadId: thread.id, userRequest: "원인만 설명해줘", targetDir: "/tmp/x" });
    db.exec("DROP TABLE task_contracts");
    applyMigrations(db);
    const legacy = await repo.get(task.id);
    assert.equal(legacy.userRequest, task.userRequest);
    assert.equal(legacy.contract.origin, "legacy");
    assert.equal(legacy.contract.authorization.mode, "read_only");
    db.prepare("INSERT INTO task_contracts VALUES (?, 1, ?, ?)").run(task.id, '{"authorization":{"mode":"unsafe"}}', task.createdAt);
    await assert.rejects(repo.get(task.id), /contract/i);
  } finally { closeDb(db); t.cleanup(); }
});

test("TaskRun insert rolls back if its contract cannot be persisted", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const thread = await new SqliteThreadRepository(db).create({ title: "atomic" });
    db.exec("CREATE TRIGGER reject_contract BEFORE INSERT ON task_contracts BEGIN SELECT RAISE(ABORT, 'contract failed'); END;");
    await assert.rejects(new SqliteTaskRunRepository(db).create({
      threadId: thread.id, userRequest: "review", targetDir: "/tmp/x",
    }), /contract failed/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_runs").get().n, 0);
  } finally { closeDb(db); t.cleanup(); }
});

test("TaskRunRepository creates with default status drafting", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const threads = new SqliteThreadRepository(db);
    const tr = new SqliteTaskRunRepository(db);
    const thread = await threads.create({ title: "x" });
    const taskRun = await tr.create({
      threadId: thread.id,
      userRequest: "do a thing",
      targetDir: "/tmp/x",
    });
    assert.match(taskRun.id, /^tsk_/);
    assert.equal(taskRun.status, "drafting");
    assert.equal(taskRun.targetDir, "/tmp/x");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("TaskRunRepository persists follow-up TaskRun linkage", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const threads = new SqliteThreadRepository(db);
    const tr = new SqliteTaskRunRepository(db);
    const thread = await threads.create({ title: "x" });
    const first = await tr.create({
      threadId: thread.id,
      userRequest: "initial task",
      targetDir: "/tmp/x",
    });
    const followUp = await tr.create({
      threadId: thread.id,
      userRequest: "continue from previous task",
      targetDir: "/tmp/x",
      followUpTaskRunId: first.id,
    });

    assert.equal(followUp.followUpTaskRunId, first.id);
    const reread = await tr.get(followUp.id);
    assert.equal(reread.followUpTaskRunId, first.id);
    const listed = await tr.listByThread(thread.id);
    assert.equal(
      listed.find((taskRun) => taskRun.id === followUp.id).followUpTaskRunId,
      first.id,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("TaskRunRepository updateStatus bumps updatedAt and persists", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const threads = new SqliteThreadRepository(db);
    const tr = new SqliteTaskRunRepository(db);
    const thread = await threads.create({ title: "x" });
    const created = await tr.create({
      threadId: thread.id,
      userRequest: "do",
      targetDir: "/tmp/x",
    });
    await new Promise((r) => setTimeout(r, 5));
    const updated = await tr.updateStatus(created.id, "running");
    assert.equal(updated.status, "running");
    assert.notEqual(updated.updatedAt, created.updatedAt);
    const reread = await tr.get(created.id);
    assert.equal(reread.status, "running");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("TaskRunRepository listByThread filters and orders by createdAt desc", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const threads = new SqliteThreadRepository(db);
    const tr = new SqliteTaskRunRepository(db);
    const a = await threads.create({ title: "a" });
    const b = await threads.create({ title: "b" });
    const a1 = await tr.create({
      threadId: a.id,
      userRequest: "1",
      targetDir: "/tmp/a",
    });
    await new Promise((r) => setTimeout(r, 5));
    const a2 = await tr.create({
      threadId: a.id,
      userRequest: "2",
      targetDir: "/tmp/a",
    });
    await tr.create({
      threadId: b.id,
      userRequest: "3",
      targetDir: "/tmp/b",
    });
    const onlyA = await tr.listByThread(a.id);
    assert.equal(onlyA.length, 2);
    assert.equal(onlyA[0].id, a2.id);
    assert.equal(onlyA[1].id, a1.id);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("Foreign key constraint blocks TaskRun without parent Thread", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const tr = new SqliteTaskRunRepository(db);
    await assert.rejects(() =>
      tr.create({
        threadId: "thr_nope",
        userRequest: "x",
        targetDir: "/tmp/x",
      }),
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("TaskRunRepository delete removes the row", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const threads = new SqliteThreadRepository(db);
    const tr = new SqliteTaskRunRepository(db);
    const thread = await threads.create({ title: "x" });
    const created = await tr.create({
      threadId: thread.id,
      userRequest: "to delete",
      targetDir: "/tmp/x",
    });
    await tr.delete(created.id);
    const found = await tr.get(created.id);
    assert.equal(found, null);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
