import type { AgentProvider } from "./settings.ts";
import { APPROVAL_ACTION_TYPES, type ApprovalActionType } from "./approval.ts";
import { WORKER_ROLES, type WorkerRole } from "./orchestration.ts";

/**
 * Detailed agent settings model — see docs/design/agent-detailed-settings.md.
 * An AgentProfile bundles persona, model tuning, CLI environment, action
 * permissions, and references to MCP servers + skill sources. The resolver
 * in AgentPlanningService selects the active profile per invocation; legacy
 * `HarnessSettings.agent` remains as a fallback during the migration window.
 */

/**
 * Mirrors `ApprovalActionType` so the permissions matrix in the UI never
 * references an action the approval system doesn't know about. Re-exported
 * under a distinct name to make import sites self-explanatory.
 */
export const AGENT_PROFILE_ACTION_TYPES: readonly ApprovalActionType[] =
  APPROVAL_ACTION_TYPES;

export interface AgentBudget {
  /** Maximum estimated USD cost for a single approval/invocation. */
  perInvocationUsd?: number;
  /** Maximum projected USD cost accumulated within one TaskRun. */
  perTaskRunUsd?: number;
  /** Maximum projected USD cost accumulated for the current ISO day. */
  perDayUsd?: number;
}

export interface AgentPermissions {
  /** Action types this profile auto-approves (overrides global autoApprove). */
  autoApproveActions: readonly ApprovalActionType[];
  /** Action types this profile rejects outright. Takes priority over auto. */
  blockedActions: readonly ApprovalActionType[];
  /** Skill IDs allowed for this profile. Empty array = all enabled skills. */
  allowedSkillIds: readonly string[];
  /** MCP tool name glob patterns allowed. Empty = all. */
  toolAllowlist: readonly string[];
  /** MCP tool name glob patterns rejected. Takes priority over allowlist. */
  toolDenylist: readonly string[];
  /** Optional pre-execution budget caps for estimated model/tool spend. */
  budget?: AgentBudget;
}

export interface AgentCliEnv {
  /** Absolute CLI path override. Empty string = search $PATH. */
  cliPathOverride: string;
  /** Plain-text environment variables passed to the CLI. */
  env: Readonly<Record<string, string>>;
  /**
   * Map of env-var name → SecretVault key. The main process decrypts at
   * spawn time and merges into the child process env. Renderer never sees
   * the plaintext.
   */
  envSecretRefs: Readonly<Record<string, string>>;
}

export interface AgentModelTuning {
  model: string;
  /** undefined = use provider default. */
  temperature?: number;
  maxTokens?: number;
  timeoutMs: number;
  stallTimeoutMs: number;
  contextDepth: number;
  systemPromptPrefix: string;
  systemPromptSuffix: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  /** Broad domain bucket used for UI filtering and profile selection hints. */
  category: string;
  /** Fine-grained specialities; role remains the execution-stage contract. */
  tags: readonly string[];
  provider: AgentProvider;
  role: WorkerRole;
  /** Natural-language role description injected into the system prompt. */
  persona: string;
  tuning: AgentModelTuning;
  cli: AgentCliEnv;
  permissions: AgentPermissions;
  /** McpServerConfig.id values activated for this profile. */
  mcpServerIds: readonly string[];
  /** SkillSource.id values activated for this profile. Empty = global only. */
  skillSourceIds: readonly string[];
  /** Exactly one profile carries isDefault=true at any time. */
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CapabilityBindingRisk = "low" | "medium" | "high";

export interface CapabilityBindingProposal {
  profileId: string;
  addMcpServerIds: string[];
  addSkillSourceIds: string[];
  allowSkillIds: string[];
  addToolAllowPatterns: string[];
  addToolDenyPatterns: string[];
  rationale: string;
  risk: CapabilityBindingRisk;
}

export interface AgentProfileBindingSnapshot {
  mcpServerIds: string[];
  skillSourceIds: string[];
  allowedSkillIds: string[];
  toolAllowlist: string[];
  toolDenylist: string[];
}

export interface AgentProfileBindingPreview {
  ok: boolean;
  warnings: string[];
  alreadySatisfied: boolean;
  before: AgentProfileBindingSnapshot;
  after: AgentProfileBindingSnapshot;
}

export const DEFAULT_AGENT_PERMISSIONS: Readonly<AgentPermissions> =
  Object.freeze({
    autoApproveActions: Object.freeze([]) as readonly ApprovalActionType[],
    blockedActions: Object.freeze([]) as readonly ApprovalActionType[],
    allowedSkillIds: Object.freeze([]) as readonly string[],
    toolAllowlist: Object.freeze([]) as readonly string[],
    toolDenylist: Object.freeze([]) as readonly string[],
  });

const VALID_PROVIDERS: readonly AgentProvider[] = ["auto", "claude", "codex"];
const ACTION_SET: ReadonlySet<string> = new Set(APPROVAL_ACTION_TYPES);
const ROLE_SET: ReadonlySet<string> = new Set(WORKER_ROLES);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => typeof item === "string");

