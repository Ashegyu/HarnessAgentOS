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
import { SkillSourcesTab } from "./SkillSourcesTab";

interface Props {
  onClose: () => void;
  initialTopologyTaskRunId?: string | null;
}

type SettingsTabId =
  | "general"
  | "agents"
  | "remoteAgents"
  | "pipelines"
  | "mcp"
  | "skills"
  | "secrets";

interface SettingsTabDef {
  id: SettingsTabId;
  label: string;
}

const TABS: readonly SettingsTabDef[] = [
  { id: "general", label: "General" },
  { id: "agents", label: "Agents" },
  { id: "remoteAgents", label: "Remote Agents" },
  { id: "pipelines", label: "Pipelines" },
  { id: "mcp", label: "MCP" },
  { id: "skills", label: "Skills" },
  { id: "secrets", label: "Secrets" },
];

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
    return { ...state, draft: { ...state.draft, approval: { ...state.draft.approval, autoExecuteWorkerFileActions: action.value } } };
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
          <span>설정</span>
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

        {activeTab === "agents" && (
          <div className="settings-dialog__body settings-dialog__body--flush">
            <AgentProfilesTab />
          </div>
        )}

        {activeTab === "pipelines" && (
          <div className="settings-dialog__body settings-dialog__body--flush">
            <PipelinesTab initialTopologyTaskRunId={initialTopologyTaskRunId} />
          </div>
        )}

        {activeTab === "remoteAgents" && (
          <div className="settings-dialog__body settings-dialog__body--flush">
            <RemoteAgentsTab />
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

        {activeTab === "secrets" && (
          <div className="settings-dialog__body">
            <SecretsTab />
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
              </label>
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
                Worker가 제안한 file_write approval만 자동 처리합니다. 일반 file_write,
                shell, network, git_commit, orchestration_plan은 포함하지 않으며 Agent
                Profile의 Block 설정이 계속 우선합니다.
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
