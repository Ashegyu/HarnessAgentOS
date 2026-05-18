import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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

const tmpUnderCwd = () => {
  const parent = join(process.cwd(), "workspace");
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, "hgos-runner-"));
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async (predicate, message) => {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await wait(5);
  }
  assert.fail(message);
};

const withTimeout = async (promise, ms, message) =>
  Promise.race([
    promise,
    wait(ms).then(() => {
      throw new Error(message);
    }),
  ]);

const fakeRunnerHarness = (input = {}) => {
  const now = "2026-05-18T00:00:00.000Z";
  const taskRun = {
    id: input.taskRunId ?? "task_1",
    threadId: "thread_1",
    userRequest: "run",
    targetDir: process.cwd(),
    status: "waiting_for_approval",
    createdAt: now,
    updatedAt: now,
  };
  const approval = {
    id: input.approvalId ?? "approval_1",
    taskRunId: taskRun.id,
    checkpointId: "checkpoint_1",
    actionType: "shell",
    actionSummary: input.command ?? "node -v",
    status: "approved",
    proposedAction: {
      type: "shell",
      command: input.command ?? "node -v",
    },
    createdAt: now,
    updatedAt: now,
  };
  const checkpointStep = {
    id: "checkpoint_step_1",
    taskRunId: taskRun.id,
    index: 0,
    kind: "approval",
    title: "approval",
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  const checkpoint = {
    id: approval.checkpointId,
    taskRunId: taskRun.id,
    stepId: checkpointStep.id,
    reason: "before_edit",
    stateRef: "{}",
    summary: "test",
    createdAt: now,
  };
  const steps = [checkpointStep];
  const artifacts = [];
  const statuses = [];
  const state = {
    getApproval: async (id) => (id === approval.id ? approval : null),
    getTaskRun: async (id) => (id === taskRun.id ? taskRun : null),
    listStepsByTaskRun: async () => steps,
    createStep: async (stepInput) => {
      const step = {
        id: `step_${steps.length + 1}`,
        createdAt: now,
        updatedAt: now,
        status: stepInput.status ?? "pending",
        ...stepInput,
      };
      steps.push(step);
      return step;
    },
    setTaskRunCurrentStep: async (_id, stepId) => {
      taskRun.currentStepId = stepId;
      return taskRun;
    },
    setTaskRunStatus: async (_id, status) => {
      statuses.push(status);
      taskRun.status = status;
      taskRun.updatedAt = now;
      return taskRun;
    },
    setStepStatus: async (id, status, patch = {}) => {
      const step = steps.find((s) => s.id === id);
      if (step) {
        step.status = status;
        Object.assign(step, patch);
      }
      return step;
    },
    decideApproval: async (_id, status, message) => {
      approval.status = status;
      approval.decisionMessage = message;
      return approval;
    },
    listApprovalsByTaskRun: async () => [approval],
    listCheckpointsByTaskRun: async () => [checkpoint],
    createArtifact: async (artifactInput) => {
      const artifact = {
        createdAt: now,
        updatedAt: now,
        ...artifactInput,
      };
      artifacts.push(artifact);
      return artifact;
    },
  };
  const artifactStore = {
    write: async ({ taskRunId, artifactId, kind }) => ({
      uri: `artifact://${taskRunId}/${kind}/${artifactId}`,
    }),
  };
  return { approval, artifactStore, artifacts, state, statuses, taskRun };
};

test("cancelExecution returns false for a taskRun without inflight execution", async () => {
  const harness = fakeRunnerHarness();
  const runner = new RunnerService({
    state: harness.state,
    artifactStore: harness.artifactStore,
  });

  assert.deepEqual(await runner.cancelExecution({ taskRunId: "missing" }), {
    cancelled: false,
  });
});

test("cancelExecution aborts inflight shell execution and marks TaskRun cancelled", async () => {
  const harness = fakeRunnerHarness({ command: "node long-running.js" });
  let seenSignal;
  let shellStarted = false;
  const runner = new RunnerService({
    state: harness.state,
    artifactStore: harness.artifactStore,
    shellRunner: {
      run: async (input) =>
        new Promise((_resolve, reject) => {
          seenSignal = input.signal;
          shellStarted = true;
          input.signal?.addEventListener(
            "abort",
            () => {
              const err = new Error("cancelled");
              err.code = "RUNNER_CANCELLED";
              reject(err);
            },
            { once: true },
          );
        }),
    },
  });

  const run = runner.executeApproved(harness.approval.id);
  await waitUntil(() => shellStarted, "shell runner was not started");

  assert.deepEqual(
    await runner.cancelExecution({ taskRunId: harness.taskRun.id }),
    { cancelled: true },
  );
  assert.equal(seenSignal instanceof AbortSignal, true);
  assert.equal(seenSignal.aborted, true);
  await assert.rejects(
    () => withTimeout(run, 100, "executeApproved did not settle after cancel"),
    (e) => e instanceof RunnerError && e.code === "RUNNER_CANCELLED",
  );
  assert.equal(harness.taskRun.status, "cancelled");
  assert.deepEqual(harness.statuses.slice(-2), ["running", "cancelled"]);
});

test("executeApproved can run again after a cancelled shell execution", async () => {
  const harness = fakeRunnerHarness({ command: "node maybe-long-running.js" });
  let callCount = 0;
  let firstShellStarted = false;
  const runner = new RunnerService({
    state: harness.state,
    artifactStore: harness.artifactStore,
    shellRunner: {
      run: async (input) => {
        callCount += 1;
        if (callCount === 1) {
          firstShellStarted = true;
          return new Promise((_resolve, reject) => {
            input.signal?.addEventListener(
              "abort",
              () => {
                const err = new Error("cancelled");
                err.code = "RUNNER_CANCELLED";
                reject(err);
              },
              { once: true },
            );
          });
        }
        return {
          stdout: "ok\n",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
          command: input.command,
          cwd: input.cwd,
        };
      },
    },
  });

  const firstRun = runner.executeApproved(harness.approval.id);
  await waitUntil(() => firstShellStarted, "first shell runner was not started");
  await runner.cancelExecution({ taskRunId: harness.taskRun.id });
  await assert.rejects(
    () =>
      withTimeout(firstRun, 100, "first executeApproved did not settle"),
    (e) => e instanceof RunnerError && e.code === "RUNNER_CANCELLED",
  );
  assert.deepEqual(
    await runner.cancelExecution({ taskRunId: harness.taskRun.id }),
    { cancelled: false },
  );

  const secondRun = await runner.executeApproved(harness.approval.id);
  assert.equal(secondRun.exitCode, 0);
  assert.equal(callCount, 2);
  assert.equal(harness.taskRun.status, "ready_for_review");
});

test("test command execution receives the TaskRun abort signal", async () => {
  const harness = fakeRunnerHarness({ command: "npm test -- --runInBand" });
  let seenSignal;
  const runner = new RunnerService({
    state: harness.state,
    artifactStore: harness.artifactStore,
    testRunner: {
      run: async (input) => {
        seenSignal = input.signal;
        return {
          stdout: "ok\n",
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

  await runner.executeApproved(harness.approval.id);

  assert.equal(seenSignal instanceof AbortSignal, true);
  assert.equal(seenSignal.aborted, false);
});

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

      const approvalStep = (await state.listStepsByTaskRun(approval.taskRunId))
        .find((s) => s.id === draft.checkpoint.stepId);
      assert.equal(approvalStep.status, "succeeded");

      const updatedTaskRun = await state.getTaskRun(approval.taskRunId);
      assert.equal(updatedTaskRun.status, "ready_for_review");
    } finally {
      closeDb(db);
    }
  } finally {
    t.cleanup();
  }
});

test("file_write normalizes cwd-relative targetDir paths before execution", async () => {
  const t = tmpUnderCwd();
  try {
    const { db, conversation, runner } = await setup(t);
    try {
      const draft = await conversation.createTask({
        userRequest: "x",
        targetDir: t.target,
      });
      const approval = draft.approvals[0];
      const cwdRelativeTargetFile = relative(
        process.cwd(),
        join(t.target, "README.md"),
      );
      await conversation.setProposedAction(approval.id, {
        type: "file_write",
        filePatch: { path: cwdRelativeTargetFile, after: "# Hello\n" },
      });
      await conversation.approve({ approvalId: approval.id });

      await runner.executeApproved(approval.id);

      assert.equal(readFileSync(join(t.target, "README.md"), "utf8"), "# Hello\n");
      assert.equal(existsSync(join(t.target, cwdRelativeTargetFile)), false);
    } finally {
      closeDb(db);
    }
  } finally {
    t.cleanup();
  }
});

test("executeApproved keeps approval step pending until sibling approvals resolve", async () => {
  const t = tmp();
  try {
    const { db, state, conversation, runner } = await setup(t);
    try {
      const draft = await conversation.createTask({
        userRequest: "x",
        targetDir: t.target,
      });
      const first = draft.approvals[0];
      const second = await state.createApproval({
        taskRunId: draft.taskRun.id,
        checkpointId: draft.checkpoint.id,
        actionType: "file_write",
        actionSummary: "second file",
      });
      await conversation.setProposedAction(first.id, {
        type: "file_write",
        filePatch: { path: "one.txt", after: "one\n" },
      });
      await conversation.setProposedAction(second.id, {
        type: "file_write",
        filePatch: { path: "two.txt", after: "two\n" },
      });
      await conversation.approve({ approvalId: first.id });
      await conversation.approve({ approvalId: second.id });

      await runner.executeApproved(first.id);

      let approvalStep = (await state.listStepsByTaskRun(draft.taskRun.id))
        .find((s) => s.id === draft.checkpoint.stepId);
      assert.equal(approvalStep.status, "pending");
      let updatedTaskRun = await state.getTaskRun(draft.taskRun.id);
      assert.equal(updatedTaskRun.status, "waiting_for_approval");

      await runner.executeApproved(second.id);

      approvalStep = (await state.listStepsByTaskRun(draft.taskRun.id))
        .find((s) => s.id === draft.checkpoint.stepId);
      assert.equal(approvalStep.status, "succeeded");
      updatedTaskRun = await state.getTaskRun(draft.taskRun.id);
      assert.equal(updatedTaskRun.status, "ready_for_review");
    } finally {
      closeDb(db);
    }
  } finally {
    t.cleanup();
  }
});

test("file_write modifies an existing file and records before/after diff", async () => {
  const t = tmp();
  try {
    const { db, state, conversation, runner } = await setup(t);
    try {
      writeFileSync(join(t.target, "existing.txt"), "old\n", "utf8");
      const draft = await conversation.createTask({
        userRequest: "x",
        targetDir: t.target,
      });
      const approval = draft.approvals[0];
      await conversation.setProposedAction(approval.id, {
        type: "file_write",
        filePatch: {
          path: "existing.txt",
          before: "old\n",
          after: "new\n",
        },
      });
      await conversation.approve({ approvalId: approval.id });
      await runner.executeApproved(approval.id);

      assert.equal(readFileSync(join(t.target, "existing.txt"), "utf8"), "new\n");
      const artifacts = await state.listArtifactsByTaskRun(approval.taskRunId);
      const diff = artifacts.find((a) => a.kind === "diff");
      assert.ok(diff, "diff artifact must exist");
      assert.match(diff.summary, /bytes written/);
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

test("executeApproved refuses approvals with blocked policy evaluation", async () => {
  const t = tmp();
  try {
    const { db, state, conversation, runner } = await setup(t);
    try {
      const draft = await conversation.createTask({
        userRequest: "x",
        targetDir: t.target,
      });
      const approval = await state.createApproval({
        taskRunId: draft.taskRun.id,
        checkpointId: draft.checkpoint.id,
        actionType: "file_write",
        actionSummary: "blocked write",
        policyEvaluation: {
          operation: {
            kind: "path_violation",
            name: "target_outside_workspace",
          },
          decision: "blocked",
          riskLevel: "blocked",
          allowAutoApprove: false,
          reason: "outside workspace",
        },
      });
      await state.setApprovalProposedAction(approval.id, {
        type: "file_write",
        filePatch: { path: "blocked.txt", after: "no\n" },
      });
      await state.decideApproval(approval.id, "approved");

      await assert.rejects(
        () => runner.executeApproved(approval.id),
        (e) => e instanceof RunnerError && e.code === "RUNNER_POLICY_BLOCKED",
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
