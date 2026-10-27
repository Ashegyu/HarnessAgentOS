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

test("deterministic template plans are retained as artifacts but never presented as final answers", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const svc = new LocalStateService(db);
    const { ConversationService } = await import("../../../core/src/conversation/conversation-service.ts");
    const conversation = new ConversationService({ state: svc, pathExists: () => true });
    const thread = await svc.createThread({ title: "CLI unavailable" });
    const draft = await conversation.createTask({ threadId: thread.id, targetDir: t.file, userRequest: "현재 프로젝트를 분석해서 HTML 파일로 저장해줘", mode: "template" });
    const detail = await svc.getThreadDetail(thread.id);
    assert.equal(detail.agentAnswers[draft.taskRun.id], undefined);
    assert.ok((await svc.listArtifactsByTaskRun(draft.taskRun.id)).some(row => row.id === draft.planArtifact.id));
  } finally { closeDb(db); t.cleanup(); }
});

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

test("createThread rejects relative targetDir", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const svc = new LocalStateService(db);
    await assert.rejects(
      () =>
        svc.createThread({
          title: "x",
          targetDir: "relative/path",
        }),
      /absolute path/,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

// v12 — pipeline binding goes through the service intact.
test("createThread passes pipelineId through to the repository", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const svc = new LocalStateService(db);
    const bound = await svc.createThread({
      title: "bound",
      pipelineId: "pipe_xyz",
    });
    assert.equal(bound.pipelineId, "pipe_xyz");

    const reloaded = await svc.getThread(bound.id);
    assert.equal(reloaded?.pipelineId, "pipe_xyz");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("createThread treats empty-string pipelineId as 'no binding'", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const svc = new LocalStateService(db);
    const thread = await svc.createThread({ title: "x", pipelineId: "" });
    assert.equal(thread.pipelineId, undefined);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("withTransaction rolls back writes when the work throws", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const svc = new LocalStateService(db);
    assert.throws(
      () =>
        svc.withTransaction(state => {
          state.createThread({ title: "rolled back" });
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.deepEqual(await svc.listThreads(), []);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("a transaction callback cannot absorb independent writes across an await", async () => {
  const db = openDb({ filePath: ":memory:" });
  try {
    const svc = new LocalStateService(db);
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const first = Promise.resolve().then(() => svc.withTransaction(async () => {
      await svc.createThread({ title: "rolled back owner" });
      await barrier;
      throw new Error("owner failed");
    })).then(() => null, error => error);
    // The owner has entered the callback; an unrelated operation must not
    // join its SQLite transaction merely because it uses the same service.
    await Promise.resolve();
    await Promise.resolve();
    const independent = await svc.createThread({ title: "independent success" });
    release();
    assert.ok(await first instanceof Error);
    assert.equal((await svc.getThread(independent.id))?.title, "independent success");
    assert.deepEqual((await svc.listThreads()).map(row => row.id), [independent.id]);
    assert.equal(db.inTransaction, false);
  } finally { closeDb(db); }
});

test("withTransaction rejects async work before executing it", () => {
  const db = openDb({ filePath: ":memory:" });
  try {
    const svc = new LocalStateService(db);
    let called = false;
    assert.throws(() => svc.withTransaction(async state => {
      called = true;
      state.createThread({ title: "must not run" });
    }), /must be synchronous/);
    assert.equal(called, false);
    assert.equal(db.inTransaction, false);
    assert.equal(db.prepare("SELECT count(*) AS count FROM threads").get().count, 0);
  } finally { closeDb(db); }
});

test("promise-returning work rolls back and cannot reuse its transaction scope later", async () => {
  const db = openDb({ filePath: ":memory:" });
  try {
    const svc = new LocalStateService(db);
    let continuation;
    let leaked;
    assert.throws(() => svc.withTransaction(state => {
      leaked = state;
      state.createThread({ title: "rolled back prefix" });
      continuation = Promise.resolve().then(() => state.createThread({ title: "late write" }));
      return continuation;
    }), /must be synchronous/);
    await assert.rejects(continuation, /no longer active/);
    assert.throws(() => leaked.getThread("missing"), /no longer active/);
    assert.deepEqual(await svc.listThreads(), []);
    assert.equal(db.inTransaction, false);
  } finally { closeDb(db); }
});

test("synchronous nested transactions roll back only their savepoint and close both scopes", async () => {
  const db = openDb({ filePath: ":memory:" });
  try {
    const svc = new LocalStateService(db);
    let outerScope;
    let innerScope;
    const kept = svc.withTransaction(outer => {
      outerScope = outer;
      const thread = outer.createThread({ title: "outer retained" });
      assert.throws(() => svc.withTransaction(inner => {
        innerScope = inner;
        inner.createThread({ title: "inner rolled back" });
        throw new Error("inner failure");
      }), /inner failure/);
      assert.equal(outer.getThread(thread.id).id, thread.id);
      return thread;
    });
    assert.deepEqual((await svc.listThreads()).map(row => row.id), [kept.id]);
    assert.throws(() => innerScope.createThread({ title: "invalid" }), /no longer active/);
    assert.throws(() => outerScope.createThread({ title: "invalid" }), /no longer active/);
    assert.equal(db.inTransaction, false);
  } finally { closeDb(db); }
});

test("setTaskRunStatus rejects an invalid transition without mutating SQLite state", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const svc = new LocalStateService(db);
    const thread = await svc.createThread({ title: "transition guard" });
    const taskRun = await svc.createTaskRun({
      threadId: thread.id,
      userRequest: "guard invalid state",
      targetDir: process.cwd(),
    });

    await assert.rejects(
      () => svc.setTaskRunStatus(taskRun.id, "done"),
      /Invalid TaskRun transition drafting -> done/,
    );
    assert.equal((await svc.getTaskRun(taskRun.id))?.status, "drafting");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("concurrent task transitions cannot overwrite cancellation after validating stale state", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const svc = new LocalStateService(db);
    const thread = await svc.createThread({ title: "transition race" });
    const taskRun = await svc.createTaskRun({
      threadId: thread.id, userRequest: "run", targetDir: process.cwd(), status: "running",
    });
    const results = await Promise.allSettled([
      svc.setTaskRunStatus(taskRun.id, "cancelled"),
      svc.setTaskRunStatus(taskRun.id, "ready_for_review"),
    ]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    assert.equal((await svc.getTaskRun(taskRun.id)).status, "cancelled");
  } finally { closeDb(db); t.cleanup(); }
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

test("getThreadDetail picks latest plan deterministically when timestamps tie", async () => {
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
    const step = await svc.createStep({
      taskRunId: taskRun.id,
      index: 0,
      kind: "plan",
      title: "plan",
      status: "succeeded",
    });
    const oldPlan = await svc.createArtifact({
      taskRunId: taskRun.id,
      stepId: step.id,
      kind: "plan",
      title: "old",
      uri: "artifact://plan/old",
      summary: "old summary",
    });
    const newPlan = await svc.createArtifact({
      taskRunId: taskRun.id,
      stepId: step.id,
      kind: "plan",
      title: "new",
      uri: "artifact://plan/new",
      summary: "new summary",
    });
    db.prepare("UPDATE artifacts SET created_at=? WHERE id IN (?, ?)")
      .run("2026-05-14T00:00:00.000Z", oldPlan.id, newPlan.id);

    const detail = await svc.getThreadDetail(thread.id);
    assert.equal(detail?.agentAnswers[taskRun.id], "new summary");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("buildThreadMarkdown returns a complete thread export document", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const svc = new LocalStateService(db);
    const thread = await svc.createThread({ title: "export me" });
    const taskRun = await svc.createTaskRun({
      threadId: thread.id,
      userRequest: "produce artifact",
      targetDir: "/tmp/export-me",
    });
    const step = await svc.createStep({
      taskRunId: taskRun.id,
      index: 0,
      kind: "plan",
      title: "Plan",
      status: "succeeded",
    });
    const checkpoint = await svc.createCheckpoint({
      taskRunId: taskRun.id,
      stepId: step.id,
      reason: "before_edit",
      stateRef: "harness:checkpoint/export",
      summary: "checkpoint",
    });
    const approval = await svc.createApproval({
      taskRunId: taskRun.id,
      checkpointId: checkpoint.id,
      actionType: "file_write",
      actionSummary: "write export",
    });
    const artifact = await svc.createArtifact({
      taskRunId: taskRun.id,
      stepId: step.id,
      kind: "log",
      title: "log",
      uri: "artifact://log/export",
      summary: "evidence",
    });
    const markdown = await svc.buildThreadMarkdown(thread.id);
    assert.ok(markdown);
    assert.match(markdown, new RegExp(thread.id));
    assert.match(markdown, new RegExp(taskRun.id));
    assert.match(markdown, new RegExp(step.id));
    assert.match(markdown, new RegExp(checkpoint.id));
    assert.match(markdown, new RegExp(approval.id));
    assert.match(markdown, new RegExp(artifact.id));
    assert.match(markdown, /artifact:\/\/log\/export/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("getDatabaseDiagnostics reports WAL checkpoint and file sizes", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const svc = new LocalStateService(db);
    await svc.createThread({ title: "diagnostics" });
    const diagnostics = svc.getDatabaseDiagnostics();
    assert.equal(typeof diagnostics.mainBytes, "number");
    assert.equal(typeof diagnostics.walBytes, "number");
    assert.equal(typeof diagnostics.shmBytes, "number");
    assert.equal(
      diagnostics.totalBytes,
      diagnostics.mainBytes + diagnostics.walBytes + diagnostics.shmBytes,
    );
    assert.equal(typeof diagnostics.walCheckpoint.busy, "number");
    assert.equal(typeof diagnostics.walCheckpoint.log, "number");
    assert.equal(typeof diagnostics.walCheckpoint.checkpointed, "number");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("getThreadDetail prefers saved agent raw output over plan summary", async () => {
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
    const step = await svc.createStep({
      taskRunId: taskRun.id,
      index: 0,
      kind: "plan",
      title: "plan",
      status: "succeeded",
    });
    const rawOutput = await svc.createArtifact({
      taskRunId: taskRun.id,
      stepId: step.id,
      kind: "log",
      title: "Agent raw output",
      uri: "artifact://log/raw",
      summary:
        '{"type":"item.completed","item":{"type":"assistant_message","role":"assistant","content":[{"type":"output_text","text":"raw stream answer"}]}}',
    });
    const plan = await svc.createArtifact({
      taskRunId: taskRun.id,
      stepId: step.id,
      kind: "plan",
      title: "Plan",
      uri: "artifact://plan/final",
      summary: "plan summary",
    });
    db.prepare("UPDATE artifacts SET created_at=? WHERE id=?")
      .run("2026-05-14T00:00:00.000Z", rawOutput.id);
    db.prepare("UPDATE artifacts SET created_at=? WHERE id=?")
      .run("2026-05-14T00:01:00.000Z", plan.id);

    const detail = await svc.getThreadDetail(thread.id);
    assert.equal(detail?.agentAnswers[taskRun.id], rawOutput.summary);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("getThreadDetail does not expose agent placeholder plan as chat answer", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const svc = new LocalStateService(db);
    const thread = await svc.createThread({ title: "x" });
    const taskRun = await svc.createTaskRun({
      threadId: thread.id,
      userRequest: "do",
      targetDir: "/tmp/x",
      status: "blocked",
    });
    const step = await svc.createStep({
      taskRunId: taskRun.id,
      index: 0,
      kind: "plan",
      title: "Agent plan 대기",
      status: "pending",
    });
    await svc.createArtifact({
      taskRunId: taskRun.id,
      stepId: step.id,
      kind: "plan",
      title: "Awaiting agent plan",
      uri: "artifact://plan/placeholder",
      summary:
        "Agent mode TaskRun — call `agent.generatePlan(taskRunId)` to produce a plan and approvals.",
    });

    const detail = await svc.getThreadDetail(thread.id);
    assert.equal(detail?.agentAnswers[taskRun.id], undefined);
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

    await assert.rejects(
      () =>
        svc.createTaskRun({
          threadId: thread.id,
          userRequest: "do",
          targetDir: "relative/path",
        }),
      /absolute path/,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("createApproval attaches default policy evaluation", async () => {
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
    const step = await svc.createStep({
      taskRunId: taskRun.id,
      index: 0,
      kind: "approval",
      title: "approval",
    });
    const checkpoint = await svc.createCheckpoint({
      taskRunId: taskRun.id,
      stepId: step.id,
      reason: "before_edit",
      stateRef: "{}",
      summary: "approval checkpoint",
    });
    const approval = await svc.createApproval({
      taskRunId: taskRun.id,
      checkpointId: checkpoint.id,
      actionType: "dependency_install",
      actionSummary: "install package",
    });

    assert.equal(approval.policyEvaluation?.decision, "confirm");
    assert.equal(approval.policyEvaluation?.riskLevel, "high");
    assert.equal(approval.policyEvaluation?.allowAutoApprove, false);

    const reloaded = await svc.getApproval(approval.id);
    assert.deepEqual(reloaded?.policyEvaluation, approval.policyEvaluation);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
