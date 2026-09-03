import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasPipelineSourcePlanArtifact,
  pipelineAutoApproveDecision,
} from "./pipeline-auto-approval.ts";

test("hasPipelineSourcePlanArtifact detects persisted pipeline orchestration plans", () => {
  assert.equal(
    hasPipelineSourcePlanArtifact([
      {
        kind: "orchestration_plan",
        summary:
          'Plan\n\n```json\n{"id":"orch_1","sourcePipelineId":"pipe_template_3d_new_project_delivery"}\n```',
      },
    ]),
    true,
  );
  assert.equal(
    hasPipelineSourcePlanArtifact([
      {
        kind: "orchestration_plan",
        summary: 'Plan\n\n```json\n{"id":"orch_1"}\n```',
      },
    ]),
    false,
  );
});

test("hasPipelineSourcePlanArtifact detects direct harness orchestration plans", () => {
  assert.equal(
    hasPipelineSourcePlanArtifact([
      {
        kind: "orchestration_plan",
        summary:
          'Plan\n\n```json\n{"id":"orch_1","sourceHarness":{"packageId":"harness_youtube","packageName":"YouTube","workflowId":"wf","workflowName":"Workflow","bindingSetId":"hbs_1","bindingSetName":"Default"}}\n```',
      },
    ]),
    true,
  );
});

test("pipelineAutoApproveDecision approves a selected pipeline unless a hard policy blocks it", () => {
  assert.deepEqual(pipelineAutoApproveDecision({}), {
    approved: true,
    decidedAt: "global_toggle",
    reason:
      "Orchestration task was pre-approved by explicit pipeline or harness selection.",
  });

  assert.deepEqual(
    pipelineAutoApproveDecision({
      policyEvaluation: {
        operation: { kind: "approval_action", actionType: "network" },
        decision: "blocked",
        riskLevel: "blocked",
        allowAutoApprove: false,
        reason: "network blocked",
      },
    }),
    {
      approved: false,
      decidedAt: "policy_blocked",
      reason: "Policy blocked pipeline auto-approve: network blocked",
    },
  );
});

test("pipelineAutoApproveDecision keeps active profile blocks as a non-bypassable floor", () => {
  assert.deepEqual(
    pipelineAutoApproveDecision(
      { actionType: "file_write" },
      {
        activeProfile: {
          permissions: {
            autoApproveActions: [],
            blockedActions: ["file_write"],
          },
        },
      },
    ),
    {
      approved: false,
      decidedAt: "blocked_action",
      reason: "Active profile blocks file_write.",
    },
  );
});

test("pipelineAutoApproveDecision blocks a pipeline approval that exceeds profile budget", () => {
  assert.deepEqual(
    pipelineAutoApproveDecision(
      {
        actionType: "model_use",
        policyEvaluation: {
          operation: { kind: "approval_action", actionType: "model_use" },
          decision: "confirm",
          riskLevel: "medium",
          allowAutoApprove: true,
          reason: "model selection",
          costEstimateUsd: 0.2,
        },
      },
      {
        activeProfile: {
          permissions: {
            autoApproveActions: [],
            blockedActions: [],
            budget: { perInvocationUsd: 0.1 },
          },
        },
        accumulatedTaskRunCostUsd: 0,
        accumulatedDailyCostUsd: 0,
      },
    ),
    {
      approved: false,
      decidedAt: "budget_blocked",
      reason: "budget 차단: 예상 비용 $0.20, 한도 $0.10",
    },
  );
});
