import { useEffect, useRef, useState } from "react";
import type { AgentInvocation, AgentStreamEvent } from "@harness/core";
import {
  feedStreamChunk,
  flushStreamParser,
  hydrateSavedAgentOutput,
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
import { AgentStreamSections } from "./AgentStreamSections";

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
  const [progress, setProgress] = useState<AgentProgressItem[]>([]);
  const stateRef = useRef<StreamParserState>(initStreamParserState());

  useEffect(() => {
    stateRef.current = initStreamParserState();
    setParsed(stateRef.current.parsed);
    setError(null);
    setProgress([]);

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

  const isRunning =
    invocation.status === "queued" || invocation.status === "running";
  const isTerminal = isTerminalStatus(invocation.status);
  const responseDraftText =
    parsed.intermediateText.length > 0 ? parsed.intermediateText : parsed.liveText;
  const finalText =
    parsed.finalText ??
    (isTerminal && responseDraftText.length > 0 ? responseDraftText : null);
  const hasFinalAnswer = finalText !== null;
  const hasAnyOutput =
    hasFinalAnswer ||
    parsed.sections.length > 0 ||
    parsed.intermediateText.length > 0 ||
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

      {!hasAnyOutput && progress.length === 0 && (
        <div className="inline-agent-stream__placeholder">
          {isRunning ? "에이전트 응답 대기 중…" : "출력 없음"}
        </div>
      )}

      {progress.length > 0 && (
        <AgentProgressList
          items={progress}
          compact
          terminal={isTerminal}
        />
      )}

      <AgentStreamSections
        sections={parsed.sections}
        surface="inline"
        terminal={isTerminal}
        fallbackFinalText={finalText}
      />
    </div>
  );
};

const isTerminalStatus = (status: AgentInvocation["status"]): boolean =>
  status === "succeeded" || status === "failed" || status === "cancelled";
