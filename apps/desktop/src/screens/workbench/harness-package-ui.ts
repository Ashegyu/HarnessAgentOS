import type {
  AgentProfile,
  AgentProvider,
  HarnessArtifactContract,
  HarnessDefinition,
  HarnessPackageRepairInput,
  HarnessWorkflowDefinition,
  WorkerOutputContract,
  HarnessSourceFormat,
  HarnessValidationIssue,
  HarnessValidationStatus,
  WorkerRole,
} from "@harness/core";
import {
  DEFAULT_AGENT_PERMISSIONS,
  DEFAULT_AGENT_STALL_TIMEOUT_MS,
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_CODEX_MODEL,
  WORKER_OUTPUT_CONTRACTS,
} from "@harness/core";
import type { HarnessAgentBindingCandidate } from "@harness/orchestration/harness-binding-readiness";
export {
  assessHarnessBindingReadiness,
  harnessAgentBindingCandidates,
  type HarnessAgentBindingCandidate,
  type HarnessBindingReadinessInput,
  type HarnessBindingReadinessIssue,
  type HarnessBindingReadinessSeverity,
  type HarnessBindingReadinessSummary,
} from "@harness/orchestration/harness-binding-readiness";

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

export const inferHarnessCandidateWorkerRole = (
  candidate: HarnessAgentBindingCandidate,
): WorkerRole => {
  const text = normalizeMatchText(
    `${candidate.harnessAgentRef} ${candidate.label}`,
  );
  if (/(security|sec|vuln|threat|auth|secret)/.test(text)) {
    return "security-reviewer";
  }
  if (/(performance|perf|latency|benchmark|allocation)/.test(text)) {
    return "performance-reviewer";
  }
  if (/(build|compile|resolver|failure|error)/.test(text)) {
    return "build-error-resolver";
  }
  if (/(refactor|cleanup|cleaner)/.test(text)) return "refactor-cleaner";
  if (/(test|tester|qa|verify|validator|validation)/.test(text)) {
    return "tester";
  }
  if (/(review|reviewer|critic|quality)/.test(text)) return "reviewer";
  if (/(orchestrator|coordinate|coordinator|workflow)/.test(text)) {
    return "orchestrator";
  }
  if (/(doc|document|documentation|writerdoc)/.test(text)) {
    return "documenter";
  }
  if (/(plan|planner|architect|strategy|strategist|prd|design)/.test(text)) {
    return "planner";
  }
  return "coder";
};

export const createAgentProfileInputFromHarnessCandidate = (
  candidate: HarnessAgentBindingCandidate,
  provider: AgentProvider = "codex",
): Omit<AgentProfile, "id" | "createdAt" | "updatedAt"> => {
  const name = candidate.label.trim() || candidate.harnessAgentRef;
  const tags = uniqueNonEmpty([
    candidate.harnessAgentRef,
    candidate.label,
    candidate.sourceFile ?? "",
  ]);
  return {
    name,
    description: `Imported harness role for ${candidate.harnessAgentRef}.`,
    category: "harness",
    tags,
    provider,
    role: inferHarnessCandidateWorkerRole(candidate),
    persona: [
      `You are the ${name} worker for imported Harness workflows.`,
      `Harness agent ref: ${candidate.harnessAgentRef}.`,
      "Follow the workflow step instructions exactly and keep side effects approval-gated.",
    ].join(" "),
    tuning: {
      model: DEFAULT_CODEX_MODEL,
      reasoningEffort: "xhigh",
      timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
      stallTimeoutMs: DEFAULT_AGENT_STALL_TIMEOUT_MS,
      contextDepth: 5,
      systemPromptPrefix: "",
      systemPromptSuffix: "",
    },
    cli: {
      cliPathOverride: "",
      env: {},
      envSecretRefs: {},
    },
    permissions: {
      autoApproveActions: [...DEFAULT_AGENT_PERMISSIONS.autoApproveActions],
      blockedActions: [...DEFAULT_AGENT_PERMISSIONS.blockedActions],
      allowedSkillIds: [...DEFAULT_AGENT_PERMISSIONS.allowedSkillIds],
      toolAllowlist: [...DEFAULT_AGENT_PERMISSIONS.toolAllowlist],
      toolDenylist: [...DEFAULT_AGENT_PERMISSIONS.toolDenylist],
    },
    mcpServerIds: [],
    skillSourceIds: [],
    isDefault: false,
  };
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

const uniqueNonEmpty = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
};

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
