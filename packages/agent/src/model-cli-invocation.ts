import {
  AGENT_REASONING_EFFORTS,
  type AgentProvider,
  type AgentReasoningEffort,
} from "@harness/core";
import type { ModelCliRequest } from "./model-cli-types.ts";

export interface CliInvocation {
  command: AgentProvider;
  args: string[];
  stdin: string;
}

export const buildCliInvocation = (
  request: ModelCliRequest,
): CliInvocation => ({
  command: request.modelConfig.provider,
  args: buildArgs(request),
  stdin: buildStdin(request),
});

export const extractProviderPayload = (
  _provider: AgentProvider,
  stdout: string,
): { text: string } => ({ text: extractCodexExecPayload(stdout) });

export const formatProviderExitFailure = (
  provider: AgentProvider,
  exitCode: number,
  stdout: string,
  stderr: string,
): string => {
  const detail = extractCodexFailureDetail(stdout, stderr);
  return detail.length > 0
    ? `${provider} exited with code ${exitCode}: ${detail}`
    : `${provider} exited with code ${exitCode}`;
};

const buildArgs = (request: ModelCliRequest): string[] => {
  const { model } = request.modelConfig;
  // Codex CLI has no dedicated `--system-prompt` or per-run resume flag.
  // Per-run MCP is passed with verified `-c mcp_servers.*` overrides, not
  // `--mcp-config`. Some options are global-only in the current CLI
  // (`--ask-for-approval`, `-c`), so they must appear before the `exec`
  // subcommand. Use stdin (`-`) so prompts with spaces/non-ASCII never
  // become accidental argv segments.
  const sandboxMode =
    request.sandbox.mode === "workspace-write" ? "workspace-write" : "read-only";
  const askForApproval = request.sandbox.autoReview === true ? "on-request" : "never";
  const args = [
    "--model",
    model,
    "--cd",
    request.cwd,
    "--sandbox",
    sandboxMode,
    "--ask-for-approval",
    askForApproval,
  ];
  if (request.sandbox.autoReview === true) {
    args.push("-c", 'approvals_reviewer="auto_review"');
  }
  const reasoningEffort = normalizeReasoningEffort(
    request.modelConfig.reasoningEffort,
  );
  if (reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${reasoningEffort}`);
  }
  for (const override of normalizeCodexConfigOverrides(
    request.codexConfigOverrides,
  )) {
    args.push("-c", override);
  }
  args.push("exec", "--json", "--skip-git-repo-check", "-");
  return args;
};

const normalizeCodexConfigOverrides = (
  overrides: readonly string[] | undefined,
): string[] => {
  if (!overrides) return [];
  const normalized: string[] = [];
  for (const override of overrides) {
    const value = override.trim();
    if (!value) continue;
    normalized.push(value);
  }
  return normalized;
};

const REASONING_EFFORT_SET: ReadonlySet<string> = new Set(
  AGENT_REASONING_EFFORTS,
);

const normalizeReasoningEffort = (
  effort: unknown,
): AgentReasoningEffort | undefined =>
  typeof effort === "string" && REASONING_EFFORT_SET.has(effort)
    ? (effort as AgentReasoningEffort)
    : undefined;

const buildStdin = (request: ModelCliRequest): string => {
  if (!request.systemPrompt) {
    return request.prompt;
  }
  return [
    "SYSTEM INSTRUCTIONS",
    request.systemPrompt,
    "",
    "USER REQUEST",
    request.prompt,
  ].join("\n");
};

export const extractCodexExecPayload = (rawStdout: string): string => {
  if (!rawStdout.trim()) return "";
  let lastAssistantText: string | null = null;
  const deltas: string[] = [];
  for (const line of rawStdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const assistantText = extractAssistantText(obj);
      if (assistantText !== null) {
        lastAssistantText = assistantText;
      }
      const delta = extractCodexDeltaText(obj);
      if (delta !== null) {
        deltas.push(delta);
      }
    } catch {
      // Non-JSON lines are ignored in --json mode; raw stdout remains
      // the final fallback if no assistant message is found.
    }
  }
  if (lastAssistantText !== null) return lastAssistantText;
  const deltaText = deltas.join("");
  return deltaText.length > 0 ? deltaText : rawStdout;
};

const extractAssistantText = (obj: Record<string, unknown>): string | null => {
  const candidates = [obj["item"], obj["message"], obj["response"], obj];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    if (!looksLikeAssistantMessage(candidate)) continue;
    const text = extractText(candidate);
    if (text.length > 0) return text;
  }
  return null;
};

const looksLikeAssistantMessage = (obj: Record<string, unknown>): boolean => {
  if (obj["role"] === "assistant") return true;
  const type = typeof obj["type"] === "string" ? obj["type"] : "";
  return (
    type === "assistant_message" ||
    type === "agent_message" ||
    type.includes("assistant")
  );
};

const extractText = (obj: Record<string, unknown>): string => {
  if (typeof obj["text"] === "string") return obj["text"];
  if (typeof obj["output_text"] === "string") return obj["output_text"];
  if (typeof obj["content"] === "string") return obj["content"];
  const content = obj["content"];
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!isRecord(block)) continue;
    if (typeof block["text"] === "string") {
      parts.push(block["text"]);
      continue;
    }
    if (typeof block["output_text"] === "string") {
      parts.push(block["output_text"]);
    }
  }
  return parts.join("");
};

const extractCodexDeltaText = (obj: Record<string, unknown>): string | null => {
  if (typeof obj["delta"] === "string") return obj["delta"];
  const delta = obj["delta"];
  if (isRecord(delta) && typeof delta["text"] === "string") {
    return delta["text"];
  }
  const item = obj["item"];
  if (isRecord(item)) {
    const itemDelta = item["delta"];
    if (typeof itemDelta === "string") return itemDelta;
    if (isRecord(itemDelta) && typeof itemDelta["text"] === "string") {
      return itemDelta["text"];
    }
  }
  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const extractCodexFailureDetail = (stdout: string, stderr: string): string => {
  const messages: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj["message"] === "string" && obj["type"] === "error") {
        messages.push(obj["message"]);
      }
      const error = obj["error"];
      if (isRecord(error) && typeof error["message"] === "string") {
        messages.push(error["message"]);
      }
    } catch {
      // Codex --json should be JSONL, but keep stderr fallback below.
    }
  }

  const authMessage = messages.find((message) =>
    /\b(401|unauthorized|authentication|missing bearer|api key)\b/i.test(
      message,
    ),
  );
  if (authMessage !== undefined) {
    return compactFailureText(`authentication failed: ${authMessage}`);
  }

  if (messages.length > 0) {
    return compactFailureText(dedupe(messages).slice(-3).join("\n"));
  }
  return compactFailureText(stderr) || compactFailureText(stdout);
};

const dedupe = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
};

const compactFailureText = (text: string): string => {
  const compact = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  return compact.length > 1_200 ? `${compact.slice(0, 1_200)}...` : compact;
};
