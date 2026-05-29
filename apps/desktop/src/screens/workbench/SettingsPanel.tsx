import { useEffect, useReducer, useState } from "react";
import type {
  AgentPipeline,
  AgentProvider,
  HarnessSettings,
  OrchestrationMode,
} from "@harness/core";
import { AgentProfilesTab } from "./AgentProfilesTab";
import { McpServersTab } from "./McpServersTab";
import { PipelinesTab } from "./PipelinesTab";
import { RemoteAgentsTab } from "./RemoteAgentsTab";
import { SecretsTab } from "./SecretsTab";
import { FeatureGuideTab } from "./FeatureGuideTab";
import { FeatureHelpButton } from "./FeatureHelpButton";
import type { FeatureHelpId } from "./feature-help";
import { SkillSourcesTab } from "./SkillSourcesTab";
import { HarnessPackagesTab } from "./HarnessPackagesTab";
import { EvalsTab } from "./EvalsTab";
import { BudgetOverviewTab } from "./BudgetOverviewTab";
import { ActivityLogTab } from "./ActivityLogTab";
import { KeyboardShortcutsTab } from "./KeyboardShortcutsTab";
import { SystemDiagnosticsTab } from "./SystemDiagnosticsTab";
import { BackupExportTab } from "./BackupExportTab";

interface Props {
  onClose: () => void;
  initialTopologyTaskRunId?: string | null;
}

type SettingsTabId =
  | "guide"
  | "general"
  | "agents"
  | "remoteAgents"
  | "pipelines"
  | "evals"
  | "mcp"
  | "skills"
  | "harnessPackages"
  | "secrets"
  | "budget"
  | "activityLog"
  | "diagnostics"
  | "backupExport"
  | "shortcuts";

interface SettingsTabDef {
  id: SettingsTabId;
  label: string;
}

const TABS: readonly SettingsTabDef[] = [
  { id: "guide", label: "Guide" },
  { id: "general", label: "General" },
  { id: "agents", label: "Agents" },
  { id: "remoteAgents", label: "Remote Agents" },
  { id: "pipelines", label: "Pipelines" },
  { id: "evals", label: "Evals" },
  { id: "mcp", label: "MCP" },
  { id: "skills", label: "Skills" },
  { id: "harnessPackages", label: "Harnesses" },
  { id: "secrets", label: "Secrets" },
  { id: "budget", label: "Budget" },
  { id: "activityLog", label: "Activity" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "backupExport", label: "Backup" },
  { id: "shortcuts", label: "Shortcuts" },
];

const TAB_HELP: Record<SettingsTabId, FeatureHelpId> = {
  guide: "workbench",
  general: "settings",
  agents: "agentProfiles",
  remoteAgents: "remoteAgents",
  pipelines: "pipelines",
  evals: "settings",
  mcp: "mcpServers",
  skills: "skills",
  harnessPackages: "pipelines",
  secrets: "secrets",
  budget: "budget",
  activityLog: "activityLog",
  diagnostics: "diagnostics",
  backupExport: "backupExport",
  shortcuts: "shortcuts",
};

type FormState =
  | { kind: "loading" }
  | { kind: "ready"; draft: HarnessSettings; saving: boolean; error: string | null }
  | { kind: "error"; message: string };

type Action =
  | { type: "loaded"; settings: HarnessSettings }
  | { type: "loadError"; message: string }
  | { type: "setProvider"; value: AgentProvider }
  | { type: "setModel"; value: string }
  | { type: "setTimeoutMs"; value: number }
  | { type: "setStallTimeoutMs"; value: number }
  | { type: "setContextDepth"; value: number }
  | { type: "setCodexWorkspaceWrite"; value: boolean }
  | { type: "setCodexAutoReview"; value: boolean }
  | { type: "setOrchestrationEnabled"; value: boolean }
  | { type: "setDefaultMode"; value: OrchestrationMode }
  | { type: "setDefaultInstructions"; value: string }
  | { type: "setDefaultPipelineId"; value: string }
  | { type: "setAutoApprove"; value: boolean }
  | { type: "setAutoExecuteWorkerFileActions"; value: boolean }
  | { type: "saving" }
  | { type: "saved"; settings: HarnessSettings }
  | { type: "saveError"; message: string };

