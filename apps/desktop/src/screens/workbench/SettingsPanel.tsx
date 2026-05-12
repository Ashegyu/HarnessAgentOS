import { useEffect, useReducer, useState } from "react";
import type { AgentProvider, HarnessSettings, OrchestrationMode, WorkerProfile } from "@harness/core";
import { DEFAULT_HARNESS_SETTINGS } from "@harness/core";
import { AgentProfilesTab } from "./AgentProfilesTab";
import { McpServersTab } from "./McpServersTab";
import { PipelinesTab } from "./PipelinesTab";
import { SecretsTab } from "./SecretsTab";
import { SkillSourcesTab } from "./SkillSourcesTab";

interface Props {
  onClose: () => void;
}

type SettingsTabId =
  | "general"
  | "agents"
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
  | { type: "addWorkerProfile" }
  | { type: "removeWorkerProfile"; id: string }
  | { type: "updateWorkerProfile"; profile: WorkerProfile }
  | { type: "setAutoApprove"; value: boolean }
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
  if (action.type === "addWorkerProfile") {
    const newProfile: WorkerProfile = {
      id: crypto.randomUUID(),
      name: "New Worker",
      provider: "auto",
      model: "",
      role: "coder",
    };
    return { ...state, draft: { ...state.draft, orchestration: { ...state.draft.orchestration, workerProfiles: [...state.draft.orchestration.workerProfiles, newProfile] } } };
  }
  if (action.type === "removeWorkerProfile") {
    return { ...state, draft: { ...state.draft, orchestration: { ...state.draft.orchestration, workerProfiles: state.draft.orchestration.workerProfiles.filter((p) => p.id !== action.id) } } };
  }
  if (action.type === "updateWorkerProfile") {
    return { ...state, draft: { ...state.draft, orchestration: { ...state.draft.orchestration, workerProfiles: state.draft.orchestration.workerProfiles.map((p) => p.id === action.profile.id ? action.profile : p) } } };
  }
  if (action.type === "setAutoApprove") {
    return { ...state, draft: { ...state.draft, approval: { ...state.draft.approval, autoApprove: action.value } } };
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

export const SettingsPanel = ({ onClose }: Props): JSX.Element => {
  const [state, dispatch] = useReducer(reducer, { kind: "loading" });
  const [activeTab, setActiveTab] = useState<SettingsTabId>("general");

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
            <PipelinesTab />
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
                <span className="settings-field__label">Timeout (ms)</span>
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
                <span className="settings-field__label">Stall timeout (ms)</span>
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

              <label className="settings-field">
                <span className="settings-field__label">기본 Mode</span>
                <select
                  className="settings-field__input"
                  value={state.draft.orchestration.defaultMode}
                  disabled={state.saving}
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

              <div className="settings-field">
                <div className="settings-field__label-row">
                  <span className="settings-field__label">Worker Profiles</span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={state.saving}
                    onClick={() => dispatch({ type: "addWorkerProfile" })}
                  >
                    + 추가
                  </button>
                </div>
                {state.draft.orchestration.workerProfiles.length === 0 ? (
                  <p className="settings-field__hint">등록된 worker profile이 없습니다.</p>
                ) : (
                  <ul className="worker-profiles-list">
                    {state.draft.orchestration.workerProfiles.map((p) => (
                      <li key={p.id} className="worker-profile-item">
                        <input
                          type="text"
                          className="settings-field__input"
                          placeholder="이름"
                          value={p.name}
                          disabled={state.saving}
                          onChange={(e) =>
                            dispatch({ type: "updateWorkerProfile", profile: { ...p, name: e.target.value } })
                          }
                        />
                        <select
                          className="settings-field__input"
                          value={p.role}
                          disabled={state.saving}
                          onChange={(e) =>
                            dispatch({ type: "updateWorkerProfile", profile: { ...p, role: e.target.value as WorkerProfile["role"] } })
                          }
                        >
                          <option value="planner">planner</option>
                          <option value="coder">coder</option>
                          <option value="reviewer">reviewer</option>
                          <option value="tester">tester</option>
                        </select>
                        <select
                          className="settings-field__input"
                          value={p.provider}
                          disabled={state.saving}
                          onChange={(e) =>
                            dispatch({ type: "updateWorkerProfile", profile: { ...p, provider: e.target.value as AgentProvider } })
                          }
                        >
                          <option value="auto">auto</option>
                          <option value="claude">claude</option>
                          <option value="codex">codex</option>
                        </select>
                        <input
                          type="text"
                          className="settings-field__input"
                          placeholder="모델 (비워두면 기본값)"
                          value={p.model}
                          disabled={state.saving}
                          onChange={(e) =>
                            dispatch({ type: "updateWorkerProfile", profile: { ...p, model: e.target.value } })
                          }
                        />
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm btn--danger"
                          disabled={state.saving}
                          onClick={() => dispatch({ type: "removeWorkerProfile", id: p.id })}
                          aria-label="삭제"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
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
                  모든 approval 자동 승인 및 실행
                </span>
              </label>
              <p className="settings-field__hint" style={{ color: "var(--status-failed)" }}>
                ⚠ 켜면 file_write·shell뿐 아니라 dependency_install·git_commit·skill_script·network·orchestration_plan까지 사람의 확인 없이 자동 실행됩니다. orchestration_plan을 자동 승인하면 worker가 만드는 후속 approval도 연쇄적으로 자동 처리됩니다.
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
