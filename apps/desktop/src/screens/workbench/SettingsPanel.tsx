import { useEffect, useReducer } from "react";
import type { AgentProvider, HarnessSettings } from "@harness/core";

interface Props {
  onClose: () => void;
}

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
    return { ...state, draft: { agent: { ...state.draft.agent, provider: action.value } } };
  }
  if (action.type === "setModel") {
    return { ...state, draft: { agent: { ...state.draft.agent, model: action.value } } };
  }
  if (action.type === "setTimeoutMs") {
    return { ...state, draft: { agent: { ...state.draft.agent, timeoutMs: action.value } } };
  }
  if (action.type === "setStallTimeoutMs") {
    return { ...state, draft: { agent: { ...state.draft.agent, stallTimeoutMs: action.value } } };
  }
  if (action.type === "setContextDepth") {
    return { ...state, draft: { agent: { ...state.draft.agent, contextDepth: action.value } } };
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

        {state.kind === "loading" && (
          <div className="settings-dialog__body empty-state">설정 불러오는 중…</div>
        )}

        {state.kind === "error" && (
          <div className="settings-dialog__body empty-state" style={{ color: "var(--status-failed)" }}>
            {state.message}
          </div>
        )}

        {state.kind === "ready" && (
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

            {state.error && (
              <div style={{ color: "var(--status-failed)", fontSize: 12, marginTop: 8 }}>
                {state.error}
              </div>
            )}
          </div>
        )}

        {state.kind === "ready" && (
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
