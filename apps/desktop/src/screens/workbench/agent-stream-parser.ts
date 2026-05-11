// Parses raw stdout chunks from claude --output-format=stream-json into
// structured events the UI can render. Each JSON-per-line event becomes
// one parsed entry; partial chunks across multiple `raw` stream events
// are buffered.

export type ParsedStreamEntry =
  | { kind: "text_delta"; text: string }
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "turn_summary"; status: string; detail: string }
  | { kind: "hook"; name: string; event: string; phase: "started" | "response" }
  | { kind: "rate_limit"; status: string; resetsAt?: number; overage?: string }
  | {
      kind: "result";
      text: string;
      isError: boolean;
      durationMs: number;
      durationApiMs: number;
      stopReason?: string;
      costUsd?: number;
      usage?: Record<string, unknown>;
      sessionId?: string;
    }
  | { kind: "unknown"; raw: string };

export interface ParsedStream {
  /** Final assistant answer (from `type:"result"`). Null if not yet seen. */
  finalText: string | null;
  /** Incremental text accumulated from text_delta events. */
  liveText: string;
  /** Recorded tool calls in arrival order. */
  toolUses: Array<{ name: string; input: unknown }>;
  /** Most recent post_turn_summary (last one wins). */
  turnSummary: { status: string; detail: string } | null;
  /** Hooks observed (compact list, both start + response). */
  hooks: Array<{ name: string; event: string; phase: "started" | "response" }>;
  /** Most recent rate-limit snapshot. */
  rateLimit: { status: string; resetsAt?: number; overage?: string } | null;
  /** Result metadata (latency, cost, tokens). */
  resultMeta: {
    isError: boolean;
    durationMs: number;
    durationApiMs: number;
    stopReason?: string;
    costUsd?: number;
    usage?: Record<string, unknown>;
    sessionId?: string;
  } | null;
  /** Lines that failed to parse — kept so a "Raw" view can still help debugging. */
  unknown: string[];
}

const EMPTY: ParsedStream = {
  finalText: null,
  liveText: "",
  toolUses: [],
  turnSummary: null,
  hooks: [],
  rateLimit: null,
  resultMeta: null,
  unknown: [],
};

export const emptyParsedStream = (): ParsedStream => ({
  ...EMPTY,
  toolUses: [],
  hooks: [],
  unknown: [],
});

export interface StreamParserState {
  /** Bytes accumulated but not yet terminated by a newline. */
  pending: string;
  /** Parsed accumulator. */
  parsed: ParsedStream;
  /** Tracks in-progress tool_use input JSON: blockIndex → { toolUseIndex, accumulated partial_json } */
  pendingToolInputs: Map<number, { toolUseIndex: number; json: string }>;
}

export const initStreamParserState = (): StreamParserState => ({
  pending: "",
  parsed: emptyParsedStream(),
  pendingToolInputs: new Map(),
});

/**
 * Feed a new raw chunk (from `AgentStreamEvent { type: "raw" }`) into the
 * parser. Mutates and returns the same state object.
 */
export const feedStreamChunk = (
  state: StreamParserState,
  chunk: string,
): StreamParserState => {
  state.pending += chunk;
  let nl = state.pending.indexOf("\n");
  while (nl >= 0) {
    const line = state.pending.slice(0, nl).trim();
    state.pending = state.pending.slice(nl + 1);
    if (line.length > 0) ingestLine(state, line);
    nl = state.pending.indexOf("\n");
  }
  return state;
};

/**
 * Force-parse the trailing pending buffer (e.g. when the stream ends
 * without a final newline). Idempotent.
 */
export const flushStreamParser = (state: StreamParserState): StreamParserState => {
  const tail = state.pending.trim();
  state.pending = "";
  if (tail.length > 0) ingestLine(state, tail);
  return state;
};

/**
 * Replace the parser with the canonical assistant text — used when the
 * IPC layer emits `type: "assistant_text"`. The adapter already extracts
 * the final string, so we accept it verbatim as the authoritative answer.
 */
