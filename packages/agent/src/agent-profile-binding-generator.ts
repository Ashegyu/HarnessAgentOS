import type {
  AgentProfile,
  AgentProfileBindingSnapshot,
  CapabilityBindingRisk,
  McpServerBindingProposalResult,
  McpServerConfig,
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

  if (profile.provider !== "claude") {
    warnings.push(
      "Codex MCP config delivery is not enabled; profile binding only affects Claude provider invocations today.",
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
  return `Add MCP server "${server.name}" to AgentProfile "${profile.name}" for future Claude invocations.`;
};