const reducer = (state: FormState, action: Action): FormState => {
  if (action.type === "loaded") {
    return { kind: "ready", draft: action.settings, saving: false, error: null };
  }
  if (action.type === "loadError") {
    return { kind: "error", message: action.message };
  }
  if (state.kind !== "ready") return state;
  if (action.type === "setProvider") {
    return { ...state, draft: { ...state.draft, agent: { ...state.draft.agent, provider: action.value } } };
  }
  if (action.type === "setModel") {
    return { ...state, draft: { ...state.draft, agent: { ...state.draft.agent, model: action.value } } };
  }
  if (action.type === "setTimeoutMs") {
    return { ...state, draft: { ...state.draft, agent: { ...state.draft.agent, timeoutMs: action.value } } };
  }
  if (action.type === "setStallTimeoutMs") {
    return { ...state, draft: { ...state.draft, agent: { ...state.draft.agent, stallTimeoutMs: action.value } } };
  }
  if (action.type === "setContextDepth") {
    return { ...state, draft: { ...state.draft, agent: { ...state.draft.agent, contextDepth: action.value } } };
  }
  if (action.type === "setCodexWorkspaceWrite") {
    return { ...state, draft: { ...state.draft, agent: { ...state.draft.agent, codexWorkspaceWrite: action.value } } };
  }
  if (action.type === "setCodexAutoReview") {
    return { ...state, draft: { ...state.draft, agent: { ...state.draft.agent, codexAutoReview: action.value } } };
  }
  if (action.type === "setOrchestrationEnabled") {
    return { ...state, draft: { ...state.draft, orchestration: { ...state.draft.orchestration, enabled: action.value } } };
  }
  if (action.type === "setDefaultMode") {
    return { ...state, draft: { ...state.draft, orchestration: { ...state.draft.orchestration, defaultMode: action.value } } };
  }
  if (action.type === "setDefaultInstructions") {
    return { ...state, draft: { ...state.draft, orchestration: { ...state.draft.orchestration, defaultInstructions: action.value } } };
  }
  if (action.type === "setDefaultPipelineId") {
    return { ...state, draft: { ...state.draft, orchestration: { ...state.draft.orchestration, defaultPipelineId: action.value } } };
  }
  if (action.type === "setAutoApprove") {
    return { ...state, draft: { ...state.draft, approval: { ...state.draft.approval, autoApprove: action.value } } };
  }
  if (action.type === "setAutoExecuteWorkerFileActions") {
    return {
      ...state,
      draft: {
        ...state.draft,
        approval: {
          ...state.draft.approval,
          autoExecuteWorkerFileActions: action.value,
          workerFileAutoExecutionConfigured: true,
        },
      },
    };
  }
  if (action.type === "saving") {
    return { ...state, saving: true, error: null };
  }
  if (action.type === "saved") {
    return { ...state, saving: false, draft: action.settings, error: null };
  }
  if (action.type === "saveError") {
    return { ...state, saving: false, error: action.message };
  }
  return state;
};

