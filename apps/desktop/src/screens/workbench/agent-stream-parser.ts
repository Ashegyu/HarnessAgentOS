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
  intermediateText: "",
  liveText: "",
  thinkingText: "",
  toolUses: [],
  sections: [],
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
  hooks: [],
  unknown: [],
});

export interface StreamParserState {
  /** Bytes accumulated but not yet terminated by a newline. */
  pending: string;
  /** Parsed accumulator. */
  parsed: ParsedStream;
  /** Tracks in-progress tool_use input JSON: blockIndex → parsed indexes + accumulated partial_json */
  pendingToolInputs: Map<
    number,
    { toolUseIndex: number; sectionIndex: number; json: string }
  >;
  /** Confirmed final text extracted from structured agent-plan output. */
  pendingFinalText: string | null;
  /** Monotonic id source for chronological render sections. */
  nextSectionId: number;
}

export const initStreamParserState = (): StreamParserState => ({
  pending: "",
  parsed: emptyParsedStream(),
  pendingToolInputs: new Map(),
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

export const promoteIntermediateTextToFinal = (
  state: StreamParserState,
  meta?: { latencyMs?: number; costEstimate?: number },
): StreamParserState => {
  const parsed = state.parsed;
  if (parsed.finalText === null) {
    const text = state.pendingFinalText ??
      (parsed.intermediateText.length > 0 ? parsed.intermediateText : parsed.liveText);
    if (text.length > 0) {
      const finalText = normalizeAssistantDisplayText(text);
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
    ...(parsed.resultMeta?.usage ? { usage: parsed.resultMeta.usage } : {}),
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
    parsed.unknown.push(line);
    return;
  }
  const type = obj["type"];
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
        if (blockIndex >= 0) {
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
        parsed.liveText += text;
        appendTextDeltaSection(state, "response", text, "live");
      } else if (delta && delta["type"] === "thinking_delta" && typeof delta["thinking"] === "string") {
        // Extended thinking block — accumulated separately so the UI can
        // render the model's reasoning in its own section.
        const thinking = delta["thinking"] as string;
        parsed.thinkingText += thinking;
        appendTextDeltaSection(state, "thinking", thinking);
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
  if (ingestCodexLine(state, obj)) return;
  parsed.unknown.push(line);
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
  parsed.resultMeta !== null;

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
    state.parsed.intermediateText = text;
    appendResponseSnapshotSection(state, text, "intermediate");
    return;
  }
  state.parsed.intermediateText = plan.prose || plan.summary;
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
    state.parsed.finalText = text;
    appendFinalSection(state, text);
    return;
  }
  if (state.parsed.intermediateText.length === 0) {
    state.parsed.intermediateText = plan.prose || plan.summary;
    appendUniqueResponseSnapshotSection(
      state,
      state.parsed.intermediateText,
      "intermediate",
    );
  }
  applyHarnessAgentPlanDisplay(state, plan);
  state.parsed.finalText = plan.summary;
  appendFinalSection(state, plan.summary);
};

const applyHarnessAgentPlanDisplay = (
  state: StreamParserState,
  plan: HarnessAgentPlanDisplay,
): void => {
  state.pendingFinalText = plan.summary;
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
  const questions = stringArray(plan["questions"]);
  if (questions.length > 0) {
    sections.push(["확인 질문", ...questions.map((q) => `- ${q}`)].join("\n"));
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
  const trimmed = text.trim();
  if (trimmed.length === 0 || parsed.thinkingText.includes(trimmed)) return;
  parsed.thinkingText = parsed.thinkingText.length > 0
    ? `${parsed.thinkingText}\n\n${trimmed}`
    : trimmed;
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
      last.text += text;
      return;
    }
    sections.push({ id: nextSectionId(state), kind: "thinking", text });
    return;
  }
  if (last?.kind === "response" && last.phase === phase) {
    last.text += text;
    return;
  }
  sections.push({ id: nextSectionId(state), kind: "response", phase, text });
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
  if (last?.kind === "response" && last.phase === phase) {
    last.text = text;
    return;
  }
  sections.push({ id: nextSectionId(state), kind: "response", phase, text });
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
  const toolUseIndex = parsed.toolUses.length;
  parsed.toolUses.push(toolUse);
  parsed.sections.push({
    id: nextSectionId(state),
    kind: "tool",
    name: toolUse.name,
    input: toolUse.input,
  });
  return toolUseIndex;
};

const appendFinalSection = (
  state: StreamParserState,
  text: string | null,
): void => {
  if (text === null || text.trim().length === 0) return;
  const sections = state.parsed.sections;
  const last = sections[sections.length - 1];
  if (last?.kind === "final") {
    last.text = text;
    return;
  }
  const exists = sections.some(
    (section) => section.kind === "final" && section.text.trim() === text.trim(),
  );
  if (!exists) {
    sections.push({ id: nextSectionId(state), kind: "final", text });
  }
};

const nextSectionId = (state: StreamParserState): string =>
  `stream-section-${state.nextSectionId++}`;

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];

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
    parsed.resultMeta = {
      isError: false,
      durationMs: 0,
      durationApiMs: 0,
    };
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
    appendToolUseSection(state, toolUse);
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

const extractCodexToolUse = (
  obj: Record<string, unknown>,
): { name: string; input: unknown } | null => {
  const candidate = isRecord(obj["item"]) ? obj["item"] : obj;
  const type = typeof candidate["type"] === "string" ? candidate["type"] : "";
  if (
    !type.includes("tool") &&
    !type.includes("function_call") &&
    !type.includes("local_shell_call")
  ) {
    return null;
  }
  const name =
    typeof candidate["name"] === "string"
      ? (candidate["name"] as string)
      : typeof candidate["tool_name"] === "string"
        ? (candidate["tool_name"] as string)
        : type || "tool";
  const input =
    candidate["input"] ??
    candidate["arguments"] ??
    candidate["args"] ??
    candidate["command"] ??
    null;
  return { name, input };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
