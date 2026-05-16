import type {
  Artifact,
  CapabilityPromptContext,
  QualityGateResult,
  TaskRun,
} from "@harness/core";
import type { PackedRepoContext } from "./context-packer.ts";

/**
 * Phase 8 prompt budget (hard cap 80KB, soft caps per section).
 * Source: phase-08-agent-cli-integration.md "Prompt size budget".
 */
export const PROMPT_HARD_CAP_BYTES = 80 * 1024;

export interface AgentHandoffPromptMessage {
  fromRole: string;
  fromTitle: string;
  content: string;
  artifactId: string;
  createdAt?: string;
}

export interface PromptBuildInput {
  taskRun: TaskRun;
  /** Optional repair-loop instruction; injected near the bottom. */
  instruction?: string;
  /** Prior local worker outputs handed off inside the same TaskRun. */
  handoffMessages?: readonly AgentHandoffPromptMessage[];
  /** Deterministic repository map selected from the persisted repo index. */
  repoContext?: PackedRepoContext | string | null;
  /** Latest non-failed artifacts the agent may use as context. */
  recentArtifacts?: Artifact[];
  /** When repairing a failed quality gate, the latest gate result. */
  qualityRisks?: QualityGateResult | null;
  /** User-approved Skillify capability instructions for this TaskRun. */
  capabilityContexts?: CapabilityPromptContext[];
  /**
   * AgentProfile-derived overrides — see docs/design/agent-detailed-settings.md §4.1.
   * The resolver in AgentPlanningService passes these from the active
   * profile (or empty strings when falling back to legacy settings).
   *
   * Layering rule: PREFIX → PERSONA → SYSTEM → OUTPUT CONTRACT → SUFFIX.
   * Prefix carries org-wide policy (above the per-role persona); suffix
   * carries trailing reminders that should win the recency battle.
   */
  persona?: string;
  systemPromptPrefix?: string;
  systemPromptSuffix?: string;
  profileMetadata?: {
    name: string;
    role: string;
    category: string;
    tags: readonly string[];
  };
}

