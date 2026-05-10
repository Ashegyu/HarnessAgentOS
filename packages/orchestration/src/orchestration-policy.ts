import type { OrchestrationMode, WorkerStep } from "./orchestration-types";
import { OrchestrationError } from "./orchestration-types";

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
};

export const assertActionTypeAllowed = (actionType: string): void => {
  if (FORBIDDEN_DIRECT_ACTIONS.has(actionType)) {
    throw new OrchestrationError(
      "ORCH_DIRECT_ACTION_BLOCKED",
      `Worker may not execute ${actionType} directly; create an approval through the conversation flow instead`,
    );
  }
};
