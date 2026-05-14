import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentInvocationStatus,
  AgentStreamEvent,
} from "@harness/core";
import {
  feedStreamChunk,
  flushStreamParser,
  initStreamParserState,
  promoteIntermediateTextToFinal,
  setIntermediateAssistantText,
  type ParsedStream,
  type StreamParserState,
} from "./agent-stream-parser";
import {
  AgentProgressList,
  type AgentProgressItem,
} from "./AgentProgressList";

interface AgentStreamViewProps {
  invocationId: string;
  status: AgentInvocationStatus;
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
  invocationId,
  status,
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
  const liveBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    stateRef.current = initStreamParserState();
    setParsed(stateRef.current.parsed);
    setError(null);
    setProgress([]);
    setShowRaw(false);
    setShowMeta(false);

    const off = window.harness.events.onAgentStreamEvent(
      (event: AgentStreamEvent) => {
        if (event.invocationId !== invocationId) return;
        if (event.type === "progress") {
          setProgress((items) => [...items, event].slice(-12));
        } else if (event.type === "raw") {
          feedStreamChunk(stateRef.current, event.text);
          // Trigger a render with a fresh object so React picks it up.
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
      flushStreamParser(stateRef.current);
      off();
    };
  }, [invocationId]);

  useEffect(() => {
    if (liveBoxRef.current) {
      liveBoxRef.current.scrollTop = liveBoxRef.current.scrollHeight;
    }
  }, [parsed.liveText, parsed.intermediateText, parsed.finalText]);

  const isTerminal =
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled";
  const responseDraftText =
    parsed.intermediateText.length > 0 ? parsed.intermediateText : parsed.liveText;
  const finalText =
    parsed.finalText ??
    (isTerminal && responseDraftText.length > 0 ? responseDraftText : null);
  const hasFinalAnswer = finalText !== null;
  const hasAnyOutput =
    hasFinalAnswer ||
    parsed.intermediateText.length > 0 ||
    parsed.liveText.length > 0 ||
    parsed.thinkingText.length > 0 ||
    parsed.toolUses.length > 0 ||
    parsed.unknown.length > 0 ||
    progress.length > 0;

  const metaItems = useMemo(() => buildMetaItems(parsed), [parsed]);

  return (
    <div className="agent-stream-view" aria-label="Agent stream">
      <div className="agent-stream-view__header">
        <span className={`agent-stream-view__pill agent-stream-view__pill--${status}`}>
          {status}
        </span>
        <span className="agent-stream-view__id" title={invocationId}>
          {invocationId.slice(0, 16)}…
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
          {progress.length > 0 && (
            <AgentProgressList items={progress} />
          )}

          {parsed.thinkingText.length > 0 && (
            <section className="agent-stream-section agent-stream-section--thinking">
              <header className="agent-stream-section__head">
                <span className="agent-stream-section__title">생각</span>
              </header>
              <div className="agent-stream-section__thinking">
                {parsed.thinkingText}
              </div>
            </section>
          )}

          {parsed.toolUses.length > 0 && (
            <section className="agent-stream-section">
              <header className="agent-stream-section__head">
                <span className="agent-stream-section__title">
                  명령어 / 도구 호출 ({parsed.toolUses.length})
                </span>
              </header>
              <ul className="agent-stream-section__tools">
                {parsed.toolUses.map((t, i) => (
                  <li key={`${t.name}-${i}`}>
                    <code>{t.name}</code>
                    {t.input ? (
                      <span className="agent-stream-section__tool-input">
                        {JSON.stringify(t.input).slice(0, 120)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!hasFinalAnswer && responseDraftText.length > 0 ? (
            <section className="agent-stream-section">
              <header className="agent-stream-section__head">
                <span className="agent-stream-section__title">
                  중간 답변 / 응답 작성 중
                </span>
              </header>
              <div ref={liveBoxRef} className="agent-stream-section__live">
                {responseDraftText}
              </div>
            </section>
          ) : null}

          {finalText !== null && (
            <section className="agent-stream-section">
              <header className="agent-stream-section__head">
                <span className="agent-stream-section__title">최종 답변</span>
              </header>
              <pre className="agent-stream-section__final">{finalText}</pre>
            </section>
          )}

          {!hasFinalAnswer &&
            responseDraftText.length === 0 &&
            progress.length === 0 &&
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
              ? ` · $${parsed.resultMeta.costUsd.toFixed(4)}`
              : ""}
          </span>
        </div>
      )}
    </div>
  );
};

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
    if (p.resultMeta.costUsd !== undefined) out.push(["Cost", `$${p.resultMeta.costUsd.toFixed(4)}`]);
    if (p.resultMeta.usage) {
      const u = p.resultMeta.usage;
      const parts: string[] = [];
      if (typeof u["input_tokens"] === "number") parts.push(`in=${u["input_tokens"]}`);
      if (typeof u["output_tokens"] === "number") parts.push(`out=${u["output_tokens"]}`);
      if (typeof u["cache_read_input_tokens"] === "number")
        parts.push(`cache_read=${u["cache_read_input_tokens"]}`);
      if (parts.length > 0) out.push(["Tokens", parts.join(" ")]);
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
