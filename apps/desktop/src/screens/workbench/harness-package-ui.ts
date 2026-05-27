import type {
  AgentProfile,
  AgentProviderStatusMap,
  Capability,
  HarnessArtifactContract,
  HarnessDefinition,
  HarnessPackageRepairInput,
  HarnessWorkflowDefinition,
  McpServerConfig,
  SkillSource,
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

export type HarnessBindingReadinessSeverity = "error" | "warning" | "info";

export interface HarnessBindingReadinessIssue {
  severity: HarnessBindingReadinessSeverity;
  code: string;
  message: string;
  harnessAgentRef?: string;
  stepId?: string;
  profileId?: string;
}

export interface HarnessBindingReadinessSummary {
  ok: boolean;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  issues: readonly HarnessBindingReadinessIssue[];
}

export interface HarnessBindingReadinessInput {
  definition: HarnessDefinition;
  workflowId: string | null;
  bindings: Readonly<Record<string, string>>;
  profiles: readonly AgentProfile[];
  providers?: AgentProviderStatusMap;
  mcpServers?: readonly McpServerConfig[];
  skillSources?: readonly SkillSource[];
  capabilities?: readonly Capability[];
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

export const assessHarnessBindingReadiness = (
  input: HarnessBindingReadinessInput,
): HarnessBindingReadinessSummary => {
  const issues: HarnessBindingReadinessIssue[] = [];
  const profilesById = new Map(input.profiles.map((p) => [p.id, p] as const));
  const mcpById = new Map(
    (input.mcpServers ?? []).map((server) => [server.id, server] as const),
  );
  const skillSourceById = new Map(
    (input.skillSources ?? []).map((source) => [source.id, source] as const),
  );
  const capabilityById = new Map(
    (input.capabilities ?? []).map((capability) => [
      normalizeBindingRef(capability.id),
      capability,
    ] as const),
  );
  const agentByRef = buildHarnessAgentRefIndex(input.definition);
  const requiredPackageCapabilities = input.definition.capabilities.filter(
    (capability) => capability.required,
  );
  const requiresMcp = requiredPackageCapabilities.some(
    (capability) => capability.kind === "mcp_server",
  );
  const requiresSkillSource = requiredPackageCapabilities.some(
    (capability) => capability.kind === "skill_source",
  );
  const mcpRegistryLoaded = input.mcpServers !== undefined;
  const skillSourceRegistryLoaded = input.skillSources !== undefined;

  for (const capability of input.definition.capabilities) {
    if (capability.risk === "high") {
      issues.push({
        severity: "warning",
        code: "HARNESS_CAPABILITY_HIGH_RISK",
        message: `Harness capability ${capability.id} is high risk and must stay approval-visible.`,
      });
    }
    if (
      capability.required &&
      input.capabilities !== undefined &&
      capability.kind !== "model_provider" &&
      capability.kind !== "mcp_server" &&
      capability.kind !== "skill_source" &&
      !capabilityById.has(normalizeBindingRef(capability.id))
    ) {
      issues.push({
        severity: "warning",
        code: "HARNESS_CAPABILITY_UNMATCHED",
        message: `Required harness capability ${capability.id} is not present in the local capability registry.`,
      });
    }
  }

  for (const candidate of harnessAgentBindingCandidates(
    input.definition,
    input.workflowId,
  )) {
    const profileId = input.bindings[candidate.harnessAgentRef] ?? "";
    if (profileId.length === 0) {
      issues.push({
        severity: "error",
        code: "HARNESS_PROFILE_UNBOUND",
        message: `${candidate.label} is not bound to an AgentProfile.`,
        harnessAgentRef: candidate.harnessAgentRef,
      });
      continue;
    }
    const profile = profilesById.get(profileId);
    if (!profile) {
      issues.push({
        severity: "error",
        code: "HARNESS_PROFILE_UNKNOWN",
        message: `${candidate.label} is bound to a missing AgentProfile (${profileId}).`,
        harnessAgentRef: candidate.harnessAgentRef,
        profileId,
      });
      continue;
    }

    const agent = agentByRef.get(normalizeBindingRef(candidate.harnessAgentRef));
    collectProviderIssues(issues, candidate, profile, agent, input.providers);
    collectMcpIssues(
      issues,
      candidate,
      profile,
      mcpById,
      requiresMcp,
      mcpRegistryLoaded,
    );
    collectSkillSourceIssues(
      issues,
      candidate,
      profile,
      skillSourceById,
      requiresSkillSource,
      skillSourceRegistryLoaded,
    );
    collectAgentCapabilityIssues(
      issues,
      candidate,
      profile,
      agent?.requiredCapabilities ?? [],
      capabilityById,
      input.capabilities !== undefined,
    );
  }

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter(
    (issue) => issue.severity === "warning",
  ).length;
  const infoCount = issues.filter((issue) => issue.severity === "info").length;
  return {
    ok: errorCount === 0,
    errorCount,
    warningCount,
    infoCount,
    issues,
  };
};

const normalizeMatchText = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "");

const normalizeBindingRef = (value: string): string =>
  value.trim().toLowerCase();

const buildHarnessAgentRefIndex = (
  definition: HarnessDefinition,
): ReadonlyMap<string, HarnessDefinition["agents"][number]> => {
  const out = new Map<string, HarnessDefinition["agents"][number]>();
  for (const agent of definition.agents) {
    out.set(normalizeBindingRef(agent.id), agent);
    out.set(normalizeBindingRef(agent.roleHint), agent);
  }
  return out;
};

const collectProviderIssues = (
  issues: HarnessBindingReadinessIssue[],
  candidate: HarnessAgentBindingCandidate,
  profile: AgentProfile,
  agent: HarnessDefinition["agents"][number] | undefined,
  providers: AgentProviderStatusMap | undefined,
): void => {
  if (
    agent?.providerHint !== undefined &&
    agent.providerHint !== "auto" &&
    profile.provider !== "auto" &&
    profile.provider !== agent.providerHint
  ) {
    issues.push({
      severity: "warning",
      code: "HARNESS_PROVIDER_HINT_MISMATCH",
      message: `${candidate.label} prefers ${agent.providerHint}, but ${profile.name} uses ${profile.provider}.`,
      harnessAgentRef: candidate.harnessAgentRef,
      profileId: profile.id,
    });
  }
  if (profile.provider === "auto") {
    issues.push({
      severity: "info",
      code: "HARNESS_PROVIDER_AUTO",
      message: `${profile.name} uses provider=auto; runtime provider readiness depends on current settings.`,
      harnessAgentRef: candidate.harnessAgentRef,
      profileId: profile.id,
    });
    return;
  }
  if (providers && !providers[profile.provider].available) {
    issues.push({
      severity: "warning",
      code: "HARNESS_PROVIDER_UNAVAILABLE",
      message: `${profile.provider} provider is not currently available for ${profile.name}.`,
      harnessAgentRef: candidate.harnessAgentRef,
      profileId: profile.id,
    });
  }
};

const collectMcpIssues = (
  issues: HarnessBindingReadinessIssue[],
  candidate: HarnessAgentBindingCandidate,
  profile: AgentProfile,
  mcpById: ReadonlyMap<string, McpServerConfig>,
  requiresMcp: boolean,
  registryLoaded: boolean,
): void => {
  if (requiresMcp && profile.mcpServerIds.length === 0) {
    issues.push({
      severity: "warning",
      code: "HARNESS_MCP_BINDING_MISSING",
      message: `${profile.name} has no MCP server binding for a harness that declares MCP requirements.`,
      harnessAgentRef: candidate.harnessAgentRef,
      profileId: profile.id,
    });
  }
  if (!registryLoaded) return;
  for (const serverId of profile.mcpServerIds) {
    const server = mcpById.get(serverId);
    if (!server) {
      issues.push({
        severity: "warning",
        code: "HARNESS_MCP_UNKNOWN",
        message: `${profile.name} references missing MCP server ${serverId}.`,
        harnessAgentRef: candidate.harnessAgentRef,
        profileId: profile.id,
      });
      continue;
    }
    if (!server.enabled) {
      issues.push({
        severity: "warning",
        code: "HARNESS_MCP_DISABLED",
        message: `${profile.name} references disabled MCP server ${server.name}.`,
        harnessAgentRef: candidate.harnessAgentRef,
        profileId: profile.id,
      });
    }
    if (
      profile.provider === "codex" &&
      (server.transport !== "stdio" ||
        Object.keys(server.envSecretRefs).length > 0)
    ) {
      issues.push({
        severity: "warning",
        code: "HARNESS_MCP_CODEX_LIMITED",
        message: `${server.name} may not be usable by Codex because only stdio/no-secret MCP overrides are currently supported.`,
        harnessAgentRef: candidate.harnessAgentRef,
        profileId: profile.id,
      });
    }
  }
};

const collectSkillSourceIssues = (
  issues: HarnessBindingReadinessIssue[],
  candidate: HarnessAgentBindingCandidate,
  profile: AgentProfile,
  skillSourceById: ReadonlyMap<string, SkillSource>,
  requiresSkillSource: boolean,
  registryLoaded: boolean,
): void => {
  if (requiresSkillSource && profile.skillSourceIds.length === 0) {
    issues.push({
      severity: "warning",
      code: "HARNESS_SKILL_SOURCE_BINDING_MISSING",
      message: `${profile.name} has no Skill source binding for a harness that declares Skill requirements.`,
      harnessAgentRef: candidate.harnessAgentRef,
      profileId: profile.id,
    });
  }
  if (!registryLoaded) return;
  for (const sourceId of profile.skillSourceIds) {
    const source = skillSourceById.get(sourceId);
    if (!source) {
      issues.push({
        severity: "warning",
        code: "HARNESS_SKILL_SOURCE_UNKNOWN",
        message: `${profile.name} references missing Skill source ${sourceId}.`,
        harnessAgentRef: candidate.harnessAgentRef,
        profileId: profile.id,
      });
      continue;
    }
    if (!source.enabled) {
      issues.push({
        severity: "warning",
        code: "HARNESS_SKILL_SOURCE_DISABLED",
        message: `${profile.name} references disabled Skill source ${source.name}.`,
        harnessAgentRef: candidate.harnessAgentRef,
        profileId: profile.id,
      });
    }
    if (!source.trusted) {
      issues.push({
        severity: "warning",
        code: "HARNESS_SKILL_SOURCE_UNTRUSTED",
        message: `${source.name} is untrusted; skill_script actions remain blocked until promoted.`,
        harnessAgentRef: candidate.harnessAgentRef,
        profileId: profile.id,
      });
    }
  }
  if (profile.skillSourceIds.length > 0 && profile.permissions.allowedSkillIds.length === 0) {
    issues.push({
      severity: "info",
      code: "HARNESS_SKILL_ALLOWLIST_OPEN",
      message: `${profile.name} allows all enabled Skills from selected sources.`,
      harnessAgentRef: candidate.harnessAgentRef,
      profileId: profile.id,
    });
  }
};

const collectAgentCapabilityIssues = (
  issues: HarnessBindingReadinessIssue[],
  candidate: HarnessAgentBindingCandidate,
  profile: AgentProfile,
  requiredCapabilities: readonly string[],
  capabilityById: ReadonlyMap<string, Capability>,
  capabilityRegistryLoaded: boolean,
): void => {
  const allowlist = new Set(profile.permissions.allowedSkillIds);
  for (const requiredCapability of requiredCapabilities) {
    const capability = capabilityById.get(normalizeBindingRef(requiredCapability));
    if (capabilityRegistryLoaded && !capability) {
      issues.push({
        severity: "warning",
        code: "HARNESS_AGENT_CAPABILITY_UNKNOWN",
        message: `${candidate.label} requires capability ${requiredCapability}, but it is not present in the local registry.`,
        harnessAgentRef: candidate.harnessAgentRef,
        profileId: profile.id,
      });
    }
    const capabilityId = capability?.id ?? requiredCapability;
    if (allowlist.size > 0 && !allowlist.has(capabilityId)) {
      issues.push({
        severity: "warning",
        code: "HARNESS_AGENT_CAPABILITY_NOT_ALLOWED",
        message: `${profile.name} does not allow required capability ${capabilityId}.`,
        harnessAgentRef: candidate.harnessAgentRef,
        profileId: profile.id,
      });
    }
  }
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
