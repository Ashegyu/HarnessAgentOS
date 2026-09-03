import { useCallback, useEffect, useState } from "react";
import type {
  Approval,
  AutoApproveDecision,
  ProposedActionDetails,
  TaskRunDetail,
} from "@harness/core";
import { AgentPanel } from "./AgentPanel";
import { AgentTopologyPanel } from "./AgentTopologyPanel";
import { ApprovalPanel } from "./ApprovalPanel";
import { PlanArtifactView } from "./PlanArtifactView";
import { TaskRunTimeline } from "./TaskRunTimeline";
import { ArtifactPanel } from "./ArtifactPanel";
import { QualityPanel } from "./QualityPanel";
import { CostPanel } from "./CostPanel";
import { DecisionsPanel } from "./DecisionsPanel";
import { OrchestrationPanel } from "./OrchestrationPanel";
import { TaskRunStateActions } from "./TaskRunStateActions";
import { FeatureHelpButton } from "./FeatureHelpButton";
import {
  WorkbenchIcon,
  type WorkbenchIconName,
} from "./WorkbenchIcon";

type TaskRunDetailState =
  | { kind: "idle" }
  | { kind: "loading"; taskRunId: string }
  | { kind: "ready"; detail: TaskRunDetail }
  | { kind: "error"; taskRunId: string; message: string };

export type RightPanelTab =
  | "plan"
  | "agent"
  | "graph"
  | "timeline"
  | "artifacts"
  | "quality"
  | "orchestration"
  | "cost"
  | "decisions";

// `label` is the short string baked into the icon column; `tooltip` carries
// the full meaning for the hover bubble (and for screen readers via title).
const TABS: ReadonlyArray<{
  id: RightPanelTab;
  label: string;
  tooltip: string;
  icon: WorkbenchIconName;
}> = [
  { id: "plan", label: "Plan", tooltip: "Plan", icon: "plan" },
  { id: "agent", label: "Agent", tooltip: "Agent", icon: "agent" },
  { id: "graph", label: "Graph", tooltip: "Agent Graph", icon: "graph" },
  { id: "timeline", label: "Time", tooltip: "Timeline", icon: "timeline" },
  { id: "artifacts", label: "Files", tooltip: "Artifacts", icon: "files" },
  { id: "quality", label: "QA", tooltip: "Quality", icon: "quality" },
  { id: "orchestration", label: "Orch", tooltip: "Orchestration", icon: "orchestration" },
  { id: "cost", label: "Cost", tooltip: "Cost", icon: "cost" },
  { id: "decisions", label: "Decs", tooltip: "Decisions", icon: "decisions" },
];

interface RightPanelProps {
  state: TaskRunDetailState;
  onApprove: (input: {
    approvalId: string;
    message?: string;
    scope?: "once" | "run_action_class";
  }) => Promise<void>;
  onReject: (input: { approvalId: string; message: string }) => Promise<void>;
  onRedirect: (input: { instruction: string }) => Promise<void>;
  onConfigure: (input: {
    approvalId: string;
    details: ProposedActionDetails;
  }) => Promise<void>;
  onExecute: (input: { approvalId: string }) => Promise<void>;
  onQualityChanged: () => Promise<void>;
  onAgentGenerate: (taskRunId: string) => Promise<void>;
  onAgentRetry: (invocationId: string) => Promise<void>;
  onAgentCancel: (invocationId: string) => Promise<void>;
  onAgentUseFallback: (taskRunId: string) => Promise<void>;
  agentAvailable: boolean;
  activeTab: RightPanelTab;
  onActiveTabChange: (tab: RightPanelTab) => void;
  /**
   * True when this TaskRun was created by picking a pipeline at submit
   * time. The pipeline pick IS the user's consent, so AgentPanel must
   * hide the "Agent plan 생성" button regardless of whether the
   * `orchestration_plan` approval row has landed yet. Without this
   * signal, AgentPanel briefly renders the manual button between
   * `setSelectedTaskRunId` and the eventual `taskRunChanged` event
   * that carries the new approval.
   */
  pipelineAutoLaunched: boolean;
  getPipelineAutoDecision?: (approval: Approval) => AutoApproveDecision;
}

