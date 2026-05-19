import type {
  AgentProfile,
  AgentProfileBindingSnapshot,
  CapabilityBindingRisk,
  McpServerBindingProposalResult,
  McpServerConfig,
  SkillProfileBindingProposalResult,
  SkillSource,
} from "@harness/core";

export interface BuildMcpServerBindingProposalInput {
  profile: AgentProfile;
  server: McpServerConfig;
}

export const buildMcpServerBindingProposal = (
  input: BuildMcpServerBindingProposalInput,
): McpServerBindingProposalResult => {
  const { profile, server } = input;
  const before = snapshotProfileBindings(profile);
  const addMcpServerIds =
    server.scope === "per-agent" && !profile.mcpServerIds.includes(server.id)
      ? [server.id]
      : [];
  const after: AgentProfileBindingSnapshot = {
    ...before,
    mcpServerIds: uniqueAppend(before.mcpServerIds, addMcpServerIds),
  };
  const warnings = buildWarnings({ profile, server, addMcpServerIds });
  const alreadySatisfied = snapshotsEqual(before, after);
  const risk = bindingRisk({ profile, server, addMcpServerIds });

  return {
    serverId: server.id,
    serverName: server.name,
    profileId: profile.id,
    profileName: profile.name,
    proposal: {
      profileId: profile.id,
      addMcpServerIds,
      addSkillSourceIds: [],
      allowSkillIds: [],
      addToolAllowPatterns: [],
      addToolDenyPatterns: [],
      rationale: rationaleFor({ profile, server, addMcpServerIds }),
      risk,
    },
    preview: {
      ok: true,
      warnings,
      alreadySatisfied,
      before,
      after,
    },
  };
};

export const applyMcpServerBindingProposal = (
  profile: AgentProfile,
  result: McpServerBindingProposalResult,
): AgentProfile => {
  if (profile.id !== result.profileId) {
    throw new Error(
      `Binding proposal for "${result.profileId}" does not target AgentProfile "${profile.id}".`,
    );
  }
  return {
    ...profile,
    mcpServerIds: [...result.preview.after.mcpServerIds],
  };
};

export interface BuildSkillSourceBindingProposalInput {
  profile: AgentProfile;
  source: SkillSource;
  capabilityIds?: readonly string[];
}

export const buildSkillSourceBindingProposal = (
  input: BuildSkillSourceBindingProposalInput,
): SkillProfileBindingProposalResult => {
  const { profile, source } = input;
  const before = snapshotProfileBindings(profile);
  const requestedCapabilityIds = uniqueList(input.capabilityIds ?? []);
  const addSkillSourceIds = !profile.skillSourceIds.includes(source.id)
    ? [source.id]
    : [];
  const allowSkillIds =
    before.allowedSkillIds.length === 0
      ? []
      : requestedCapabilityIds.filter(
          (id) => !before.allowedSkillIds.includes(id),
        );
  const after: AgentProfileBindingSnapshot = {
    ...before,
    skillSourceIds: uniqueAppend(before.skillSourceIds, addSkillSourceIds),
    allowedSkillIds: uniqueAppend(before.allowedSkillIds, allowSkillIds),
  };
  const warnings = buildSkillWarnings({
    profile,
    source,
    requestedCapabilityIds,
    addSkillSourceIds,
    allowSkillIds,
  });
  const alreadySatisfied = snapshotsEqual(before, after);
  const risk = skillBindingRisk({ source, addSkillSourceIds, allowSkillIds });

  return {
    sourceId: source.id,
    sourceName: source.name,
    profileId: profile.id,
    profileName: profile.name,
    proposal: {
      profileId: profile.id,
      addMcpServerIds: [],
      addSkillSourceIds,
      allowSkillIds,
      addToolAllowPatterns: [],
      addToolDenyPatterns: [],
      rationale: skillRationaleFor({
        profile,
        source,
        addSkillSourceIds,
        allowSkillIds,
      }),
      risk,
    },
    preview: {
      ok: true,
      warnings,
      alreadySatisfied,
      before,
      after,
    },
  };
};

export const applySkillSourceBindingProposal = (
  profile: AgentProfile,
  result: SkillProfileBindingProposalResult,
): AgentProfile => {
  if (profile.id !== result.profileId) {
    throw new Error(
      `Binding proposal for "${result.profileId}" does not target AgentProfile "${profile.id}".`,
    );
  }
  return {
    ...profile,
    skillSourceIds: [...result.preview.after.skillSourceIds],
    permissions: {
      ...profile.permissions,
      allowedSkillIds: [...result.preview.after.allowedSkillIds],
    },
  };
};

const snapshotProfileBindings = (
  profile: AgentProfile,
): AgentProfileBindingSnapshot => ({
  mcpServerIds: [...profile.mcpServerIds],
  skillSourceIds: [...profile.skillSourceIds],
  allowedSkillIds: [...profile.permissions.allowedSkillIds],
  toolAllowlist: [...profile.permissions.toolAllowlist],
  toolDenylist: [...profile.permissions.toolDenylist],
});

