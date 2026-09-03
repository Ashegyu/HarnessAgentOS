import type {
  AgentProgressEvent,
  AgentProgressStage,
  AgentToolCallEvent,
} from "@harness/core";

// Parses raw Codex `exec --json` stdout chunks into structured events the UI
// can render. Each JSON-per-line event becomes
// one parsed entry; partial chunks across multiple `raw` stream events
// are buffered.

export const MAX_STREAM_PENDING_CHARS = 256 * 1024;
export const MAX_STREAM_TEXT_CHARS = 512 * 1024;
export const MAX_STREAM_UNKNOWN_LINES = 100;
export const MAX_STREAM_TOOL_USES = 256;
const MAX_STREAM_SECTIONS = 512;
const MAX_STREAM_PROGRESS_ITEMS = 100;
const MAX_STREAM_HOOKS = 100;
const MAX_STREAM_TOOL_INPUT_CHARS = 64 * 1024;

export type ParsedProgressItem = Pick<
  AgentProgressEvent,
  "stage" | "message" | "detail" | "at"
>;

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
      usageApproximate?: boolean;
      costEstimateApproximate?: boolean;
      sessionId?: string;
    }
  | { kind: "unknown"; raw: string };

export type ParsedStreamSection =
  | { id: string; kind: "thinking"; text: string }
  | { id: string; kind: "response"; text: string; phase: "live" | "intermediate" }
  | { id: string; kind: "tool"; name: string; input: unknown }
  | { id: string; kind: "final"; text: string };

export interface ParsedStream {
  /** Final assistant answer (from `type:"result"`). Null if not yet seen. */
  finalText: string | null;
  /**
   * Completed assistant text that arrived before the invocation is terminal.
   * Codex can emit completed assistant items while the app-level invocation is
   * still running, so this must not be treated as final until promoted.
   */
  intermediateText: string;
  /** Incremental text accumulated from text_delta events. */
  liveText: string;
  /**
   * Incremental text accumulated from `thinking_delta` events (extended
   * thinking blocks). Distinct from `liveText` so the UI can render the
   * model's chain-of-thought in its own section with different styling.
   */
  thinkingText: string;
  /** Recorded tool calls in arrival order. */
  toolUses: Array<{ name: string; input: unknown }>;
  /**
   * Chronological stream sections in arrival order. Unlike the aggregate
   * fields above, this preserves interleaving such as thinking → tool →
   * response → tool.
   */
  sections: ParsedStreamSection[];
  /** Persisted progress events replayed from saved Harness stream logs. */
  progress: ParsedProgressItem[];
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
    usageApproximate?: boolean;
    costEstimateApproximate?: boolean;
    sessionId?: string;
  } | null;
  /** Lines that failed to parse — kept so a "Raw" view can still help debugging. */
  unknown: string[];
}

const EMPTY: ParsedStream = {
  finalText: null,
  intermediateText: "",
  liveText: "",
  thinkingText: "",
  toolUses: [],
  sections: [],
  progress: [],
  turnSummary: null,
  hooks: [],
  rateLimit: null,
  resultMeta: null,
  unknown: [],
};

export const emptyParsedStream = (): ParsedStream => ({
  ...EMPTY,
  toolUses: [],
  sections: [],
  progress: [],
  hooks: [],
  unknown: [],
});

export interface StreamParserState {
  /** Bytes accumulated but not yet terminated by a newline. */
  pending: string;
  /** Provider raw chunks replayed from persisted Harness `raw` events. */
  pendingRaw: string;
  /** Parsed accumulator. */
  parsed: ParsedStream;
  /** Tracks in-progress tool_use input JSON: blockIndex → parsed indexes + accumulated partial_json */
  pendingToolInputs: Map<
    number,
    { toolUseIndex: number; sectionIndex: number; json: string }
  >;
  /** Tracks Codex item.started/item.completed tool updates by item id. */
  codexToolSections: Map<string, { toolUseIndex: number; sectionIndex: number }>;
  /** Confirmed final text extracted from structured agent-plan output. */
  pendingFinalText: string | null;
  /** Monotonic id source for chronological render sections. */
  nextSectionId: number;
}

