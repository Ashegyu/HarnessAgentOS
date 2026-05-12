import { useEffect, useState, type KeyboardEvent } from "react";
import type { OrchestrationMode } from "@harness/core";
import { ORCHESTRATION_MODES } from "@harness/core";

export type ConversationMode = "template" | "agent";

interface ConversationInputProps {
  threadId: string | null;
  threadTargetDir?: string | undefined;
  /** Whether at least one agent CLI provider is currently available. */
  agentAvailable: boolean;
  onSubmit: (input: {
    userRequest: string;
    targetDir?: string;
    mode: ConversationMode;
    orchMode?: OrchestrationMode;
    orchInstruction?: string;
  }) => Promise<void>;
}

export const ConversationInput = ({
  threadId,
  threadTargetDir,
  agentAvailable,
  onSubmit,
}: ConversationInputProps): JSX.Element => {
  const [text, setText] = useState("");
  const [overrideDir, setOverrideDir] = useState("");
  const [showDirOverride, setShowDirOverride] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ConversationMode>("template");

  const [orchEnabled, setOrchEnabled] = useState(false);
  const [orchExpanded, setOrchExpanded] = useState(false);
  const [orchMode, setOrchMode] = useState<OrchestrationMode>("single_worker");
  const [orchInstruction, setOrchInstruction] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const s = await window.harness.settings.get();
        if (s.orchestration.enabled) {
          setOrchEnabled(true);
          setOrchMode(s.orchestration.defaultMode);
          if (s.orchestration.defaultInstructions) {
            setOrchInstruction(s.orchestration.defaultInstructions);
          }
        }
      } catch {
        // settings unavailable — orch stays hidden
      }
    })();
  }, []);

  const targetDir = overrideDir.trim() || threadTargetDir || "";
  const canSubmit = !submitting && text.trim().length > 0 && targetDir.length > 0;

  // If agent becomes unavailable, drop back to template so the submit
  // can't fail with AGENT_PROVIDER_UNAVAILABLE mid-flow.
  if (mode === "agent" && !agentAvailable) {
    setMode("template");
  }

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload: {
        userRequest: string;
        targetDir?: string;
        mode: ConversationMode;
        orchMode?: OrchestrationMode;
        orchInstruction?: string;
      } = {
        userRequest: text.trim(),
        mode,
      };
      if (overrideDir.trim().length > 0) payload.targetDir = overrideDir.trim();
      else if (!threadTargetDir) payload.targetDir = targetDir;
      if (orchEnabled && orchExpanded) {
        payload.orchMode = orchMode;
        if (orchInstruction.trim().length > 0)
          payload.orchInstruction = orchInstruction.trim();
      }
      await onSubmit(payload);
      setText("");
      setOverrideDir("");
      setShowDirOverride(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="conversation-input">
      <div className="conversation-input__targetdir">
        <span className="conversation-input__label">대상 폴더</span>
        {showDirOverride ? (
          <input
            className="conversation-input__dir"
            type="text"
            value={overrideDir}
            onChange={(e) => setOverrideDir(e.target.value)}
            placeholder={threadTargetDir ?? "절대 경로 입력"}
            disabled={submitting}
          />
        ) : (
          <span className="conversation-input__dir-display" title={targetDir}>
            {targetDir.length > 0 ? targetDir : "미설정"}
          </span>
        )}
        {showDirOverride ? (
          <button
            type="button"
            className="conversation-input__dir-toggle"
            onClick={async () => {
              setError(null);
              try {
                const picked = await window.harness.app.selectDirectory();
                if (picked) setOverrideDir(picked);
              } catch (e) {
                setError(
                  `폴더 선택 실패: ${e instanceof Error ? e.message : String(e)}`,
                );
              }
            }}
            disabled={submitting}
          >
            찾아보기…
          </button>
        ) : null}
        <button
          type="button"
          className="conversation-input__dir-toggle"
          onClick={() => setShowDirOverride((v) => !v)}
          disabled={submitting}
        >
          {showDirOverride ? "닫기" : "변경"}
        </button>
      </div>
      <div
        className="conversation-input__mode"
        role="radiogroup"
        aria-label="Plan mode"
      >
        <button
          type="button"
          role="radio"
          aria-checked={mode === "template"}
          className={
            mode === "template"
              ? "conversation-input__mode-btn conversation-input__mode-btn--active"
              : "conversation-input__mode-btn"
          }
          onClick={() => setMode("template")}
          disabled={submitting}
        >
          Template
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === "agent"}
          className={
            mode === "agent"
              ? "conversation-input__mode-btn conversation-input__mode-btn--active"
              : "conversation-input__mode-btn"
          }
          onClick={() => agentAvailable && setMode("agent")}
          disabled={submitting || !agentAvailable}
          title={agentAvailable ? "" : "CLI provider 미설치"}
        >
          Agent {agentAvailable ? "" : "(미설치)"}
        </button>
      </div>
      {orchEnabled && (
        <div className="conversation-input__orch">
          <button
            type="button"
            className="conversation-input__orch-toggle"
            onClick={() => setOrchExpanded((v) => !v)}
            disabled={submitting}
          >
            {orchExpanded ? "▾" : "▸"} Orchestration
          </button>
          {orchExpanded && (
            <div className="conversation-input__orch-form">
              <label className="conversation-input__orch-field">
                <span>Mode</span>
                <select
                  value={orchMode}
                  onChange={(e) => setOrchMode(e.target.value as OrchestrationMode)}
                  disabled={submitting}
                >
                  {ORCHESTRATION_MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label className="conversation-input__orch-field">
                <span>Instruction (선택)</span>
                <input
                  type="text"
                  value={orchInstruction}
                  onChange={(e) => setOrchInstruction(e.target.value)}
                  placeholder="planner에게 전달할 지시"
                  disabled={submitting}
                />
              </label>
            </div>
          )}
        </div>
      )}
      <textarea
        className="conversation-input__text"
        placeholder={
          threadId
            ? "작업을 자연어로 입력하세요. Enter=전송, Shift+Enter=줄바꿈."
            : "왼쪽에서 스레드를 선택하거나 새로 만든 뒤 입력하세요."
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={submitting || threadId === null}
        rows={3}
      />
      {error && <div className="conversation-input__error">{error}</div>}
      <div className="conversation-input__footer">
        <span className="conversation-input__hint">
          {submitting
            ? mode === "agent"
              ? "Agent 호출 중…"
              : "계획 생성 중…"
            : mode === "agent"
              ? "Agent CLI가 plan과 approval을 생성합니다 — 모든 side effect는 승인 후 실행."
              : "전송하면 plan / before_edit checkpoint / approval이 생성됩니다."}
        </span>
        <button type="button" disabled={!canSubmit} onClick={() => void submit()}>
          {submitting ? "처리 중…" : "전송"}
        </button>
      </div>
    </div>
  );
};
