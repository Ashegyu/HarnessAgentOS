import { useState } from "react";
import type { ProposedActionDetails, TaskRunDetail } from "@harness/core";
import { AgentPanel } from "./AgentPanel";
import { ApprovalPanel } from "./ApprovalPanel";
import { PlanArtifactView } from "./PlanArtifactView";
import { TaskRunTimeline } from "./TaskRunTimeline";
import { ArtifactPanel } from "./ArtifactPanel";
import { QualityPanel } from "./QualityPanel";
import { CapabilityPanel } from "./CapabilityPanel";
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
  | "timeline"
  | "artifacts"
  | "quality"
  | "capabilities"
  | "orchestration";

const TABS: ReadonlyArray<{ id: RightPanelTab; label: string }> = [
  { id: "plan", label: "Plan" },
  { id: "agent", label: "Agent" },
  { id: "timeline", label: "Timeline" },
  { id: "artifacts", label: "Artifacts" },
  { id: "quality", label: "Quality" },
  { id: "capabilities", label: "Capabilities" },
  { id: "orchestration", label: "Orchestration" },
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
        <>
          <nav
            className="right-panel__tabs"
            role="tablist"
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
              >
                {tab.label}
              </button>
            ))}
          </nav>

          <div
            className="right-panel__tab-body"
            role="tabpanel"
            id={`right-panel-panel-${activeTab}`}
            aria-labelledby={`right-panel-tab-${activeTab}`}
          >
            {activeTab === "plan" && (
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
                  />
                </section>
              </div>
            )}

            {activeTab === "agent" && (
              <AgentPanel
                taskRun={state.detail.taskRun}
                invocations={state.detail.agentInvocations}
                agentAvailable={agentAvailable}
                onGenerate={() => onAgentGenerate(state.detail.taskRun.id)}
                onRetry={onAgentRetry}
                onCancel={onAgentCancel}
                onUseFallback={() => onAgentUseFallback(state.detail.taskRun.id)}
              />
            )}

            {activeTab === "timeline" && (
              <TaskRunTimeline
                taskRun={state.detail.taskRun}
                steps={state.detail.steps}
              />
            )}

            {activeTab === "artifacts" && (
              <ArtifactPanel
                artifacts={state.detail.artifacts.filter(
                  (a) => a.kind !== "plan",
                )}
              />
            )}

            {activeTab === "quality" && (
              <QualityPanel
                key={state.detail.taskRun.id}
                taskRun={state.detail.taskRun}
                artifacts={state.detail.artifacts}
                onTaskRunChanged={onQualityChanged}
              />
            )}

            {activeTab === "capabilities" && (
              <div className="right-panel__stack">
                <section aria-label="Capabilities">
                  <header className="panel-header panel-header--inset">
                    <span>Capabilities</span>
                  </header>
                  <CapabilityPanel
                    key={state.detail.taskRun.id}
                    taskRun={state.detail.taskRun}
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
                  />
                </section>
              </div>
            )}

            {activeTab === "orchestration" && (
              <OrchestrationPanel
                key={`${state.detail.taskRun.id}-orch`}
                taskRun={state.detail.taskRun}
                approvals={state.detail.approvals}
                onRefreshTaskRun={onQualityChanged}
              />
            )}
          </div>
        </>
      )}
    </aside>
  );
};
