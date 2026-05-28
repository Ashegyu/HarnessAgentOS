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

test("buildAutoApprovedExecutionPlan batches file writes and trailing shell checks", () => {
  const plan = buildAutoApprovedExecutionPlan("task_1", [
    approval("write_a", "file_write"),
    approval("write_b", "file_write"),
    approval("test", "shell"),
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
    approval("patch_a", "file_patch"),
    approval("write_b", "file_write"),
    approval("test", "shell"),
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
    approval("check", "shell"),
  ]);

  assert.equal(plan.codeChangeAttempt, null);
  assert.deepEqual(plan.individualRunnerApprovalIds, ["check"]);
});

test("buildAutoApprovedExecutionPlan preserves ambiguous interleaved runner order", () => {
  const plan = buildAutoApprovedExecutionPlan("task_1", [
    approval("write_a", "file_write"),
    approval("check", "shell"),
    approval("patch_b", "file_patch"),
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
    approval("write", "file_write"),
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
