import { useState } from "react";
import type { Approval, TaskRun } from "@harness/core";
import { CapabilityPanel } from "./CapabilityPanel";
import { FeatureHelpButton } from "./FeatureHelpButton";
import type { FeatureHelpId } from "./feature-help";
import { InstinctPanel } from "./InstinctPanel";
import { LearnerPanel } from "./LearnerPanel";
import { SkillSourcesTab } from "./SkillSourcesTab";

interface LearningPanelProps {
  taskRun: TaskRun | null;
  approvals?: Approval[];
  profileId?: string | null;
  onApprovalCreated: () => Promise<void>;
  onClose: () => void;
}

type LearningTabId = "instincts" | "capabilities" | "learner" | "skills";

interface LearningTabDef {
  id: LearningTabId;
  label: string;
  helpId: FeatureHelpId;
}

const TABS: readonly LearningTabDef[] = [
  { id: "instincts", label: "Instincts", helpId: "instinct" },
  { id: "capabilities", label: "Capabilities", helpId: "capabilities" },
  { id: "learner", label: "Learner", helpId: "learner" },
  { id: "skills", label: "Skills", helpId: "skills" },
];

export const LearningPanel = ({
  taskRun,
  approvals = [],
  profileId = null,
  onApprovalCreated,
  onClose,
}: LearningPanelProps): JSX.Element => {
  const [activeTab, setActiveTab] = useState<LearningTabId>("instincts");
  const active = TABS.find((tab) => tab.id === activeTab) ?? TABS[0]!;
  const taskRunKey = taskRun?.id ?? "no-task-run";

  return (
    <div
      className="settings-overlay"
      role="dialog"
      aria-modal
      aria-label="Learning"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings-dialog">
        <header className="settings-dialog__header">
          <span className="settings-dialog__title">
            Learning
            <FeatureHelpButton featureId="learner" />
          </span>
          <button
            type="button"
            className="settings-dialog__close"
            onClick={onClose}
            aria-label="닫기"
          >
            ×
          </button>
        </header>

        <nav
          className="settings-dialog__tabs"
          role="tablist"
          aria-label="Learning categories"
        >
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`settings-dialog__tab${
                activeTab === tab.id ? " settings-dialog__tab--active" : ""
              }`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="settings-dialog__feature-help">
          <span>{active.label}</span>
          <FeatureHelpButton featureId={active.helpId} />
        </div>

        {activeTab === "instincts" && (
          <div className="settings-dialog__body">
            <InstinctPanel />
          </div>
        )}

        {activeTab === "capabilities" && (
          <div className="settings-dialog__body">
            <CapabilityPanel
              key={taskRunKey}
              taskRun={taskRun}
              approvals={approvals}
              prompt={taskRun?.userRequest ?? ""}
              profileId={profileId}
              onApprovalCreated={onApprovalCreated}
            />
          </div>
        )}

        {activeTab === "learner" && (
          <div className="settings-dialog__body">
            <div className="right-panel__stack">
              <section aria-label="Learner">
                <header className="panel-header panel-header--inset">
                  <span className="panel-header__title">
                    Learner
                    <FeatureHelpButton featureId="learner" />
                  </span>
                </header>
                <LearnerPanel
                  key={taskRunKey}
                  taskRun={taskRun}
                  approvals={approvals}
                  profileId={profileId}
                  onApprovalCreated={onApprovalCreated}
                />
              </section>
            </div>
          </div>
        )}

        {activeTab === "skills" && (
          <div className="settings-dialog__body">
            <SkillSourcesTab />
          </div>
        )}
      </div>
    </div>
  );
};
