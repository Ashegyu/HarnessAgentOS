import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAutoApprovedExecutionPlan,
  CODE_CHANGE_REPAIR_INSTRUCTION,
  runAutoApprovedExecutionPlan,
  shouldAutoCreateRepairPlanAfterAttempt,
} from "./auto-execution-plan.ts";

const approval = (id, actionType) => ({
  id,
  taskRunId: "task_1",
  checkpointId: "checkpoint_1",
  actionType,
  actionSummary: `${actionType} ${id}`,
  status: "pending",
});

const fileWriteApproval = (id) => ({
  ...approval(id, "file_write"),
  proposedAction: {
    type: "file_write",
    filePatch: {
      path: `src/${id}.ts`,
      after: `export const ${id.replaceAll("_", "")} = true;\n`,
    },
  },
});

const filePatchApproval = (id) => ({
  ...approval(id, "file_patch"),
  proposedAction: {
    type: "file_patch",
    unifiedPatch: {
      path: `src/${id}.ts`,
      patch: [
        `--- a/src/${id}.ts`,
        `+++ b/src/${id}.ts`,
        "@@ -1 +1 @@",
        "-export const oldValue = false;",
        "+export const newValue = true;",
        "",
      ].join("\n"),
    },
  },
});

const shellApproval = (id, command = "npm run check") => ({
  ...approval(id, "shell"),
  proposedAction: {
    type: "shell",
    command,
  },
});

test("buildAutoApprovedExecutionPlan batches file writes and trailing shell checks", () => {
  const plan = buildAutoApprovedExecutionPlan("task_1", [
    fileWriteApproval("write_a"),
    fileWriteApproval("write_b"),
    shellApproval("test"),
  ]);

  assert.deepEqual(plan.orchestrationApprovalIds, []);
  assert.deepEqual(plan.advisoryApprovalIds, []);
  assert.deepEqual(plan.individualRunnerApprovalIds, []);
  assert.deepEqual(plan.codeChangeAttempt, {
    taskRunId: "task_1",
    changeApprovalIds: ["write_a", "write_b"],
    verificationApprovalIds: ["test"],
  });
});

test("buildAutoApprovedExecutionPlan batches file patches with file writes and trailing shell checks", () => {
  const plan = buildAutoApprovedExecutionPlan("task_1", [
    filePatchApproval("patch_a"),
    fileWriteApproval("write_b"),
    shellApproval("test"),
  ]);

  assert.deepEqual(plan.individualRunnerApprovalIds, []);
  assert.deepEqual(plan.codeChangeAttempt, {
    taskRunId: "task_1",
    changeApprovalIds: ["patch_a", "write_b"],
    verificationApprovalIds: ["test"],
  });
});

test("buildAutoApprovedExecutionPlan keeps shell-only approvals on the legacy runner path", () => {
  const plan = buildAutoApprovedExecutionPlan("task_1", [
    shellApproval("check"),
  ]);

  assert.equal(plan.codeChangeAttempt, null);
  assert.deepEqual(plan.individualRunnerApprovalIds, ["check"]);
});

test("buildAutoApprovedExecutionPlan preserves ambiguous interleaved runner order", () => {
  const plan = buildAutoApprovedExecutionPlan("task_1", [
    fileWriteApproval("write_a"),
    shellApproval("check"),
    filePatchApproval("patch_b"),
  ]);

  assert.equal(plan.codeChangeAttempt, null);
  assert.deepEqual(plan.individualRunnerApprovalIds, [
    "write_a",
    "check",
    "patch_b",
  ]);
});

test("buildAutoApprovedExecutionPlan separates orchestration and advisory approvals", () => {
  const plan = buildAutoApprovedExecutionPlan("task_1", [
    approval("plan", "orchestration_plan"),
    approval("capability", "capability_use"),
    approval("model", "model_use"),
    fileWriteApproval("write"),
  ]);

  assert.deepEqual(plan.orchestrationApprovalIds, ["plan"]);
  assert.deepEqual(plan.advisoryApprovalIds, ["capability", "model"]);
  assert.deepEqual(plan.individualRunnerApprovalIds, []);
  assert.deepEqual(plan.codeChangeAttempt, {
    taskRunId: "task_1",
    changeApprovalIds: ["write"],
    verificationApprovalIds: [],
  });
});

test("buildAutoApprovedExecutionPlan skips runner approvals without proposedAction", () => {
  const plan = buildAutoApprovedExecutionPlan("task_1", [
    approval("missing", "file_write"),
    shellApproval("check"),
  ]);

  assert.equal(plan.codeChangeAttempt, null);
  assert.deepEqual(plan.individualRunnerApprovalIds, ["check"]);
  assert.deepEqual(plan.skippedRunnerApprovalIds, ["missing"]);
});

test("buildAutoApprovedExecutionPlan skips runner approvals with mismatched proposedAction type", () => {
  const plan = buildAutoApprovedExecutionPlan("task_1", [
    {
      ...approval("mismatch", "file_write"),
      proposedAction: {
        type: "shell",
        command: "npm run check",
      },
    },
    fileWriteApproval("write"),
  ]);

  assert.deepEqual(plan.skippedRunnerApprovalIds, ["mismatch"]);
  assert.deepEqual(plan.codeChangeAttempt?.changeApprovalIds, ["write"]);
});

