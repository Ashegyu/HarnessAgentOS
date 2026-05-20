import { createHash } from "node:crypto";
import type {
  A2ARefinementAttempt,
  A2ARefinementRequest,
  A2ARefinementStopReason,
} from "@harness/core";

export interface A2ARefinementPolicyInput {
  request: A2ARefinementRequest;
  existingAttempts: readonly A2ARefinementAttempt[];
  endpointAvailable?: boolean;
  maxAttemptsPerSignature?: number;
  maxAttemptsPerTaskRun?: number;
}

export type A2ARefinementPolicyDecision =
  | {
      ok: true;
      feedbackSignature: string;
    }
  | {
      ok: false;
      feedbackSignature: string;
      stopReason: A2ARefinementStopReason;
    };

const ACTIVE_REFINEMENT_STATUSES = new Set<A2ARefinementAttempt["status"]>([
  "pending_approval",
  "queued",
  "running",
  "input_required",
  "auth_required",
]);

const DEFAULT_MAX_ATTEMPTS_PER_SIGNATURE = 2;
const DEFAULT_MAX_ATTEMPTS_PER_TASK_RUN = 4;

export const evaluateA2ARefinementPolicy = (
  input: A2ARefinementPolicyInput,
): A2ARefinementPolicyDecision => {
  const feedbackSignature = refinementFeedbackSignature(input.request);
  if (input.endpointAvailable === false) {
    return {
      ok: false,
      feedbackSignature,
      stopReason: "endpoint_unavailable",
    };
  }

  const maxAttemptsPerTaskRun =
    input.maxAttemptsPerTaskRun ?? DEFAULT_MAX_ATTEMPTS_PER_TASK_RUN;
  const taskRunAttempts = input.existingAttempts.filter(
    (attempt) => attempt.taskRunId === input.request.taskRunId,
  );
  if (taskRunAttempts.length >= maxAttemptsPerTaskRun) {
    return {
      ok: false,
      feedbackSignature,
      stopReason: "max_attempts_for_task_run",
    };
  }

  const matchingSignatureAttempts = taskRunAttempts.filter(
    (attempt) =>
      attempt.targetInvocationId === input.request.targetInvocationId &&
      attempt.feedbackSignature === feedbackSignature,
  );
  if (
    matchingSignatureAttempts.some((attempt) =>
      ACTIVE_REFINEMENT_STATUSES.has(attempt.status),
    )
  ) {
    return {
      ok: false,
      feedbackSignature,
      stopReason: "repeated_feedback_signature",
    };
  }

  const maxAttemptsPerSignature =
    input.maxAttemptsPerSignature ?? DEFAULT_MAX_ATTEMPTS_PER_SIGNATURE;
  if (matchingSignatureAttempts.length >= maxAttemptsPerSignature) {
    return {
      ok: false,
      feedbackSignature,
      stopReason: "max_attempts_for_signature",
    };
  }

  return { ok: true, feedbackSignature };
};

export const refinementFeedbackSignature = (
  request: A2ARefinementRequest,
): string => {
  const payload = JSON.stringify({
    taskRunId: request.taskRunId,
    targetInvocationId: request.targetInvocationId,
    feedbackSourceKind: request.feedbackSourceKind,
    feedbackSourceStepId: request.feedbackSourceStepId ?? null,
    feedbackSourceInvocationId: request.feedbackSourceInvocationId ?? null,
    feedbackArtifactId: request.feedbackArtifactId ?? null,
    qualityGateId: request.qualityGateId ?? null,
    instruction: normalizeInstruction(request.instruction),
    referencedArtifactIds: [...request.referencedArtifactIds].sort(),
  });
  return createHash("sha256").update(payload).digest("hex");
};

const normalizeInstruction = (instruction: string): string =>
  instruction.trim().toLowerCase().replace(/\s+/g, " ");
