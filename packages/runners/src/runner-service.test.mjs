import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDb,
  closeDb,
  LocalStateService,
  FilesystemArtifactStore,
} from "../../../packages/storage/src/index.ts";
import { ConversationService } from "../../../packages/core/src/index.ts";
import { RunnerService, RunnerError } from "./runner-service.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-runner-"));
  return {
    dir,
    db: join(dir, "test.db"),
    artifacts: join(dir, "artifacts"),
    target: join(dir, "target"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const setup = async (t) => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(t.target, { recursive: true });
  const db = openDb({ filePath: t.db });
  const state = new LocalStateService(db);
  const artifactStore = new FilesystemArtifactStore({ rootDir: t.artifacts });
  const conversation = new ConversationService({
    state,
    pathExists: async () => true,
  });
  const runner = new RunnerService({ state, artifactStore });
  return { db, state, artifactStore, conversation, runner };
};

test("executeApproved refuses when approval is still pending", async () => {
  const t = tmp();
  try {
    const { db, conversation, runner } = await setup(t);
    try {
      const draft = await conversation.createTask({
        userRequest: "x",
        targetDir: t.target,
      });
      const approval = draft.approvals[0];
      await assert.rejects(
        () => runner.executeApproved(approval.id),
        (e) => e instanceof RunnerError && e.code === "RUNNER_APPROVAL_REQUIRED",
      );
    } finally {
      closeDb(db);
    }
  } finally {
    t.cleanup();
  }
});

test("executeApproved fails when proposedAction is missing", async () => {
  const t = tmp();
  try {
    const { db, conversation, runner } = await setup(t);
    try {
      const draft = await conversation.createTask({
        userRequest: "x",
        targetDir: t.target,
      });
      const approval = draft.approvals[0];
      await conversation.approve({ approvalId: approval.id });
      await assert.rejects(
        () => runner.executeApproved(approval.id),
        (e) =>
          e instanceof RunnerError && e.code === "RUNNER_EXECUTION_FAILED",
      );
    } finally {
      closeDb(db);
    }
  } finally {
    t.cleanup();
  }
});

test("file_write writes inside targetDir and emits diff artifact", async () => {
  const t = tmp();
  try {
    const { db, state, conversation, runner } = await setup(t);
    try {
      const draft = await conversation.createTask({
        userRequest: "x",
        targetDir: t.target,
      });
      const approval = draft.approvals[0];
      await conversation.setProposedAction(approval.id, {
        type: "file_write",
        filePatch: { path: "hello.txt", after: "hello world\n" },
      });
      await conversation.approve({ approvalId: approval.id });
      const r = await runner.executeApproved(approval.id);
      assert.ok(r.changedFiles?.[0]);

      const written = readFileSync(join(t.target, "hello.txt"), "utf8");
      assert.equal(written, "hello world\n");

      const artifacts = await state.listArtifactsByTaskRun(approval.taskRunId);
      assert.ok(artifacts.some((a) => a.kind === "diff"));

      const executedApproval = await state.getApproval(approval.id);
      assert.equal(executedApproval.status, "executed");

      const updatedTaskRun = await state.getTaskRun(approval.taskRunId);
      assert.notEqual(updatedTaskRun.status, "blocked");
    } finally {
      closeDb(db);
    }
  } finally {
    t.cleanup();
  }
});

test("executeApproved refuses to re-run an executed approval directly", async () => {
  const t = tmp();
  try {
    const { db, state, conversation, runner } = await setup(t);
    try {
      const draft = await conversation.createTask({
        userRequest: "x",
        targetDir: t.target,
      });
      const approval = draft.approvals[0];
      await conversation.setProposedAction(approval.id, {
        type: "file_write",
        filePatch: { path: "once.txt", after: "one\n" },
      });
      await conversation.approve({ approvalId: approval.id });
      await runner.executeApproved(approval.id);

      const executedApproval = await state.getApproval(approval.id);
      assert.equal(executedApproval.status, "executed");
      await assert.rejects(
        () => runner.executeApproved(approval.id),
        (e) => e instanceof RunnerError && e.code === "RUNNER_APPROVAL_REQUIRED",
      );
    } finally {
      closeDb(db);
    }
  } finally {
    t.cleanup();
  }
});

test("file_write outside targetDir is rejected before disk write", async () => {
  const t = tmp();
  try {
    const { db, conversation, runner } = await setup(t);
    try {
      const draft = await conversation.createTask({
        userRequest: "x",
        targetDir: t.target,
      });
      const approval = draft.approvals[0];
      await conversation.setProposedAction(approval.id, {
        type: "file_write",
        filePatch: { path: "../../escape.txt", after: "no" },
      });
      await conversation.approve({ approvalId: approval.id });
      await assert.rejects(
        () => runner.executeApproved(approval.id),
        (e) =>
          e instanceof RunnerError &&
          e.code === "RUNNER_TARGET_OUTSIDE_WORKSPACE",
      );
    } finally {
      closeDb(db);
    }
  } finally {
    t.cleanup();
  }
});

test("dependency_install is blocked at the runner gate", async () => {
  const t = tmp();
  try {
    const { db, state, conversation, runner } = await setup(t);
    try {
      // Create a TaskRun manually with a dependency_install approval to
      // test the high-risk block, since the deterministic plan-drafter
      // only emits file_write actions.
      const thread = await state.createThread({
        title: "x",
        targetDir: t.target,
      });
      const tr = await state.createTaskRun({
        threadId: thread.id,
        userRequest: "x",
        targetDir: t.target,
      });
      const step = await state.createStep({
        taskRunId: tr.id,
        index: 0,
        kind: "approval",
        title: "approval",
      });
      const cp = await state.createCheckpoint({
        taskRunId: tr.id,
        stepId: step.id,
        reason: "before_edit",
        stateRef: "{}",
        summary: "test",
      });
      const approval = await state.createApproval({
        taskRunId: tr.id,
        checkpointId: cp.id,
        actionType: "dependency_install",
        actionSummary: "install lodash",
      });
      await state.setApprovalProposedAction(approval.id, {
        type: "dependency_install",
        command: "npm install lodash",
      });
      await state.decideApproval(approval.id, "approved");

      await assert.rejects(
        () => runner.executeApproved(approval.id),
        (e) =>
          e instanceof RunnerError && e.code === "RUNNER_BLOCKED_HIGH_RISK",
      );
    } finally {
      closeDb(db);
    }
  } finally {
    t.cleanup();
  }
});

test("retryApproval refuses when TaskRun is not blocked/quality_failed", async () => {
  const t = tmp();
  try {
    const { db, state, conversation, runner } = await setup(t);
    try {
      const draft = await conversation.createTask({
        userRequest: "x",
        targetDir: t.target,
      });
      const approval = draft.approvals[0];
      await state.setApprovalProposedAction(approval.id, {
        type: "file_write",
        filePatch: { path: "a.txt", after: "hi" },
      });
      await state.decideApproval(approval.id, "approved");

      // TaskRun is still waiting_for_approval here, not blocked.
      await assert.rejects(
        () => runner.retryApproval(approval.id),
        (e) =>
          e instanceof RunnerError && e.code === "RUNNER_RETRY_NOT_BLOCKED",
      );
    } finally {
      closeDb(db);
    }
  } finally {
    t.cleanup();
  }
});

test("shell + recognised test command surfaces as a 'test' step", async () => {
  const t = tmp();
  try {
    const { db, state, conversation, runner } = await setup(t);
    try {
      const draft = await conversation.createTask({
        userRequest: "x",
        targetDir: t.target,
      });
      const tr = draft.taskRun;
      const cp = draft.checkpoint;
      const approval = await state.createApproval({
        taskRunId: tr.id,
        checkpointId: cp.id,
        actionType: "shell",
        actionSummary: "npm test --silent",
      });
      await state.setApprovalProposedAction(approval.id, {
        type: "shell",
        command: "npm test --silent",
      });
      await state.decideApproval(approval.id, "approved");

      // Driving runShell against a real shell would slow the suite and
      // depend on the host having Node — instead assert that the step
      // gets created with kind="test" before any execution side effect
      // by inspecting state right after the failure path completes.
      try {
        await runner.executeApproved(approval.id);
      } catch {
        // Test command may fail in this sandbox — that's fine; we only
        // care that the runner classified the step kind correctly.
      }
      const steps = await state.listStepsByTaskRun(tr.id);
      const runnerStep = steps.find(
        (s) => s.title.startsWith("test:") || s.kind === "test",
      );
      assert.ok(runnerStep, "expected a runner step kinded as 'test'");
      assert.equal(runnerStep.kind, "test");
    } finally {
      closeDb(db);
    }
  } finally {
    t.cleanup();
  }
});

test("shell step stores actual command for build evidence", async () => {
  const t = tmp();
  try {
    const { db, state, artifactStore, conversation } = await setup(t);
    const runner = new RunnerService({
      state,
      artifactStore,
      shellRunner: {
        run: async () => ({
          stdout: "built\n",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
      },
    });
    try {
      const draft = await conversation.createTask({
        userRequest: "x",
        targetDir: t.target,
      });
      const approval = await state.createApproval({
        taskRunId: draft.taskRun.id,
        checkpointId: draft.checkpoint.id,
        actionType: "shell",
        actionSummary: "execute command",
      });
      await state.setApprovalProposedAction(approval.id, {
        type: "shell",
        command: "npm run build",
      });
      await state.decideApproval(approval.id, "approved");

      await runner.executeApproved(approval.id);

      const steps = await state.listStepsByTaskRun(draft.taskRun.id);
      const runnerStep = steps.find((s) => s.kind === "shell");
      assert.ok(runnerStep, "expected shell runner step");
      assert.equal(runnerStep.title, "shell: npm run build");
      assert.equal(runnerStep.inputSummary, "npm run build");
    } finally {
      closeDb(db);
    }
  } finally {
    t.cleanup();
  }
});

test("shell approvals use generous hard timeout with idle timeout", async () => {
  const t = tmp();
  try {
    const { db, state, artifactStore, conversation } = await setup(t);
    let seen;
    const runner = new RunnerService({
      state,
      artifactStore,
      shellRunner: {
        run: async (input) => {
          seen = input;
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
            durationMs: 1,
            command: input.command,
            cwd: input.cwd,
          };
        },
      },
    });
    try {
      const draft = await conversation.createTask({
        userRequest: "x",
        targetDir: t.target,
      });
      const approval = await state.createApproval({
        taskRunId: draft.taskRun.id,
        checkpointId: draft.checkpoint.id,
        actionType: "shell",
        actionSummary: "execute command",
      });
      await state.setApprovalProposedAction(approval.id, {
        type: "shell",
        command: "node -v",
      });
      await state.decideApproval(approval.id, "approved");

      await runner.executeApproved(approval.id);

      assert.equal(seen.timeoutMs, 30 * 60_000);
      assert.equal(seen.idleTimeoutMs, 10 * 60_000);
    } finally {
      closeDb(db);
    }
  } finally {
    t.cleanup();
  }
});

test("test approvals use longer hard timeout with idle timeout", async () => {
  const t = tmp();
  try {
    const { db, state, artifactStore, conversation } = await setup(t);
    let seen;
    const runner = new RunnerService({
      state,
      artifactStore,
      testRunner: {
        run: async (input) => {
          seen = input;
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
            durationMs: 1,
            command: input.command,
            cwd: input.cwd,
            passed: true,
          };
        },
      },
    });
    try {
      const draft = await conversation.createTask({
        userRequest: "x",
        targetDir: t.target,
      });
      const approval = await state.createApproval({
        taskRunId: draft.taskRun.id,
        checkpointId: draft.checkpoint.id,
        actionType: "shell",
        actionSummary: "execute tests",
      });
      await state.setApprovalProposedAction(approval.id, {
        type: "shell",
        command: "npm test -- --runInBand",
      });
      await state.decideApproval(approval.id, "approved");

      await runner.executeApproved(approval.id);

      assert.equal(seen.timeoutMs, 45 * 60_000);
      assert.equal(seen.idleTimeoutMs, 10 * 60_000);
    } finally {
      closeDb(db);
    }
  } finally {
    t.cleanup();
  }
});

test("artifact DB id matches file id so readArtifact does not ENOENT", async () => {
  const t = tmp();
  try {
    const { db, state, artifactStore, conversation, runner } = await setup(t);
    try {
      const draft = await conversation.createTask({
        userRequest: "x",
        targetDir: t.target,
      });
      const approval = draft.approvals[0];
      await conversation.setProposedAction(approval.id, {
        type: "file_write",
        filePatch: { path: "check.txt", after: "content\n" },
      });
      await conversation.approve({ approvalId: approval.id });
      await runner.executeApproved(approval.id);

      const artifacts = await state.listArtifactsByTaskRun(approval.taskRunId);
      const diffArtifact = artifacts.find((a) => a.kind === "diff");
      assert.ok(diffArtifact, "diff artifact must exist in DB");

      // The artifact's DB id must match the file written to disk.
      // Before the fix, these were different ids → ENOENT.
      const content = await artifactStore.read({
        taskRunId: approval.taskRunId,
        artifactId: diffArtifact.id,
        kind: "diff",
      });
      assert.ok(content.length > 0, "artifact file must be readable via DB id");
    } finally {
      closeDb(db);
    }
  } finally {
    t.cleanup();
  }
});

test("retryApproval succeeds when TaskRun is blocked", async () => {
  const t = tmp();
  try {
    const { db, state, conversation, runner } = await setup(t);
    try {
      const draft = await conversation.createTask({
        userRequest: "x",
        targetDir: t.target,
      });
      const approval = draft.approvals[0];
      await state.setApprovalProposedAction(approval.id, {
        type: "file_write",
        filePatch: { path: "retry.txt", after: "hello" },
      });
      await state.decideApproval(approval.id, "approved");
      // Force the TaskRun into blocked status to simulate a prior failure.
      await state.setTaskRunStatus(draft.taskRun.id, "blocked");

      const result = await runner.retryApproval(approval.id);
      assert.equal(result.taskRunId, draft.taskRun.id);
      assert.ok(result.artifactIds.length >= 1);
    } finally {
      closeDb(db);
    }
  } finally {
    t.cleanup();
  }
});

test("retryApproval can re-run an executed approval when quality_failed", async () => {
  const t = tmp();
  try {
    const { db, state, conversation, runner } = await setup(t);
    try {
      const draft = await conversation.createTask({
        userRequest: "x",
        targetDir: t.target,
      });
      const approval = draft.approvals[0];
      await conversation.setProposedAction(approval.id, {
        type: "file_write",
        filePatch: { path: "retry-executed.txt", after: "hello" },
      });
      await conversation.approve({ approvalId: approval.id });
      await runner.executeApproved(approval.id);

      const executedApproval = await state.getApproval(approval.id);
      assert.equal(executedApproval.status, "executed");

      await state.setTaskRunStatus(draft.taskRun.id, "quality_failed");
      const result = await runner.retryApproval(approval.id);
      assert.equal(result.taskRunId, draft.taskRun.id);
      assert.ok(result.artifactIds.length >= 1);
    } finally {
      closeDb(db);
    }
  } finally {
    t.cleanup();
  }
});
