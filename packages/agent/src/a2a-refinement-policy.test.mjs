import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateA2ARefinementPolicy,
  refinementFeedbackSignature,
} from "./a2a-refinement-policy.ts";

const request = {
  taskRunId: "tr-1",
  targetInvocationId: "inv-1",
  feedbackSourceKind: "quality_gate",
  qualityGateId: "qg-1",
  instruction: "  Fix the missing   acceptance criteria. ",
  referencedArtifactIds: ["art-b", "art-a"],
};

test("refinementFeedbackSignature normalizes instruction and artifact ordering", () => {
  const a = refinementFeedbackSignature(request);
  const b = refinementFeedbackSignature({
    ...request,
    instruction: "fix the missing acceptance criteria.",
    referencedArtifactIds: ["art-a", "art-b"],
  });
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
});

test("evaluateA2ARefinementPolicy enforces task and signature limits", () => {
  const signature = refinementFeedbackSignature(request);
  const succeededAttempt = {
    id: "ref-1",
    taskRunId: "tr-1",
    targetInvocationId: "inv-1",
    endpointId: "ep-1",
    feedbackSourceKind: "quality_gate",
    qualityGateId: "qg-1",
    referenceTaskIds: [],
    referenceArtifactIds: [],
    feedbackSignature: signature,
    attemptIndex: 0,
    status: "succeeded",
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
  };

  assert.equal(
    evaluateA2ARefinementPolicy({
      request,
      existingAttempts: [succeededAttempt, { ...succeededAttempt, id: "ref-2" }],
    }).ok,
    false,
  );
  assert.equal(
    evaluateA2ARefinementPolicy({
      request,
      existingAttempts: [
        { ...succeededAttempt, id: "ref-1", feedbackSignature: "a" },
        { ...succeededAttempt, id: "ref-2", feedbackSignature: "b" },
        { ...succeededAttempt, id: "ref-3", feedbackSignature: "c" },
        { ...succeededAttempt, id: "ref-4", feedbackSignature: "d" },
      ],
    }).stopReason,
    "max_attempts_for_task_run",
  );
});

test("evaluateA2ARefinementPolicy stops active duplicate and unavailable endpoint", () => {
  const signature = refinementFeedbackSignature(request);
  const active = {
    id: "ref-active",
    taskRunId: "tr-1",
    targetInvocationId: "inv-1",
    endpointId: "ep-1",
    feedbackSourceKind: "quality_gate",
    qualityGateId: "qg-1",
    referenceTaskIds: [],
    referenceArtifactIds: [],
    feedbackSignature: signature,
    attemptIndex: 0,
    status: "running",
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
  };

  assert.equal(
    evaluateA2ARefinementPolicy({
      request,
      existingAttempts: [active],
    }).stopReason,
    "repeated_feedback_signature",
  );
  assert.equal(
    evaluateA2ARefinementPolicy({
      request,
      existingAttempts: [],
      endpointAvailable: false,
    }).stopReason,
    "endpoint_unavailable",
  );
});
