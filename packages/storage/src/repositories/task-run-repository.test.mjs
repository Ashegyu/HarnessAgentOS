import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import { SqliteThreadRepository } from "./thread-repository.ts";
import { SqliteTaskRunRepository } from "./task-run-repository.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-tr-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

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
