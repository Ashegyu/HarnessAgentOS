import { test } from "node:test";
import assert from "node:assert/strict";
import { OrchestrationError } from "@harness/orchestration";
import { buildOrchestrationHandlers } from "./orchestration-ipc-handlers.ts";

const setup = (overrides = {}) => {
  const calls = [];
  const changed = [];
  const service = {
    isEnabled: () => true,
    getLatestPlan: async () => null,
    draftPlan: async (input) => {
      calls.push(input);
      return {
        plan: {
          id: "orch_1",
          taskRunId: input.taskRunId,
          mode: input.mode,
          workerSteps: [],
          requiresApproval: true,
        },
        artifact: {
          id: "art_1",
          taskRunId: input.taskRunId,
          kind: "orchestration_plan",
          title: "Plan",
          summary: "Plan",
          uri: "harness:orchestration/orch_1",
          metadataJson: "{}",
          createdAt: "2026-05-27T00:00:00.000Z",
        },
        approval: {
          id: "appr_1",
          taskRunId: input.taskRunId,
          checkpointId: "chk_1",
          status: "pending",
          message: "Approve plan",
          requestedAt: "2026-05-27T00:00:00.000Z",
          decidedAt: null,
          proposedAction: { type: "orchestration_plan", planId: "orch_1" },
          policyEvaluation: null,
          autoApproveDecision: null,
        },
      };
    },
    runApproved: async ({ approvalId }) => ({
      taskRunId: "task_1",
      planId: "orch_1",
      approvals: [{ id: approvalId }],
      artifacts: [],
    }),
    ...overrides,
  };
  const handlers = buildOrchestrationHandlers({
    service,
    events: {
      taskRunChanged: (taskRunId) => changed.push(taskRunId),
    },
  });
  return { handlers, calls, changed };
};

test("orchestration.draftPlan accepts direct harness source and trims ids", async () => {
  const { handlers, calls, changed } = setup();

  const result = await handlers.draftPlan({
    taskRunId: "task_1",
    mode: "multi_worker",
    harness: {
      packageId: " pkg_1 ",
      workflowId: " wf_1 ",
      bindingSetId: " hbs_1 ",
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    {
      taskRunId: "task_1",
      mode: "multi_worker",
      harness: {
        packageId: "pkg_1",
        workflowId: "wf_1",
        bindingSetId: "hbs_1",
      },
    },
  ]);
  assert.deepEqual(changed, ["task_1"]);
});

test("orchestration.draftPlan rejects malformed harness source before service call", async () => {
  const { handlers, calls, changed } = setup();

  const result = await handlers.draftPlan({
    taskRunId: "task_1",
    mode: "multi_worker",
    harness: {
      packageId: "pkg_1",
      bindingSetId: "",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "STATE_INVALID_INPUT");
  assert.match(result.error.message, /bindingSetId/);
  assert.deepEqual(calls, []);
  assert.deepEqual(changed, []);
});

test("orchestration.draftPlan rejects pipelineId and harness together", async () => {
  const { handlers, calls, changed } = setup();

  const result = await handlers.draftPlan({
    taskRunId: "task_1",
    mode: "multi_worker",
    pipelineId: "pipe_1",
    harness: {
      packageId: "pkg_1",
      bindingSetId: "hbs_1",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ORCHESTRATION_INVALID_PLAN");
  assert.deepEqual(calls, []);
  assert.deepEqual(changed, []);
});

test("orchestration.draftPlan propagates direct harness orchestration errors", async () => {
  const { handlers, changed } = setup({
    draftPlan: async () => {
      throw new OrchestrationError(
        "HARNESS_BINDING_SET_NOT_FOUND",
        "Harness binding set hbs_missing not found",
      );
    },
  });

  const result = await handlers.draftPlan({
    taskRunId: "task_1",
    mode: "multi_worker",
    harness: {
      packageId: "pkg_1",
      bindingSetId: "hbs_missing",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "HARNESS_BINDING_SET_NOT_FOUND");
  assert.match(result.error.message, /hbs_missing/);
  assert.deepEqual(changed, []);
});
