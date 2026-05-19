import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentInvocation,
  AgentInvocationStatus,
  AgentStreamEvent,
} from "@harness/core";
import {
  feedStreamChunk,
  flushStreamParser,
  hydrateSavedAgentOutput,
  initStreamParserState,
  promoteIntermediateTextToFinal,
  recordObservedToolCall,
  setIntermediateAssistantText,
  type ParsedStream,
  type StreamParserState,
} from "./agent-stream-parser";
import {
  AgentProgressList,
  type AgentProgressItem,
} from "./AgentProgressList";
import { AgentStreamSections } from "./AgentStreamSections";

interface AgentStreamViewProps {
  invocation: AgentInvocation;
}

/**
 * Renders structured views over claude --output-format=stream-json.
 * - Live text  : text_delta tokens accumulated as they arrive
 * - Final text : `type:"result"` once produced (replaces live)
 * - Tool uses  : list of content_block_start of type tool_use
 * - Metadata   : turn summary, rate limit, cost/tokens (collapsible)
 * - Raw view   : opt-in fallback so unparsed lines stay debuggable
 */
export const AgentStreamView = ({
  invocation,
}: AgentStreamViewProps): JSX.Element => {
  const [parsed, setParsed] = useState<ParsedStream>(() =>
    initStreamParserState().parsed,
  );
  const [error, setError] = useState<{ code: string; message: string } | null>(
    null,
  );
  const [progress, setProgress] = useState<AgentProgressItem[]>([]);
  const [showRaw, setShowRaw] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
  const stateRef = useRef<StreamParserState>(initStreamParserState());

  useEffect(() => {
    stateRef.current = initStreamParserState();
    setParsed(stateRef.current.parsed);
    setError(null);
    setProgress([]);
    setShowRaw(false);
    setShowMeta(false);

    const isTerminal = isTerminalStatus(invocation.status);
    let cancelled = false;

    if (invocation.rawOutputArtifactId) {
      void window.harness.runner
        .readArtifact({ artifactId: invocation.rawOutputArtifactId })
        .then(({ content }) => {
          if (cancelled) return;
          hydrateSavedAgentOutput(stateRef.current, content, {
            terminal: isTerminal,
            ...(invocation.latencyMs !== undefined
              ? { latencyMs: invocation.latencyMs }
              : {}),
            ...(invocation.costEstimate !== undefined
              ? { costEstimate: invocation.costEstimate }
              : {}),
          });
          setParsed({ ...stateRef.current.parsed });
        })
        .catch((e) => {
          if (cancelled) return;
          setError({
            code: "ARTIFACT_READ_FAILED",
            message: e instanceof Error ? e.message : String(e),
          });
        });
    }

    const off = window.harness.events.onAgentStreamEvent(
      (event: AgentStreamEvent) => {
        if (event.invocationId !== invocation.id) return;
        if (event.type === "progress") {
          setProgress((items) => [...items, event].slice(-12));
        } else if (event.type === "raw") {
          feedStreamChunk(stateRef.current, event.text);
          // Trigger a render with a fresh object so React picks it up.
          setParsed({ ...stateRef.current.parsed });
        } else if (event.type === "tool_call") {
          recordObservedToolCall(stateRef.current, event);
          setParsed({ ...stateRef.current.parsed });
        } else if (event.type === "assistant_text") {
          setIntermediateAssistantText(stateRef.current, event.text);
          setParsed({ ...stateRef.current.parsed });
        } else if (event.type === "result") {
          flushStreamParser(stateRef.current);
          promoteIntermediateTextToFinal(stateRef.current, event);
          setParsed({ ...stateRef.current.parsed });
        } else if (event.type === "failed") {
          setError({ code: event.errorCode, message: event.message });
        }
      },
    );
    return () => {
      cancelled = true;
      flushStreamParser(stateRef.current);
      off();
    };
  }, [
    invocation.id,
    invocation.rawOutputArtifactId,
    invocation.status,
    invocation.latencyMs,
    invocation.costEstimate,
  ]);

  const status = invocation.status;
  const isTerminal = isTerminalStatus(status);
  const responseDraftText =
    parsed.intermediateText.length > 0 ? parsed.intermediateText : parsed.liveText;
  const finalText =
    parsed.finalText ??
    (isTerminal && responseDraftText.length > 0 ? responseDraftText : null);
  const hasFinalAnswer = finalText !== null;
  const hasAnyOutput =
    hasFinalAnswer ||
    parsed.sections.length > 0 ||
    parsed.progress.length > 0 ||
    parsed.intermediateText.length > 0 ||
    parsed.liveText.length > 0 ||
    parsed.thinkingText.length > 0 ||
    parsed.toolUses.length > 0 ||
    parsed.unknown.length > 0 ||
    progress.length > 0;
  const progressItems = progress.length > 0 ? progress : parsed.progress;

  const metaItems = useMemo(() => buildMetaItems(parsed), [parsed]);

  return (
    <div className="agent-stream-view" aria-label="Agent stream">
      <div className="agent-stream-view__header">
        <span className={`agent-stream-view__pill agent-stream-view__pill--${status}`}>
          {status}
        </span>
        <span className="agent-stream-view__id" title={invocation.id}>
          {invocation.id.slice(0, 16)}…
        </span>
        <span className="agent-stream-view__spacer" />
        {hasAnyOutput && (
          <button
            type="button"
            className="agent-stream-view__toggle"
            onClick={() => setShowRaw((v) => !v)}
          >
            {showRaw ? "정리됨 보기" : "원본 보기"}
          </button>
        )}
      </div>

      {error && (
        <div className="agent-stream-view__error">
          <strong>{error.code}</strong>
          <span>{error.message}</span>
        </div>
      )}

      {showRaw ? (
        <pre className="agent-stream-view__body">
          {[
            finalText ? `# result\n${finalText}` : null,
            parsed.intermediateText
              ? `# intermediate\n${parsed.intermediateText}`
              : null,
            parsed.thinkingText ? `# thinking\n${parsed.thinkingText}` : null,
            parsed.liveText ? `# live\n${parsed.liveText}` : null,
            parsed.unknown.length > 0
              ? `# unknown\n${parsed.unknown.join("\n")}`
              : null,
          ]
            .filter(Boolean)
            .join("\n\n") || "출력 없음"}
        </pre>
      ) : (
        <>
          {progressItems.length > 0 && (
            <AgentProgressList
              items={progressItems}
              terminal={isTerminal}
              terminalStatus={status}
            />
          )}

          <AgentStreamSections
            sections={parsed.sections}
            surface="panel"
            terminal={isTerminal}
            fallbackFinalText={finalText}
          />

          {!hasFinalAnswer &&
            responseDraftText.length === 0 &&
            progressItems.length === 0 &&
            parsed.sections.length === 0 &&
            parsed.thinkingText.length === 0 &&
            parsed.toolUses.length === 0 && (
              <section className="agent-stream-section">
                <div className="agent-stream-section__placeholder">
                  {status === "queued"
                    ? "큐에 대기 중…"
                    : status === "running"
                      ? "스트리밍 대기 중…"
                      : "출력 없음"}
                </div>
              </section>
            )}
          {metaItems.length > 0 && (
            <section className="agent-stream-section">
              <header
                className="agent-stream-section__head agent-stream-section__head--clickable"
                onClick={() => setShowMeta((v) => !v)}
              >
                <span className="agent-stream-section__title">
                  메타데이터 {showMeta ? "▾" : "▸"}
                </span>
              </header>
              {showMeta && (
                <dl className="agent-stream-section__meta">
                  {metaItems.map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>
          )}
        </>
      )}

      {isTerminal && parsed.resultMeta && (
        <div className="agent-stream-view__footer">
          <span>
            응답 시간 {Math.round(parsed.resultMeta.durationMs / 100) / 10}s · 도구 {parsed.toolUses.length}개
            {parsed.resultMeta.costUsd !== undefined
              ? ` · $${parsed.resultMeta.costUsd.toFixed(4)}${
                  parsed.resultMeta.costEstimateApproximate ? " approx." : ""
                }`
              : ""}
          </span>
        </div>
      )}
    </div>
  );
};

const isTerminalStatus = (status: AgentInvocationStatus): boolean =>
  status === "succeeded" || status === "failed" || status === "cancelled";

const buildMetaItems = (p: ParsedStream): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  if (p.turnSummary) {
    out.push([
      "Turn",
      `${p.turnSummary.status}${p.turnSummary.detail ? ` — ${p.turnSummary.detail}` : ""}`,
    ]);
  }
  if (p.resultMeta) {
    out.push(["Duration", `${p.resultMeta.durationMs}ms (api ${p.resultMeta.durationApiMs}ms)`]);
    if (p.resultMeta.stopReason) out.push(["Stop", p.resultMeta.stopReason]);
    if (p.resultMeta.costUsd !== undefined) {
      out.push([
        "Cost",
        `$${p.resultMeta.costUsd.toFixed(4)}${
          p.resultMeta.costEstimateApproximate ? " (approx.)" : ""
        }`,
      ]);
    }
    if (p.resultMeta.usage) {
      const u = p.resultMeta.usage;
      const parts: string[] = [];
      if (typeof u["input_tokens"] === "number") parts.push(`in=${u["input_tokens"]}`);
      if (typeof u["output_tokens"] === "number") parts.push(`out=${u["output_tokens"]}`);
      if (typeof u["total_tokens"] === "number") parts.push(`total=${u["total_tokens"]}`);
      if (typeof u["cache_read_input_tokens"] === "number")
        parts.push(`cache_read=${u["cache_read_input_tokens"]}`);
      if (parts.length > 0) {
        out.push([
          "Tokens",
          `${parts.join(" ")}${p.resultMeta.usageApproximate ? " (approx.)" : ""}`,
        ]);
      }
    }
    if (p.resultMeta.sessionId) out.push(["Session", p.resultMeta.sessionId]);
  }
  if (p.rateLimit) {
    out.push([
      "Rate limit",
      `${p.rateLimit.status}${p.rateLimit.overage ? ` (${p.rateLimit.overage})` : ""}`,
    ]);
  }
  if (p.hooks.length > 0) {
    const distinct = new Set(p.hooks.map((h) => h.name));
    out.push(["Hooks", `${distinct.size}개 (${p.hooks.length} 이벤트)`]);
  }
  return out;
};