export const SettingsPanel = ({
  onClose,
  initialTopologyTaskRunId = null,
}: Props): JSX.Element => {
  const [state, dispatch] = useReducer(reducer, { kind: "loading" });
  const [activeTab, setActiveTab] = useState<SettingsTabId>("general");
  const [pipelines, setPipelines] = useState<AgentPipeline[]>([]);
  const activeTabLabel =
    TABS.find((tab) => tab.id === activeTab)?.label ?? "Settings";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await window.harness.settings.get();
        if (!cancelled) dispatch({ type: "loaded", settings });
      } catch (e) {
        if (!cancelled) {
          dispatch({ type: "loadError", message: e instanceof Error ? e.message : String(e) });
        }
      }
      try {
        const list = await window.harness.pipeline.list();
        if (!cancelled) setPipelines(list);
      } catch {
        // pipeline namespace unavailable — leave list empty, dropdown stays hidden.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSave = async (): Promise<void> => {
    if (state.kind !== "ready") return;
    dispatch({ type: "saving" });
    try {
      const saved = await window.harness.settings.update(state.draft);
      dispatch({ type: "saved", settings: saved });
      onClose();
    } catch (e) {
      dispatch({ type: "saveError", message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div
      className="settings-overlay"
      role="dialog"
      aria-modal
      aria-label="설정"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="settings-dialog">
        <header className="settings-dialog__header">
          <span className="settings-dialog__title">
            설정
            <FeatureHelpButton featureId="settings" />
          </span>
          <button type="button" className="settings-dialog__close" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </header>

        <nav
          className="settings-dialog__tabs"
          role="tablist"
          aria-label="설정 카테고리"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={activeTab === t.id}
              className={`settings-dialog__tab${
                activeTab === t.id ? " settings-dialog__tab--active" : ""
              }`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="settings-dialog__feature-help">
          <span>{activeTabLabel}</span>
          <FeatureHelpButton featureId={TAB_HELP[activeTab]} />
        </div>

        {activeTab === "guide" && (
          <div className="settings-dialog__body">
            <FeatureGuideTab />
          </div>
        )}

        {activeTab === "agents" && (
          <div className="settings-dialog__body settings-dialog__body--flush">
            <AgentProfilesTab />
          </div>
        )}

        {activeTab === "pipelines" && (
          <div className="settings-dialog__body settings-dialog__body--flush">
            <PipelinesTab
              initialTopologyTaskRunId={initialTopologyTaskRunId}
              onDefaultPipelineChanged={(pipelineId) => {
                dispatch({ type: "setOrchestrationEnabled", value: true });
                dispatch({ type: "setDefaultPipelineId", value: pipelineId });
                void window.harness.pipeline
                  .list()
                  .then((list) => setPipelines(list))
                  .catch(() => {
                    // General tab dropdown is optional; Pipelines tab remains authoritative.
                  });
              }}
            />
          </div>
        )}

        {activeTab === "remoteAgents" && (
          <div className="settings-dialog__body settings-dialog__body--flush">
            <RemoteAgentsTab />
          </div>
        )}

        {activeTab === "evals" && (
          <div className="settings-dialog__body settings-dialog__body--flush">
            <EvalsTab />
          </div>
        )}

        {activeTab === "mcp" && (
          <div className="settings-dialog__body settings-dialog__body--flush">
            <McpServersTab />
          </div>
        )}

        {activeTab === "skills" && (
          <div className="settings-dialog__body">
            <SkillSourcesTab />
          </div>
        )}

        {activeTab === "harnessPackages" && (
          <div className="settings-dialog__body settings-dialog__body--flush">
            <HarnessPackagesTab />
          </div>
        )}

        {activeTab === "secrets" && (
          <div className="settings-dialog__body">
            <SecretsTab />
          </div>
        )}

        {activeTab === "budget" && (
          <div className="settings-dialog__body settings-dialog__body--flush">
            <BudgetOverviewTab />
          </div>
        )}

        {activeTab === "activityLog" && (
          <div className="settings-dialog__body settings-dialog__body--flush">
            <ActivityLogTab />
          </div>
        )}

        {activeTab === "diagnostics" && (
          <div className="settings-dialog__body settings-dialog__body--flush">
            <SystemDiagnosticsTab />
          </div>
        )}

        {activeTab === "backupExport" && (
          <div className="settings-dialog__body settings-dialog__body--flush">
            <BackupExportTab />
          </div>
        )}

        {activeTab === "shortcuts" && (
          <div className="settings-dialog__body settings-dialog__body--flush">
            <KeyboardShortcutsTab />
          </div>
        )}

        {activeTab === "general" && state.kind === "loading" && (
          <div className="settings-dialog__body empty-state">설정 불러오는 중…</div>
        )}

        {activeTab === "general" && state.kind === "error" && (
          <div className="settings-dialog__body empty-state" style={{ color: "var(--status-failed)" }}>
            {state.message}
          </div>
        )}

        {activeTab === "general" && state.kind === "ready" && (
          <div className="settings-dialog__body">
            <fieldset className="settings-fieldset">
              <legend>에이전트</legend>

              <label className="settings-field">
                <span className="settings-field__label">Provider</span>
                <select
                  className="settings-field__input"
                  value={state.draft.agent.provider}
                  disabled={state.saving}
                  onChange={(e) =>
                    dispatch({ type: "setProvider", value: e.target.value as AgentProvider })
                  }
                >
                  <option value="auto">auto (자동 선택)</option>
                  <option value="claude">claude</option>
                  <option value="codex">codex</option>
                </select>
                <span className="settings-field__hint">
                  auto는 가용한 CLI(claude → codex 순)를 자동 선택합니다.
                  특정 제품군에 고정하려면 claude / codex를 직접 지정하세요.
                  Agent Profile에서 같은 옵션을 덮어쓸 수 있습니다.
                </span>
              </label>

              <label className="settings-field">
                <span className="settings-field__label">Model</span>
                <input
                  type="text"
                  className="settings-field__input"
                  placeholder="기본값 사용 (비워두기)"
                  value={state.draft.agent.model}
                  disabled={state.saving}
                  onChange={(e) => dispatch({ type: "setModel", value: e.target.value })}
                />
                <span className="settings-field__hint">
                  비워두면 각 CLI의 기본 모델을 그대로 씁니다.
                  <code>claude-sonnet-4-6</code> 같은 ID를 직접 지정할 수 있습니다.
                </span>
              </label>

              <label className="settings-field">
                <span className="settings-field__label">Hard timeout (ms)</span>
                <input
                  type="number"
                  className="settings-field__input"
                  min={1000}
                  step={1000}
                  value={state.draft.agent.timeoutMs}
                  disabled={state.saving}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (v > 0) dispatch({ type: "setTimeoutMs", value: v });
                  }}
                />
                <span className="settings-field__hint">
                  한 번의 agent invocation이 이 시간을 넘으면 강제 종료됩니다.
                  길게 잡으면 빠진 응답을 오래 기다려 비용·블로킹이 늘어납니다.
                </span>
              </label>

              <label className="settings-field">
                <span className="settings-field__label">Idle timeout (ms)</span>
                <input
                  type="number"
                  className="settings-field__input"
                  min={1000}
                  step={1000}
                  value={state.draft.agent.stallTimeoutMs}
                  disabled={state.saving}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (v > 0) dispatch({ type: "setStallTimeoutMs", value: v });
                  }}
                />
                <span className="settings-field__hint">
                  마지막 stream 출력 이후 이 시간 동안 아무것도 오지 않으면
                  stall로 간주하고 invocation을 종료합니다. Hard timeout보다 짧게 잡으세요.
                </span>
              </label>

              <label className="settings-field">
                <span className="settings-field__label">Context depth</span>
                <input
                  type="number"
                  className="settings-field__input"
                  min={1}
                  step={1}
                  value={state.draft.agent.contextDepth}
                  disabled={state.saving}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (Number.isInteger(v) && v >= 1) dispatch({ type: "setContextDepth", value: v });
                  }}
                />
                <span className="settings-field__hint">
                  agent에게 함께 전달할 최근 step/checkpoint 개수입니다.
                  늘리면 맥락은 풍부해지지만 prompt 토큰 비용이 같이 증가합니다.
                </span>
              </label>

              <label className="settings-field settings-field--checkbox">
                <input
                  type="checkbox"
                  checked={state.draft.agent.codexWorkspaceWrite === true}
                  disabled={state.saving}
                  onChange={(e) =>
                    dispatch({
                      type: "setCodexWorkspaceWrite",
                      value: e.target.checked,
                    })
                  }
                />
                <span className="settings-field__label">
                  Codex workspace-write sandbox
                </span>
              </label>
              <p className="settings-field__hint">
                켜면 Codex CLI 호출에 <code>--sandbox workspace-write</code>를
                사용합니다. 끄면 기존처럼 <code>read-only</code>로 실행합니다.
              </p>

              <label className="settings-field settings-field--checkbox">
                <input
                  type="checkbox"
                  checked={state.draft.agent.codexAutoReview === true}
                  disabled={state.saving}
                  onChange={(e) =>
                    dispatch({
                      type: "setCodexAutoReview",
                      value: e.target.checked,
                    })
                  }
                />
                <span className="settings-field__label">
                  Codex approval 자동 검토
                </span>
              </label>
              <p className="settings-field__hint">
                켜면 Codex CLI 호출에 approval auto-review 설정을 추가하고
                provider approval 요청을 <code>on-request</code>로 허용합니다.
              </p>
            </fieldset>

            <fieldset className="settings-fieldset">
              <legend>Agent Orchestration (실험적)</legend>

              <label className="settings-field settings-field--checkbox">
                <input
                  type="checkbox"
                  checked={state.draft.orchestration.enabled}
                  disabled={state.saving}
                  onChange={(e) =>
                    dispatch({ type: "setOrchestrationEnabled", value: e.target.checked })
                  }
                />
                <span className="settings-field__label">Orchestration 활성화</span>
              </label>
              <p className="settings-field__hint">
                끄면 사용자 입력이 단일 worker에게 그대로 전달됩니다.
                켜면 Pipelines 탭에서 정의한 단계 순서를 따라 planner → worker가 협업합니다.
              </p>

              {pipelines.length > 0 && (
                <label className="settings-field">
                  <span className="settings-field__label">기본 Pipeline</span>
                  <select
                    className="settings-field__input"
                    value={
                      pipelines.some(
                        (p) => p.id === state.draft.orchestration.defaultPipelineId,
                      )
                        ? state.draft.orchestration.defaultPipelineId
                        : ""
                    }
                    disabled={state.saving}
                    onChange={(e) =>
                      dispatch({ type: "setDefaultPipelineId", value: e.target.value })
                    }
                  >
                    <option value="">(없음 — Legacy mode 사용)</option>
                    {pipelines.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.steps.length} steps)
                      </option>
                    ))}
                  </select>
                  <span className="settings-field__hint">
                    새 thread가 기본으로 쓸 pipeline입니다.
                    선택하면 아래 Legacy Mode는 비활성화되고 pipeline의 단계 정의가 우선합니다.
                  </span>
                </label>
              )}

              <label className="settings-field">
                <span className="settings-field__label">기본 Legacy Mode</span>
                <select
                  className="settings-field__input"
                  value={state.draft.orchestration.defaultMode}
                  disabled={
                    state.saving ||
                    state.draft.orchestration.defaultPipelineId.length > 0
                  }
                  onChange={(e) =>
                    dispatch({ type: "setDefaultMode", value: e.target.value as OrchestrationMode })
                  }
                >
                  <option value="single_worker">single_worker</option>
                  <option value="planner_worker">planner_worker</option>
                  <option value="multi_worker">multi_worker</option>
                </select>
                <span className="settings-field__hint">
                  Pipeline이 지정되지 않은 thread에만 적용되는 구버전 mode입니다.
                  single_worker는 worker 한 명, planner_worker는 plan → worker,
                  multi_worker는 plan → 다중 worker 분배입니다.
                </span>
              </label>

              <label className="settings-field">
                <span className="settings-field__label">기본 Instruction</span>
                <textarea
                  className="settings-field__input settings-field__textarea"
                  rows={3}
                  placeholder="플래너에게 전달할 기본 지시 (선택)"
                  value={state.draft.orchestration.defaultInstructions}
                  disabled={state.saving}
                  onChange={(e) =>
                    dispatch({ type: "setDefaultInstructions", value: e.target.value })
                  }
                />
                <span className="settings-field__hint">
                  새 task의 planner 프롬프트 앞에 자동으로 붙는 조직/팀 지침입니다.
                  비워두면 사용자 입력만 전달됩니다.
                </span>
              </label>

              <p className="settings-field__hint">
                에이전트 워크플로우 구성은 <strong>Agents</strong> 탭에서 Agent Profile별로,
                <strong> Pipelines</strong> 탭에서 실행 순서를 설정하세요.
                Worker Profiles는 더 이상 사용되지 않습니다.
              </p>
            </fieldset>

            <fieldset className="settings-fieldset">
              <legend>Approval 자동화</legend>

              <label className="settings-field settings-field--checkbox">
                <input
                  type="checkbox"
                  checked={state.draft.approval.autoApprove}
                  disabled={state.saving}
                  onChange={(e) =>
                    dispatch({ type: "setAutoApprove", value: e.target.checked })
                  }
                />
                <span className="settings-field__label">
                  허용된 approval 자동 승인 및 실행
                </span>
              </label>
              <p className="settings-field__hint" style={{ color: "var(--status-failed)" }}>
                ⚠ 켜도 service-layer policy가 blocked 또는 manual-only로 표시한 approval은 자동 승인되지 않습니다. capability_use/model_use는 실행하지 않고 Skill 컨텍스트나 Learner 모델 추천만 반영합니다.
              </p>

              <label className="settings-field settings-field--checkbox">
                <input
                  type="checkbox"
                  checked={state.draft.approval.autoExecuteWorkerFileActions}
                  disabled={state.saving}
                  onChange={(e) =>
                    dispatch({
                      type: "setAutoExecuteWorkerFileActions",
                      value: e.target.checked,
                    })
                  }
                />
                <span className="settings-field__label">
                  Worker 파일 생성/수정 자동 승인 및 실행
                </span>
              </label>
              <p className="settings-field__hint">
                Worker가 제안한 file_write/file_patch approval만 자동 처리합니다. 일반
                file_write/file_patch, shell, network, git_commit, orchestration_plan은
                포함하지 않으며 Agent Profile의 Block 설정이 계속 우선합니다. 기본값은 켜짐입니다.
              </p>
            </fieldset>

            {state.error && (
              <div style={{ color: "var(--status-failed)", fontSize: 12, marginTop: 8 }}>
                {state.error}
              </div>
            )}
          </div>
        )}

        {activeTab === "general" && state.kind === "ready" && (
          <footer className="settings-dialog__footer">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={onClose}
              disabled={state.saving}
            >
              취소
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void handleSave()}
              disabled={state.saving}
            >
              {state.saving ? "저장 중…" : "저장"}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
};