export const setFinalAssistantText = (
  state: StreamParserState,
  text: string,
): StreamParserState => {
  state.parsed.finalText = text;
  return state;
};

const ingestLine = (state: StreamParserState, line: string): void => {
  const parsed = state.parsed;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    parsed.unknown.push(line);
    return;
  }
  const type = obj["type"];
  if (type === "result") {
    parsed.finalText = typeof obj["result"] === "string" ? (obj["result"] as string) : parsed.finalText;
    parsed.resultMeta = {
      isError: Boolean(obj["is_error"]),
      durationMs: Number(obj["duration_ms"] ?? 0),
      durationApiMs: Number(obj["duration_api_ms"] ?? 0),
      ...(typeof obj["stop_reason"] === "string" ? { stopReason: obj["stop_reason"] as string } : {}),
      ...(typeof obj["total_cost_usd"] === "number" ? { costUsd: obj["total_cost_usd"] as number } : {}),
      ...(typeof obj["usage"] === "object" && obj["usage"] !== null
        ? { usage: obj["usage"] as Record<string, unknown> }
        : {}),
      ...(typeof obj["session_id"] === "string" ? { sessionId: obj["session_id"] as string } : {}),
    };
    return;
  }
  if (type === "stream_event") {
    const ev = obj["event"] as Record<string, unknown> | undefined;
    const evType = ev?.["type"];
    const blockIndex = typeof ev?.["index"] === "number" ? (ev["index"] as number) : -1;
    if (evType === "content_block_start") {
      const block = ev?.["content_block"] as Record<string, unknown> | undefined;
      if (block && block["type"] === "tool_use" && typeof block["name"] === "string") {
        const toolUseIndex = parsed.toolUses.length;
        parsed.toolUses.push({ name: block["name"] as string, input: null });
        if (blockIndex >= 0) {
          state.pendingToolInputs.set(blockIndex, { toolUseIndex, json: "" });
        }
      }
    } else if (evType === "content_block_delta") {
      const delta = ev?.["delta"] as Record<string, unknown> | undefined;
      if (delta && delta["type"] === "text_delta" && typeof delta["text"] === "string") {
        parsed.liveText += delta["text"] as string;
      } else if (delta && delta["type"] === "input_json_delta" && typeof delta["partial_json"] === "string") {
        const pending = state.pendingToolInputs.get(blockIndex);
        if (pending) pending.json += delta["partial_json"] as string;
      }
    } else if (evType === "content_block_stop") {
      const pending = state.pendingToolInputs.get(blockIndex);
      if (pending) {
        state.pendingToolInputs.delete(blockIndex);
        if (pending.json.length > 0) {
          const toolEntry = parsed.toolUses[pending.toolUseIndex];
          if (toolEntry) {
            try {
              toolEntry.input = JSON.parse(pending.json);
            } catch {
              // keep input as null if JSON is malformed
            }
          }
        }
      }
    }
    return;
  }
  if (type === "system") {
    const subtype = obj["subtype"];
    if (subtype === "post_turn_summary") {
      parsed.turnSummary = {
        status: String(obj["status_category"] ?? ""),
        detail: String(obj["status_detail"] ?? ""),
      };
      return;
    }
    if (subtype === "hook_started" || subtype === "hook_response") {
      parsed.hooks.push({
        name: String(obj["hook_name"] ?? "unknown"),
        event: String(obj["hook_event"] ?? "unknown"),
        phase: subtype === "hook_started" ? "started" : "response",
      });
      return;
    }
    parsed.unknown.push(line);
    return;
  }
  if (type === "rate_limit_event") {
    const info = obj["rate_limit_info"] as Record<string, unknown> | undefined;
    if (info) {
      parsed.rateLimit = {
        status: String(info["status"] ?? ""),
        ...(typeof info["resetsAt"] === "number" ? { resetsAt: info["resetsAt"] as number } : {}),
        ...(typeof info["overageStatus"] === "string" ? { overage: info["overageStatus"] as string } : {}),
      };
    }
    return;
  }
  parsed.unknown.push(line);
};
