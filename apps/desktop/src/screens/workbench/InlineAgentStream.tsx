import { useEffect, useRef, useState } from "react";
import type { AgentInvocation, AgentStreamEvent } from "@harness/core";
import {
  feedStreamChunk,
  flushStreamParser,
  initStreamParserState,
  setFinalAssistantText,
  type ParsedStream,
  type StreamParserState,
} from "./agent-stream-parser";

interface InlineAgentStreamProps {
  /**
   * Latest invocation for the currently-active TaskRun. The component
   * subscribes to events filtered by `invocation.id` and rebuilds parser
   * state from scratch whenever the id changes.
   */
  invocation: AgentInvocation;
}

/**
 * Compact, chat-bubble-friendly streaming view scoped to one
 * AgentInvocation. Splits output into four visually distinct sections so
 * the user can tell at a glance which part is the model thinking, which
 * part is a tool/command call, which part is the in-flight answer being
 * typed, and which part is the final committed answer.
 *
 * Designed for inline use in `ChatTranscript` next to a `chat-turn` —
 * the full-fidelity right-panel `AgentStreamView` is the source of truth
 * for raw / metadata / collapsed views.
 */
export const InlineAgentStream = ({
  invocation,
}: InlineAgentStreamProps): JSX.Element => {
  const [parsed, setParsed] = useState<ParsedStream>(
    () => initStreamParserState().parsed,
  );
  const [error, setError] = useState<{ code: string; message: string } | null>(
    null,
  );
  const stateRef = useRef<StreamParserState>(initStreamParserState());
  const liveBoxRef = useRef<HTMLDivElement | null>(null);
  const thinkingBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    stateRef.current = initStreamParserState();
    setParsed(stateRef.current.parsed);
    setError(null);

    const off = window.harness.events.onAgentStreamEvent(
      (event: AgentStreamEvent) => {
        if (event.invocationId !== invocation.id) return;
        if (event.type === "raw") {
          feedStreamChunk(stateRef.current, event.text);
          setParsed({ ...stateRef.current.parsed });
        } else if (event.type === "assistant_text") {
          setFinalAssistantText(stateRef.current, event.text);
          setParsed({ ...stateRef.current.parsed });
        } else if (event.type === "result") {
          flushStreamParser(stateRef.current);
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
  }, [invocation.id]);

  // Auto-scroll the two streaming sections so the most-recent content
  // stays visible while the model is still emitting tokens.
  useEffect(() => {
    if (liveBoxRef.current) {
      liveBoxRef.current.scrollTop = liveBoxRef.current.scrollHeight;
    }
  }, [parsed.liveText]);
  useEffect(() => {
    if (thinkingBoxRef.current) {
      thinkingBoxRef.current.scrollTop = thinkingBoxRef.current.scrollHeight;
    }
  }, [parsed.thinkingText]);

  const isRunning =
    invocation.status === "queued" || invocation.status === "running";
  const hasAnyOutput =
    parsed.finalText !== null ||
    parsed.liveText.length > 0 ||
    parsed.thinkingText.length > 0 ||
    parsed.toolUses.length > 0;

  return (
    <div className="inline-agent-stream" aria-label="Agent stream">
      <div className="inline-agent-stream__header">
        <span
          className={`inline-agent-stream__pill inline-agent-stream__pill--${invocation.status}`}
        >
          {invocation.status}
        </span>
        <span className="inline-agent-stream__id" title={invocation.id}>
          {invocation.provider} · {invocation.model}
        </span>
      </div>

      {error && (
        <div className="inline-agent-stream__error">
          <strong>{error.code}</strong>
          <span>{error.message}</span>
        </div>
      )}

      {!hasAnyOutput && (
        <div className="inline-agent-stream__placeholder">
          {isRunning ? "에이전트 응답 대기 중…" : "출력 없음"}
        </div>
      )}

      {parsed.thinkingText.length > 0 && (
        <section className="inline-agent-stream__section inline-agent-stream__section--thinking">
          <header className="inline-agent-stream__head">
            <span className="inline-agent-stream__icon" aria-hidden>
              ✦
            </span>
            <span className="inline-agent-stream__title">생각</span>
          </header>
          <div
            ref={thinkingBoxRef}
            className="inline-agent-stream__thinking"
          >
            {parsed.thinkingText}
          </div>
        </section>
      )}

      {parsed.toolUses.length > 0 && (
        <section className="inline-agent-stream__section inline-agent-stream__section--tool">
          <header className="inline-agent-stream__head">
            <span className="inline-agent-stream__icon" aria-hidden>
              ▷
            </span>
            <span className="inline-agent-stream__title">
              명령어 ({parsed.toolUses.length})
            </span>
          </header>
          <ul className="inline-agent-stream__tools">
            {parsed.toolUses.map((t, i) => (
              <li key={`${t.name}-${i}`}>
                <code>{t.name}</code>
                {t.input ? (
                  <span className="inline-agent-stream__tool-input">
                    {JSON.stringify(t.input).slice(0, 160)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {parsed.finalText === null && parsed.liveText.length > 0 && (
        <section className="inline-agent-stream__section inline-agent-stream__section--live">
          <header className="inline-agent-stream__head">
            <span className="inline-agent-stream__icon" aria-hidden>
              …
            </span>
            <span className="inline-agent-stream__title">
              응답 작성 중
            </span>
          </header>
          <div ref={liveBoxRef} className="inline-agent-stream__live">
            {parsed.liveText}
          </div>
        </section>
      )}

      {parsed.finalText !== null && (
        <section className="inline-agent-stream__section inline-agent-stream__section--final">
          <header className="inline-agent-stream__head">
            <span className="inline-agent-stream__icon" aria-hidden>
              ✓
            </span>
            <span className="inline-agent-stream__title">최종 답변</span>
          </header>
          <pre className="inline-agent-stream__final">{parsed.finalText}</pre>
        </section>
      )}
    </div>
  );
};
