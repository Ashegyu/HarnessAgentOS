import {
  APPROVAL_ACTION_TYPES,
  WORKER_OUTPUT_CONTRACTS,
  type ApprovalActionType,
} from "@harness/core";
import type {
  OrchestrationMode,
  WorkerStep,
} from "./orchestration-types.ts";
import { OrchestrationError } from "./orchestration-types.ts";

/**
 * Phase 7 policy. Enforces the security contract:
 *   "worker는 직접 file/shell runner를 호출할 수 없다.
 *    Harness Core를 통해 approval을 생성해야 한다."
 *
 * Pure functions; no DB or runner access. Used by the planner and
 * worker-runner to refuse any structurally unsafe action.
 */

const ALLOWED_WORKER_ARTIFACT_KINDS = new Set([
  "plan",
  "log",
  "test_result",
  "quality_report",
  "snapshot",
  "diff",
  "file",
  "orchestration_plan",
]);

const FORBIDDEN_DIRECT_ACTIONS = new Set([
  // Listed for clarity; orchestration never invokes runners directly.
  "shell",
  "file_write",
  "dependency_install",
  "git_commit",
  "network",
  "skill_script",
]);

const APPROVAL_ACTION_SET: ReadonlySet<string> = new Set(
  APPROVAL_ACTION_TYPES,
);

const OUTPUT_CONTRACT_SET: ReadonlySet<string> = new Set(
  WORKER_OUTPUT_CONTRACTS,
);

export const validateWorkerStep = (step: WorkerStep): void => {
  if (step.title.trim().length === 0) {
    throw new OrchestrationError(
      "ORCH_INVALID_PLAN",
      "Worker step title must be non-empty",
    );
  }
  for (const kind of step.expectedArtifactKinds) {
    if (!ALLOWED_WORKER_ARTIFACT_KINDS.has(kind)) {
      throw new OrchestrationError(
        "ORCH_INVALID_PLAN",
        `Worker step artifact kind ${kind} is not allowed`,
      );
    }
  }
  if (
    step.dependsOn !== undefined &&
    (!Array.isArray(step.dependsOn) ||
      !step.dependsOn.every((id) => typeof id === "string" && id.length > 0))
  ) {
    throw new OrchestrationError(
      "ORCH_INVALID_PLAN",
      `Worker step ${step.id} has malformed dependsOn`,
    );
  }
  if (
    step.allowedActions !== undefined &&
    (!Array.isArray(step.allowedActions) ||
      !step.allowedActions.every(
        (action) =>
          typeof action === "string" && APPROVAL_ACTION_SET.has(action),
      ))
  ) {
    throw new OrchestrationError(
      "ORCH_INVALID_PLAN",
      `Worker step ${step.id} has malformed allowedActions`,
    );
  }
  if (
    step.outputContract !== undefined &&
    !OUTPUT_CONTRACT_SET.has(step.outputContract)
  ) {
    throw new OrchestrationError(
      "ORCH_INVALID_PLAN",
      `Worker step ${step.id} has malformed outputContract`,
    );
  }
};

export const orderWorkerStepsByDependencies = (
  workerSteps: readonly WorkerStep[],
): WorkerStep[] => {
  const byId = new Map<string, WorkerStep>();
  for (const [i, step] of workerSteps.entries()) {
    if (byId.has(step.id)) {
      throw new OrchestrationError(
        "ORCH_INVALID_PLAN",
        `Worker step ${i + 1} duplicates id ${step.id}`,
      );
    }
    byId.set(step.id, step);
  }

  for (const step of workerSteps) {
    for (const depId of step.dependsOn ?? []) {
      if (depId === step.id) {
        throw new OrchestrationError(
          "ORCH_INVALID_PLAN",
          `Worker step ${step.id} cannot depend on itself`,
        );
      }
      if (!byId.has(depId)) {
        throw new OrchestrationError(
          "ORCH_INVALID_PLAN",
          `Worker step ${step.id} depends on unknown step ${depId}`,
        );
      }
    }
  }

  const remaining = new Set(workerSteps.map((step) => step.id));
  const ordered: WorkerStep[] = [];
  while (remaining.size > 0) {
    let progressed = false;
    for (const step of workerSteps) {
      if (!remaining.has(step.id)) continue;
      const ready = (step.dependsOn ?? []).every(
        (depId) => !remaining.has(depId),
      );
      if (!ready) continue;
      ordered.push(step);
      remaining.delete(step.id);
      progressed = true;
    }
    if (!progressed) {
      throw new OrchestrationError(
        "ORCH_INVALID_PLAN",
        "Worker step dependencies contain a cycle",
      );
    }
  }
  return ordered;
};

export const validateWorkerTopology = (
  workerSteps: readonly WorkerStep[],
): void => {
  void orderWorkerStepsByDependencies(workerSteps);
};

export const validatePlanShape = (input: {
  mode: OrchestrationMode;
  workerSteps: WorkerStep[];
}): void => {
  if (input.workerSteps.length === 0) {
    throw new OrchestrationError(
      "ORCH_INVALID_PLAN",
      "Orchestration plan must have at least one worker step",
    );
  }
  if (input.mode === "single_worker" && input.workerSteps.length > 1) {
    throw new OrchestrationError(
      "ORCH_INVALID_PLAN",
      "single_worker mode allows only one worker step",
    );
  }
  if (input.mode === "planner_worker" && input.workerSteps.length < 2) {
    throw new OrchestrationError(
      "ORCH_INVALID_PLAN",
      "planner_worker mode requires at least planner + worker steps",
    );
  }
  for (const step of input.workerSteps) validateWorkerStep(step);
  validateWorkerTopology(input.workerSteps);
};

export const assertActionTypeAllowed = (actionType: string): void => {
  if (FORBIDDEN_DIRECT_ACTIONS.has(actionType)) {
    throw new OrchestrationError(
      "ORCH_DIRECT_ACTION_BLOCKED",
      `Worker may not execute ${actionType} directly; create an approval through the conversation flow instead`,
    );
  }
};

export const isActionAllowedForWorkerStep = (
  step: WorkerStep,
  actionType: ApprovalActionType,
): boolean =>
  step.allowedActions === undefined || step.allowedActions.includes(actionType);
