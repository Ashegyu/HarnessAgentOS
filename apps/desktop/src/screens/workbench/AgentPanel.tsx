import { useMemo, useState } from "react";
import type {
  A2ARemoteTaskRef,
  A2ARefinementAttempt,
  AgentInvocation,
  Artifact,
  PipelineBackflowAttempt,
  Step,
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
import {
  describeAgentInvocationForDisplay,
  orderedAgentInvocationsForDisplay,
} from "./agent-invocation-display";
import { FeatureHelpButton } from "./FeatureHelpButton";

interface AgentPanelProps {
  taskRun: TaskRun;
  invocations: AgentInvocation[]; // newest-first
  steps: Step[];
  artifacts: Artifact[];
  remoteTaskRefs?: A2ARemoteTaskRef[];
  refinementAttempts?: A2ARefinementAttempt[];
  pipelineBackflowAttempts?: PipelineBackflowAttempt[];
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
  steps,
  artifacts,
  remoteTaskRefs = [],
  refinementAttempts = [],
  pipelineBackflowAttempts = [],
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
  const displayInvocations = useMemo(
    () => orderedAgentInvocationsForDisplay(invocations),
    [invocations],
  );

  const activeInvocation =
    [...displayInvocations]
      .reverse()
      .find((inv) => inv.status === "queued" || inv.status === "running") ??
    displayInvocations[displayInvocations.length - 1];
  const activeRemoteTask = activeInvocation
    ? remoteTaskForInvocation(remoteTaskRefs, activeInvocation.id)
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
    if (!activeInvocation) {
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
      activeInvocation.status === "queued" ||
      activeInvocation.status === "running";
    const canRetry =
      activeInvocation.status === "failed" ||
      activeInvocation.status === "cancelled";
    return (
      <>
        {canCancel && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void handle("cancel", () => onCancel(activeInvocation.id))
            }
          >
            {busy === "cancel" ? "취소 중…" : "취소"}
          </button>
        )}
        {canRetry && (
          <button
            type="button"
            disabled={!agentAvailable || busy !== null}
            onClick={() =>
              void handle("retry", () => onRetry(activeInvocation.id))
            }
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
        <span className="panel-header__title">
          Agent
          <FeatureHelpButton featureId="agentPlan" />
        </span>
        {activeInvocation && (
          <span className="agent-panel__meta">
            {displayInvocations.length > 1
              ? `${displayInvocations.length} invocations`
              : `${activeInvocation.provider}:${activeInvocation.model} · ${formatLatency(
                  activeInvocation.latencyMs,
                )}`}
            {activeRemoteTask && (
              <span
                className={`agent-panel__remote${
                  remoteTaskNeedsAttention(activeRemoteTask)
                    ? " agent-panel__remote--attention"
                    : ""
                }`}
                title={[
                  remoteTaskAttentionLabel(activeRemoteTask),
                  remoteTaskTitle(activeRemoteTask),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              >
                {formatRemoteTaskLabel(activeRemoteTask)}
              </span>
            )}
          </span>
        )}
      </header>
      <div className="panel-body panel-body--compact">
        {displayInvocations.length > 0 ? (
          <div className="agent-panel__streams">
            {displayInvocations.map((invocation, index) => {
              const remote = remoteTaskForInvocation(remoteTaskRefs, invocation.id);
              return (
                <section key={invocation.id} className="agent-panel__stream">
                  <AgentAnswerLabel
                    invocation={invocation}
                    steps={steps}
                    ordinal={index + 1}
                  />
                  {remote ? (
                    <div
                      className={`agent-panel__stream-meta${
                        remoteTaskNeedsAttention(remote)
                          ? " agent-panel__stream-meta--attention"
                          : ""
                      }`}
                      title={[
                        remoteTaskAttentionLabel(remote),
                        remoteTaskTitle(remote),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    >
                      {formatRemoteTaskLabel(remote)}
                    </div>
                  ) : null}
                  <AgentStreamView invocation={invocation} />
                  {invocation.errorCode && invocation.status !== "succeeded" && (
                    <div className="agent-panel__error">
                      <strong>{invocation.errorCode}</strong>
                      <span>{invocation.errorMessage}</span>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        ) : (
          <div className="empty-state">
            Agent mode TaskRun입니다. 계획을 생성하려면 아래 버튼을 누르세요.
          </div>
        )}
        <InternalHandoffPanel handoffs={handoffs} />
        <A2ARefinementAttemptPanel attempts={refinementAttempts} />
        <PipelineBackflowAttemptPanel attempts={pipelineBackflowAttempts} />
        <div className="agent-panel__actions">{renderControls()}</div>
        {error && <div className="agent-panel__error">{error}</div>}
      </div>
    </section>
  );
};

const PipelineBackflowAttemptPanel = ({
  attempts,
}: {
  attempts: readonly PipelineBackflowAttempt[];
}): JSX.Element | null => {
  if (attempts.length === 0) return null;
  return (
    <section className="internal-handoff-panel" aria-label="Pipeline backflow attempts">
      <header className="internal-handoff-panel__header">
        <strong>Pipeline backflow</strong>
        <span>{attempts.length}</span>
      </header>
      <div className="internal-handoff-panel__list">
        {attempts.map((attempt) => (
          <article key={attempt.id} className="internal-handoff-panel__item">
            <div className="internal-handoff-panel__route">
              <span>{attempt.ruleId}</span>
              <span>{attempt.trigger}</span>
              <span>
                {attempt.targetStepId} → {attempt.retryStepId}
              </span>
            </div>
            <div className="internal-handoff-panel__meta">
              attempt {attempt.attemptIndex + 1}/{attempt.maxAttempts} ·{" "}
              {attempt.status}
              {attempt.reason ? ` · ${attempt.reason}` : ""}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
};

const A2ARefinementAttemptPanel = ({
  attempts,
}: {
  attempts: readonly A2ARefinementAttempt[];
}): JSX.Element | null => {
  if (attempts.length === 0) return null;
  return (
    <section className="internal-handoff-panel">
      <header className="internal-handoff-panel__header">
        <strong>A2A refinements</strong>
        <span>{attempts.length}</span>
      </header>
      <div className="internal-handoff-panel__list">
        {attempts.map((attempt) => (
          <article key={attempt.id} className="internal-handoff-panel__item">
            <div className="internal-handoff-panel__route">
              <span>{attempt.feedbackSourceKind}</span>
              <span>→</span>
              <span>{attempt.targetInvocationId}</span>
            </div>
            <div className="internal-handoff-panel__meta">
              attempt {attempt.attemptIndex} · {attempt.status}
              {attempt.remoteTaskId ? ` · ${attempt.remoteTaskId}` : ""}
              {attempt.stopReason ? ` · ${attempt.stopReason}` : ""}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
};

const AgentAnswerLabel = ({
  invocation,
  steps,
  ordinal,
}: {
  invocation: AgentInvocation;
  steps: readonly Step[];
  ordinal: number;
}): JSX.Element => {
  const display = describeAgentInvocationForDisplay(invocation, steps);
  return (
    <header className="agent-answer-label agent-answer-label--panel">
      <div className="agent-answer-label__main">
        <span className="agent-answer-label__caption">Agent {ordinal}</span>
        <strong>{display.agentName}</strong>
        <code>{display.providerLabel}</code>
      </div>
      <span className="agent-answer-label__detail" title={display.detail}>
        {display.detail}
      </span>
    </header>
  );
};
