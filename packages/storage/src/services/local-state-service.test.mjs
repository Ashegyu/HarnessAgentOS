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
    await assert.rejects(
      () =>
        svc.withTransaction(async () => {
          await svc.createThread({ title: "rolled back" });
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
