import { useEffect, useReducer } from "react";
import type {
  AgentProvider,
  HarnessSettings,
  OrchestrationMode,
  WorkerProfile,
  WorkerRole,
} from "@harness/core";

interface Props {
  onClose: () => void;
}

type PanelState =
  | { kind: "loading" }
  | { kind: "ready"; settings: HarnessSettings; saving: boolean; error: string | null }
  | { kind: "error"; message: string };

type Action =
  | { type: "loaded"; settings: HarnessSettings }
  | { type: "loadError"; message: string }
  | { type: "setEnabled"; value: boolean }
  | { type: "setMode"; value: OrchestrationMode }
  | { type: "setInstructions"; value: string }
  | { type: "addProfile" }
  | { type: "removeProfile"; id: string }
  | { type: "updateProfile"; profile: WorkerProfile }
  | { type: "saving" }
  | { type: "saved"; settings: HarnessSettings }
  | { type: "saveError"; message: string };

const reducer = (state: PanelState, action: Action): PanelState => {
  if (action.type === "loaded") {
    return { kind: "ready", settings: action.settings, saving: false, error: null };
  }
  if (action.type === "loadError") {
    return { kind: "error", message: action.message };
  }
  if (state.kind !== "ready") return state;
  const orch = state.settings.orchestration;
  switch (action.type) {
    case "setEnabled":
      return { ...state, settings: { ...state.settings, orchestration: { ...orch, enabled: action.value } } };
    case "setMode":
      return { ...state, settings: { ...state.settings, orchestration: { ...orch, defaultMode: action.value } } };
    case "setInstructions":
      return { ...state, settings: { ...state.settings, orchestration: { ...orch, defaultInstructions: action.value } } };
    case "addProfile": {
      const newProfile: WorkerProfile = {
        id: crypto.randomUUID(),
        name: "New Agent",
        provider: "auto",
        model: "",
        role: "coder",
      };
      return {
        ...state,
        settings: {
          ...state.settings,
          orchestration: { ...orch, workerProfiles: [...orch.workerProfiles, newProfile] },
        },
      };
    }
    case "removeProfile":
      return {
        ...state,
        settings: {
          ...state.settings,
          orchestration: { ...orch, workerProfiles: orch.workerProfiles.filter((p) => p.id !== action.id) },
        },
      };
    case "updateProfile":
      return {
        ...state,
        settings: {
          ...state.settings,
          orchestration: {
            ...orch,
            workerProfiles: orch.workerProfiles.map((p) =>
              p.id === action.profile.id ? action.profile : p,
            ),
          },
        },
      };
    case "saving":
      return { ...state, saving: true, error: null };
    case "saved":
      return { ...state, saving: false, settings: action.settings };
    case "saveError":
      return { ...state, saving: false, error: action.message };
    default:
      return state;
  }
};

const MODES: { value: OrchestrationMode; label: string; desc: string }[] = [
  { value: "single_worker", label: "Single Worker", desc: "에이전트 하나가 모든 작업 처리" },
  { value: "planner_worker", label: "Planner + Worker", desc: "플래너가 계획하고 워커가 실행" },
  { value: "multi_worker", label: "Multi Worker", desc: "여러 에이전트가 병렬 처리" },
];

const ROLES: WorkerRole[] = ["planner", "coder", "reviewer", "tester"];
const PROVIDERS: AgentProvider[] = ["auto", "claude", "codex"];

const ROLE_LABELS: Record<WorkerRole, string> = {
  planner: "Planner",
  coder: "Coder",
  reviewer: "Reviewer",
  tester: "Tester",
};

