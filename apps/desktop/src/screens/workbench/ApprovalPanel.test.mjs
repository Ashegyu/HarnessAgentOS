import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

globalThis.React = React;
const { ApprovalPanel } = await import("./ApprovalPanel.tsx");

const now = "2026-05-20T00:00:00.000Z";

test("ApprovalPanel renders detailed A2A refinement approval metadata", () => {
  const html = renderToStaticMarkup(
    React.createElement(ApprovalPanel, {
      approvals: [
        {
          id: "appr_1",
          taskRunId: "tsk_1",
          checkpointId: "chk_1",
          actionType: "network",
          actionSummary: "A2A refinement to Remote Coder: fix missing test",
          status: "pending",
          proposedAction: { type: "network" },
          policyEvaluation: {
            decision: "manual_required",
            riskLevel: "high",
            reason: "network requires approval",
            allowAutoApprove: false,
          },
        },
      ],
      checkpoints: [
        {
          id: "chk_1",
          taskRunId: "tsk_1",
          stepId: "step_1",
          reason: "manual",
          stateRef: JSON.stringify({
            a2aRefinementAttemptId: "a2ar_1",
            targetInvocationId: "ainv_1",
            endpointId: "a2a_1",
            instruction: "fix missing test",
            referencedArtifactIds: ["art_1"],
          }),
          summary: "A2A refinement request to Remote Coder",
          createdAt: now,
        },
      ],
      refinementAttempts: [
        {
          id: "a2ar_1",
          taskRunId: "tsk_1",
          targetInvocationId: "ainv_1",
          endpointId: "a2a_1",
          feedbackSourceKind: "quality_gate",
          parentRemoteTaskId: "remote-task-1",
          parentRemoteContextId: "remote-context-1",
          referenceTaskIds: ["remote-task-1"],
          referenceArtifactIds: ["art_1"],
          feedbackSignature: "sig_1",
          attemptIndex: 1,
          status: "pending_approval",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "a2ar_0",
          taskRunId: "tsk_1",
          targetInvocationId: "ainv_1",
          endpointId: "a2a_1",
          feedbackSourceKind: "quality_gate",
          parentRemoteTaskId: "remote-task-1",
          parentRemoteContextId: "remote-context-1",
          referenceTaskIds: ["remote-task-1"],
          referenceArtifactIds: ["art_1"],
          feedbackSignature: "sig_1",
          attemptIndex: 0,
          status: "succeeded",
          createdAt: now,
          updatedAt: now,
          completedAt: now,
        },
      ],
      taskRunTargetDir: process.cwd(),
      onApprove: async () => {},
      onReject: async () => {},
      onRedirect: async () => {},
      onConfigure: async () => {},
      onExecute: async () => {},
      pipelineAutoLaunched: false,
    }),
  );

  assert.match(html, /A2A refinement approval/);
  assert.match(html, /endpoint/);
  assert.match(html, /a2a_1/);
  assert.match(html, /remote-context-1/);
  assert.match(html, /signature 2\/2/);
  assert.match(html, /task run 2\/4/);
});

test("ApprovalPanel exposes manual controls for pipeline runner approvals that cannot auto-execute", () => {
  const html = renderToStaticMarkup(
    React.createElement(ApprovalPanel, {
      approvals: [
        {
          id: "appr_1",
          taskRunId: "tsk_1",
          checkpointId: "chk_1",
          actionType: "file_write",
          actionSummary: "Write missing file",
          status: "pending",
          policyEvaluation: {
            decision: "allow",
            riskLevel: "medium",
            reason: "allowed",
            allowAutoApprove: true,
          },
        },
      ],
      checkpoints: [],
      refinementAttempts: [],
      taskRunTargetDir: process.cwd(),
      onApprove: async () => {},
      onReject: async () => {},
      onRedirect: async () => {},
      onConfigure: async () => {},
      onExecute: async () => {},
      pipelineAutoLaunched: true,
    }),
  );

  assert.match(html, /자동 처리 제외: Missing proposedAction/);
  assert.match(html, /세부 지정/);
  assert.match(html, /승인/);
  assert.doesNotMatch(html, /자동 처리 중/);
});

test("ApprovalPanel keeps auto-processing hint for pipeline runner approvals that can auto-execute", () => {
  const html = renderToStaticMarkup(
    React.createElement(ApprovalPanel, {
      approvals: [
        {
          id: "appr_1",
          taskRunId: "tsk_1",
          checkpointId: "chk_1",
          actionType: "file_write",
          actionSummary: "Write file",
          status: "pending",
          proposedAction: {
            type: "file_write",
            filePatch: {
              path: "README.md",
              before: "",
              after: "hello\n",
            },
          },
          policyEvaluation: {
            decision: "allow",
            riskLevel: "medium",
            reason: "allowed",
            allowAutoApprove: true,
          },
        },
      ],
      checkpoints: [],
      refinementAttempts: [],
      taskRunTargetDir: process.cwd(),
      onApprove: async () => {},
      onReject: async () => {},
      onRedirect: async () => {},
      onConfigure: async () => {},
      onExecute: async () => {},
      pipelineAutoLaunched: true,
    }),
  );

  assert.match(html, /자동 처리 중/);
  assert.doesNotMatch(html, /자동 처리 제외/);
});
