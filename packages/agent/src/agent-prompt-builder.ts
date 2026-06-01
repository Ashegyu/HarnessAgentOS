import type {
  Artifact,
  CapabilityPromptContext,
  Instinct,
  ObservationRecallResult,
  QualityGateResult,
  TaskRun,
  WorkerHandoffPayload,
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
  structuredPayload?: WorkerHandoffPayload;
}

export interface ThreadContextPromptTask {
  ordinal: number;
  taskRunId: string;
  userRequest: string;
  status: TaskRun["status"];
  answerSummary?: string;
  isFollowUpAnchor?: boolean;
}

export interface PromptBuildInput {
  taskRun: TaskRun;
  /** Optional repair-loop instruction; injected near the bottom. */
  instruction?: string;
  /** Previous TaskRuns in the same thread, oldest-first and excluding this run. */
  threadContext?: readonly ThreadContextPromptTask[];
  /** Prior local worker outputs handed off inside the same TaskRun. */
  handoffMessages?: readonly AgentHandoffPromptMessage[];
  /** Deterministic repository map selected from the persisted repo index. */
  repoContext?: PackedRepoContext | string | null;
  /** Latest non-failed artifacts the agent may use as context. */
  recentArtifacts?: Artifact[];
  /** When repairing a failed quality gate, the latest gate result. */
  qualityRisks?: QualityGateResult | null;
  /** User-approved learned guidance from repeated local outcomes. */
  instinctContexts?: Instinct[];
  /** User-approved Skillify capability instructions for this TaskRun. */
  capabilityContexts?: CapabilityPromptContext[];
  /** Recalled observations explicitly pinned by the user for this invocation. */
  pinnedObservationContexts?: readonly ObservationRecallResult[];
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
  /**
   * When true, the provider invocation is allowed to write inside targetDir
   * directly (currently Codex workspace-write mode). When false/omitted,
   * file changes must be proposed as Harness approvals.
   */
  directFileEdits?: boolean;
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
  directFileEdits: boolean | undefined,
): string => {
  const parts: string[] = [];
  const trimmedPrefix = trimmedOrNull(prefix);
  if (trimmedPrefix) parts.push(trimmedPrefix);
  if (metadata) parts.push(formatProfileMetadata(metadata));
  const trimmedPersona = trimmedOrNull(persona);
  if (trimmedPersona) parts.push(`ROLE\n${trimmedPersona}`);
  parts.push(SYSTEM_PROMPT.trim());
  parts.push(
    directFileEdits === true
      ? DIRECT_FILE_EDITS_ENABLED_POLICY.trim()
      : DIRECT_FILE_EDITS_DISABLED_POLICY.trim(),
  );
  parts.push(OUTPUT_CONTRACT.trim());
  const trimmedSuffix = trimmedOrNull(suffix);
  if (trimmedSuffix) parts.push(trimmedSuffix);
  parts.push(NON_INTERACTIVE_AGENT_POLICY.trim());
  return parts.join("\n\n");
};

export const NON_INTERACTIVE_AGENT_POLICY = `\
FINAL NON-INTERACTIVE POLICY
- This applies to every Harness agent, including custom profiles, pipeline
  workers, and remote handoffs.
- Do not ask the user follow-up questions, clarification questions, or
  confirmation questions.
- If a choice is missing, choose the safest useful default, record it in
  assumptions, and keep progressing.
- Never wait for a user reply inside the agent output.
- The questions field must remain exactly questions: [].
- For existing-file partial edits, prefer file_patch. file_patch.patch MUST be
  a single-file unified diff whose headers match file_patch.path.
- For file_write, file_write.after MUST be the exact complete file content
  to write after approval. Harness replaces the whole file with this string.
- Do not put instructions, patch descriptions, TODO prose, or "add this to
  the file" text inside file_write.after. Use file_write only for new files or
  whole-file replacement where you have the complete content.
`;

const SYSTEM_PROMPT = `\
SYSTEM
- You are an agent planner inside HarnessAgentOS.
- Every filesystem path must be relative to targetDir.
- Reject absolute paths, drive paths, UNC paths, and ".." traversal.
- Do not request or echo secrets, API keys, tokens, or credentials.
- Do not claim completion. A separate quality gate decides completion.
- Do not produce shell commands containing rm -rf, del /s, shutdown,
  format, mkfs, or any other destructive operation.
- Do not ask follow-up questions or clarification questions. The user cannot
  answer inside this agent run.
- If information is missing, choose a conservative default, record it in
  assumptions, and continue with the most useful next action.
- If the user request is informational (no side effect needed), respond
  with proposedActions: [] and answer in summary.
- The questions field must always be exactly questions: [].
`;