const uniqueAppend = (
  current: readonly string[],
  additions: readonly string[],
): string[] => {
  const seen = new Set(current);
  const next = [...current];
  for (const id of additions) {
    if (seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  return next;
};

const uniqueList = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
};

const snapshotsEqual = (
  before: AgentProfileBindingSnapshot,
  after: AgentProfileBindingSnapshot,
): boolean =>
  arraysEqual(before.mcpServerIds, after.mcpServerIds) &&
  arraysEqual(before.skillSourceIds, after.skillSourceIds) &&
  arraysEqual(before.allowedSkillIds, after.allowedSkillIds) &&
  arraysEqual(before.toolAllowlist, after.toolAllowlist) &&
  arraysEqual(before.toolDenylist, after.toolDenylist);

const arraysEqual = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const buildWarnings = (input: {
  profile: AgentProfile;
  server: McpServerConfig;
  addMcpServerIds: readonly string[];
}): string[] => {
  const { profile, server, addMcpServerIds } = input;
  const warnings: string[] = [];

  if (server.scope === "global") {
    warnings.push(
      "This is a global MCP server; it is selected for Claude invocations without adding it to AgentProfile.mcpServerIds.",
    );
  } else if (addMcpServerIds.length === 0) {
    warnings.push(
      `AgentProfile "${profile.name}" already includes MCP server "${server.name}".`,
    );
  }

  if (profile.provider === "codex") {
    if (server.transport === "stdio" && Object.keys(server.envSecretRefs).length === 0) {
      warnings.push(
        "Codex per-run MCP delivery uses verified mcp_servers overrides for stdio/no-secret servers. Actual MCP tool calls still depend on an authenticated Codex CLI run.",
      );
    } else {
      warnings.push(
        "Codex per-run MCP delivery is limited to stdio/no-secret servers; remote transports or SecretVault refs will fail before CLI launch.",
      );
    }
  } else if (profile.provider !== "claude") {
    warnings.push(
      "provider=auto may resolve to Codex; MCP delivery is limited to Codex stdio/no-secret servers or Claude MCP config.",
    );
  }
  if (!server.enabled) {
    warnings.push(
      `MCP server "${server.name}" is disabled; binding will not activate it until the server is enabled.`,
    );
  }
  if (!server.lastHealth?.okAt) {
    warnings.push(
      `MCP server "${server.name}" health check has not succeeded yet.`,
    );
  }
  if (profile.permissions.toolDenylist.length > 0) {
    warnings.push(
      "Existing AgentProfile toolDenylist entries remain higher priority than allow patterns.",
    );
  }

  return warnings;
};

const bindingRisk = (input: {
  profile: AgentProfile;
  server: McpServerConfig;
  addMcpServerIds: readonly string[];
}): CapabilityBindingRisk => {
  const { profile, server, addMcpServerIds } = input;
  if (addMcpServerIds.length === 0) return "low";
  if (profile.provider !== "claude") return "medium";
  if (!server.enabled || !server.lastHealth?.okAt) return "medium";
  return "low";
};

const rationaleFor = (input: {
  profile: AgentProfile;
  server: McpServerConfig;
  addMcpServerIds: readonly string[];
}): string => {
  const { profile, server, addMcpServerIds } = input;
  if (server.scope === "global") {
    return `No profile-local id change is needed because "${server.name}" has global scope.`;
  }
  if (addMcpServerIds.length === 0) {
    return `"${server.name}" is already present in AgentProfile "${profile.name}".`;
  }
  return `Add MCP server "${server.name}" to AgentProfile "${profile.name}" for future compatible provider invocations.`;
};

const buildSkillWarnings = (input: {
  profile: AgentProfile;
  source: SkillSource;
  requestedCapabilityIds: readonly string[];
  addSkillSourceIds: readonly string[];
  allowSkillIds: readonly string[];
}): string[] => {
  const {
    profile,
    source,
    requestedCapabilityIds,
    addSkillSourceIds,
    allowSkillIds,
  } = input;
  const warnings: string[] = [];

  if (addSkillSourceIds.length === 0) {
    warnings.push(
      `AgentProfile "${profile.name}" already includes Skill source "${source.name}".`,
    );
  }
  if (!source.enabled) {
    warnings.push(
      `Skill source "${source.name}" is disabled; binding will not expose its skills until the source is enabled.`,
    );
  }
  if (!source.trusted) {
    warnings.push(
      `Skill source "${source.name}" is untrusted; skill_script actions remain blocked unless trust is promoted.`,
    );
  }
  if (
    requestedCapabilityIds.length > 0 &&
    profile.permissions.allowedSkillIds.length === 0
  ) {
    warnings.push(
      "AgentProfile allowedSkillIds is empty and already allows all enabled skills; proposal will not narrow the profile automatically.",
    );
  } else if (
    requestedCapabilityIds.length > 0 &&
    allowSkillIds.length === 0
  ) {
    warnings.push(
      "Requested Skill ids are already allowed by this AgentProfile.",
    );
  }

  return warnings;
};

const skillBindingRisk = (input: {
  source: SkillSource;
  addSkillSourceIds: readonly string[];
  allowSkillIds: readonly string[];
}): CapabilityBindingRisk => {
  const { source, addSkillSourceIds, allowSkillIds } = input;
  if (addSkillSourceIds.length === 0 && allowSkillIds.length === 0) {
    return "low";
  }
  if (!source.enabled || !source.trusted) return "medium";
  return "low";
};

const skillRationaleFor = (input: {
  profile: AgentProfile;
  source: SkillSource;
  addSkillSourceIds: readonly string[];
  allowSkillIds: readonly string[];
}): string => {
  const { profile, source, addSkillSourceIds, allowSkillIds } = input;
  if (addSkillSourceIds.length === 0 && allowSkillIds.length === 0) {
    return `"${source.name}" is already present for AgentProfile "${profile.name}".`;
  }
  if (addSkillSourceIds.length > 0 && allowSkillIds.length > 0) {
    return `Add Skill source "${source.name}" and allow ${allowSkillIds.length} Skill id(s) for AgentProfile "${profile.name}".`;
  }
  if (addSkillSourceIds.length > 0) {
    return `Add Skill source "${source.name}" to AgentProfile "${profile.name}".`;
  }
  return `Allow ${allowSkillIds.length} Skill id(s) from "${source.name}" for AgentProfile "${profile.name}".`;
};
