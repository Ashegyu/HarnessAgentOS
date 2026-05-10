import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import { LocalStateService } from "./local-state-service.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-svc-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

test("createThread rejects empty title", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const svc = new LocalStateService(db);
    await assert.rejects(() => svc.createThread({ title: "   " }));
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("createThread normalizes targetDir via path-policy", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const svc = new LocalStateService(db);
    const thread = await svc.createThread({
      title: "x",
      targetDir: "C:/Users/me",
    });
    assert.equal(thread.targetDir, "C:\\Users\\me");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("getThreadDetail returns thread with empty taskRuns array", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const svc = new LocalStateService(db);
    const thread = await svc.createThread({ title: "x" });
    const detail = await svc.getThreadDetail(thread.id);
    assert.ok(detail);
    assert.equal(detail.thread.id, thread.id);
    assert.deepEqual(detail.taskRuns, []);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("getThreadDetail returns null for missing id", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const svc = new LocalStateService(db);
    assert.equal(await svc.getThreadDetail("thr_nope"), null);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("createTaskRun requires existing thread and validates targetDir", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const svc = new LocalStateService(db);
    const thread = await svc.createThread({ title: "x" });
    const taskRun = await svc.createTaskRun({
      threadId: thread.id,
      userRequest: "do",
      targetDir: "/tmp/x",
    });
    assert.equal(taskRun.targetDir, "/tmp/x");

    await assert.rejects(() =>
      svc.createTaskRun({
        threadId: "thr_nope",
        userRequest: "do",
        targetDir: "/tmp/x",
      }),
    );

    await assert.rejects(() =>
      svc.createTaskRun({
        threadId: thread.id,
        userRequest: "do",
        targetDir: "",
      }),
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
