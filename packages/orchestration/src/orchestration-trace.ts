import type {
  OrchestrationMode,
  WorkerBackflowRule,
  WorkerStep,
} from "@harness/core";

/**
 * Phase 7 trace summary helpers. Pure functions producing the
 * artifact summary text that the worker-runner persists for each
 * worker step. Centralized so the format stays consistent.
 */
export const formatPlanSummary = (input: {
  mode: OrchestrationMode;
  workerSteps: WorkerStep[];
  backflowRules?: WorkerBackflowRule[];
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
    if (step.remoteEndpointId) {
      lines.push(`   - remote A2A endpoint: ${step.remoteEndpointId}`);
    }
    if (step.dependsOn !== undefined) {
      lines.push(
        `   - depends on: ${step.dependsOn.join(", ") || "(none)"}`,
      );
    }
    if (step.allowedActions !== undefined) {
      lines.push(
        `   - allowed actions: ${step.allowedActions.join(", ") || "(none)"}`,
      );
    }
    if (step.outputContract) {
      lines.push(`   - output contract: ${step.outputContract}`);
    }
  });
  if (input.backflowRules && input.backflowRules.length > 0) {
    lines.push("", "## Backflow Rules", "");
    input.backflowRules.forEach((rule, idx) => {
      lines.push(
        `${idx + 1}. **${rule.trigger}** — ${rule.retryStepId} -> ${rule.targetStepId}`,
        `   - retry: ${rule.retryStepId}`,
        `   - max attempts: ${rule.maxAttempts}`,
      );
      if (rule.instruction) {
        lines.push(`   - instruction: ${rule.instruction}`);
      }
    });
  }
  return lines.join("\n");
};

export const formatWorkerStepArtifact = (input: {
  step: WorkerStep;
  output: string;
  /** Display name of the AgentProfile (when pipeline-driven). */
  profileName?: string;
  /** Display name of the remote A2A endpoint (when selected). */
  remoteEndpointName?: string;
}): string => {
  const lines = [
    `# Worker step: ${input.step.title}`,
    "",
    `**Role**: ${input.step.role}`,
    `**Status**: ${input.step.status}`,
  ];
  if (input.profileName) {
    lines.push(`**Profile**: ${input.profileName}`);
  }
  if (input.remoteEndpointName) {
    lines.push(`**Remote A2A**: ${input.remoteEndpointName}`);
  }
  if (input.step.dependsOn !== undefined) {
    lines.push(
      `**Depends on**: ${input.step.dependsOn.join(", ") || "(none)"}`,
    );
  }
  if (input.step.allowedActions !== undefined) {
    lines.push(
      `**Allowed actions**: ${
        input.step.allowedActions.join(", ") || "(none)"
      }`,
    );
  }
  if (input.step.outputContract) {
    lines.push(`**Output contract**: ${input.step.outputContract}`);
  }
  lines.push(
    "",
    `## Output (advisory only — no side effects)`,
    "",
    input.output.trim().length > 0 ? input.output : "(empty)",
    "",
    `> 이 출력은 제안일 뿐, file/shell 변경이 필요하면 approval을 별도로 생성해야 합니다.`,
  );
  return lines.join("\n");
};
