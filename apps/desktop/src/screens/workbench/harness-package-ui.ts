import type {
  AgentProfile,
  HarnessArtifactContract,
  HarnessDefinition,
  HarnessPackageRepairInput,
  HarnessWorkflowDefinition,
  WorkerOutputContract,
  HarnessSourceFormat,
  HarnessValidationIssue,
  HarnessValidationStatus,
} from "@harness/core";
import { WORKER_OUTPUT_CONTRACTS } from "@harness/core";

export const HARNESS_SOURCE_FORMAT_LABELS: Record<HarnessSourceFormat, string> =
  {
    claude: "Claude",
    codex: "Codex",
    "harness-native": "Harness native",
  };

export const HARNESS_VALIDATION_STATUS_LABELS: Record<
  HarnessValidationStatus,
  string
> = {
  valid: "Valid",
  valid_with_warnings: "Warnings",
  needs_review: "Needs review",
  unsupported: "Unsupported",
};

export interface HarnessPackageSummary {
  formatLabel: string;
  statusLabel: string;
  files: number;
  agents: number;
  skills: number;
  workflows: number;
  capabilities: number;
  issueCounts: Record<HarnessValidationIssue["severity"], number>;
  blocksExecution: boolean;
}

export interface HarnessAgentBindingCandidate {
  harnessAgentRef: string;
  label: string;
  sourceFile?: string;
  stepCount: number;
}

export interface HarnessWorkflowStepRow {
  id: string;
  title: string;
  owner: string;
  dependsOn: string;
  artifacts: string;
  outputContract: string;
}

export interface HarnessWorkflowStepRepairDraft {
  stepId: string;
  title: string;
  agentRef: string;
  roleHint: string;
  instruction: string;
  dependsOnText: string;
  artifactsText: string;
  artifactContracts: readonly HarnessArtifactContract[];
  outputContract: WorkerOutputContract;
}

export interface HarnessWorkflowRepairDraft {
  workflowId: string;
  note: string;
  steps: readonly HarnessWorkflowStepRepairDraft[];
}

export const summarizeHarnessPackage = (
  definition: HarnessDefinition,
): HarnessPackageSummary => {
  const issueCounts = {
    info: 0,
    warning: 0,
    error: 0,
  };
  let blocksExecution = false;
  for (const issue of definition.validation.issues) {
    issueCounts[issue.severity] += 1;
    if (issue.blocksExecution) blocksExecution = true;
  }
  return {
    formatLabel: HARNESS_SOURCE_FORMAT_LABELS[definition.source.format],
    statusLabel: HARNESS_VALIDATION_STATUS_LABELS[definition.validation.status],
    files: definition.source.files.length,
    agents: definition.agents.length,
    skills: definition.skills.length,
    workflows: definition.workflows.length,
    capabilities: definition.capabilities.length,
    issueCounts,
    blocksExecution,
  };
};

export const primaryHarnessPackageIssue = (
  definition: HarnessDefinition,
): HarnessValidationIssue | null =>
  definition.validation.issues.find((issue) => issue.blocksExecution) ??
  definition.validation.issues[0] ??
  null;

export const harnessAgentBindingCandidates = (
  definition: HarnessDefinition,
  workflowId: string | null,
): HarnessAgentBindingCandidate[] => {
  const workflow =
    definition.workflows.find((item) => item.id === workflowId) ??
    definition.workflows[0] ??
    null;
  if (!workflow) return [];
  const agentsById = new Map(
    definition.agents.map((agent) => [agent.id, agent] as const),
  );
  const candidates = new Map<string, HarnessAgentBindingCandidate>();
  for (const step of workflow.steps) {
    const ref = step.agentRef ?? step.roleHint;
    if (ref.length === 0) continue;
    const agent = agentsById.get(ref);
    const existing = candidates.get(ref);
    if (existing) {
      candidates.set(ref, {
        ...existing,
        stepCount: existing.stepCount + 1,
      });
      continue;
    }
    candidates.set(ref, {
      harnessAgentRef: ref,
      label: agent?.name ?? step.roleHint,
      sourceFile: agent?.sourceFile,
      stepCount: 1,
    });
  }
  return [...candidates.values()];
};

export const suggestHarnessProfileBinding = (
  candidate: HarnessAgentBindingCandidate,
  profiles: readonly AgentProfile[],
): string => {
  const ref = normalizeMatchText(candidate.harnessAgentRef);
  const label = normalizeMatchText(candidate.label);
  const exact = profiles.find((profile) => {
    const name = normalizeMatchText(profile.name);
    return name === ref || name === label;
  });
  if (exact) return exact.id;
  const tagged = profiles.find((profile) =>
    profile.tags.some((tag) => {
      const normalized = normalizeMatchText(tag);
      return normalized === ref || normalized === label;
    }),
  );
  if (tagged) return tagged.id;
  const partial = profiles.find((profile) => {
    const name = normalizeMatchText(profile.name);
    return name.includes(ref) || ref.includes(name);
  });
  return partial?.id ?? "";
};

