import type { Artifact, QualityGateResult, TaskRun } from "@harness/core";

/**
 * Phase 8 prompt budget (hard cap 80KB, soft caps per section).
 * Source: phase-08-agent-cli-integration.md "Prompt size budget".
 */
export const PROMPT_HARD_CAP_BYTES = 80 * 1024;

export interface PromptBuildInput {
  taskRun: TaskRun;
  /** Optional repair-loop instruction; injected near the bottom. */
  instruction?: string;
  /** Latest non-failed artifacts the agent may use as context. */
  recentArtifacts?: Artifact[];
  /** When repairing a failed quality gate, the latest gate result. */
  qualityRisks?: QualityGateResult | null;
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
): string => {
  const parts: string[] = [];
  const trimmedPrefix = trimmedOrNull(prefix);
  if (trimmedPrefix) parts.push(trimmedPrefix);
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
  if (input.instruction && input.instruction.trim().length > 0) {
    userSections.push(
      ["REDIRECT INSTRUCTION", `- ${input.instruction.trim()}`].join("\n"),
    );
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
  if (input.instruction && input.instruction.trim().length > 0) {
    sections.push(
      ["REDIRECT INSTRUCTION", `- ${input.instruction.trim()}`].join("\n"),
    );
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
