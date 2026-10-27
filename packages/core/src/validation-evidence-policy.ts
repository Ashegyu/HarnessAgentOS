import type { Artifact } from "./types/artifact.ts";
import type { Step } from "./types/step.ts";
import type { ValidationRun } from "./types/validation-run.ts";

export interface CurrentValidationWorkspace {
  workspaceKey: string;
  fingerprint: string | null;
  generation: number;
  activeMutations: number;
}

export interface CurrentValidationEvidence {
  runs: ValidationRun[];
  unverifiedReasons: string[];
}

/** Latest host execution per exact checker, evaluated against current inputs. */
export const selectCurrentValidationEvidence = (input: {
  taskRunId: string;
  runs: readonly ValidationRun[];
  steps: readonly Step[];
  artifacts: readonly Artifact[];
  current: CurrentValidationWorkspace;
}): CurrentValidationEvidence => {
  const latest = new Map<string, ValidationRun>();
  const ambiguous = new Set<string>();
  for (const run of input.runs) {
    if (run.taskRunId !== input.taskRunId || run.kinds.length === 0) continue;
    const prior = latest.get(run.checkerId);
    if (prior?.sequence === run.sequence && prior.id !== run.id) ambiguous.add(run.checkerId);
    if (!prior || run.sequence > prior.sequence) latest.set(run.checkerId, run);
  }
  const steps = new Map(input.steps.filter(step => step.taskRunId === input.taskRunId).map(step => [step.id, step]));
  const artifacts = new Map(input.artifacts.filter(artifact => artifact.taskRunId === input.taskRunId).map(artifact => [artifact.id, artifact]));
  const result: CurrentValidationEvidence = { runs: [], unverifiedReasons: [] };
  const reject = (reason: string): void => {
    if (!result.unverifiedReasons.includes(reason)) result.unverifiedReasons.push(reason);
  };
  for (const run of [...latest.values()].sort((a, b) => a.sequence - b.sequence)) {
    if (ambiguous.has(run.checkerId) || !Number.isSafeInteger(run.sequence) || run.sequence < 1) {
      reject("validation execution ordering is unverifiable");
      continue;
    }
    if (!input.current.fingerprint || input.current.activeMutations !== 0 ||
        run.workspaceKey !== input.current.workspaceKey || run.startFingerprint !== input.current.fingerprint ||
        run.finishFingerprint !== input.current.fingerprint || run.startGeneration !== input.current.generation ||
        run.finishGeneration !== input.current.generation) {
      reject("validation inputs changed or could not be verified; rerun the checks");
      continue;
    }
    if (run.status === "running" || run.status === "cancelled") {
      reject("the latest validation execution did not finish");
      continue;
    }
    const step = steps.get(run.stepId);
    const succeeded = run.status === "completed" && run.exitCode === 0;
    if (!step || (step.kind !== "shell" && step.kind !== "test") ||
        step.status !== (succeeded ? "succeeded" : "failed")) {
      reject("validation execution is not linked to a matching terminal runner step");
      continue;
    }
    const artifact = run.artifactId ? artifacts.get(run.artifactId) : undefined;
    if ((succeeded && !artifact) || (artifact && (artifact.stepId !== run.stepId ||
        (artifact.kind !== "log" && artifact.kind !== "test_result")))) {
      reject("validation output artifact is missing or belongs to another execution");
      continue;
    }
    if (run.status === "completed" && !Number.isInteger(run.exitCode)) {
      reject("validation process has no recorded exit result");
      continue;
    }
    result.runs.push(run);
  }
  return result;
};