const isStringRecord = (v: unknown): v is Record<string, string> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v).every((val) => typeof val === "string");
};

const isActionArray = (v: unknown): boolean =>
  Array.isArray(v) && v.every((item) => typeof item === "string" && ACTION_SET.has(item));

const isNonNegativeFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

const isAgentBudget = (v: unknown): v is AgentBudget => {
  if (v === undefined) return true;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const b = v as Record<string, unknown>;
  return (
    (b.perInvocationUsd === undefined ||
      isNonNegativeFiniteNumber(b.perInvocationUsd)) &&
    (b.perTaskRunUsd === undefined ||
      isNonNegativeFiniteNumber(b.perTaskRunUsd)) &&
    (b.perDayUsd === undefined || isNonNegativeFiniteNumber(b.perDayUsd))
  );
};

export const isAgentPermissions = (v: unknown): v is AgentPermissions => {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    isActionArray(p.autoApproveActions) &&
    isActionArray(p.blockedActions) &&
    isStringArray(p.allowedSkillIds) &&
    isStringArray(p.toolAllowlist) &&
    isStringArray(p.toolDenylist) &&
    isAgentBudget(p.budget)
  );
};

export const isAgentCliEnv = (v: unknown): v is AgentCliEnv => {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.cliPathOverride === "string" &&
    isStringRecord(c.env) &&
    isStringRecord(c.envSecretRefs)
  );
};

export const isAgentModelTuning = (v: unknown): v is AgentModelTuning => {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  if (typeof t.model !== "string") return false;
  if (typeof t.timeoutMs !== "number") return false;
  if (typeof t.stallTimeoutMs !== "number") return false;
  if (typeof t.contextDepth !== "number") return false;
  if (typeof t.systemPromptPrefix !== "string") return false;
  if (typeof t.systemPromptSuffix !== "string") return false;
  if (t.temperature !== undefined && typeof t.temperature !== "number") return false;
  if (t.maxTokens !== undefined && typeof t.maxTokens !== "number") return false;
  return true;
};

export const isAgentProfile = (v: unknown): v is AgentProfile => {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    typeof p.name === "string" &&
    typeof p.description === "string" &&
    typeof p.category === "string" &&
    isStringArray(p.tags) &&
    typeof p.provider === "string" &&
    VALID_PROVIDERS.includes(p.provider as AgentProvider) &&
    typeof p.role === "string" &&
    ROLE_SET.has(p.role) &&
    typeof p.persona === "string" &&
    isAgentModelTuning(p.tuning) &&
    isAgentCliEnv(p.cli) &&
    isAgentPermissions(p.permissions) &&
    isStringArray(p.mcpServerIds) &&
    isStringArray(p.skillSourceIds) &&
    typeof p.isDefault === "boolean" &&
    typeof p.createdAt === "string" &&
    typeof p.updatedAt === "string"
  );
};
