import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDb,
  LocalStateService,
  openDb,
  FilesystemArtifactStore,
} from "../../../packages/storage/src/index.ts";
import { RunnerService } from "../../runners/src/runner-service.ts";
import { CodeChangeLoopService } from "./code-change-loop-service.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-code-loop-"));
  return {
    dir,
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const seedTaskRun = async (state, targetDir = "/tmp/proj") => {
  const thread = await state.createThread({
    title: "code loop",
    targetDir,
  });
  return state.createTaskRun({
    threadId: thread.id,
    userRequest: "add a feature",
    targetDir,
    status: "running",
  });
};

const createApproval = async (state, taskRunId, actionType, details) => {
  const index = (await state.listStepsByTaskRun(taskRunId)).length;
  const step = await state.createStep({
    taskRunId,
    index,
    kind: "approval",
    title: `${actionType} approval`,
    status: "succeeded",
    inputSummary: actionType,
  });
  const checkpoint = await state.createCheckpoint({
    taskRunId,
    stepId: step.id,
    reason: "before_edit",
    stateRef: JSON.stringify({ taskRunId, stepId: step.id }),
    summary: `${actionType} checkpoint`,
  });
  return state.createApproval({
    taskRunId,
    checkpointId: checkpoint.id,
    actionType,
    actionSummary: `${actionType} action`,
    status: "approved",
    proposedAction: details,
  });
};

const createFileWriteApproval = (state, taskRunId, path) =>
  createApproval(state, taskRunId, "file_write", {
    type: "file_write",
    filePatch: { path, after: `content for ${path}` },
  });

const createFilePatchApproval = (state, taskRunId, path) =>
  createApproval(state, taskRunId, "file_patch", {
    type: "file_patch",
    unifiedPatch: {
      path,
      patch: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
    },
  });

const createShellApproval = (state, taskRunId, command) =>
  createApproval(state, taskRunId, "shell", {
    type: "shell",
    command,
  });

const makeRunner = (handlers = {}) => {
  const calls = [];
  return {
    calls,
    executor: {
      async executeApproved(approvalId) {
        calls.push(approvalId);
        const handler = handlers[approvalId];
        if (handler) return handler();
        return {
          taskRunId: "taskRun",
          stepId: `step-${approvalId}`,
          commandSummary: `executed ${approvalId}`,
          exitCode: 0,
          changedFiles: [],
          artifactIds: [],
        };
      },
    },
  };
};

test("exit zero from a supplied echo verification cannot fabricate a passed quality gate", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const change = await createFileWriteApproval(state, taskRun.id, "result.txt");
    const echo = await createShellApproval(state, taskRun.id, "echo test build smoke");
    const { executor } = makeRunner();
    const result = await new CodeChangeLoopService({ state, runner: executor }).runAttempt({
      taskRunId: taskRun.id, changeApprovalIds: [change.id], verificationApprovalIds: [echo.id],
    });
    assert.equal(result.status, "applied_unverified");
    const gate = await state.getLatestQualityGateResult(taskRun.id);
    assert.equal(gate.status, "warning");
    assert.equal(gate.testsPassed, undefined);
    assert.equal(gate.buildPassed, undefined);
    assert.equal(gate.smokePassed, undefined);
  } finally { closeDb(db); t.cleanup(); }
});

test("real approved Node tests produce verified code-change evidence bound to the current inputs", { timeout: 20_000 }, async () => {
  const t = tmp();
  const project = join(t.dir, "project");
  mkdirSync(project);
  writeFileSync(join(project, "validation.test.mjs"), 'import { test } from "node:test"; import assert from "node:assert/strict"; test("actual check", () => assert.equal(2 + 2, 4));\n');
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const task = await seedTaskRun(state, project);
    const change = await createFileWriteApproval(state, task.id, "result.txt");
    const checker = await createApproval(state, task.id, "shell", { type: "shell", command: "node", args: ["--test", "validation.test.mjs"] });
    const runner = new RunnerService({ state, artifactStore: new FilesystemArtifactStore({ rootDir: join(t.dir, "artifacts") }) });
    const result = await new CodeChangeLoopService({ state, runner }).runAttempt({ taskRunId: task.id,
      changeApprovalIds: [change.id], verificationApprovalIds: [checker.id] });
    assert.equal(result.status, "verified");
    const gate = await state.getLatestQualityGateResult(task.id);
    assert.equal(gate.status, "passed");
    assert.equal(gate.testsPassed, true);
    assert.equal(gate.buildPassed, undefined);
    assert.equal(gate.changedFilesReviewed, false);
    assert.ok(gate.validationState?.fingerprint);
    await state.assertQualityGateCurrent(gate);
    writeFileSync(join(project, "result.txt"), "changed after checking");
    await assert.rejects(state.assertQualityGateCurrent(gate), error => error.code === "QUALITY_DONE_BLOCKED");
  } finally { closeDb(db); t.cleanup(); }
});

