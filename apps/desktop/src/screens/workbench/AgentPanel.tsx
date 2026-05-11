import { useState } from "react";
import type { AgentInvocation, TaskRun } from "@harness/core";
import { AgentStreamView } from "./AgentStreamView";

interface AgentPanelProps {
  taskRun: TaskRun;
  invocations: AgentInvocation[]; // newest-first
  onRetry: (invocationId: string) => Promise<void>;
  onCancel: (invocationId: string) => Promise<void>;
  onUseFallback: () => Promise<void>;
  onGenerate: () => Promise<void>;
  /** When false, Generate / Retry buttons are disabled with a tooltip. */
  agentAvailable: boolean;
}

const formatLatency = (ms: number | undefined): string => {
  if (typeof ms !== "number") return "—";
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

/**
 * Phase 8 — top-of-Plan-tab inline panel. Renders for any TaskRun that
 * has at least one AgentInvocation row OR whose status is `drafting`
 * (i.e. agent mode placeholder still waiting on generatePlan).
 */
export const AgentPanel = ({
  taskRun,
  invocations,
  onRetry,
  onCancel,
  onUseFallback,
  onGenerate,
  agentAvailable,
}: AgentPanelProps): JSX.Element | null => {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const latest = invocations[0];
  const isAgentMode = invocations.length > 0 || taskRun.status === "drafting";
  if (!isAgentMode) return null;

  const handle = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const renderControls = (): JSX.Element => {
    if (!latest) {
      // drafting state, no invocation yet
      return (
        <button
          type="button"
          disabled={!agentAvailable || busy !== null}
          onClick={() => void handle("generate", onGenerate)}
          title={agentAvailable ? "" : "CLI provider 미설치 또는 미인증"}
        >
          {busy === "generate" ? "계획 생성 중…" : "Agent plan 생성"}
        </button>
      );
    }
    const canCancel =
      latest.status === "queued" || latest.status === "running";
    const canRetry =
      latest.status === "failed" || latest.status === "cancelled";
    return (
      <>
        {canCancel && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void handle("cancel", () => onCancel(latest.id))}
          >
            {busy === "cancel" ? "취소 중…" : "취소"}
          </button>
        )}
        {canRetry && (
          <button
            type="button"
            disabled={!agentAvailable || busy !== null}
            onClick={() => void handle("retry", () => onRetry(latest.id))}
          >
            {busy === "retry" ? "재시도 중…" : "재시도"}
          </button>
        )}
        {(canRetry || taskRun.status === "blocked") && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void handle("fallback", onUseFallback)}
            title="템플릿 기반 plan으로 fallback (CLI 사용 안 함)"
          >
            {busy === "fallback" ? "템플릿 전환 중…" : "Template fallback"}
          </button>
        )}
      </>
    );
  };

  return (
    <section className="agent-panel" aria-label="Agent invocation">
      <header className="panel-header panel-header--inset">
        <span>Agent</span>
        {latest && (
          <span className="agent-panel__meta">
            {latest.provider}:{latest.model} · {formatLatency(latest.latencyMs)}
          </span>
        )}
      </header>
      <div className="panel-body panel-body--compact">
        {latest ? (
          <AgentStreamView invocationId={latest.id} status={latest.status} />
        ) : (
          <div className="empty-state">
            Agent mode TaskRun입니다. 계획을 생성하려면 아래 버튼을 누르세요.
          </div>
        )}
        {latest?.errorCode && latest.status !== "succeeded" && (
          <div className="agent-panel__error">
            <strong>{latest.errorCode}</strong>
            <span>{latest.errorMessage}</span>
          </div>
        )}
        <div className="agent-panel__actions">{renderControls()}</div>
        {error && <div className="agent-panel__error">{error}</div>}
        {invocations.length > 1 && (
          <details className="agent-panel__history">
            <summary>이전 invocation ({invocations.length - 1})</summary>
            <ul>
              {invocations.slice(1).map((inv) => (
                <li key={inv.id}>
                  <code>{inv.id.slice(0, 16)}…</code> · {inv.status} ·{" "}
                  {formatLatency(inv.latencyMs)}
                  {inv.errorCode ? ` · ${inv.errorCode}` : ""}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
};
