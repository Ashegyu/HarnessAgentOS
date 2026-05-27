import type {
  AgentProfile,
  HarnessDefinition,
  HarnessSourceFormat,
  HarnessValidationIssue,
  HarnessValidationStatus,
} from "@harness/core";

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

const normalizeMatchText = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "");