export const harnessWorkflowStepRows = (
  workflow: HarnessWorkflowDefinition,
): HarnessWorkflowStepRow[] =>
  workflow.steps.map((step) => ({
    id: step.id,
    title: step.title,
    owner: step.agentRef ?? step.roleHint,
    dependsOn:
      step.dependsOn.length > 0 ? step.dependsOn.join(", ") : "None",
    artifacts:
      step.artifactContracts.length > 0
        ? step.artifactContracts
            .map((artifact) => artifact.pathHint ?? artifact.title)
            .join(", ")
        : "None",
    outputContract: step.outputContract,
  }));

export const repairDraftFromWorkflow = (
  workflow: HarnessWorkflowDefinition,
): HarnessWorkflowRepairDraft => ({
  workflowId: workflow.id,
  note: "",
  steps: workflow.steps.map((step) => ({
    stepId: step.id,
    title: step.title,
    agentRef: step.agentRef ?? "",
    roleHint: step.roleHint,
    instruction: step.instruction,
    dependsOnText: step.dependsOn.join(", "),
    artifactsText: formatHarnessArtifactText(step.artifactContracts),
    artifactContracts: step.artifactContracts,
    outputContract: step.outputContract,
  })),
});

export const repairInputFromDraft = (
  packageId: string,
  draft: HarnessWorkflowRepairDraft,
): HarnessPackageRepairInput => ({
  packageId,
  ...(draft.note.trim().length > 0 ? { note: draft.note.trim() } : {}),
  workflows: [
    {
      workflowId: draft.workflowId,
      steps: draft.steps.map((step) => {
        const agentRef = step.agentRef.trim();
        return {
          stepId: step.stepId,
          title: step.title.trim(),
          agentRef: agentRef.length > 0 ? agentRef : null,
          roleHint: step.roleHint.trim(),
          instruction: step.instruction,
          dependsOn: parseHarnessListText(step.dependsOnText),
          artifactContracts: repairArtifactContractsFromText(
            step.stepId,
            step.artifactsText,
            step.artifactContracts,
          ),
          outputContract: step.outputContract,
        };
      }),
    },
  ],
});

export const validateHarnessWorkflowRepairDraft = (
  draft: HarnessWorkflowRepairDraft,
): string[] => {
  const issues: string[] = [];
  const stepIds = new Set(draft.steps.map((step) => step.stepId));
  const depsByStep = new Map<string, readonly string[]>();
  for (const step of draft.steps) {
    if (step.title.trim().length === 0) {
      issues.push(`${step.stepId}: title is required.`);
    }
    if (step.roleHint.trim().length === 0) {
      issues.push(`${step.stepId}: role hint is required.`);
    }
    if (!WORKER_OUTPUT_CONTRACT_SET.has(step.outputContract)) {
      issues.push(`${step.stepId}: output contract is invalid.`);
    }
    const deps = parseHarnessListText(step.dependsOnText);
    depsByStep.set(step.stepId, deps);
    for (const depId of deps) {
      if (!stepIds.has(depId)) {
        issues.push(`${step.stepId}: unknown dependency ${depId}.`);
      }
      if (depId === step.stepId) {
        issues.push(`${step.stepId}: dependency cannot reference itself.`);
      }
    }
  }
  if (hasDependencyCycle(depsByStep)) {
    issues.push("Workflow dependencies contain a cycle.");
  }
  return issues;
};

const normalizeMatchText = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "");

const WORKER_OUTPUT_CONTRACT_SET: ReadonlySet<string> = new Set(
  WORKER_OUTPUT_CONTRACTS,
);

const NONE_LIST_TOKENS = new Set(["none", "n/a", "na", "없음"]);

const parseHarnessListText = (value: string): string[] => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  if (NONE_LIST_TOKENS.has(trimmed.toLowerCase())) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of trimmed.split(/[,\n]+/)) {
    const item = token.trim();
    if (item.length === 0 || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
};

const formatHarnessArtifactText = (
  artifacts: readonly HarnessArtifactContract[],
): string =>
  artifacts
    .map((artifact) => artifact.pathHint ?? artifact.title)
    .filter((value) => value.length > 0)
    .join(", ");

const repairArtifactContractsFromText = (
  stepId: string,
  value: string,
  existing: readonly HarnessArtifactContract[],
): HarnessArtifactContract[] => {
  const tokens = parseHarnessListText(value);
  return tokens.map((token, index) => {
    const current = existing[index];
    const usesPathHint = /[\\/]/.test(token) || token.includes(".");
    return {
      id: current?.id ?? `${stepId}-artifact-${index + 1}`,
      ...(usesPathHint ? { pathHint: token } : {}),
      title: current?.title ?? token,
      kind: current?.kind ?? "workspace_file",
      required: current?.required ?? true,
      description: current?.description ?? token,
      ...(current?.validationHint !== undefined
        ? { validationHint: current.validationHint }
        : {}),
    };
  });
};

const hasDependencyCycle = (
  depsByStep: ReadonlyMap<string, readonly string[]>,
): boolean => {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): boolean => {
    if (visited.has(stepId)) return false;
    if (visiting.has(stepId)) return true;
    visiting.add(stepId);
    for (const depId of depsByStep.get(stepId) ?? []) {
      if (depsByStep.has(depId) && visit(depId)) return true;
    }
    visiting.delete(stepId);
    visited.add(stepId);
    return false;
  };
  for (const stepId of depsByStep.keys()) {
    if (visit(stepId)) return true;
  }
  return false;
};