const DIRECT_FILE_EDITS_DISABLED_POLICY = `\
FILE CHANGE POLICY
- Do NOT modify files directly; you must only propose actions.
- A read-only provider sandbox means direct edits are blocked by design. It
  does not block you from proposing file_patch/file_write actions for the
  Harness runner to apply after approval.
- In worker/pipeline runs, valid file_patch/file_write proposedActions may be
  auto-approved and executed by Harness when worker file automation is enabled.
  Do not describe this as a manual-only approval handoff; emit the concrete
  proposedActions so Harness can validate and apply them.
- Avoid prose like "I will not apply changes directly." It creates the wrong
  UX; say that you will emit concrete Harness actions that can be applied after
  validation.
- Do not answer that you cannot modify files directly. When the request needs
  a permitted side effect, produce proposedActions for Harness approval.
- If the user request asks for code changes and a safe proposal is possible,
  proposedActions must contain the file_patch/file_write/shell actions needed
  for the Harness runner to apply after approval.
- Prefer file_patch for partial edits to existing files. Only propose
  file_write when you can provide the complete replacement content for the
  file. The runner will not interpret instructions.
`;

const DIRECT_FILE_EDITS_ENABLED_POLICY = `\
FILE CHANGE POLICY
- The Codex provider may run with workspace-write sandbox for this invocation.
- You may modify files directly inside targetDir when the user asks for code
  changes. Keep changes narrow and never write outside targetDir.
- If you modified files directly, set proposedActions to [] and summarize the
  changed files and verification in the response.
- If you cannot safely modify directly, propose file_patch/file_write actions
  instead of saying file modification is impossible.
- Prefer direct edits for implementation work in workspace-write mode, then
  propose shell checks when verification is useful and allowed.
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
    | { type: "file_patch"; path: string; patch: string; rationale: string }
    | { type: "file_write"; path: string; before?: string; after: string; rationale: string }
    | { type: "shell"; command: string; args?: string[]; rationale: string }
  >;
  suggestedQualityChecks: Array<{ command: string; reason: string }>;
  questions: string[];
}
- questions MUST be [] in every response. Put missing-information handling in
  assumptions instead of asking the user.
- For a file_patch action, patch is a single-file unified diff for path. Do not
  include multiple files in one file_patch.
- Use full hunk headers such as @@ -10,3 +10,4 @@. Bare @@ headers are
  accepted only when Harness can uniquely match the surrounding context.
- For a file_write action, after is not a diff and not a natural-language
  instruction. It is the complete UTF-8 text of the target file after the
  approval runs. Include unchanged existing content too. For new files, include
  the entire new file.
- Never write "add/update/modify this file..." instructions in after. Harness
  writes after verbatim with no interpretation.
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
    input.directFileEdits,
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
  if (input.threadContext && input.threadContext.length > 0) {
    userSections.push(formatThreadContext(input.threadContext));
  }
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
  if (input.instinctContexts && input.instinctContexts.length > 0) {
    userSections.push(formatInstinctContexts(input.instinctContexts));
  }
  if (input.capabilityContexts && input.capabilityContexts.length > 0) {
    userSections.push(formatCapabilityContexts(input.capabilityContexts));
  }
  if (input.pinnedObservationContexts && input.pinnedObservationContexts.length > 0) {
    userSections.push(formatPinnedObservationContexts(input.pinnedObservationContexts));
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
    const preservedHeadCount =
      input.threadContext && input.threadContext.length > 0 ? 3 : 2;
    const head = userSections.slice(0, preservedHeadCount).join("\n\n");
    const room =
      PROMPT_HARD_CAP_BYTES -
      Buffer.byteLength(systemPrompt + "\n\n" + head, "utf8") -
      64;
    const middle = userSections.slice(preservedHeadCount).join("\n\n");
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
  if (input.threadContext && input.threadContext.length > 0) {
    sections.push(formatThreadContext(input.threadContext));
  }
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
  if (input.instinctContexts && input.instinctContexts.length > 0) {
    sections.push(formatInstinctContexts(input.instinctContexts));
  }
  if (input.capabilityContexts && input.capabilityContexts.length > 0) {
    sections.push(formatCapabilityContexts(input.capabilityContexts));
  }
  if (input.pinnedObservationContexts && input.pinnedObservationContexts.length > 0) {
    sections.push(formatPinnedObservationContexts(input.pinnedObservationContexts));
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
  sections.push(NON_INTERACTIVE_AGENT_POLICY.trim());
  const joined = sections.join("\n\n");
  if (Buffer.byteLength(joined, "utf8") <= PROMPT_HARD_CAP_BYTES) return joined;
  // Hard cap: chop from the middle (context) but keep system + user + contracts.
  const preservedHeadCount =
    input.threadContext && input.threadContext.length > 0 ? 4 : 3;
  const head = sections.slice(0, preservedHeadCount).join("\n\n");
  const tail = sections.slice(-2).join("\n\n");
  const room = PROMPT_HARD_CAP_BYTES - Buffer.byteLength(head + "\n\n" + tail, "utf8") - 64;
  const middle = sections.slice(preservedHeadCount, -2).join("\n\n");
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
    if (message.structuredPayload) {
      lines.push(
        "",
        "```harness_worker_handoff_v1",
        JSON.stringify(message.structuredPayload),
        "```",
      );
    }
    lines.push("", message.content.trim().slice(0, 6_000));
  }
  return lines.join("\n");
};

