import { useMemo, useState } from "react";
import type {
  A2ARemoteTaskRef,
  AgentInvocation,
  Artifact,
  TaskRun,
} from "@harness/core";
import { AgentStreamView } from "./AgentStreamView";
import { InternalHandoffPanel } from "./InternalHandoffPanel";
import {
  formatRemoteTaskLabel,
  remoteTaskAttentionLabel,
  remoteTaskForInvocation,
  remoteTaskNeedsAttention,
  remoteTaskTitle,
} from "./agent-remote-task";
import { deriveInternalAgentHandoffs } from "./agent-handoff-display";
import { shouldRenderAgentPanel } from "./agent-panel-visibility";

interface AgentPanelProps {
  taskRun: TaskRun;
  invocations: AgentInvocation[]; // newest-first
  artifacts: Artifact[];
  remoteTaskRefs?: A2ARemoteTaskRef[];
  onRetry: (invocationId: string) => Promise<void>;
  onCancel: (invocationId: string) => Promise<void>;
  onUseFallback: () => Promise<void>;
  onGenerate: () => Promise<void>;
  /** When false, Generate / Retry buttons are disabled with a tooltip. */
  agentAvailable: boolean;
  /** Pending advisory approvals must be decided before prompt build. */
  pendingAdvisoryApprovals: number;
  /**
   * True when this TaskRun is being driven by orchestration (pipeline
   * pick or legacy orch mode). In that mode the user must NOT see the
   * "Agent plan 생성" button — orchestration owns the agent calls via
   * its worker steps, so the standalone agent.generatePlan path is the
   * wrong handle to pull. We still surface stream/retry/cancel for
   * individual worker invocations because each worker step DOES create
   * an AgentInvocation.
   */
  orchestrationDriven: boolean;
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
  artifacts,
  remoteTaskRefs = [],
  onRetry,
  onCancel,
  onUseFallback,
  onGenerate,
  agentAvailable,
  pendingAdvisoryApprovals,
  orchestrationDriven,
}: AgentPanelProps): JSX.Element | null => {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handoffs = useMemo(
    () => deriveInternalAgentHandoffs(artifacts),
    [artifacts],
  );

  const latest = invocations[0];
  const latestRemoteTask = latest
    ? remoteTaskForInvocation(remoteTaskRefs, latest.id)
    : null;
  // Show this panel whenever there is at least one invocation (agent
  // mode OR pipeline workers), or when the task is still in `drafting`
  // and the user can still trigger an agent plan. Orchestration-driven
  // drafting tasks that haven't spun up a worker yet show nothing —
  // the central main window already displays the live stream once a
  // worker invocation lands.
  const shouldRender = shouldRenderAgentPanel({
    taskRunStatus: taskRun.status,
    invocationCount: invocations.length,
    handoffCount: handoffs.length,
    orchestrationDriven,
  });
  if (!shouldRender) return null;

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
      // drafting state, no invocation yet. Suppress the explicit
      // "Agent plan 생성" button when the run is orchestration-driven —
      // that's the wrong handle for pipelines (the worker auto-runs).
      if (orchestrationDriven) {
        return (
          <span className="agent-panel__hint">
            파이프라인 / 오케스트레이션이 워커 호출을 자동 실행합니다.
          </span>
        );
      }
      if (pendingAdvisoryApprovals > 0) {
        return (
          <span className="agent-panel__hint">
            추천 후보 {pendingAdvisoryApprovals}건의 승인/거절을 기다리는 중입니다.
          </span>
        );
      }
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
            title="CLI를 쓰지 않는 기본 plan으로 전환"
          >
            {busy === "fallback" ? "기본 plan 전환 중…" : "기본 plan 전환"}
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
            {latestRemoteTask && (
              <span
                className={`agent-panel__remote${
                  remoteTaskNeedsAttention(latestRemoteTask)
                    ? " agent-panel__remote--attention"
                    : ""
                }`}
                title={[
                  remoteTaskAttentionLabel(latestRemoteTask),
                  remoteTaskTitle(latestRemoteTask),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              >
                {formatRemoteTaskLabel(latestRemoteTask)}
              </span>
            )}
          </span>
        )}
      </header>
      <div className="panel-body panel-body--compact">
        {latest ? (
          <AgentStreamView invocation={latest} />
        ) : (
          <div className="empty-state">
            Agent mode TaskRun입니다. 계획을 생성하려면 아래 버튼을 누르세요.
          </div>
        )}
        <InternalHandoffPanel handoffs={handoffs} />
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
                  {(() => {
                    const remote = remoteTaskForInvocation(remoteTaskRefs, inv.id);
                    return remote ? ` · ${formatRemoteTaskLabel(remote)}` : "";
                  })()}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
};
