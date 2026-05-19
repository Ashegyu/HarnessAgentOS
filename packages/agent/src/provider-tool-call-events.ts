import type {
  AgentToolCallEvent,
} from "@harness/core";

export interface ProviderToolCallStreamParserOptions {
  invocationId: string;
  provider: AgentToolCallEvent["provider"];
  source: "stdout" | "stderr";
}

export class ProviderToolCallStreamParser {
  private pending = "";
  private readonly options: ProviderToolCallStreamParserOptions;

  constructor(options: ProviderToolCallStreamParserOptions) {
    this.options = options;
  }

  feed(chunk: string): AgentToolCallEvent[] {
    this.pending += chunk;
    const out: AgentToolCallEvent[] = [];
    let nl = this.pending.indexOf("\n");
    while (nl >= 0) {
      const line = this.pending.slice(0, nl).trim();
      this.pending = this.pending.slice(nl + 1);
      if (line.length > 0) {
        out.push(...extractProviderToolCalls(line, this.options));
      }
      nl = this.pending.indexOf("\n");
    }
    return out;
  }

  flush(): AgentToolCallEvent[] {
    const line = this.pending.trim();
    this.pending = "";
    return line.length > 0 ? extractProviderToolCalls(line, this.options) : [];
  }
}

export const extractProviderToolCalls = (
  line: string,
  options: ProviderToolCallStreamParserOptions,
): AgentToolCallEvent[] => {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  return options.provider === "claude"
    ? extractClaudeToolCalls(obj, options)
    : extractCodexToolCalls(obj, options);
};

const extractClaudeToolCalls = (
  obj: Record<string, unknown>,
  options: ProviderToolCallStreamParserOptions,
): AgentToolCallEvent[] => {
  if (obj["type"] !== "stream_event") return [];
  const ev = obj["event"];
  if (!isRecord(ev) || ev["type"] !== "content_block_start") return [];
  const block = ev["content_block"];
  if (!isRecord(block) || block["type"] !== "tool_use") return [];
  const toolName = stringValue(block["name"]);
  if (!toolName) return [];
  const toolCallId = stringValue(block["id"]);
  return [
    {
      type: "tool_call",
      invocationId: options.invocationId,
      provider: options.provider,
      source: options.source,
      phase: "started",
      toolName,
      ...(toolCallId ? { toolCallId } : {}),
      ...(block["input"] !== undefined ? { input: block["input"] } : {}),
    },
  ];
};

const extractCodexToolCalls = (
  obj: Record<string, unknown>,
  options: ProviderToolCallStreamParserOptions,
): AgentToolCallEvent[] => {
  const candidates = [
    isRecord(obj["payload"]) ? obj["payload"] : null,
    isRecord(obj["item"]) ? obj["item"] : null,
    obj,
  ].filter((candidate): candidate is Record<string, unknown> =>
    candidate !== null,
  );

  for (const candidate of candidates) {
    const toolCall = extractCodexToolCall(candidate, obj, options);
    if (toolCall) return [toolCall];
  }
  return [];
};

const extractCodexToolCall = (
  candidate: Record<string, unknown>,
  envelope: Record<string, unknown>,
  options: ProviderToolCallStreamParserOptions,
): AgentToolCallEvent | null => {
  const type = stringValue(candidate["type"]) ?? "";
  if (!isCodexToolCallType(type)) return null;
  const toolName = codexToolName(candidate, type);
  if (toolName.length === 0) return null;
  const toolCallId =
    stringValue(candidate["call_id"]) ??
    stringValue(candidate["callId"]) ??
    stringValue(candidate["id"]);
  const input =
    type === "command_execution"
      ? normalizeCodexCommandExecutionInput(candidate)
      : normalizeCodexToolInput(
          candidate["input"] ??
            candidate["arguments"] ??
            candidate["args"] ??
            candidate["command"] ??
            null,
        );
  return {
    type: "tool_call",
    invocationId: options.invocationId,
    provider: options.provider,
    source: options.source,
    phase: inferCodexToolCallPhase(envelope, candidate),
    toolName,
    ...(toolCallId ? { toolCallId } : {}),
    ...(input !== undefined ? { input } : {}),
  };
};

const codexToolName = (
  candidate: Record<string, unknown>,
  type: string,
): string => {
  if (type === "mcp_tool_call") {
    const server = stringValue(candidate["server"]);
    const tool = stringValue(candidate["tool"]);
    if (server && tool) return `mcp__${server}__${tool}`;
  }
  return (
    stringValue(candidate["name"]) ??
    stringValue(candidate["tool_name"]) ??
    type
  );
};

const inferCodexToolCallPhase = (
  envelope: Record<string, unknown>,
  candidate: Record<string, unknown>,
): AgentToolCallEvent["phase"] => {
  const envelopeType = stringValue(envelope["type"]) ?? "";
  const status = stringValue(candidate["status"]) ?? "";
  return envelopeType.includes("completed") || status === "completed"
    ? "completed"
    : "started";
};

const isCodexToolCallType = (type: string): boolean => {
  if (type === "function_call_output") return false;
  return (
    type.includes("tool") ||
    type.includes("local_shell_call") ||
    type === "command_execution" ||
    type === "function_call" ||
    type.includes("shell") ||
    type.includes("exec_command")
  );
};

const normalizeCodexToolInput = (input: unknown): unknown => {
  if (typeof input !== "string") return input;
  const trimmed = input.trim();
  if (
    !(
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    )
  ) {
    return input;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return input;
  }
};

const normalizeCodexCommandExecutionInput = (
  candidate: Record<string, unknown>,
): unknown => {
  const command = candidate["command"];
  if (typeof command !== "string" || command.trim().length === 0) {
    return candidate;
  }
  const status = candidate["status"];
  const exitCode = candidate["exit_code"];
  const output = candidate["aggregated_output"];
  return {
    command,
    ...(typeof status === "string" ? { status } : {}),
    ...(typeof exitCode === "number" ? { exitCode } : {}),
    ...(typeof output === "string" && output.trim().length > 0
      ? { outputPreview: output.slice(0, 1_000) }
      : {}),
  };
};

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
