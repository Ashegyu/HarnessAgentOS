import type {
  A2ARefinementAttempt,
  A2ARefinementFeedbackSourceKind,
  Approval,
} from "@harness/core";
import {
  AGENT_INVOCATION_NOT_FOUND,
  A2A_ENDPOINT_NOT_FOUND,
  STATE_INVALID_INPUT,
} from "@harness/core";
import type { LocalStateService } from "@harness/storage";
import {
  evaluateA2ARefinementPolicy,
  refinementFeedbackSignature,
} from "@harness/agent";

export interface RequestA2ARefinementInput {
  taskRunId: string;
  targetInvocationId: string;
  feedbackSourceKind: A2ARefinementFeedbackSourceKind;
  feedbackSourceStepId?: string;
  feedbackSourceInvocationId?: string;
  feedbackArtifactId?: string;
  qualityGateId?: string;
  instruction: string;
  referencedArtifactIds: readonly string[];
}

export interface RequestA2ARefinementOptions {
  state: LocalStateService;
  input: RequestA2ARefinementInput;
}

export interface RequestA2ARefinementResult {
  attempt: A2ARefinementAttempt;
  approval: Approval;
}

export class A2ARefinementRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "A2ARefinementRequestError";
    this.code = code;
  }
}

export const requestA2ARefinement = async (
  options: RequestA2ARefinementOptions,
): Promise<RequestA2ARefinementResult> => {
  const input = normalizeInput(options.input);
  const taskRun = await options.state.getTaskRun(input.taskRunId);
  if (!taskRun) {
    throw new A2ARefinementRequestError(
      STATE_INVALID_INPUT,
      `TaskRun not found: ${input.taskRunId}`,
    );
  }
  const targetInvocation = await options.state.agentInvocations.get(
    input.targetInvocationId,
  );
  if (!targetInvocation || targetInvocation.taskRunId !== input.taskRunId) {
    throw new A2ARefinementRequestError(
      AGENT_INVOCATION_NOT_FOUND,
      `AgentInvocation not found: ${input.targetInvocationId}`,
    );
  }
  const remoteRef = await options.state.a2aRemoteAgents.getRemoteTaskRef(
    input.targetInvocationId,
  );
  if (!remoteRef) {
    throw new A2ARefinementRequestError(
      STATE_INVALID_INPUT,
      `Target invocation has no A2A remote task ref: ${input.targetInvocationId}`,
    );
  }
  const endpoint = await options.state.a2aRemoteAgents.getEndpoint(
    remoteRef.endpointId,
  );
  if (!endpoint) {
    throw new A2ARefinementRequestError(
      A2A_ENDPOINT_NOT_FOUND,
      `A2A endpoint not found: ${remoteRef.endpointId}`,
    );
  }

  const existingAttempts = await options.state.a2aRefinements.listByTaskRun(
    input.taskRunId,
  );
  const policy = evaluateA2ARefinementPolicy({
    request: input,
    existingAttempts,
    endpointAvailable: endpoint.enabled && endpoint.trusted,
  });
  if (!policy.ok) {
    throw new A2ARefinementRequestError(
      STATE_INVALID_INPUT,
      `A2A refinement stopped: ${policy.stopReason}`,
    );
  }

  const feedbackSignature = refinementFeedbackSignature(input);
  const attempt = await options.state.a2aRefinements.create({
    taskRunId: input.taskRunId,
    targetInvocationId: input.targetInvocationId,
    endpointId: endpoint.id,
    feedbackSourceKind: input.feedbackSourceKind,
    ...(input.feedbackSourceStepId
      ? { feedbackSourceStepId: input.feedbackSourceStepId }
      : {}),
    ...(input.feedbackSourceInvocationId
      ? { feedbackSourceInvocationId: input.feedbackSourceInvocationId }
      : {}),
    ...(input.feedbackArtifactId
      ? { feedbackArtifactId: input.feedbackArtifactId }
      : {}),
    ...(input.qualityGateId ? { qualityGateId: input.qualityGateId } : {}),
    ...(remoteRef.remoteTaskId
      ? { parentRemoteTaskId: remoteRef.remoteTaskId }
      : {}),
    ...(remoteRef.remoteContextId
      ? { parentRemoteContextId: remoteRef.remoteContextId }
      : {}),
    referenceTaskIds: remoteRef.remoteTaskId ? [remoteRef.remoteTaskId] : [],
    referenceArtifactIds: input.referencedArtifactIds,
    feedbackSignature,
    status: "pending_approval",
  });

  const stepIndex = (await options.state.listStepsByTaskRun(input.taskRunId))
    .length;
  const step = await options.state.createStep({
    taskRunId: input.taskRunId,
    index: stepIndex,
    kind: "approval",
    title: "A2A refinement approval",
    status: "pending",
    inputSummary: `${endpoint.name}: ${input.instruction.slice(0, 160)}`,
  });
  const checkpoint = await options.state.createCheckpoint({
    taskRunId: input.taskRunId,
    stepId: step.id,
    reason: "manual",
    stateRef: JSON.stringify({
      taskRunStatus: "waiting_for_approval",
      currentStepId: step.id,
      a2aRefinementAttemptId: attempt.id,
      targetInvocationId: input.targetInvocationId,
      endpointId: endpoint.id,
      instruction: input.instruction,
      referencedArtifactIds: input.referencedArtifactIds,
    }),
    summary: `A2A refinement request to ${endpoint.name}`,
  });
  const approval = await options.state.createApproval({
    taskRunId: input.taskRunId,
    checkpointId: checkpoint.id,
    actionType: "network",
    actionSummary: `A2A refinement to ${endpoint.name}: ${input.instruction.slice(0, 160)}`,
    status: "pending",
    proposedAction: {
      type: "network",
    },
  });
  await options.state.setTaskRunCurrentStep(input.taskRunId, step.id);
  await options.state.setTaskRunStatus(input.taskRunId, "waiting_for_approval");
  return { attempt, approval };
};

const normalizeInput = (
  input: RequestA2ARefinementInput,
): RequestA2ARefinementInput => {
  const instruction = input.instruction.trim();
  if (instruction.length === 0) {
    throw new A2ARefinementRequestError(
      STATE_INVALID_INPUT,
      "instruction must be non-empty",
    );
  }
  return {
    ...input,
    instruction,
    referencedArtifactIds: [...new Set(input.referencedArtifactIds)],
  };
};