export const AgentsPanel = ({ onClose }: Props): JSX.Element => {
  const [state, dispatch] = useReducer(reducer, { kind: "loading" });

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
      const saved = await window.harness.settings.update(state.settings);
      dispatch({ type: "saved", settings: saved });
    } catch (e) {
      dispatch({ type: "saveError", message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="agents-panel">
      <header className="agents-panel__header">
        <button
          type="button"
          className="agents-panel__back"
          onClick={onClose}
          aria-label="뒤로"
        >
          ←
        </button>
        <span className="agents-panel__title">Agents &amp; Orchestration</span>
      </header>

      {state.kind === "loading" && (
        <div className="agents-panel__body">
          <div className="empty-state">설정 불러오는 중…</div>
        </div>
      )}

      {state.kind === "error" && (
        <div className="agents-panel__body">
          <div className="empty-state" style={{ color: "var(--status-failed)" }}>
            {state.message}
          </div>
        </div>
      )}

      {state.kind === "ready" && (
        <>
          <div className="agents-panel__body">
            {/* Enable toggle */}
            <section className="agents-section">
              <div className="agents-section__enable-row">
                <div>
                  <div className="agents-section__title">Orchestration</div>
                  <div className="agents-section__desc">
                    여러 에이전트를 조율해 작업을 처리합니다
                  </div>
                </div>
                <label className="toggle-switch" aria-label="Orchestration 활성화">
                  <input
                    type="checkbox"
                    checked={state.settings.orchestration.enabled}
                    disabled={state.saving}
                    onChange={(e) =>
                      dispatch({ type: "setEnabled", value: e.target.checked })
                    }
                  />
                  <span className="toggle-switch__track" />
                </label>
              </div>
            </section>

            {/* Execution mode */}
            <section className="agents-section">
              <div className="agents-section__title">실행 모드</div>
              <div className="mode-cards">
                {MODES.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    className={`mode-card${state.settings.orchestration.defaultMode === m.value ? " mode-card--active" : ""}`}
                    disabled={state.saving}
                    onClick={() => dispatch({ type: "setMode", value: m.value })}
                  >
                    <span className="mode-card__label">{m.label}</span>
                    <span className="mode-card__desc">{m.desc}</span>
                  </button>
                ))}
              </div>
            </section>

            {/* Worker profiles */}
            <section className="agents-section">
              <div className="agents-section__header-row">
                <div className="agents-section__title">Worker Agents</div>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={state.saving}
                  onClick={() => dispatch({ type: "addProfile" })}
                >
                  + 에이전트 추가
                </button>
              </div>
              {state.settings.orchestration.workerProfiles.length === 0 ? (
                <div className="agents-empty-hint">
                  에이전트를 추가해 오케스트레이션을 구성하세요
                </div>
              ) : (
                <div className="worker-cards">
                  {state.settings.orchestration.workerProfiles.map((p) => (
                    <div key={p.id} className="worker-card">
                      <div className="worker-card__row">
                        <input
                          type="text"
                          className="worker-card__name"
                          placeholder="에이전트 이름"
                          value={p.name}
                          disabled={state.saving}
                          onChange={(e) =>
                            dispatch({ type: "updateProfile", profile: { ...p, name: e.target.value } })
                          }
                        />
                        <button
                          type="button"
                          className="worker-card__delete"
                          disabled={state.saving}
                          aria-label="삭제"
                          onClick={() => dispatch({ type: "removeProfile", id: p.id })}
                        >
                          ×
                        </button>
                      </div>
                      <div className="worker-card__fields">
                        <label className="worker-card__field">
                          <span>역할</span>
                          <select
                            value={p.role}
                            disabled={state.saving}
                            onChange={(e) =>
                              dispatch({ type: "updateProfile", profile: { ...p, role: e.target.value as WorkerRole } })
                            }
                          >
                            {ROLES.map((r) => (
                              <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                            ))}
                          </select>
                        </label>
                        <label className="worker-card__field">
                          <span>Provider</span>
                          <select
                            value={p.provider}
                            disabled={state.saving}
                            onChange={(e) =>
                              dispatch({ type: "updateProfile", profile: { ...p, provider: e.target.value as AgentProvider } })
                            }
                          >
                            {PROVIDERS.map((pr) => (
                              <option key={pr} value={pr}>{pr}</option>
                            ))}
                          </select>
                        </label>
                        <label className="worker-card__field worker-card__field--model">
                          <span>Model</span>
                          <input
                            type="text"
                            placeholder="기본값 사용"
                            value={p.model}
                            disabled={state.saving}
                            onChange={(e) =>
                              dispatch({ type: "updateProfile", profile: { ...p, model: e.target.value } })
                            }
                          />
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Default instructions */}
            <section className="agents-section">
              <div className="agents-section__title">기본 지시사항</div>
              <div className="agents-section__desc">플래너 에이전트에게 전달되는 기본 지시입니다</div>
              <textarea
                className="agents-instructions"
                rows={4}
                placeholder="예: 변경 전 반드시 테스트를 작성하세요. 코드 주석은 한국어로…"
                value={state.settings.orchestration.defaultInstructions}
                disabled={state.saving}
                onChange={(e) =>
                  dispatch({ type: "setInstructions", value: e.target.value })
                }
              />
            </section>

            {state.error && (
              <div className="agents-panel__error">{state.error}</div>
            )}
          </div>

          <footer className="agents-panel__footer">
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
        </>
      )}
    </div>
  );
};
