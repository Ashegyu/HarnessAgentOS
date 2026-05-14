import type { AgentProvider } from "@harness/core";
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
  provider: AgentProvider,
  stdout: string,
): { text: string; sessionId?: string } => {
  if (provider === "claude") return extractClaudeStreamPayload(stdout);
  return { text: extractCodexExecPayload(stdout) };
};

const buildArgs = (request: ModelCliRequest): string[] => {
  const { provider, model } = request.modelConfig;
  if (provider === "claude") {
    // Streaming output: emits one JSON line per chunk so the stall timer
    // sees regular activity. Without this, `--print` buffers the entire
    // response and stdout stays empty until completion — any non-trivial
    // prompt then trips the stall detector.
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--model", model,
    ];
    if (request.systemPrompt) {
      args.push("--system-prompt", request.systemPrompt);
    }
    if (request.sessionId) {
      args.push("--resume", request.sessionId);
    }
    if (request.mcpConfigPath) {
      args.push("--mcp-config", request.mcpConfigPath);
    }
    if (process.env["ANTHROPIC_API_KEY"]) {
      args.splice(1, 0, "--bare");
    }
    return args;
  }
  // Codex CLI has no `--system-prompt`, no Claude-compatible `--resume`,
  // and no verified per-invocation MCP config flag. Some options are
  // global-only in the current CLI (`--ask-for-approval`), so they must
  // appear before the `exec` subcommand. Use stdin (`-`) so prompts with
  // spaces/non-ASCII never become accidental argv segments.
  return [
    "--model",
    model,
    "--cd",
    request.cwd,
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-",
  ];
};

const buildStdin = (request: ModelCliRequest): string => {
  if (request.modelConfig.provider !== "codex" || !request.systemPrompt) {
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

/**
 * Parse claude --output-format=stream-json output and extract the final
 * assistant text plus the session id. The stream emits one JSON object
 * per line; the last `type: "result"` line carries `.result` and
 * `.session_id`.
 *
 * Fallback priority (needed when the result line has a null result field,
 * e.g. on content-policy errors):
 *   1. `type: "result"` -> `.result` string
 *   2. Last `type: "assistant"` -> `.message.content[].text` concatenated
 *      (emitted by --include-partial-messages; last line is the final state)
 *   3. Concatenated `stream_event` `text_delta` chunks (--verbose mode)
 */
const extractClaudeStreamPayload = (
  rawStdout: string,
): { text: string; sessionId?: string } => {
  if (!rawStdout) return { text: "" };
  let resultText: string | null = null;
  let lastAssistantText: string | null = null;
  let sessionId: string | undefined;
  const deltas: string[] = [];
  for (const line of rawStdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj["type"] === "result" && typeof obj["result"] === "string") {
        resultText = obj["result"] as string;
      }
      if (typeof obj["session_id"] === "string") {
        sessionId = obj["session_id"] as string;
      }
      if (obj["type"] === "assistant") {
        const msg = obj["message"] as Record<string, unknown> | undefined;
        const content = msg?.["content"];
        if (Array.isArray(content)) {
          const parts: string[] = [];
          for (const block of content) {
            if (
              typeof block === "object" &&
              block !== null &&
              (block as Record<string, unknown>)["type"] === "text" &&
              typeof (block as Record<string, unknown>)["text"] === "string"
            ) {
              parts.push((block as Record<string, unknown>)["text"] as string);
            }
          }
          if (parts.length > 0) {
            lastAssistantText = parts.join("");
          }
        }
      }
      if (obj["type"] === "stream_event") {
        const ev = obj["event"] as Record<string, unknown> | undefined;
        const delta = ev?.["delta"] as Record<string, unknown> | undefined;
        if (
          delta &&
          delta["type"] === "text_delta" &&
          typeof delta["text"] === "string"
        ) {
          deltas.push(delta["text"] as string);
        }
      }
    } catch {
      // non-JSON line — ignore
    }
  }
  return {
    text: resultText ?? lastAssistantText ?? deltas.join(""),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
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
