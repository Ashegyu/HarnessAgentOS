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

test("pipelineAutoApproveDecision bypasses active profile blocks but not hard policy blocks", () => {
  assert.deepEqual(pipelineAutoApproveDecision({}), {
    approved: true,
    decidedAt: "global_toggle",
    reason:
      "Orchestration task was pre-approved by explicit pipeline or harness selection; active profile block lists do not apply to worker approvals.",
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