export const initStreamParserState = (): StreamParserState => ({
  pending: "",
  pendingRaw: "",
  parsed: emptyParsedStream(),
  pendingToolInputs: new Map(),
  codexToolSections: new Map(),
  pendingFinalText: null,
  nextSectionId: 1,
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
  if (state.pending.length > MAX_STREAM_PENDING_CHARS) {
    state.pending = state.pending.slice(-MAX_STREAM_PENDING_CHARS);
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
  const rawTail = state.pendingRaw.trim();
  state.pendingRaw = "";
  if (rawTail.length > 0) ingestLine(state, rawTail);
  return state;
};

/**
 * Record a completed assistant message that is not yet app-terminal.
 * The UI renders this as "응답 작성 중" until a result event or terminal
 * invocation status promotes it to the final answer.
 */
export const setIntermediateAssistantText = (
  state: StreamParserState,
  text: string,
): StreamParserState => {
  applyIntermediateAssistantText(state, text);
  return state;
};

export const recordObservedToolCall = (
  state: StreamParserState,
  event: Pick<AgentToolCallEvent, "toolName" | "input" | "toolCallId">,
): StreamParserState => {
  appendObservedToolCallSection(state, event);
  return state;
};

export const promoteIntermediateTextToFinal = (
  state: StreamParserState,
  meta?: {
    latencyMs?: number;
    costEstimate?: number;
    usage?: Record<string, unknown>;
    usageApproximate?: boolean;
    costEstimateApproximate?: boolean;
  },
): StreamParserState => {
  const parsed = state.parsed;
  if (parsed.finalText === null) {
    const text = state.pendingFinalText ??
      (parsed.intermediateText.length > 0 ? parsed.intermediateText : parsed.liveText);
    if (text.length > 0) {
      const finalText = capStreamText(normalizeAssistantDisplayText(text));
      parsed.finalText = finalText;
      appendFinalSection(state, finalText);
    }
  } else {
    appendFinalSection(state, parsed.finalText);
  }
  parsed.resultMeta = {
    isError: false,
    durationMs: meta?.latencyMs ?? parsed.resultMeta?.durationMs ?? 0,
    durationApiMs: parsed.resultMeta?.durationApiMs ?? 0,
    ...(parsed.resultMeta?.stopReason ? { stopReason: parsed.resultMeta.stopReason } : {}),
    ...(meta?.costEstimate !== undefined
      ? { costUsd: meta.costEstimate }
      : parsed.resultMeta?.costUsd !== undefined
        ? { costUsd: parsed.resultMeta.costUsd }
        : {}),
    ...(meta?.usage
      ? { usage: meta.usage }
      : parsed.resultMeta?.usage
        ? { usage: parsed.resultMeta.usage }
        : {}),
    ...(meta?.usageApproximate !== undefined
      ? { usageApproximate: meta.usageApproximate }
      : parsed.resultMeta?.usageApproximate !== undefined
        ? { usageApproximate: parsed.resultMeta.usageApproximate }
        : {}),
    ...(meta?.costEstimateApproximate !== undefined
      ? { costEstimateApproximate: meta.costEstimateApproximate }
      : parsed.resultMeta?.costEstimateApproximate !== undefined
        ? { costEstimateApproximate: parsed.resultMeta.costEstimateApproximate }
        : {}),
    ...(parsed.resultMeta?.sessionId ? { sessionId: parsed.resultMeta.sessionId } : {}),
  };
  return state;
};

export const hydrateSavedAgentOutput = (
  state: StreamParserState,
  content: string,
  options?: {
    terminal?: boolean;
    latencyMs?: number;
    costEstimate?: number;
    usage?: Record<string, unknown>;
    usageApproximate?: boolean;
  },
): StreamParserState => {
  const text = content.trim();
  if (text.length === 0) return state;

  if (looksLikeJsonLineStream(text)) {
    feedStreamChunk(state, content.endsWith("\n") ? content : `${content}\n`);
    flushStreamParser(state);
  }

  if (!hasStructuredResponse(state.parsed)) {
    state.parsed.unknown = [];
    setIntermediateAssistantText(state, content);
  }

  if (options?.terminal) {
    promoteIntermediateTextToFinal(state, options);
  }
  return state;
};

/**
 * Replace the parser with an already-confirmed final assistant text.
 * Most renderer call sites should prefer `setIntermediateAssistantText`
 * followed by `promoteIntermediateTextToFinal` on app-level result.
 */
export const setFinalAssistantText = (
  state: StreamParserState,
  text: string,
): StreamParserState => {
  applyFinalAssistantText(state, text);
  return state;
};

const ingestLine = (state: StreamParserState, line: string): void => {
  const parsed = state.parsed;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    pushBounded(parsed.unknown, line, MAX_STREAM_UNKNOWN_LINES);
    return;
  }
  const type = obj["type"];
  if (ingestPersistedHarnessStreamEvent(state, obj)) return;
  if (type === "result") {
    if (typeof obj["result"] === "string") {
      applyFinalAssistantText(state, obj["result"] as string);
    } else if (parsed.finalText === null) {
      promoteIntermediateTextToFinal(state);
    }
    parsed.resultMeta = {
      isError: Boolean(obj["is_error"]),
      durationMs: Number(obj["duration_ms"] ?? 0),
      durationApiMs: Number(obj["duration_api_ms"] ?? 0),
      ...(typeof obj["stop_reason"] === "string" ? { stopReason: obj["stop_reason"] as string } : {}),
      ...(typeof obj["total_cost_usd"] === "number" ? { costUsd: obj["total_cost_usd"] as number } : {}),
      ...(typeof obj["usage"] === "object" && obj["usage"] !== null
        ? { usage: obj["usage"] as Record<string, unknown> }
        : {}),
      ...(typeof obj["usage_approximate"] === "boolean"
        ? { usageApproximate: obj["usage_approximate"] as boolean }
        : {}),
      ...(typeof obj["cost_estimate_approximate"] === "boolean"
        ? { costEstimateApproximate: obj["cost_estimate_approximate"] as boolean }
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
        const toolUseIndex = appendToolUseSection(state, {
          name: block["name"] as string,
          input: null,
        });
        const sectionIndex = parsed.sections.length - 1;
        if (blockIndex >= 0 && toolUseIndex >= 0) {
          state.pendingToolInputs.set(blockIndex, {
            toolUseIndex,
            sectionIndex,
            json: "",
          });
        }
      }
    } else if (evType === "content_block_delta") {
      const delta = ev?.["delta"] as Record<string, unknown> | undefined;
      if (delta && delta["type"] === "text_delta" && typeof delta["text"] === "string") {
        const text = delta["text"] as string;
        parsed.liveText = capStreamText(parsed.liveText + text);
        appendTextDeltaSection(state, "response", text, "live");
      } else if (delta && delta["type"] === "thinking_delta" && typeof delta["thinking"] === "string") {
        // Extended thinking block — accumulated separately so the UI can
        // render the model's reasoning in its own section.
        const thinking = delta["thinking"] as string;
        parsed.thinkingText = capStreamText(parsed.thinkingText + thinking);
        appendTextDeltaSection(state, "thinking", thinking);
      } else if (delta && delta["type"] === "input_json_delta" && typeof delta["partial_json"] === "string") {
        const pending = state.pendingToolInputs.get(blockIndex);
        if (pending) {
          pending.json = capPendingText(
            pending.json + (delta["partial_json"] as string),
          );
        }
      }
    } else if (evType === "content_block_stop") {
      const pending = state.pendingToolInputs.get(blockIndex);
      if (pending) {
        state.pendingToolInputs.delete(blockIndex);
        if (pending.json.length > 0) {
          const toolEntry = parsed.toolUses[pending.toolUseIndex];
          if (toolEntry) {
            try {
              const input = JSON.parse(pending.json);
              toolEntry.input = input;
              const section = parsed.sections[pending.sectionIndex];
              if (section?.kind === "tool") {
                section.input = input;
              }
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
      pushBounded(
        parsed.hooks,
        {
          name: String(obj["hook_name"] ?? "unknown"),
          event: String(obj["hook_event"] ?? "unknown"),
          phase: subtype === "hook_started" ? "started" : "response",
        },
        MAX_STREAM_HOOKS,
      );
      return;
    }
    pushBounded(parsed.unknown, line, MAX_STREAM_UNKNOWN_LINES);
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
  if (ingestCodexLine(state, obj)) return;
  pushBounded(parsed.unknown, line, MAX_STREAM_UNKNOWN_LINES);
};

const looksLikeJsonLineStream = (text: string): boolean => {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return firstLine.startsWith("{") && firstLine.endsWith("}");
};

const hasStructuredResponse = (parsed: ParsedStream): boolean =>
  parsed.finalText !== null ||
  parsed.intermediateText.length > 0 ||
  parsed.liveText.length > 0 ||
  parsed.thinkingText.length > 0 ||
  parsed.toolUses.length > 0 ||
  parsed.sections.length > 0 ||
  parsed.progress.length > 0 ||
  parsed.resultMeta !== null;

const ingestPersistedHarnessStreamEvent = (
  state: StreamParserState,
  obj: Record<string, unknown>,
): boolean => {
  const type = typeof obj["type"] === "string" ? obj["type"] : "";
  const hasInvocation = typeof obj["invocationId"] === "string";
  if (type === "progress" && hasInvocation) {
    const stage = obj["stage"];
    const message = obj["message"];
    const at = obj["at"];
    if (
      isProgressStage(stage) &&
      typeof message === "string" &&
      typeof at === "string"
    ) {
      pushBounded(
        state.parsed.progress,
        {
          stage,
          message,
          ...(typeof obj["detail"] === "string"
            ? { detail: obj["detail"] as string }
            : {}),
          at,
        },
        MAX_STREAM_PROGRESS_ITEMS,
      );
    }
    return true;
  }
  if (type === "raw" && hasInvocation) {
    if (typeof obj["text"] === "string") {
      feedPersistedRawChunk(state, obj["text"] as string);
    }
    return true;
  }
  if (type === "tool_call" && hasInvocation) {
    const toolName = obj["toolName"];
    if (typeof toolName === "string" && toolName.length > 0) {
      recordObservedToolCall(state, {
        toolName,
        ...(obj["input"] !== undefined ? { input: obj["input"] } : {}),
        ...(typeof obj["toolCallId"] === "string"
          ? { toolCallId: obj["toolCallId"] as string }
          : {}),
      });
    }
    return true;
  }
  if (type === "assistant_text" && hasInvocation) {
    if (typeof obj["text"] === "string") {
      applyIntermediateAssistantText(state, obj["text"] as string);
    }
    return true;
  }
  if (type === "result" && hasInvocation) {
    promoteIntermediateTextToFinal(state, {
      ...(typeof obj["latencyMs"] === "number"
        ? { latencyMs: obj["latencyMs"] as number }
        : {}),
      ...(typeof obj["costEstimate"] === "number"
        ? { costEstimate: obj["costEstimate"] as number }
        : {}),
      ...(isRecord(obj["usage"])
        ? { usage: obj["usage"] as Record<string, unknown> }
        : {}),
      ...(typeof obj["usageApproximate"] === "boolean"
        ? { usageApproximate: obj["usageApproximate"] as boolean }
        : {}),
      ...(typeof obj["costEstimateApproximate"] === "boolean"
        ? { costEstimateApproximate: obj["costEstimateApproximate"] as boolean }
        : {}),
    });
    return true;
  }
  if (type === "failed" && hasInvocation) {
    state.parsed.turnSummary = {
      status: "failed",
      detail: typeof obj["message"] === "string" ? (obj["message"] as string) : "",
    };
    state.parsed.resultMeta = {
      isError: true,
      durationMs: 0,
      durationApiMs: 0,
    };
    return true;
  }
  return (type === "started" || type === "cancelled") && hasInvocation;
};

const feedPersistedRawChunk = (
  state: StreamParserState,
  chunk: string,
): void => {
  state.pendingRaw += chunk;
  let nl = state.pendingRaw.indexOf("\n");
  while (nl >= 0) {
    const line = state.pendingRaw.slice(0, nl).trim();
    state.pendingRaw = state.pendingRaw.slice(nl + 1);
    if (line.length > 0) ingestLine(state, line);
    nl = state.pendingRaw.indexOf("\n");
  }
  if (state.pendingRaw.length > MAX_STREAM_PENDING_CHARS) {
    state.pendingRaw = state.pendingRaw.slice(-MAX_STREAM_PENDING_CHARS);
  }
};

const PROGRESS_STAGES: ReadonlySet<string> = new Set([
  "context",
  "profile",
  "prompt",
  "session",
  "mcp",
  "queued",
  "cli",
  "parse",
  "approval",
  "complete",
]);

const isProgressStage = (value: unknown): value is AgentProgressStage =>
  typeof value === "string" && PROGRESS_STAGES.has(value);

interface HarnessAgentPlanDisplay {
  summary: string;
  prose: string;
  thinkingText: string;
  toolUses: Array<{ name: string; input: unknown }>;
}

const applyIntermediateAssistantText = (
  state: StreamParserState,
  text: string,
): void => {
  const plan = extractHarnessAgentPlanDisplay(text);
  if (!plan) {
    state.pendingFinalText = null;
    state.parsed.intermediateText = capStreamText(text);
    appendResponseSnapshotSection(
      state,
      state.parsed.intermediateText,
      "intermediate",
    );
    return;
  }
  state.parsed.intermediateText = capStreamText(plan.prose || plan.summary);
  appendUniqueResponseSnapshotSection(
    state,
    state.parsed.intermediateText,
    "intermediate",
  );
  applyHarnessAgentPlanDisplay(state, plan);
};

const applyFinalAssistantText = (
  state: StreamParserState,
  text: string,
): void => {
  const plan = extractHarnessAgentPlanDisplay(text);
  if (!plan) {
    state.pendingFinalText = null;
    state.parsed.finalText = capStreamText(text);
    appendFinalSection(state, state.parsed.finalText);
    return;
  }
  if (state.parsed.intermediateText.length === 0) {
    state.parsed.intermediateText = capStreamText(plan.prose || plan.summary);
    appendUniqueResponseSnapshotSection(
      state,
      state.parsed.intermediateText,
      "intermediate",
    );
  }
  applyHarnessAgentPlanDisplay(state, plan);
  state.parsed.finalText = capStreamText(plan.summary);
  appendFinalSection(state, state.parsed.finalText);
};

const applyHarnessAgentPlanDisplay = (
  state: StreamParserState,
  plan: HarnessAgentPlanDisplay,
): void => {
  state.pendingFinalText = capStreamText(plan.summary);
  appendUniqueThinkingText(state, plan.thinkingText);
  appendUniqueToolUses(state, plan.toolUses);
};

const normalizeAssistantDisplayText = (text: string): string => {
  return extractHarnessAgentPlanDisplay(text)?.summary ?? text;
};

const extractHarnessAgentPlanDisplay = (
  text: string,
): HarnessAgentPlanDisplay | null => {
  const fenced = extractHarnessAgentPlanFencedJson(text);
  const json = fenced?.json ?? extractPlainHarnessAgentPlanJson(text);
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!isRecord(parsed) || Array.isArray(parsed)) return null;
    const summary = typeof parsed["summary"] === "string"
      ? (parsed["summary"] as string).trim()
      : "";
    if (summary.length === 0) return null;
    return {
      summary,
      prose: fenced?.prose ?? "",
      thinkingText: buildHarnessPlanThinkingText(parsed),
      toolUses: buildHarnessPlanToolUses(parsed),
    };
  } catch {
    return null;
  }
};

const extractHarnessAgentPlanFencedJson = (
  text: string,
): { json: string; prose: string } | null => {
  const match = /```harness_agent_plan\s*([\s\S]*?)```/.exec(text);
  if (!match) return null;
  const json = match[1]?.trim();
  if (!json) return null;
  const fullMatch = match[0];
  return {
    json,
    prose: text.replace(fullMatch, "").trim(),
  };
};

const extractPlainHarnessAgentPlanJson = (text: string): string | null => {
  const trimmed = text.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}") ? trimmed : null;
};

const buildHarnessPlanThinkingText = (
  plan: Record<string, unknown>,
): string => {
  const sections: string[] = [];
  const assumptions = stringArray(plan["assumptions"]);
  if (assumptions.length > 0) {
    sections.push(["가정", ...assumptions.map((a) => `- ${a}`)].join("\n"));
  }
  if (Array.isArray(plan["steps"]) && plan["steps"].length > 0) {
    const lines = ["진행 판단"];
    for (const step of plan["steps"]) {
      if (!isRecord(step)) continue;
      const title = typeof step["title"] === "string" ? step["title"] : "단계";
      const rationale = typeof step["rationale"] === "string"
        ? step["rationale"]
        : "";
      const risk = typeof step["risk"] === "string" ? step["risk"] : "";
      lines.push(
        `- ${title}${rationale ? `: ${rationale}` : ""}${risk ? ` (risk: ${risk})` : ""}`,
      );
    }
    if (lines.length > 1) sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
};

const buildHarnessPlanToolUses = (
  plan: Record<string, unknown>,
): Array<{ name: string; input: unknown }> => {
  const toolUses: Array<{ name: string; input: unknown }> = [];
  if (Array.isArray(plan["proposedActions"])) {
    for (const action of plan["proposedActions"]) {
      if (!isRecord(action)) continue;
      if (action["type"] === "shell") {
        toolUses.push({
          name: "shell",
          input: {
            command: action["command"],
            args: Array.isArray(action["args"]) ? action["args"] : undefined,
            rationale: action["rationale"],
          },
        });
      } else if (action["type"] === "file_write") {
        toolUses.push({
          name: "file_write",
          input: {
            path: action["path"],
            rationale: action["rationale"],
            contentLength:
              typeof action["after"] === "string"
                ? (action["after"] as string).length
              : undefined,
          },
        });
      } else if (action["type"] === "file_patch") {
        toolUses.push({
          name: "file_patch",
          input: {
            path: action["path"],
            rationale: action["rationale"],
            patchLength:
              typeof action["patch"] === "string"
                ? (action["patch"] as string).length
                : undefined,
          },
        });
      }
    }
  }
  if (Array.isArray(plan["suggestedQualityChecks"])) {
    for (const check of plan["suggestedQualityChecks"]) {
      if (!isRecord(check)) continue;
      toolUses.push({
        name: "quality_check",
        input: {
          command: check["command"],
          reason: check["reason"],
        },
      });
    }
  }
  return toolUses;
};

const appendUniqueThinkingText = (
  state: StreamParserState,
  text: string,
): void => {
  const parsed = state.parsed;
  const trimmed = capStreamText(text.trim());
  if (trimmed.length === 0 || parsed.thinkingText.includes(trimmed)) return;
  parsed.thinkingText = capStreamText(
    parsed.thinkingText.length > 0
      ? `${parsed.thinkingText}\n\n${trimmed}`
      : trimmed,
  );
  appendTextDeltaSection(state, "thinking", trimmed);
};

const appendUniqueToolUses = (
  state: StreamParserState,
  toolUses: Array<{ name: string; input: unknown }>,
): void => {
  const parsed = state.parsed;
  for (const toolUse of toolUses) {
    const key = `${toolUse.name}:${JSON.stringify(toolUse.input)}`;
    const exists = parsed.toolUses.some(
      (existing) => `${existing.name}:${JSON.stringify(existing.input)}` === key,
    );
    if (!exists) appendToolUseSection(state, toolUse);
  }
};

const appendObservedToolCallSection = (
  state: StreamParserState,
  event: Pick<AgentToolCallEvent, "toolName" | "input" | "toolCallId">,
): void => {
  const input = boundToolInput(event.input ?? null);
  const key = `${event.toolName}:${safeJson(input)}`;
  const existingIndex = state.parsed.toolUses.findIndex(
    (existing) =>
      existing.name === event.toolName &&
      (existing.input === null ||
        `${existing.name}:${safeJson(existing.input)}` === key),
  );
  if (existingIndex >= 0) {
    const existing = state.parsed.toolUses[existingIndex];
    if (existing && existing.input === null && input !== null) {
      existing.input = input;
      const section = state.parsed.sections.find(
        (candidate) =>
          candidate.kind === "tool" &&
          candidate.name === event.toolName &&
          candidate.input === null,
      );
      if (section?.kind === "tool") section.input = input;
    }
    return;
  }
  appendToolUseSection(state, {
    name: event.toolName,
    input,
  });
};

const appendTextDeltaSection = (
  state: StreamParserState,
  kind: "thinking" | "response",
  text: string,
  phase: "live" | "intermediate" = "live",
): void => {
  if (text.length === 0) return;
  const sections = state.parsed.sections;
  const last = sections[sections.length - 1];
  if (kind === "thinking") {
    if (last?.kind === "thinking") {
      last.text = capStreamText(last.text + text);
      return;
    }
    if (sections.length >= MAX_STREAM_SECTIONS) return;
    sections.push({
      id: nextSectionId(state),
      kind: "thinking",
      text: capStreamText(text),
    });
    return;
  }
  if (last?.kind === "response" && last.phase === phase) {
    last.text = capStreamText(last.text + text);
    return;
  }
  if (sections.length >= MAX_STREAM_SECTIONS) return;
  sections.push({
    id: nextSectionId(state),
    kind: "response",
    phase,
    text: capStreamText(text),
  });
};

const appendResponseSnapshotSection = (
  state: StreamParserState,
  text: string,
  phase: "live" | "intermediate",
): void => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  const sections = state.parsed.sections;
  const last = sections[sections.length - 1];
  if (
    last?.kind === "response" &&
    last.phase === phase &&
    last.text.trim() === trimmed
  ) {
    return;
  }
  if (sections.length >= MAX_STREAM_SECTIONS) return;
  sections.push({
    id: nextSectionId(state),
    kind: "response",
    phase,
    text: capStreamText(text),
  });
};

const appendUniqueResponseSnapshotSection = (
  state: StreamParserState,
  text: string,
  phase: "live" | "intermediate",
): void => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  const exists = state.parsed.sections.some(
    (section) =>
      section.kind === "response" &&
      section.phase === phase &&
      section.text.trim() === trimmed,
  );
  if (!exists) appendResponseSnapshotSection(state, text, phase);
};

const appendToolUseSection = (
  state: StreamParserState,
  toolUse: { name: string; input: unknown },
): number => {
  const parsed = state.parsed;
  if (
    parsed.toolUses.length >= MAX_STREAM_TOOL_USES ||
    parsed.sections.length >= MAX_STREAM_SECTIONS
  ) {
    return -1;
  }
  const toolUseIndex = parsed.toolUses.length;
  const boundedToolUse = {
    name: capPlainText(toolUse.name, 1_000),
    input: boundToolInput(toolUse.input),
  };
  parsed.toolUses.push(boundedToolUse);
  parsed.sections.push({
    id: nextSectionId(state),
    kind: "tool",
    name: boundedToolUse.name,
    input: boundedToolUse.input,
  });
  return toolUseIndex;
};

const appendFinalSection = (
  state: StreamParserState,
  text: string | null,
): void => {
  if (text === null || text.trim().length === 0) return;
  removeDuplicateTrailingResponseSection(state, text);
  const sections = state.parsed.sections;
  const last = sections[sections.length - 1];
  if (last?.kind === "final") {
    last.text = capStreamText(text);
    return;
  }
  const exists = sections.some(
    (section) => section.kind === "final" && section.text.trim() === text.trim(),
  );
  if (!exists) {
    if (sections.length >= MAX_STREAM_SECTIONS) return;
    sections.push({
      id: nextSectionId(state),
      kind: "final",
      text: capStreamText(text),
    });
  }
};

const removeDuplicateTrailingResponseSection = (
  state: StreamParserState,
  finalText: string,
): void => {
  const sections = state.parsed.sections;
  const last = sections[sections.length - 1];
  if (
    last?.kind === "response" &&
    last.text.trim() === finalText.trim()
  ) {
    sections.pop();
  }
};

const nextSectionId = (state: StreamParserState): string =>
  `stream-section-${state.nextSectionId++}`;

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const capPendingText = (text: string): string =>
  text.length <= MAX_STREAM_PENDING_CHARS
    ? text
    : text.slice(-MAX_STREAM_PENDING_CHARS);

const capStreamText = (text: string): string => {
  if (text.length <= MAX_STREAM_TEXT_CHARS) return text;
  const marker = "[earlier stream content truncated]\n";
  return marker + text.slice(-(MAX_STREAM_TEXT_CHARS - marker.length));
};

const capPlainText = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`;

const pushBounded = <T>(items: T[], value: T, limit: number): void => {
  items.push(value);
  if (items.length > limit) items.splice(0, items.length - limit);
};

const boundToolInput = (input: unknown): unknown => {
  const serialized = safeJson(input);
  if (serialized.length <= MAX_STREAM_TOOL_INPUT_CHARS) return input;
  return {
    truncated: true,
    preview: serialized.slice(0, MAX_STREAM_TOOL_INPUT_CHARS),
  };
};

const ingestCodexLine = (
  state: StreamParserState,
  obj: Record<string, unknown>,
): boolean => {
  const parsed = state.parsed;
  const type = typeof obj["type"] === "string" ? (obj["type"] as string) : "";
  if (type === "thread.started" || type === "turn.started") {
    parsed.turnSummary = {
      status: type,
      detail: typeof obj["thread_id"] === "string" ? (obj["thread_id"] as string) : "",
    };
    return true;
  }
  if (type === "turn.completed") {
    const usage = isRecord(obj["usage"]) ? obj["usage"] : undefined;
    const reasoningTokens = usage?.["reasoning_output_tokens"];
    parsed.resultMeta = {
      isError: false,
      durationMs: 0,
      durationApiMs: 0,
      ...(usage ? { usage } : {}),
    };
    if (typeof reasoningTokens === "number" && reasoningTokens > 0) {
      appendCodexReasoningUsage(state, reasoningTokens);
    }
    return true;
  }
  if (type === "turn.failed") {
    parsed.turnSummary = {
      status: "turn.failed",
      detail: extractCodexErrorMessage(obj),
    };
    parsed.resultMeta = {
      isError: true,
      durationMs: 0,
      durationApiMs: 0,
    };
    return true;
  }
  if (type === "error") {
    parsed.turnSummary = {
      status: "error",
      detail: typeof obj["message"] === "string" ? (obj["message"] as string) : "",
    };
    return true;
  }

  const payload = obj["payload"];
  if (isRecord(payload) && ingestCodexLine(state, payload)) {
    return true;
  }

  const thinkingText = extractCodexThinkingText(obj);
  if (thinkingText !== null) {
    const text = parsed.thinkingText.length > 0 ? `\n${thinkingText}` : thinkingText;
    parsed.thinkingText += text;
    appendTextDeltaSection(state, "thinking", text);
    return true;
  }

  if (isCodexToolOutput(obj)) {
    return true;
  }

  const delta = extractCodexDeltaText(obj);
  if (delta !== null) {
    parsed.liveText += delta;
    appendTextDeltaSection(state, "response", delta, "live");
    return true;
  }

  const assistantText = extractCodexAssistantText(obj);
  if (assistantText !== null) {
    applyIntermediateAssistantText(state, assistantText);
    return true;
  }

  const toolUse = extractCodexToolUse(obj);
  if (toolUse !== null) {
    appendCodexToolUseSection(state, toolUse);
    return true;
  }

  return false;
};

const extractCodexErrorMessage = (obj: Record<string, unknown>): string => {
  const error = obj["error"];
  if (isRecord(error) && typeof error["message"] === "string") {
    return error["message"] as string;
  }
  return typeof obj["message"] === "string" ? (obj["message"] as string) : "";
};

const extractCodexDeltaText = (
  obj: Record<string, unknown>,
): string | null => {
  if (typeof obj["delta"] === "string") return obj["delta"] as string;
  if (isRecord(obj["delta"])) {
    const text = extractText(obj["delta"]);
    if (text.length > 0) return text;
  }
  if (typeof obj["text"] === "string" && isDeltaLike(obj)) {
    return obj["text"] as string;
  }
  if (typeof obj["output_text"] === "string" && isDeltaLike(obj)) {
    return obj["output_text"] as string;
  }
  const item = obj["item"];
  if (isRecord(item)) {
    if (typeof item["delta"] === "string") return item["delta"] as string;
    if (isRecord(item["delta"])) {
      const text = extractText(item["delta"]);
      if (text.length > 0) return text;
    }
  }
  return null;
};

const isDeltaLike = (obj: Record<string, unknown>): boolean => {
  const type = typeof obj["type"] === "string" ? obj["type"] : "";
  return type.includes("delta");
};

const extractCodexAssistantText = (
  obj: Record<string, unknown>,
): string | null => {
  const candidates = [obj["item"], obj["message"], obj["response"], obj];
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !looksLikeAssistantMessage(candidate)) continue;
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
    (type.includes("assistant") && !type.includes("delta"))
  );
};

const extractText = (obj: Record<string, unknown>): string => {
  if (typeof obj["text"] === "string") return obj["text"] as string;
  if (typeof obj["output_text"] === "string") return obj["output_text"] as string;
  if (typeof obj["content"] === "string") return obj["content"] as string;
  const content = obj["content"];
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!isRecord(block)) continue;
    const text = extractText(block);
    if (text.length > 0) parts.push(text);
  }
  return parts.join("");
};

const extractCodexThinkingText = (
  obj: Record<string, unknown>,
): string | null => {
  const candidates = [obj["item"], obj["payload"], obj];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const type = typeof candidate["type"] === "string" ? candidate["type"] : "";
    if (!type.includes("reasoning") && !type.includes("thinking")) continue;
    const summaryText = extractCodexSummaryText(candidate["summary"]);
    if (summaryText.length > 0) return summaryText;
    if (type.includes("summary")) {
      const text = extractText(candidate);
      if (text.length > 0) return text;
    }
  }
  return null;
};

const extractCodexSummaryText = (summary: unknown): string => {
  if (typeof summary === "string") return summary.trim();
  if (!Array.isArray(summary)) return "";
  const parts: string[] = [];
  for (const block of summary) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!isRecord(block)) continue;
    const text = extractText(block);
    if (text.length > 0) parts.push(text);
  }
  return parts.join("\n").trim();
};

const extractCodexToolUse = (
  obj: Record<string, unknown>,
): { id?: string; name: string; input: unknown } | null => {
  const candidate = isRecord(obj["item"]) ? obj["item"] : obj;
  const type = typeof candidate["type"] === "string" ? candidate["type"] : "";
  if (!isCodexToolCallType(type)) {
    return null;
  }
  const id = typeof candidate["id"] === "string" ? candidate["id"] : undefined;
  const name =
    typeof candidate["name"] === "string"
      ? (candidate["name"] as string)
      : typeof candidate["tool_name"] === "string"
        ? (candidate["tool_name"] as string)
        : type || "tool";
  if (type === "command_execution") {
    return {
      ...(id !== undefined ? { id } : {}),
      name,
      input: normalizeCodexCommandExecutionInput(candidate),
    };
  }
  const input =
    candidate["input"] ??
    candidate["arguments"] ??
    candidate["args"] ??
    candidate["command"] ??
    null;
  return {
    ...(id !== undefined ? { id } : {}),
    name,
    input: normalizeCodexToolInput(input),
  };
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

const isCodexToolOutput = (obj: Record<string, unknown>): boolean => {
  const candidate = isRecord(obj["item"]) ? obj["item"] : obj;
  return candidate["type"] === "function_call_output";
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

const appendCodexToolUseSection = (
  state: StreamParserState,
  toolUse: { id?: string; name: string; input: unknown },
): void => {
  if (toolUse.id) {
    const existing = state.codexToolSections.get(toolUse.id);
    if (existing) {
      const parsedTool = state.parsed.toolUses[existing.toolUseIndex];
      if (parsedTool) {
        parsedTool.name = toolUse.name;
        parsedTool.input = toolUse.input;
      }
      const section = state.parsed.sections[existing.sectionIndex];
      if (section?.kind === "tool") {
        section.name = toolUse.name;
        section.input = toolUse.input;
      }
      return;
    }
  }
  const before = state.parsed.sections.length;
  const toolUseIndex = appendToolUseSection(state, {
    name: toolUse.name,
    input: toolUse.input,
  });
  if (toolUse.id && toolUseIndex >= 0) {
    state.codexToolSections.set(toolUse.id, {
      toolUseIndex,
      sectionIndex: before,
    });
  }
};

const appendCodexReasoningUsage = (
  state: StreamParserState,
  reasoningTokens: number,
): void => {
  const text =
    `Codex 내부 추론 사용량: ${reasoningTokens} tokens. ` +
    "세부 추론 텍스트는 Codex JSON 스트림에 포함되지 않았습니다.";
  if (state.parsed.thinkingText.includes(text)) return;
  const chunk = state.parsed.thinkingText.length > 0 ? `\n${text}` : text;
  state.parsed.thinkingText = capStreamText(
    state.parsed.thinkingText + chunk,
  );
  appendTextDeltaSection(state, "thinking", chunk);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
