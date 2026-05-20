import type {
  A2AEndpoint,
  A2ARefinementActivityEventType,
  A2ARefinementStatus,
  AgentStreamEvent,
  Checkpoint,
  RunnerResultPayload,
} from "@harness/core";
import {
  A2A_ENDPOINT_NOT_FOUND,
  RUNNER_CANCELLED,
} from "@harness/core";
import {
  A2AInvocationAdapter,
  OfficialA2AClientPort,
} from "@harness/agent";
import { newId, nowIso, type LocalStateService } from "@harness/storage";
import { RunnerError } from "@harness/runners";
import { createA2ARefinementService } from "./a2a-refinement-service";

export interface ExecuteA2ARefinementApprovalOptions {
  state: LocalStateService;
  approvalId: string;
  emitStreamEvent?: (event: AgentStreamEvent) => void;
  createAdapter?: (
    endpoint: A2AEndpoint,
  ) => Pick<A2AInvocationAdapter, "invoke">;
  now?: () => string;
  createArtifactUriNonce?: () => string;
}

interface A2ARefinementApprovalStateRef {
  a2aRefinementAttemptId: string;
  instruction: string;
}

export const executeA2ARefinementApproval = async (
  options: ExecuteA2ARefinementApprovalOptions,
): Promise<RunnerResultPayload | null> => {
  const approval = await options.state.getApproval(options.approvalId);
  if (!approval || approval.actionType !== "network") return null;

  const checkpoint = await findApprovalCheckpoint(options.state, {
    taskRunId: approval.taskRunId,
    checkpointId: approval.checkpointId,
  });
  const stateRef = parseRefinementStateRef(checkpoint?.stateRef);
  if (!stateRef) return null;

  if (
    approval.status !== "approved" &&
    approval.status !== "always_approved_for_run"
  ) {
    throw new RunnerError(
      "RUNNER_APPROVAL_REQUIRED",
      `Approval ${approval.id} is not approved (status=${approval.status})`,
    );
  }
  if (!checkpoint) {
    throw new RunnerError(
      "RUNNER_EXECUTION_FAILED",
      `Checkpoint ${approval.checkpointId} not found`,
    );
  }

  const taskRun = await options.state.getTaskRun(approval.taskRunId);
  if (!taskRun) {
    throw new RunnerError(
      "RUNNER_EXECUTION_FAILED",
      `TaskRun ${approval.taskRunId} not found`,
    );
  }
  const attempt = await options.state.a2aRefinements.get(
    stateRef.a2aRefinementAttemptId,
  );
  if (!attempt) {
    throw new RunnerError(
      "RUNNER_EXECUTION_FAILED",
      `A2A refinement attempt ${stateRef.a2aRefinementAttemptId} not found`,
    );
  }
  const endpoint = await options.state.a2aRemoteAgents.getEndpoint(
    attempt.endpointId,
  );
  if (!endpoint) {
    throw new RunnerError(
      A2A_ENDPOINT_NOT_FOUND,
      `A2A endpoint ${attempt.endpointId} not found`,
    );
  }

  const now = options.now ?? nowIso;
  const startedAt = now();
  const result: RunnerResultPayload = {
    id: newId("step"),
    taskRunId: taskRun.id,
    stepId: checkpoint.stepId,
    commandSummary: `a2a refinement: ${endpoint.name}`,
    artifactIds: [],
    startedAt,
    finishedAt: startedAt,
  };

  await options.state.setTaskRunCurrentStep(taskRun.id, checkpoint.stepId);
  await options.state.setStepStatus(checkpoint.stepId, "running", {
    outputSummary: `A2A refinement running: ${endpoint.name}`,
  });
  await options.state.setTaskRunStatus(taskRun.id, "running");
  await options.state.a2aRefinements.createEvent({
    taskRunId: taskRun.id,
    attemptId: attempt.id,
    eventType: "started",
    status: "running",
    summary: `A2A refinement started for ${endpoint.name}`,
    payload: {
      approvalId: approval.id,
      endpointId: endpoint.id,
      targetInvocationId: attempt.targetInvocationId,
    },
  });

  try {
    const service = createA2ARefinementService({
      state: options.state,
      endpoint,
      adapter:
        options.createAdapter?.(endpoint) ??
        new A2AInvocationAdapter({
          client: new OfficialA2AClientPort({ endpoint }),
        }),
      emitStreamEvent: options.emitStreamEvent,
      now,
      createArtifactUriNonce: options.createArtifactUriNonce,
    });
    const refinement = await service.runApprovedAttempt({
      attemptId: attempt.id,
      instruction: stateRef.instruction,
    });
    result.artifactIds = [
      refinement.invocation.promptArtifactId,
      ...(refinement.invocation.rawOutputArtifactId
        ? [refinement.invocation.rawOutputArtifactId]
        : []),
    ];
    if (refinement.invocation.rawOutputArtifactId) {
      result.stdout = `A2A refinement output artifact: ${refinement.invocation.rawOutputArtifactId}`;
    }
    result.finishedAt = now();

    const succeeded = refinement.attempt.status === "succeeded";
    await options.state.setStepStatus(
      checkpoint.stepId,
      succeeded ? "succeeded" : "failed",
      {
        outputSummary: `A2A refinement ${refinement.attempt.status}: ${endpoint.name}`,
      },
    );
    await options.state.decideApproval(
      approval.id,
      "executed",
      `Executed A2A refinement attempt ${attempt.id}`,
    );
    await options.state.a2aRefinements.createEvent({
      taskRunId: taskRun.id,
      attemptId: attempt.id,
      eventType: refinementEventType(refinement.attempt.status),
      status: refinement.attempt.status,
      summary: `A2A refinement ${refinement.attempt.status}: ${endpoint.name}`,
      payload: {
        approvalId: approval.id,
        endpointId: endpoint.id,
        invocationId: refinement.invocation.id,
        artifactIds: [...result.artifactIds],
      },
    });
    await settleTaskRun(options.state, taskRun.id, {
      succeeded,
    });
    return result;
  } catch (error) {
    result.finishedAt = now();
    result.stderr = error instanceof Error ? error.message : String(error);
    const errorArtifact = await options.state.createArtifact({
      taskRunId: taskRun.id,
      stepId: checkpoint.stepId,
      kind: "log",
      title: "A2A refinement error",
      uri: `harness:a2a-refinement-error/${taskRun.id}/${approval.id}/${
        options.createArtifactUriNonce?.() ?? Date.now().toString(36)
      }`,
      summary: result.stderr,
    });
    result.artifactIds.push(errorArtifact.id);
    await options.state.setStepStatus(checkpoint.stepId, "failed", {
      outputSummary: result.stderr.slice(0, 200),
    });
    await options.state.setTaskRunStatus(
      taskRun.id,
      isCancelled(error) ? "cancelled" : "blocked",
    );
    const failedAttempt = await options.state.a2aRefinements.get(attempt.id);
    const terminalEvent = terminalRefinementEvent(
      failedAttempt?.status,
      isCancelled(error),
    );
    await options.state.a2aRefinements.createEvent({
      taskRunId: taskRun.id,
      attemptId: attempt.id,
      eventType: terminalEvent.eventType,
      status: terminalEvent.status,
      summary: `A2A refinement ${terminalEvent.status}: ${endpoint.name}`,
      payload: {
        approvalId: approval.id,
        endpointId: endpoint.id,
        error: result.stderr,
      },
    });
    if (error instanceof RunnerError) throw error;
    if (isCancelled(error)) throw new RunnerError(RUNNER_CANCELLED, result.stderr);
    throw new RunnerError("RUNNER_EXECUTION_FAILED", result.stderr);
  }
};