test("runs approved writes but does not trust stub exit zero without validation provenance", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const a = await createFileWriteApproval(state, taskRun.id, "src/a.ts");
    const b = await createFileWriteApproval(state, taskRun.id, "src/b.ts");
    const check = await createShellApproval(state, taskRun.id, "npm run check");
    const { calls, executor } = makeRunner({
      [a.id]: () => ({
        taskRunId: taskRun.id,
        stepId: "apply-a",
        commandSummary: "file_write src/a.ts",
        changedFiles: ["/tmp/proj/src/a.ts"],
        artifactIds: ["diff-a"],
      }),
      [b.id]: () => ({
        taskRunId: taskRun.id,
        stepId: "apply-b",
        commandSummary: "file_write src/b.ts",
        changedFiles: ["/tmp/proj/src/b.ts"],
        artifactIds: ["diff-b"],
      }),
      [check.id]: () => ({
        taskRunId: taskRun.id,
        stepId: "verify-check",
        commandSummary: "npm run check",
        exitCode: 0,
        stdout: "ok",
        artifactIds: ["check-log"],
      }),
    });
    const service = new CodeChangeLoopService({ state, runner: executor });

    const result = await service.runAttempt({
      taskRunId: taskRun.id,
      changeApprovalIds: [a.id, b.id],
      verificationApprovalIds: [check.id],
    });

    assert.deepEqual(calls, [a.id, b.id, check.id]);
    assert.equal(result.status, "applied_unverified");
    assert.deepEqual(result.changedFiles, ["/tmp/proj/src/a.ts", "/tmp/proj/src/b.ts"]);
    assert.equal(result.verificationResults.length, 1);
    assert.equal(result.verificationResults[0].exitCode, 0);

    const updatedTaskRun = await state.getTaskRun(taskRun.id);
    assert.equal(updatedTaskRun?.status, "ready_for_review");
    const gate = await state.getLatestQualityGateResult(taskRun.id);
    assert.equal(gate?.status, "warning");
    assert.equal(gate?.testsPassed, undefined);
    assert.equal(gate?.changedFilesReviewed, false);
    const artifacts = await state.listArtifactsByTaskRun(taskRun.id);
    const manifest = artifacts.find((a) => a.title === "Code change loop attempt 1");
    assert.ok(manifest, "attempt manifest artifact must be persisted");
    assert.match(manifest.summary ?? "", /status: applied_unverified/);
    assert.match(manifest.summary ?? "", /src\/a\.ts/);
    assert.match(manifest.summary ?? "", /npm run check/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runs approved patches without inventing validation provenance for a stub", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const patch = await createFilePatchApproval(state, taskRun.id, "src/a.ts");
    const check = await createShellApproval(state, taskRun.id, "npm run check");
    const { calls, executor } = makeRunner({
      [patch.id]: () => ({
        taskRunId: taskRun.id,
        stepId: "apply-patch",
        commandSummary: "file_patch src/a.ts",
        changedFiles: ["/tmp/proj/src/a.ts"],
        artifactIds: ["diff-patch"],
      }),
      [check.id]: () => ({
        taskRunId: taskRun.id,
        stepId: "verify-check",
        commandSummary: "npm run check",
        exitCode: 0,
        stdout: "ok",
        artifactIds: ["check-log"],
      }),
    });
    const service = new CodeChangeLoopService({ state, runner: executor });

    const result = await service.runAttempt({
      taskRunId: taskRun.id,
      changeApprovalIds: [patch.id],
      verificationApprovalIds: [check.id],
    });

    assert.deepEqual(calls, [patch.id, check.id]);
    assert.equal(result.status, "applied_unverified");
    assert.deepEqual(result.changedFiles, ["/tmp/proj/src/a.ts"]);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("marks the task quality_failed when approved verification fails", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const a = await createFileWriteApproval(state, taskRun.id, "src/a.ts");
    const fail = await createShellApproval(state, taskRun.id, "npm test");
    const skipped = await createShellApproval(state, taskRun.id, "npm run build");
    const { calls, executor } = makeRunner({
      [a.id]: () => ({
        taskRunId: taskRun.id,
        stepId: "apply-a",
        commandSummary: "file_write src/a.ts",
        changedFiles: ["/tmp/proj/src/a.ts"],
        artifactIds: ["diff-a"],
      }),
      [fail.id]: () => ({
        taskRunId: taskRun.id,
        stepId: "verify-test",
        commandSummary: "npm test",
        exitCode: 1,
        stdout: "",
        stderr: "test failed",
        artifactIds: ["test-log"],
      }),
      [skipped.id]: () => {
        throw new Error("later verification must not run");
      },
    });
    const service = new CodeChangeLoopService({ state, runner: executor });

    const result = await service.runAttempt({
      taskRunId: taskRun.id,
      changeApprovalIds: [a.id],
      verificationApprovalIds: [fail.id, skipped.id],
    });

    assert.deepEqual(calls, [a.id, fail.id]);
    assert.equal(result.status, "verification_failed");
    assert.equal(result.nextAction, "repair_required");
    assert.equal(result.verificationResults[0].exitCode, 1);
    const updatedTaskRun = await state.getTaskRun(taskRun.id);
    assert.equal(updatedTaskRun?.status, "quality_failed");
    const gate = await state.getLatestQualityGateResult(taskRun.id);
    assert.equal(gate?.status, "failed");
    assert.equal(gate?.testsPassed, undefined, "a generic command failure is not automatically a test result");
    assert.match(gate?.knownRisks.join("\n") ?? "", /npm test/);
    assert.ok(gate?.evidenceArtifactIds.includes("test-log"));
    assert.equal((await state.getApproval(fail.id))?.status, "rejected");
    assert.equal((await state.getApproval(skipped.id))?.status, "rejected");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("blocks the task when applying an approved change fails", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const a = await createFileWriteApproval(state, taskRun.id, "src/a.ts");
    const b = await createFileWriteApproval(state, taskRun.id, "src/b.ts");
    const check = await createShellApproval(state, taskRun.id, "npm run check");
    const { calls, executor } = makeRunner({
      [a.id]: () => ({
        taskRunId: taskRun.id,
        stepId: "apply-a",
        commandSummary: "file_write src/a.ts",
        changedFiles: ["/tmp/proj/src/a.ts"],
        artifactIds: ["diff-a"],
      }),
      [b.id]: () => {
        throw new Error("write failed");
      },
      [check.id]: () => {
        throw new Error("verification must not run after apply failure");
      },
    });
    const service = new CodeChangeLoopService({ state, runner: executor });

    const result = await service.runAttempt({
      taskRunId: taskRun.id,
      changeApprovalIds: [a.id, b.id],
      verificationApprovalIds: [check.id],
    });

    assert.deepEqual(calls, [a.id, b.id]);
    assert.equal(result.status, "apply_failed");
    assert.equal(result.nextAction, "blocked");
    assert.match(result.failureMessage ?? "", /write failed/);
    const updatedTaskRun = await state.getTaskRun(taskRun.id);
    assert.equal(updatedTaskRun?.status, "blocked");
    assert.equal((await state.getApproval(b.id))?.status, "rejected");
    assert.equal((await state.getApproval(check.id))?.status, "rejected");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("treats stale file_patch context as repairable apply failure", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const patch = await createFilePatchApproval(state, taskRun.id, "src/a.ts");
    const check = await createShellApproval(state, taskRun.id, "npm run check");
    const { calls, executor } = makeRunner({
      [patch.id]: () => {
        const error = new Error("Patch context mismatch at line 239: expected \"\"");
        error.code = "RUNNER_PATCH_CONTEXT_MISMATCH";
        throw error;
      },
      [check.id]: () => {
        throw new Error("verification must not run after apply failure");
      },
    });
    const service = new CodeChangeLoopService({ state, runner: executor });

    const result = await service.runAttempt({
      taskRunId: taskRun.id,
      changeApprovalIds: [patch.id],
      verificationApprovalIds: [check.id],
    });

    assert.deepEqual(calls, [patch.id]);
    assert.equal(result.status, "apply_failed");
    assert.equal(result.nextAction, "repair_required");
    assert.match(result.failureMessage ?? "", /Patch context mismatch/);
    const updatedTaskRun = await state.getTaskRun(taskRun.id);
    assert.equal(updatedTaskRun?.status, "quality_failed");
    const gate = await state.getLatestQualityGateResult(taskRun.id);
    assert.equal(gate?.status, "failed");
    assert.match(gate?.knownRisks.join("\n") ?? "", /Patch context mismatch/);
    assert.equal(gate?.changedFilesReviewed, false);
    assert.equal((await state.getApproval(patch.id))?.status, "rejected");
    assert.equal((await state.getApproval(check.id))?.status, "rejected");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("records a no-op attempt when there are no approved actions to execute", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const { calls, executor } = makeRunner();
    const service = new CodeChangeLoopService({ state, runner: executor });

    const result = await service.runAttempt({
      taskRunId: taskRun.id,
      changeApprovalIds: [],
      verificationApprovalIds: [],
    });

    assert.deepEqual(calls, []);
    assert.equal(result.status, "no_changes");
    assert.equal(result.nextAction, "ready_for_review");
    const updatedTaskRun = await state.getTaskRun(taskRun.id);
    assert.equal(updatedTaskRun?.status, "ready_for_review");
    const artifacts = await state.listArtifactsByTaskRun(taskRun.id);
    assert.ok(artifacts.some((a) => a.title === "Code change loop attempt 1"));
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("auto-increments attempt numbers when the caller does not provide one", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const { executor } = makeRunner();
    const service = new CodeChangeLoopService({ state, runner: executor });

    const first = await service.runAttempt({
      taskRunId: taskRun.id,
      changeApprovalIds: [],
      verificationApprovalIds: [],
    });
    const second = await service.runAttempt({
      taskRunId: taskRun.id,
      changeApprovalIds: [],
      verificationApprovalIds: [],
    });

    assert.equal(first.attemptNumber, 1);
    assert.equal(second.attemptNumber, 2);
    const artifacts = await state.listArtifactsByTaskRun(taskRun.id);
    assert.ok(artifacts.some((a) => a.title === "Code change loop attempt 1"));
    assert.ok(artifacts.some((a) => a.title === "Code change loop attempt 2"));
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("respects an explicit attempt number from callers", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const { executor } = makeRunner();
    const service = new CodeChangeLoopService({ state, runner: executor });

    const result = await service.runAttempt({
      taskRunId: taskRun.id,
      changeApprovalIds: [],
      verificationApprovalIds: [],
      attemptNumber: 7,
    });

    assert.equal(result.attemptNumber, 7);
    const artifacts = await state.listArtifactsByTaskRun(taskRun.id);
    assert.ok(artifacts.some((a) => a.title === "Code change loop attempt 7"));
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("refuses to run an approval that is not approved", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const approval = await createFileWriteApproval(state, taskRun.id, "src/a.ts");
    await state.setApprovalProposedAction(approval.id, approval.proposedAction);
    const { executor } = makeRunner();
    const service = new CodeChangeLoopService({ state, runner: executor });

    await assert.rejects(
      () =>
        service.runAttempt({
          taskRunId: taskRun.id,
          changeApprovalIds: [approval.id],
        }),
      (e) => e.code === "CODE_CHANGE_APPROVAL_NOT_APPROVED",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
