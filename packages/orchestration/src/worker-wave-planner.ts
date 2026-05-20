import type {
  A2ARegistryEntry,
  ApprovalActionType,
  WorkerRole,
  WorkerStep,
} from "@harness/core";
import { effectiveWorkerDependencyIds } from "./worker-step-dependencies.ts";

export type ReadOnlyParallelRole = WorkerRole | "documenter";

export interface WorkerWaveStepPreview {
  stepId: string;
  title: string;
  index: number;
  role: ReadOnlyParallelRole | "unknown";
  dependencyIds: string[];
  remoteEndpointId: string | null;
  remoteEndpointLabel: string;
  remoteEndpointEnabled: boolean;
  remoteEndpointTrusted: boolean;
  allowedActions: ApprovalActionType[] | null;
  canRunReadOnlyParallel: boolean;
  blockers: string[];
  warnings: string[];
}

export interface WorkerWavePreview {
  index: number;
  stepIds: string[];
  parallelizable: boolean;
  hasSideEffects: boolean;
  warnings: string[];
  steps: WorkerWaveStepPreview[];
}

export interface WorkerWavePlan {
  waves: WorkerWavePreview[];
  deterministicOrder: string[];
  warnings: string[];
}

const READ_ONLY_PARALLEL_ROLES = new Set<string>([
  "planner",
  "orchestrator",
  "reviewer",
  "security-reviewer",
  "performance-reviewer",
  "documenter",
]);

export const planWorkerWaves = (
  workerSteps: readonly WorkerStep[],
  remoteEntries: readonly A2ARegistryEntry[] = [],
): WorkerWavePlan => {
  const remoteById = new Map(
    remoteEntries.map((entry) => [entry.endpoint.id, entry] as const),
  );
  const stepIdSet = new Set(workerSteps.map((step) => step.id));
  const dependencyById = new Map(
    workerSteps.map(
      (step, index) =>
        [step.id, effectiveWorkerDependencyIds(workerSteps, index)] as const,
    ),
  );
  const previews = workerSteps.map((step, index): WorkerWaveStepPreview => {
    const role = step.role ?? "unknown";
    const allowedActions =
      step.allowedActions !== undefined ? [...step.allowedActions] : null;
    const dependencyIds = dependencyById.get(step.id) ?? [];
    const blockers: string[] = [];
    const warnings: string[] = [];

    if (allowedActions === null) {
      blockers.push("Allowed Actions default prevents read-only parallel wave");
      warnings.push("Allowed Actions are not explicit");
    } else if (allowedActions.length > 0) {
      blockers.push(
        `side-effect proposals are allowed (${allowedActions.join(", ")})`,
      );
    }
    if (!READ_ONLY_PARALLEL_ROLES.has(role)) {
      blockers.push(`${role} role is not read-only parallel eligible`);
    }
    for (const depId of dependencyIds) {
      if (!stepIdSet.has(depId)) {
        blockers.push(`unknown dependency (${depId})`);
      }
    }

    const remoteEndpointId = step.remoteEndpointId?.trim() || null;
    const remoteEntry =
      remoteEndpointId !== null ? remoteById.get(remoteEndpointId) : undefined;
    let remoteEndpointLabel = "Local CLI";
    let remoteEndpointEnabled = true;
    let remoteEndpointTrusted = true;
    if (remoteEndpointId !== null) {
      remoteEndpointLabel =
        remoteEntry?.endpoint.name ?? `(missing remote: ${remoteEndpointId})`;
      remoteEndpointEnabled = remoteEntry?.endpoint.enabled ?? false;
      remoteEndpointTrusted = remoteEntry?.endpoint.trusted ?? false;
      if (remoteEntry === undefined) {
        blockers.push(`remote endpoint is missing (${remoteEndpointId})`);
      } else {
        if (!remoteEntry.endpoint.enabled) {
          blockers.push("remote endpoint is disabled");
        }
        if (!remoteEntry.endpoint.trusted) {
          blockers.push("remote endpoint is untrusted");
        }
      }
    }

    return {
      stepId: step.id,
      title: step.title,
      index,
      role,
      dependencyIds,
      remoteEndpointId,
      remoteEndpointLabel,
      remoteEndpointEnabled,
      remoteEndpointTrusted,
      allowedActions,
      canRunReadOnlyParallel: blockers.length === 0,
      blockers,
      warnings,
    };
  });
  return buildWavePlan(previews);
};

const buildWavePlan = (
  previews: readonly WorkerWaveStepPreview[],
): WorkerWavePlan => {
  const byId = new Map(previews.map((step) => [step.stepId, step] as const));
  const scheduled = new Set<string>();
  const remaining = new Set(previews.map((step) => step.stepId));
  const waves: WorkerWavePreview[] = [];
  const warnings: string[] = [];

  while (remaining.size > 0) {
    const ready = previews
      .filter(
        (step) =>
          remaining.has(step.stepId) &&
          step.dependencyIds.every((depId) => {
            if (!byId.has(depId)) return true;
            return scheduled.has(depId);
          }),
      )
      .sort((a, b) => a.index - b.index);

    if (ready.length === 0) {
      warnings.push("dependency cycle prevents complete wave planning");
      const blocked = previews
        .filter((step) => remaining.has(step.stepId))
        .sort((a, b) => a.index - b.index)
        .map((step) => ({
          ...step,
          blockers: [
            ...step.blockers,
            "dependency cycle prevents wave assignment",
          ],
          canRunReadOnlyParallel: false,
        }));
      waves.push(buildWave(waves.length, blocked));
      break;
    }

    for (const step of ready) {
      scheduled.add(step.stepId);
      remaining.delete(step.stepId);
    }
    waves.push(buildWave(waves.length, ready));
  }

  return {
    waves,
    deterministicOrder: previews.map((step) => step.stepId),
    warnings,
  };
};
const buildWave = (
  index: number,
  steps: readonly WorkerWaveStepPreview[],
): WorkerWavePreview => {
  const hasSideEffects = steps.some(
    (step) => step.allowedActions !== null && step.allowedActions.length > 0,
  );
  const hasDefaultActions = steps.some((step) => step.allowedActions === null);
  const parallelizable =
    steps.length > 1 && steps.every((step) => step.canRunReadOnlyParallel);
  const warnings: string[] = [];
  if (hasSideEffects) {
    warnings.push("wave contains side-effect proposals");
  }
  if (hasDefaultActions) {
    warnings.push("wave contains default action scope");
  }
  if (steps.length > 1 && !parallelizable) {
    warnings.push("wave remains serial under conservative policy");
  }
  return {
    index,
    stepIds: steps.map((step) => step.stepId),
    parallelizable,
    hasSideEffects,
    warnings,
    steps: [...steps],
  };
};