test("buildAutoApprovedExecutionPlan skips malformed runner proposedAction payloads", () => {
  const plan = buildAutoApprovedExecutionPlan("task_1", [
    {
      ...approval("malformed", "shell"),
      proposedAction: {
        type: "shell",
        command: "",
      },
    },
    shellApproval("check"),
  ]);

  assert.deepEqual(plan.skippedRunnerApprovalIds, ["malformed"]);
  assert.deepEqual(plan.individualRunnerApprovalIds, ["check"]);
});

test("shouldAutoCreateRepairPlanAfterAttempt requires pipeline consent and repair_required result", () => {
  assert.equal(
    shouldAutoCreateRepairPlanAfterAttempt({
      isPipelineAutoTask: true,
      nextAction: "repair_required",
    }),
    true,
  );
  assert.equal(
    shouldAutoCreateRepairPlanAfterAttempt({
      isPipelineAutoTask: false,
      nextAction: "repair_required",
    }),
    false,
  );
  assert.equal(
    shouldAutoCreateRepairPlanAfterAttempt({
      isPipelineAutoTask: true,
      nextAction: "ready_for_review",
    }),
    false,
  );
});

test("runAutoApprovedExecutionPlan creates a repair plan after a failed pipeline code-change attempt", async () => {
  const calls = [];
  const plan = {
    orchestrationApprovalIds: [],
    advisoryApprovalIds: [],
    individualRunnerApprovalIds: [],
    codeChangeAttempt: {
      taskRunId: "task_1",
      changeApprovalIds: ["write"],
      verificationApprovalIds: ["test"],
    },
  };

  const result = await runAutoApprovedExecutionPlan({
    executionPlan: plan,
    isPipelineAutoTask: true,
    api: {
      runOrchestrationApproved: async (input) => calls.push(["orch", input]),
      executeCodeChangeAttempt: async (input) => {
        calls.push(["code", input]);
        return { taskRunId: input.taskRunId, nextAction: "repair_required" };
      },
      createRepairPlan: async (input) => calls.push(["repair", input]),
      executeApproved: async (input) => calls.push(["runner", input]),
    },
  });

  assert.deepEqual(result, {
    failedApprovalIds: [],
    repairPlanTaskRunIds: ["task_1"],
  });
  assert.deepEqual(calls, [
    ["code", plan.codeChangeAttempt],
    [
      "repair",
      {
        taskRunId: "task_1",
        instruction: CODE_CHANGE_REPAIR_INSTRUCTION,
      },
    ],
  ]);
});

test("runAutoApprovedExecutionPlan does not auto-repair non-pipeline attempts", async () => {
  const calls = [];
  const plan = {
    orchestrationApprovalIds: [],
    advisoryApprovalIds: [],
    individualRunnerApprovalIds: [],
    codeChangeAttempt: {
      taskRunId: "task_1",
      changeApprovalIds: ["write"],
      verificationApprovalIds: ["test"],
    },
  };

  const result = await runAutoApprovedExecutionPlan({
    executionPlan: plan,
    isPipelineAutoTask: false,
    api: {
      runOrchestrationApproved: async (input) => calls.push(["orch", input]),
      executeCodeChangeAttempt: async (input) => {
        calls.push(["code", input]);
        return { taskRunId: input.taskRunId, nextAction: "repair_required" };
      },
      createRepairPlan: async (input) => calls.push(["repair", input]),
      executeApproved: async (input) => calls.push(["runner", input]),
    },
  });

  assert.deepEqual(result, {
    failedApprovalIds: [],
    repairPlanTaskRunIds: [],
  });
  assert.deepEqual(calls, [["code", plan.codeChangeAttempt]]);
});

test("runAutoApprovedExecutionPlan resumes paused orchestration after worker file changes", async () => {
  const calls = [];
  const result = await runAutoApprovedExecutionPlan({
    executionPlan: {
      orchestrationApprovalIds: [],
      advisoryApprovalIds: [],
      individualRunnerApprovalIds: ["apv_file"],
      continuationOrchestrationApprovalIds: ["apv_orch"],
      codeChangeAttempt: null,
    },
    isPipelineAutoTask: true,
    api: {
      runOrchestrationApproved: async ({ approvalId }) => {
        calls.push(`orch:${approvalId}`);
      },
      executeCodeChangeAttempt: async () => {
        throw new Error("not used");
      },
      createRepairPlan: async () => {
        throw new Error("not used");
      },
      executeApproved: async ({ approvalId }) => {
        calls.push(`runner:${approvalId}`);
      },
    },
  });

  assert.deepEqual(calls, ["runner:apv_file", "orch:apv_orch"]);
  assert.deepEqual(result.failedApprovalIds, []);
});

test("runAutoApprovedExecutionPlan reports failed approval ids for retry", async () => {
  const plan = {
    orchestrationApprovalIds: [],
    advisoryApprovalIds: [],
    individualRunnerApprovalIds: [],
    codeChangeAttempt: {
      taskRunId: "task_1",
      changeApprovalIds: ["write"],
      verificationApprovalIds: ["test"],
    },
  };

  const result = await runAutoApprovedExecutionPlan({
    executionPlan: plan,
    isPipelineAutoTask: true,
    api: {
      runOrchestrationApproved: async () => {},
      executeCodeChangeAttempt: async () => {
        throw new Error("ipc failed");
      },
      createRepairPlan: async () => {},
      executeApproved: async () => {},
    },
  });

  assert.deepEqual(result.failedApprovalIds, ["write", "test"]);
  assert.deepEqual(result.repairPlanTaskRunIds, []);
});
