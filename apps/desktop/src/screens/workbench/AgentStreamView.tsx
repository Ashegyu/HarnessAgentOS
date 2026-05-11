import { useEffect, useRef, useState } from "react";
import type {
  AgentInvocationStatus,
  AgentStreamEvent,
} from "@harness/core";

interface AgentStreamViewProps {
  invocationId: string;
  /** Current persisted status — used to decide between live / terminal. */
  status: AgentInvocationStatus;
}

/**
 * Phase 8 — subscribes to `window.harness.events.onAgentStreamEvent`,
 * filters by invocationId, accumulates raw chunks, and replaces with
 * the final assistant_text when the stream reports `result`. Cleans
 * up its subscription when invocationId changes.
 */
export const AgentStreamView = ({
  invocationId,
  status,
}: AgentStreamViewProps): JSX.Element => {
  const [chunks, setChunks] = useState<string>("");
  const [final, setFinal] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(
    null,
  );
  const bottomRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    setChunks("");
    setFinal(null);
    setError(null);
    const off = window.harness.events.onAgentStreamEvent(
      (event: AgentStreamEvent) => {
        if (event.invocationId !== invocationId) return;
        if (event.type === "raw") {
          setChunks((prev) => prev + event.text);
        } else if (event.type === "assistant_text") {
          setFinal(event.text);
        } else if (event.type === "failed") {
          setError({ code: event.errorCode, message: event.message });
        }
      },
    );
    return off;
  }, [invocationId]);

  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollTop = bottomRef.current.scrollHeight;
    }
  }, [chunks, final]);

  const isTerminal =
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled";
  const display = final ?? chunks;

  return (
    <div className="agent-stream-view" aria-label="Agent stream">
      <div className="agent-stream-view__header">
        <span className={`agent-stream-view__pill agent-stream-view__pill--${status}`}>
          {status}
        </span>
        <span className="agent-stream-view__id" title={invocationId}>
          {invocationId.slice(0, 16)}…
        </span>
      </div>
      <pre
        ref={bottomRef}
        className="agent-stream-view__body"
        aria-live={isTerminal ? "off" : "polite"}
      >
        {display.length === 0 && !error ? (
          <span className="agent-stream-view__placeholder">
            {status === "queued"
              ? "큐에 대기 중…"
              : status === "running"
                ? "스트리밍 대기 중…"
                : "출력 없음"}
          </span>
        ) : (
          display
        )}
      </pre>
      {error && (
        <div className="agent-stream-view__error">
          <strong>{error.code}</strong>
          <span>{error.message}</span>
        </div>
      )}
    </div>
  );
};