export const RightPanel = ({
  state,
  onApprove,
  onReject,
  onRedirect,
  onConfigure,
  onExecute,
  onQualityChanged,
  onAgentGenerate,
  onAgentRetry,
  onAgentCancel,
  onAgentUseFallback,
  agentAvailable,
  activeTab,
  onActiveTabChange,
  pipelineAutoLaunched,
  getPipelineAutoDecision,
}: RightPanelProps): JSX.Element => {
  const [topologyExpanded, setTopologyExpanded] = useState(false);

  useEffect(() => {
    if (state.kind !== "ready") setTopologyExpanded(false);
  }, [state.kind]);

  useEffect(() => {
    if (!topologyExpanded) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setTopologyExpanded(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [topologyExpanded]);

  const jumpToApproval = useCallback((approvalId: string): void => {
    onActiveTabChange("plan");
    window.setTimeout(() => {
      document
        .getElementById(`approval-card-${approvalId}`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 0);
  }, [onActiveTabChange]);

  const moveTabFocus = useCallback(
    (event: React.KeyboardEvent, currentIndex: number): void => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = (currentIndex + delta + TABS.length) % TABS.length;
      const next = TABS[nextIndex];
      if (!next) return;
      onActiveTabChange(next.id);
      document.getElementById(`right-panel-tab-${next.id}`)?.focus();
    },
    [onActiveTabChange],
  );

  return (
    <>
      <aside
        className="right-panel"
        aria-label="Checkpoint, artifact, and quality panel"
      >
      <section className="right-panel__pinned" aria-label="TaskRun state">
        <header className="panel-header">
          <span className="panel-header__title">
            TaskRun
            <FeatureHelpButton featureId="taskRun" />
          </span>
        </header>
        {state.kind === "ready" && (
          <div className="panel-body panel-body--compact">
            <TaskRunStateActions
              taskRun={state.detail.taskRun}
              approvals={state.detail.approvals}
              onChanged={onQualityChanged}
            />
          </div>
        )}
      </section>

      {state.kind !== "ready" ? (
        <div className="right-panel__placeholder">
          {state.kind === "idle" && (
            <div className="right-panel-empty">
              <span className="right-panel-empty__icon" aria-hidden="true">
                <WorkbenchIcon name="context" />
              </span>
              <strong>작업 컨텍스트</strong>
              <span>
                TaskRun을 선택하면 계획, 승인, 산출물과 품질 상태가 여기에
                표시됩니다.
              </span>
            </div>
          )}
          {state.kind === "loading" && (
            <div className="right-panel-empty right-panel-empty--loading">
              <span className="right-panel-empty__icon" aria-hidden="true">
                <WorkbenchIcon name="spark" />
              </span>
              <strong>컨텍스트 불러오는 중</strong>
              <span>선택한 TaskRun의 최신 상태를 동기화하고 있습니다.</span>
            </div>
          )}
          {state.kind === "error" && (
            <div className="right-panel-empty right-panel-empty--error">
              <span className="right-panel-empty__icon" aria-hidden="true">
                <WorkbenchIcon name="decisions" />
              </span>
              <strong>컨텍스트를 불러오지 못했습니다</strong>
              <code>{state.message}</code>
            </div>
          )}
        </div>
      ) : (
        <div className="right-panel__split">
          <nav
            className="right-panel__tabs right-panel__tabs--vertical"
            role="tablist"
            aria-orientation="vertical"
            aria-label="TaskRun detail tabs"
          >
            {TABS.map((tab, index) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`right-panel-tab-${tab.id}`}
                aria-selected={activeTab === tab.id}
                aria-controls={`right-panel-panel-${tab.id}`}
                tabIndex={activeTab === tab.id ? 0 : -1}
                className={
                  activeTab === tab.id
                    ? "right-panel__tab right-panel__tab--active"
                    : "right-panel__tab"
                }
                onClick={() => onActiveTabChange(tab.id)}
                onKeyDown={(event) => moveTabFocus(event, index)}
                title={tab.tooltip}
                data-tooltip={tab.tooltip}
              >
                <span className="right-panel__tab-icon" aria-hidden>
                  <WorkbenchIcon name={tab.icon} />
                </span>
                <span className="right-panel__tab-label">{tab.label}</span>
              </button>
            ))}
          </nav>

          {/* All tab panels stay mounted; only the active one is
              visible. This preserves per-tab local state (form text,
              draft plan, scroll positions, fetch results) when the
              user switches tabs and comes back. Per-taskRun resets
              still work via the existing `key={taskRun.id}` props on
              QualityPanel / OrchestrationPanel / CostPanel — they remount
              when the active TaskRun changes, just not when the user switches
              tabs. */}
          <div className="right-panel__tab-body">
            <div
              role="tabpanel"
              id="right-panel-panel-plan"
              aria-labelledby="right-panel-tab-plan"
              hidden={activeTab !== "plan"}
            >
              <div className="right-panel__stack">
                <section aria-label="Plan">
                  <header className="panel-header panel-header--inset">
                    <span className="panel-header__title">
                      Plan
                      <FeatureHelpButton featureId="agentPlan" />
                    </span>
                  </header>
                  <PlanArtifactView artifacts={state.detail.artifacts} />
                </section>
                <section aria-label="Approvals">
                  <header className="panel-header panel-header--inset">
                    <span className="panel-header__title">
                      Approvals
                      <FeatureHelpButton featureId="approvals" />
                    </span>
                  </header>
                  <ApprovalPanel
                    approvals={state.detail.approvals}
                    checkpoints={state.detail.checkpoints}
                    refinementAttempts={state.detail.a2aRefinementAttempts}
                    taskRunTargetDir={state.detail.taskRun.targetDir}
                    onApprove={onApprove}
                    onReject={onReject}
                    onRedirect={onRedirect}
                    onConfigure={onConfigure}
                    onExecute={onExecute}
                    pipelineAutoLaunched={pipelineAutoLaunched}
                    getPipelineAutoDecision={getPipelineAutoDecision}
                  />
                </section>
              </div>
            </div>

            <div
              role="tabpanel"
              id="right-panel-panel-agent"
              aria-labelledby="right-panel-tab-agent"
              hidden={activeTab !== "agent"}
            >
              <AgentPanel
                taskRun={state.detail.taskRun}
                invocations={state.detail.agentInvocations}
                steps={state.detail.steps}
                artifacts={state.detail.artifacts}
                remoteTaskRefs={state.detail.a2aRemoteTaskRefs}
                refinementAttempts={state.detail.a2aRefinementAttempts}
                pipelineBackflowAttempts={state.detail.pipelineBackflowAttempts}
                agentAvailable={agentAvailable}
                onGenerate={() => onAgentGenerate(state.detail.taskRun.id)}
                onRetry={onAgentRetry}
                onCancel={onAgentCancel}
                onUseFallback={() => onAgentUseFallback(state.detail.taskRun.id)}
                pendingAdvisoryApprovals={
                  state.detail.approvals.filter(
                    (a) =>
                      (a.actionType === "capability_use" ||
                        a.actionType === "model_use") &&
                      a.status === "pending",
                  ).length
                }
                orchestrationDriven={
                  pipelineAutoLaunched ||
                  state.detail.approvals.some(
                    (a) => a.actionType === "orchestration_plan",
                  )
                }
              />
            </div>

            <div
              role="tabpanel"
              id="right-panel-panel-graph"
              aria-labelledby="right-panel-tab-graph"
              hidden={activeTab !== "graph"}
            >
              <AgentTopologyPanel
                taskRun={state.detail.taskRun}
                steps={state.detail.steps}
                invocations={state.detail.agentInvocations}
                approvals={state.detail.approvals}
                remoteTaskRefs={state.detail.a2aRemoteTaskRefs}
                artifacts={state.detail.artifacts}
                headerActions={
                  <button
                    type="button"
                    className="panel-header__action"
                    onClick={() => setTopologyExpanded(true)}
                  >
                    <span className="panel-header__action-icon" aria-hidden>
                      ⤢
                    </span>
                    <span className="panel-header__action-label">큰 창</span>
                  </button>
                }
              />
            </div>

            <div
              role="tabpanel"
              id="right-panel-panel-timeline"
              aria-labelledby="right-panel-tab-timeline"
              hidden={activeTab !== "timeline"}
            >
              <TaskRunTimeline
                taskRun={state.detail.taskRun}
                steps={state.detail.steps}
              />
            </div>

            <div
              role="tabpanel"
              id="right-panel-panel-artifacts"
              aria-labelledby="right-panel-tab-artifacts"
              hidden={activeTab !== "artifacts"}
            >
              <ArtifactPanel
                artifacts={state.detail.artifacts.filter(
                  (a) => a.kind !== "plan",
                )}
              />
            </div>

            <div
              role="tabpanel"
              id="right-panel-panel-quality"
              aria-labelledby="right-panel-tab-quality"
              hidden={activeTab !== "quality"}
            >
              <QualityPanel
                key={state.detail.taskRun.id}
                taskRun={state.detail.taskRun}
                artifacts={state.detail.artifacts}
                approvals={state.detail.approvals}
                qualityGates={state.detail.qualityGates}
                repairAttempts={state.detail.repairAttempts}
                refinementProposals={state.detail.a2aRefinementProposals}
                onTaskRunChanged={onQualityChanged}
              />
            </div>

            <div
              role="tabpanel"
              id="right-panel-panel-orchestration"
              aria-labelledby="right-panel-tab-orchestration"
              hidden={activeTab !== "orchestration"}
            >
              <OrchestrationPanel
                key={`${state.detail.taskRun.id}-orch`}
                taskRun={state.detail.taskRun}
                approvals={state.detail.approvals}
                onRefreshTaskRun={onQualityChanged}
                pipelineAutoLaunched={pipelineAutoLaunched}
              />
            </div>

            <div
              role="tabpanel"
              id="right-panel-panel-cost"
              aria-labelledby="right-panel-tab-cost"
              hidden={activeTab !== "cost"}
            >
              <CostPanel
                key={`${state.detail.taskRun.id}-cost`}
                taskRunId={state.detail.taskRun.id}
              />
            </div>

            <div
              role="tabpanel"
              id="right-panel-panel-decisions"
              aria-labelledby="right-panel-tab-decisions"
              hidden={activeTab !== "decisions"}
            >
              <DecisionsPanel
                approvals={state.detail.approvals}
                onJumpToApproval={jumpToApproval}
              />
            </div>
          </div>
        </div>
      )}
      </aside>

      {state.kind === "ready" && topologyExpanded ? (
        <div
          className="agent-topology-window"
          role="dialog"
          aria-modal="true"
          aria-label="Agent Graph large window"
        >
          <div
            className="agent-topology-window__backdrop"
            aria-hidden
            onClick={() => setTopologyExpanded(false)}
          />
          <div className="agent-topology-window__dialog">
            <AgentTopologyPanel
              taskRun={state.detail.taskRun}
              steps={state.detail.steps}
              invocations={state.detail.agentInvocations}
              approvals={state.detail.approvals}
              remoteTaskRefs={state.detail.a2aRemoteTaskRefs}
              artifacts={state.detail.artifacts}
              variant="large"
              headerActions={
                <button
                  type="button"
                  className="panel-header__action"
                  onClick={() => setTopologyExpanded(false)}
                >
                  <span className="panel-header__action-icon" aria-hidden>
                    ×
                  </span>
                  <span className="panel-header__action-label">닫기</span>
                </button>
              }
            />
          </div>
        </div>
      ) : null}
    </>
  );
};
