import { useState } from "react";
import type { ProposedActionDetails, TaskRunDetail } from "@harness/core";
import { AgentPanel } from "./AgentPanel";
import { AgentTopologyPanel } from "./AgentTopologyPanel";
import { ApprovalPanel } from "./ApprovalPanel";
import { PlanArtifactView } from "./PlanArtifactView";
import { TaskRunTimeline } from "./TaskRunTimeline";
import { ArtifactPanel } from "./ArtifactPanel";
import { QualityPanel } from "./QualityPanel";
import { CapabilityPanel } from "./CapabilityPanel";
import { InstinctPanel } from "./InstinctPanel";
import { LearnerPanel } from "./LearnerPanel";
import { OrchestrationPanel } from "./OrchestrationPanel";
import { TaskRunStateActions } from "./TaskRunStateActions";

type TaskRunDetailState =
  | { kind: "idle" }
  | { kind: "loading"; taskRunId: string }
  | { kind: "ready"; detail: TaskRunDetail }
  | { kind: "error"; taskRunId: string; message: string };

type RightPanelTab =
  | "plan"
  | "agent"
  | "graph"
  | "timeline"
  | "artifacts"
  | "quality"
  | "capabilities"
  | "instinct"
  | "orchestration";

// `label` is the short string baked into the icon column; `tooltip` carries
// the full meaning for the hover bubble (and for screen readers via title).
const TABS: ReadonlyArray<{
  id: RightPanelTab;
  label: string;
  tooltip: string;
  icon: string;
}> = [
  { id: "plan", label: "Plan", tooltip: "Plan", icon: "◧" },
  { id: "agent", label: "Agent", tooltip: "Agent", icon: "✦" },
  { id: "graph", label: "Graph", tooltip: "Agent Graph", icon: "∿" },
  { id: "timeline", label: "Time", tooltip: "Timeline", icon: "⌛" },
  { id: "artifacts", label: "Files", tooltip: "Artifacts", icon: "▤" },
  { id: "quality", label: "QA", tooltip: "Quality", icon: "✓" },
  { id: "capabilities", label: "Caps", tooltip: "Capabilities", icon: "⚙" },
  { id: "instinct", label: "Inst", tooltip: "Instinct", icon: "※" },
  { id: "orchestration", label: "Orch", tooltip: "Orchestration", icon: "⌥" },
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
  onCapabilityApprovalCreated: () => Promise<void>;
  onAgentGenerate: (taskRunId: string) => Promise<void>;
  onAgentRetry: (invocationId: string) => Promise<void>;
  onAgentCancel: (invocationId: string) => Promise<void>;
  onAgentUseFallback: (taskRunId: string) => Promise<void>;
  agentAvailable: boolean;
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
}

export const RightPanel = ({
  state,
  onApprove,
  onReject,
  onRedirect,
  onConfigure,
  onExecute,
  onQualityChanged,
  onCapabilityApprovalCreated,
  onAgentGenerate,
  onAgentRetry,
  onAgentCancel,
  onAgentUseFallback,
  agentAvailable,
  pipelineAutoLaunched,
}: RightPanelProps): JSX.Element => {
  const [activeTab, setActiveTab] = useState<RightPanelTab>("plan");

  return (
    <aside
      className="right-panel"
      aria-label="Checkpoint, artifact, and quality panel"
    >
      <section className="right-panel__pinned" aria-label="TaskRun state">
        <header className="panel-header">
          <span>TaskRun</span>
        </header>
        <div className="panel-body panel-body--compact">
          {state.kind === "ready" ? (
            <TaskRunStateActions
              taskRun={state.detail.taskRun}
              approvals={state.detail.approvals}
              onChanged={onQualityChanged}
            />
          ) : (
            <div className="empty-state">TaskRun 선택 시 표시</div>
          )}
        </div>
      </section>

      {state.kind !== "ready" ? (
        <div className="right-panel__placeholder">
          {state.kind === "idle" && (
            <div className="empty-state">TaskRun 선택 시 표시</div>
          )}
          {state.kind === "loading" && (
            <div className="empty-state">불러오는 중…</div>
          )}
          {state.kind === "error" && (
            <div
              className="empty-state"
              style={{ color: "var(--status-failed)" }}
            >
              {state.message}
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
            {TABS.map((tab) => (
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
                onClick={() => setActiveTab(tab.id)}
                title={tab.tooltip}
                data-tooltip={tab.tooltip}
              >
                <span className="right-panel__tab-icon" aria-hidden>
                  {tab.icon}
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
              QualityPanel / CapabilityPanel / LearnerPanel /
              OrchestrationPanel — they remount when the active
              TaskRun changes, just not when the user switches tabs. */}
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
                    <span>Plan</span>
                  </header>
                  <PlanArtifactView artifacts={state.detail.artifacts} />
                </section>
                <section aria-label="Approvals">
                  <header className="panel-header panel-header--inset">
                    <span>Approvals</span>
                  </header>
                  <ApprovalPanel
                    approvals={state.detail.approvals}
                    taskRunTargetDir={state.detail.taskRun.targetDir}
                    onApprove={onApprove}
                    onReject={onReject}
                    onRedirect={onRedirect}
                    onConfigure={onConfigure}
                    onExecute={onExecute}
                    pipelineAutoLaunched={pipelineAutoLaunched}
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
                onTaskRunChanged={onQualityChanged}
              />
            </div>

            <div
              role="tabpanel"
              id="right-panel-panel-capabilities"
              aria-labelledby="right-panel-tab-capabilities"
              hidden={activeTab !== "capabilities"}
            >
              <div className="right-panel__stack">
                <section aria-label="Capabilities">
                  <header className="panel-header panel-header--inset">
                    <span>Capabilities</span>
                  </header>
                  <CapabilityPanel
                    key={state.detail.taskRun.id}
                    taskRun={state.detail.taskRun}
                    approvals={state.detail.approvals}
                    prompt={state.detail.taskRun.userRequest}
                    onApprovalCreated={onCapabilityApprovalCreated}
                  />
                </section>
                <section aria-label="Learner">
                  <header className="panel-header panel-header--inset">
                    <span>Learner</span>
                  </header>
                  <LearnerPanel
                    key={state.detail.taskRun.id}
                    taskRun={state.detail.taskRun}
                    approvals={state.detail.approvals}
                    onApprovalCreated={onCapabilityApprovalCreated}
                  />
                </section>
              </div>
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
              id="right-panel-panel-instinct"
              aria-labelledby="right-panel-tab-instinct"
              hidden={activeTab !== "instinct"}
            >
              <section aria-label="Instinct">
                <header className="panel-header panel-header--inset">
                  <span>Instinct</span>
                </header>
                <InstinctPanel key={`${state.detail.taskRun.id}-instinct`} />
              </section>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};
