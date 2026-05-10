import type { OrchestrationMode, WorkerStep } from "./orchestration-types";

/**
 * Phase 7 trace summary helpers. Pure functions producing the
 * artifact summary text that the worker-runner persists for each
 * worker step. Centralized so the format stays consistent.
 */
export const formatPlanSummary = (input: {
  mode: OrchestrationMode;
  workerSteps: WorkerStep[];
  instruction?: string;
}): string => {
  const lines: string[] = [
    `# Orchestration plan (mode=${input.mode})`,
    "",
    `Plan describes ${input.workerSteps.length} worker step(s). Approval is required before execution.`,
  ];
  if (input.instruction) {
    lines.push("", `**Instruction**: ${input.instruction}`);
  }
  lines.push("", `## Steps`, "");
  input.workerSteps.forEach((step, idx) => {
    lines.push(
      `${idx + 1}. **${step.role}** — ${step.title}`,
      `   - inputs: ${step.inputSummary || "(empty)"}`,
      `   - expected artifacts: ${
        step.expectedArtifactKinds.join(", ") || "(none)"
      }`,
    );
  });
  return lines.join("\n");
};

export const formatWorkerStepArtifact = (input: {
  step: WorkerStep;
  output: string;
}): string => {
  return [
    `# Worker step: ${input.step.title}`,
    "",
    `**Role**: ${input.step.role}`,
    `**Status**: ${input.step.status}`,
    "",
    `## Output (advisory only — no side effects)`,
    "",
    input.output.trim().length > 0 ? input.output : "(empty)",
    "",
    `> 이 출력은 제안일 뿐, file/shell 변경이 필요하면 approval을 별도로 생성해야 합니다.`,
  ].join("\n");
};
