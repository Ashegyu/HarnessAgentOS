import type { WorkerStep } from "./orchestration-types.ts";

export const effectiveWorkerDependencyIds = (
  steps: readonly WorkerStep[],
  index: number,
): string[] => {
  const step = steps[index];
  if (!step) return [];
  if (step.dependsOn !== undefined) return [...step.dependsOn];
  return index > 0 ? [steps[index - 1]!.id] : [];
};

export const buildEffectiveWorkerDependencyMap = (
  steps: readonly WorkerStep[],
): Map<string, string[]> =>
  new Map(
    steps.map(
      (step, index) =>
        [step.id, effectiveWorkerDependencyIds(steps, index)] as const,
    ),
  );