const formatThreadContext = (
  tasks: readonly ThreadContextPromptTask[],
): string => {
  const visibleTasks = tasks.slice(-6);
  const lines: string[] = [];
  const anchor = visibleTasks.find((task) => task.isFollowUpAnchor);
  if (anchor) {
    lines.push(...formatFollowUpAnchor(anchor), "");
  }
  lines.push(
    "THREAD CONTEXT",
    "- Previous TaskRuns in this same Harness thread, oldest-first.",
    "- Treat these as continuity context; the current USER REQUEST remains authoritative.",
  );
  for (const task of visibleTasks) {
    lines.push(
      "",
      `### Task ${task.ordinal}`,
      `- taskRunId: ${task.taskRunId}`,
      `- status: ${task.status}`,
      `- request: ${task.userRequest.trim().slice(0, 1_000)}`,
    );
    if (task.isFollowUpAnchor) {
      lines.push("- followUpAnchor: true");
    }
    const answerSummary = task.answerSummary?.trim();
    if (answerSummary) {
      lines.push(`- latest answer: ${answerSummary.slice(0, 2_000)}`);
    }
  }
  return lines.join("\n");
};

const formatFollowUpAnchor = (
  task: ThreadContextPromptTask,
): string[] => {
  const lines = [
    "FOLLOW-UP ANCHOR",
    "- The current USER REQUEST is a continuation of this specific previous TaskRun.",
    '- Resolve references such as "it", "that", "previous", "방금", "이전", and "그거" against this anchor first.',
    "- Use the rest of THREAD CONTEXT as supporting context only.",
    `- taskRunId: ${task.taskRunId}`,
    `- task: Task ${task.ordinal}`,
    `- status: ${task.status}`,
    `- request: ${task.userRequest.trim().slice(0, 1_500)}`,
  ];
  const answerSummary = task.answerSummary?.trim();
  if (answerSummary) {
    lines.push(`- latest answer: ${answerSummary.slice(0, 4_000)}`);
  }
  return lines;
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

const formatInstinctContexts = (instincts: readonly Instinct[]): string => {
  const lines = [
    "ACTIVE INSTINCTS",
    "- These are user-approved learned rules from repeated local outcomes.",
    "- Treat them as guidance for planning and evidence selection; they do not grant execution permission.",
  ];
  for (const instinct of instincts.slice(0, 8)) {
    lines.push(
      `- ${instinct.title} (${instinct.scope}, confidence ${Math.round(
        instinct.confidence * 100,
      )}%): ${instinct.rule}`,
    );
    const rationale = instinct.rationale.trim();
    if (rationale.length > 0) {
      lines.push(`  rationale: ${rationale.slice(0, 240)}`);
    }
  }
  return lines.join("\n");
};

const formatPinnedObservationContexts = (
  contexts: readonly ObservationRecallResult[],
): string => {
  const visibleContexts = contexts
    .filter((context) => context.summary.trim().length > 0)
    .slice(0, 5);
  const lines: string[] = [
    "PINNED OBSERVATION CONTEXT",
    "- The user explicitly selected these recalled observations for this invocation.",
    "- Treat them as advisory memory only; they do not grant execution permission.",
  ];
  for (const context of visibleContexts) {
    const summary = context.summary.trim().replace(/\s+/g, " ").slice(0, 500);
    lines.push(
      `- ${context.observationId} ${context.source}:${context.signal} score ${context.score.toFixed(2)}`,
      `  event: ${context.eventType}`,
      `  summary: ${summary}`,
    );
    if (context.outcome) {
      lines.push(
        `  outcome: used ${context.outcome.usedCount}, passed ${context.outcome.passedCount}, warning ${context.outcome.warningCount}, failed ${context.outcome.failedCount}, lastStatus: ${context.outcome.lastStatus ?? "unknown"}, lastOutcomeSource: ${context.outcome.lastOutcomeSource ?? "unknown"}, sources: quality ${context.outcome.qualityOutcomeCount}, agent ${context.outcome.agentOutcomeCount}, runner ${context.outcome.runnerOutcomeCount}, unknown ${context.outcome.unknownOutcomeCount}, reuseRisk: ${context.outcome.reuseRisk}, scoreAdjustment: ${context.outcome.scoreAdjustment.toFixed(2)}`,
      );
      if (context.outcome.failedCount > 0 || context.outcome.reuseRisk === "high") {
        lines.push(
          "  warning: prior pinned uses failed; treat this as caution, not an automatic block.",
        );
      }
    }
    if (context.taskRunId) {
      lines.push(`  priorTaskRun: ${context.taskRunId}`);
    }
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