const trimmedOrNull = (s: string | undefined): string | null => {
  if (!s) return null;
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const buildSystemBlock = (
  persona: string | undefined,
  prefix: string | undefined,
  suffix: string | undefined,
  metadata: PromptBuildInput["profileMetadata"],
): string => {
  const parts: string[] = [];
  const trimmedPrefix = trimmedOrNull(prefix);
  if (trimmedPrefix) parts.push(trimmedPrefix);
  if (metadata) parts.push(formatProfileMetadata(metadata));
  const trimmedPersona = trimmedOrNull(persona);
  if (trimmedPersona) parts.push(`ROLE\n${trimmedPersona}`);
  parts.push(SYSTEM_PROMPT.trim());
  parts.push(OUTPUT_CONTRACT.trim());
  const trimmedSuffix = trimmedOrNull(suffix);
  if (trimmedSuffix) parts.push(trimmedSuffix);
  return parts.join("\n\n");
};

const SYSTEM_PROMPT = `\
SYSTEM
- You are an agent planner inside HarnessAgentOS.
- Do NOT modify files directly; you must only propose actions.
- Every filesystem path must be relative to targetDir.
- Reject absolute paths, drive paths, UNC paths, and ".." traversal.
- Do not request or echo secrets, API keys, tokens, or credentials.
- Do not claim completion. A separate quality gate decides completion.
- Do not produce shell commands containing rm -rf, del /s, shutdown,
  format, mkfs, or any other destructive operation.
- If the user request is informational (no side effect needed), respond
  with proposedActions: [] and answer in summary + questions.
`;

const OUTPUT_CONTRACT = `\
OUTPUT CONTRACT
- Return a short Korean or English explanation in prose.
- Then a single fenced JSON block tagged \`harness_agent_plan\`.
- The JSON MUST match this TypeScript shape:

interface AgentPlanOutput {
  summary: string;
  assumptions: string[];
  steps: Array<{ title: string; rationale: string; risk: "low" | "medium" | "high" }>;
  proposedActions: Array<
    | { type: "file_write"; path: string; before?: string; after: string; rationale: string }
    | { type: "shell"; command: string; args?: string[]; rationale: string }
  >;
  suggestedQualityChecks: Array<{ command: string; reason: string }>;
  questions: string[];
}
- Do not include any other fenced code block tagged harness_agent_plan.
- Do not include high-risk action types like dependency_install / git_commit / network /
  skill_script / orchestration_plan; the runner will reject those.
`;

export interface SplitAgentPrompt {
  /** Passed via `--system-prompt`: SYSTEM + OUTPUT CONTRACT (constant per-run instructions). */
  systemPrompt: string;
  /** Passed via stdin: TARGET + USER REQUEST + optional context sections. */
  userPrompt: string;
}

/**
 * Build the agent prompt split into a system portion (for `--system-prompt`)
 * and a user portion (piped via stdin). Keeps format instructions in the
 * authoritative system channel so Claude reliably produces the JSON block.
 */
export const buildSplitAgentPrompt = (input: PromptBuildInput): SplitAgentPrompt => {
  const systemPrompt = buildSystemBlock(
    input.persona,
    input.systemPromptPrefix,
    input.systemPromptSuffix,
    input.profileMetadata,
  );
  const userSections: string[] = [];
  userSections.push(
    [
      "TARGET",
      `- targetDir: ${input.taskRun.targetDir}`,
      `- platform: ${process.platform}`,
      `- node: ${process.version}`,
    ].join("\n"),
  );
  userSections.push(
    ["USER REQUEST", `- ${input.taskRun.userRequest.trim()}`].join("\n"),
  );
  const repoContext = formatRepoContext(input.repoContext);
  if (repoContext) {
    userSections.push(repoContext);
  }
  if (input.instruction && input.instruction.trim().length > 0) {
    userSections.push(
      ["REDIRECT INSTRUCTION", `- ${input.instruction.trim()}`].join("\n"),
    );
  }
  if (input.handoffMessages && input.handoffMessages.length > 0) {
    userSections.push(formatInternalHandoffMessages(input.handoffMessages));
  }
  if (input.qualityRisks) {
    const risks = input.qualityRisks.knownRisks.slice(0, 12);
    userSections.push(
      [
        "QUALITY RISKS TO ADDRESS",
        `- status: ${input.qualityRisks.status}`,
        ...risks.map((r) => `- ${r}`),
      ].join("\n"),
    );
  }
  if (input.capabilityContexts && input.capabilityContexts.length > 0) {
    userSections.push(formatCapabilityContexts(input.capabilityContexts));
  }
  if (input.recentArtifacts && input.recentArtifacts.length > 0) {
    const top = input.recentArtifacts.slice(0, 6);
    userSections.push(
      [
        "RECENT ARTIFACTS",
        ...top.map((a) => `- ${a.kind} ${a.title}: ${(a.summary ?? "").slice(0, 240)}`),
      ].join("\n"),
    );
  }
  let userPrompt = userSections.join("\n\n");
  // Hard cap: trim middle context sections if combined size exceeds budget.
  const combined = systemPrompt + "\n\n" + userPrompt;
  if (Buffer.byteLength(combined, "utf8") > PROMPT_HARD_CAP_BYTES) {
    const head = userSections.slice(0, 2).join("\n\n");
    const room =
      PROMPT_HARD_CAP_BYTES -
      Buffer.byteLength(systemPrompt + "\n\n" + head, "utf8") -
      64;
    const middle = userSections.slice(2).join("\n\n");
    userPrompt = [head, middle.slice(0, Math.max(0, room)), "[...truncated]"].join("\n\n");
  }
  return { systemPrompt, userPrompt };
};

const formatProfileMetadata = (
  metadata: NonNullable<PromptBuildInput["profileMetadata"]>,
): string => {
  const tags = metadata.tags ?? [];
  const lines = [
    "PROFILE SELECTION",
    `- name: ${metadata.name}`,
    `- role: ${metadata.role}`,
    `- category: ${metadata.category || "core"}`,
  ];
  if (tags.length > 0) {
    lines.push(`- tags: ${tags.join(", ")}`);
  }
  return lines.join("\n");
};

export const buildAgentPrompt = (input: PromptBuildInput): string => {
  const sections: string[] = [];
  sections.push(SYSTEM_PROMPT.trim());
  sections.push(
    [
      "TARGET",
      `- targetDir: ${input.taskRun.targetDir}`,
      `- platform: ${process.platform}`,
      `- node: ${process.version}`,
    ].join("\n"),
  );
  sections.push(
    ["USER REQUEST", `- ${input.taskRun.userRequest.trim()}`].join("\n"),
  );
  const repoContext = formatRepoContext(input.repoContext);
  if (repoContext) {
    sections.push(repoContext);
  }
  if (input.instruction && input.instruction.trim().length > 0) {
    sections.push(
      ["REDIRECT INSTRUCTION", `- ${input.instruction.trim()}`].join("\n"),
    );
  }
  if (input.handoffMessages && input.handoffMessages.length > 0) {
    sections.push(formatInternalHandoffMessages(input.handoffMessages));
  }
  if (input.qualityRisks) {
    const risks = input.qualityRisks.knownRisks.slice(0, 12);
    sections.push(
      [
        "QUALITY RISKS TO ADDRESS",
        `- status: ${input.qualityRisks.status}`,
        ...risks.map((r) => `- ${r}`),
      ].join("\n"),
    );
  }
  if (input.capabilityContexts && input.capabilityContexts.length > 0) {
    sections.push(formatCapabilityContexts(input.capabilityContexts));
  }
  if (input.recentArtifacts && input.recentArtifacts.length > 0) {
    const top = input.recentArtifacts.slice(0, 6);
    sections.push(
      [
        "RECENT ARTIFACTS",
        ...top.map((a) => `- ${a.kind} ${a.title}: ${(a.summary ?? "").slice(0, 240)}`),
      ].join("\n"),
    );
  }
  sections.push(OUTPUT_CONTRACT.trim());
  const joined = sections.join("\n\n");
  if (Buffer.byteLength(joined, "utf8") <= PROMPT_HARD_CAP_BYTES) return joined;
  // Hard cap: chop from the middle (context) but keep system + user + output contract.
  const head = sections.slice(0, 3).join("\n\n");
  const tail = sections.slice(-1).join("\n\n");
  const room = PROMPT_HARD_CAP_BYTES - Buffer.byteLength(head + "\n\n" + tail, "utf8") - 64;
  const middle = sections.slice(3, -1).join("\n\n");
  const truncated = middle.slice(0, Math.max(0, room));
  return [head, truncated, "[...truncated]", tail].join("\n\n");
};

const formatInternalHandoffMessages = (
  messages: readonly AgentHandoffPromptMessage[],
): string => {
  const visibleMessages = messages
    .filter((message) => message.content.trim().length > 0)
    .slice(-6);
  const lines: string[] = [
    "INTERNAL AGENT HANDOFF",
    "- Prior local Harness agents in this run produced these outputs.",
    "- Use them as context only; side effects still require Harness approval.",
  ];
  for (const message of visibleMessages) {
    lines.push(
      "",
      `### ${message.fromRole}: ${message.fromTitle}`,
      `- artifact: ${message.artifactId}`,
    );
    if (message.createdAt) {
      lines.push(`- createdAt: ${message.createdAt}`);
    }
    lines.push("", message.content.trim().slice(0, 6_000));
  }
  return lines.join("\n");
};

const formatCapabilityContexts = (
  contexts: readonly CapabilityPromptContext[],
): string => {
  const lines: string[] = [
    "APPROVED SKILL CAPABILITIES",
    "- The user approved these Skillify candidates for this TaskRun.",
    "- Treat them as guidance only; still obey the Harness output contract and approval policy.",
  ];
  for (const ctx of contexts.slice(0, 5)) {
    const instructions = ctx.instructions.trim().slice(0, 6_000);
    lines.push(
      "",
      `### ${ctx.capability.name}`,
      `- id: ${ctx.capability.id}`,
      `- source: ${ctx.capability.source}`,
      `- risk: ${ctx.capability.riskLevel}`,
      `- approval reason: ${ctx.reason}`,
      "",
      instructions,
    );
  }
  return lines.join("\n");
};

const formatRepoContext = (
  context: PackedRepoContext | string | null | undefined,
): string | null => {
  if (typeof context === "string") {
    const trimmed = context.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!context) return null;
  const trimmed = context.section.trim();
  return trimmed.length > 0 ? trimmed : null;
};