const findApprovalCheckpoint = async (
  state: LocalStateService,
  input: { taskRunId: string; checkpointId: string },
): Promise<Checkpoint | null> => {
  const checkpoints = await state.listCheckpointsByTaskRun(input.taskRunId);
  return (
    checkpoints.find((checkpoint) => checkpoint.id === input.checkpointId) ??
    null
  );
};

const parseRefinementStateRef = (
  raw: string | undefined,
): A2ARefinementApprovalStateRef | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    if (
      typeof parsed.a2aRefinementAttemptId !== "string" ||
      typeof parsed.instruction !== "string" ||
      parsed.instruction.trim().length === 0
    ) {
      return null;
    }
    return {
      a2aRefinementAttemptId: parsed.a2aRefinementAttemptId,
      instruction: parsed.instruction,
    };
  } catch {
    return null;
  }
};

const settleTaskRun = async (
  state: LocalStateService,
  taskRunId: string,
  input: { succeeded: boolean },
): Promise<void> => {
  if (!input.succeeded) {
    await state.setTaskRunStatus(taskRunId, "blocked");
    return;
  }
  const approvals = await state.listApprovalsByTaskRun(taskRunId);
  await state.setTaskRunStatus(
    taskRunId,
    approvals.some(isUnresolvedApproval)
      ? "waiting_for_approval"
      : "ready_for_review",
  );
};

const isUnresolvedApproval = (approval: { status: string }): boolean =>
  approval.status === "pending" ||
  approval.status === "approved" ||
  approval.status === "always_approved_for_run";

const NON_TERMINAL_REFINEMENT_STATUSES: ReadonlySet<A2ARefinementStatus> =
  new Set(["pending_approval", "queued", "running"]);

const terminalRefinementEvent = (
  status: A2ARefinementStatus | undefined,
  cancelled: boolean,
): {
  eventType: A2ARefinementActivityEventType;
  status: A2ARefinementStatus;
} => {
  if (status && !NON_TERMINAL_REFINEMENT_STATUSES.has(status)) {
    return { eventType: refinementEventType(status), status };
  }
  const fallbackStatus: A2ARefinementStatus = cancelled ? "cancelled" : "failed";
  return { eventType: fallbackStatus, status: fallbackStatus };
};

const refinementEventType = (
  status: A2ARefinementStatus,
): A2ARefinementActivityEventType => {
  if (status === "succeeded") return "succeeded";
  if (status === "stopped") return "stopped";
  if (status === "cancelled") return "cancelled";
  if (status === "input_required") return "input_required";
  if (status === "auth_required") return "auth_required";
  if (status === "running" || status === "queued") return "started";
  return "failed";
};

const isCancelled = (error: unknown): boolean =>
  isRecord(error) && error.name === "AbortError";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
