import type {
  AgentProfile,
  AgentProviderStatusMap,
  Capability,
  HarnessBindingReadinessIssue,
  HarnessBindingReadinessSeverity,
  HarnessBindingReadinessSummary,
  HarnessDefinition,
  McpServerConfig,
  SkillSource,
} from "@harness/core";

export type {
  HarnessBindingReadinessIssue,
  HarnessBindingReadinessSeverity,
  HarnessBindingReadinessSummary,
} from "@harness/core";

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

export interface HarnessAgentBindingCandidate {
  harnessAgentRef: string;
  label: string;
  sourceFile?: string;
  stepCount: number;
}

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
  const bindingByRef = new Map<string, string>();
  for (const [ref, profileId] of Object.entries(input.bindings)) {
    const key = normalizeBindingRef(ref);
    if (key.length > 0 && !bindingByRef.has(key)) {
      bindingByRef.set(key, profileId);
    }
  }
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
    const profileId =
      bindingByRef.get(normalizeBindingRef(candidate.harnessAgentRef)) ?? "";
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

export const harnessAgentBindingCandidates = (
  definition: HarnessDefinition,
  workflowId: string | null,
): HarnessAgentBindingCandidate[] => {
  const workflow =
    definition.workflows.find((item) => item.id === workflowId) ??
    definition.workflows[0] ??
    null;
  if (!workflow) return [];
  const agentsByRef = buildHarnessAgentRefIndex(definition);
  const candidates = new Map<string, HarnessAgentBindingCandidate>();
  for (const step of workflow.steps) {
    const ref = (step.agentRef ?? step.roleHint).trim();
    const key = normalizeBindingRef(ref);
    if (key.length === 0) continue;
    const agent = agentsByRef.get(key);
    const existing = candidates.get(key);
    if (existing) {
      candidates.set(key, {
        ...existing,
        stepCount: existing.stepCount + 1,
      });
      continue;
    }
    candidates.set(key, {
      harnessAgentRef: ref,
      label: agent?.name ?? step.roleHint,
      sourceFile: agent?.sourceFile,
      stepCount: 1,
    });
  }
  return [...candidates.values()];
};

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
  if (providers && !providers.codex.available) {
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
  if (
    profile.skillSourceIds.length > 0 &&
    profile.permissions.allowedSkillIds.length === 0
  ) {
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
