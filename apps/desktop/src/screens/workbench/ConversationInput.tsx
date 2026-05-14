import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import type { AgentPipeline, OrchestrationMode } from "@harness/core";
import { ORCHESTRATION_MODES } from "@harness/core";

export type ConversationMode = "template" | "agent";

interface ConversationInputProps {
  threadId: string | null;
  threadTargetDir?: string | undefined;
  /**
   * AgentPipeline.id bound to the active thread. When set, the per-message
   * Orchestration toggle is hidden and submissions automatically include
   * this pipeline via WorkbenchShell's routing — the input shows a small
   * "Pipeline: <name>" badge so the user knows their messages will run
   * through that pipeline.
   */
  threadPipelineId?: string | undefined;
  /** Whether at least one agent CLI provider is currently available. */
  agentAvailable: boolean;
  /**
   * Optional seed payload to inject text into the composer (e.g. when a
   * suggestion chip is clicked). The object reference change triggers
   * the effect, so callers should pass a new object each time even if the
   * text is identical.
   */
  composerSeed?: { text: string; key: number } | null;
  onSubmit: (input: {
    userRequest: string;
    targetDir?: string;
    mode: ConversationMode;
    orchMode?: OrchestrationMode;
    orchInstruction?: string;
    /**
     * When set, the orchestration plan is synthesized from this
     * AgentPipeline instead of the hardcoded `orchMode` synthesizer.
     */
    orchPipelineId?: string;
  }) => Promise<void>;
}

export const ConversationInput = ({
  threadId,
  threadTargetDir,
  threadPipelineId,
  agentAvailable,
  composerSeed,
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
  const [orchPipelineId, setOrchPipelineId] = useState<string>("");
  const [pipelines, setPipelines] = useState<AgentPipeline[]>([]);
  const [showLegacyMode, setShowLegacyMode] = useState(false);

  const refreshPipelines = useCallback(
    async (preferredId?: string): Promise<void> => {
      try {
        const list = await window.harness.pipeline.list();
        setPipelines(list);
        if (list.length > 0) {
          // Priority: explicit preferred (from settings.defaultPipelineId) →
          // current selection → first available.
          setOrchPipelineId((prev) => {
            if (preferredId && list.some((p) => p.id === preferredId)) {
              return preferredId;
            }
            return list.some((p) => p.id === prev) ? prev : list[0]!.id;
          });
          setShowLegacyMode(false);
        } else {
          setShowLegacyMode(true);
        }
      } catch {
        // pipeline namespace unavailable — keep legacy-only behavior
        setShowLegacyMode(true);
      }
    },
    [],
  );

  // On mount: load settings once, then load pipelines (seeded with the
  // user's configured default pipeline if any).
  useEffect(() => {
    void (async () => {
      let preferredId: string | undefined;
      try {
        const s = await window.harness.settings.get();
        if (s.orchestration.enabled) {
          setOrchEnabled(true);
          setOrchMode(s.orchestration.defaultMode);
          if (s.orchestration.defaultInstructions) {
            setOrchInstruction(s.orchestration.defaultInstructions);
          }
        }
        if (s.orchestration.defaultPipelineId.length > 0) {
          preferredId = s.orchestration.defaultPipelineId;
        }
      } catch {
        // settings unavailable — orch stays hidden
      }
      await refreshPipelines(preferredId);
    })();
  }, [refreshPipelines]);

  // Refresh pipeline list whenever the user opens the Orchestration panel,
  // so pipelines created in Settings → Pipelines are visible immediately.
  useEffect(() => {
    if (orchExpanded) {
      void refreshPipelines();
    }
  }, [orchExpanded, refreshPipelines]);

  // Suggestion chip → composer text injection. Parent updates the seed
  // object reference (key changes) each time, so re-clicking the same
  // chip still triggers the effect.
  useEffect(() => {
    if (composerSeed && composerSeed.text.length > 0) {
      setText(composerSeed.text);
    }
  }, [composerSeed]);

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
        orchPipelineId?: string;
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
        // Pipeline takes precedence over mode when one is selected.
        if (orchPipelineId.length > 0)
          payload.orchPipelineId = orchPipelineId;
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
      {threadPipelineId && (() => {
        // Thread-level binding takes precedence: hide the legacy
        // per-message Orchestration toggle entirely and show a static
        // badge so the user knows their submissions auto-route through
        // the bound pipeline (WorkbenchShell.handleCreateTask).
        const bound = pipelines.find((p) => p.id === threadPipelineId);
        const label = bound
          ? `${bound.name} (${bound.steps.length} steps)`
          : "(삭제됨 — 일반 채팅으로 폴백)";
        return (
          <div
            className="conversation-input__orch"
            title="이 스레드는 파이프라인에 묶여 있어, 모든 메시지가 자동으로 이 파이프라인을 거칩니다."
          >
            <span className="conversation-input__orch-badge">
              ▣ Pipeline: <strong>{label}</strong>
            </span>
          </div>
        );
      })()}
      {!threadPipelineId && orchEnabled && (
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
              {pipelines.length > 0 && (
                <label className="conversation-input__orch-field">
                  <span>Pipeline</span>
                  <select
                    value={orchPipelineId}
                    onChange={(e) => setOrchPipelineId(e.target.value)}
                    disabled={submitting}
                  >
                    {pipelines.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.steps.length} steps)
                      </option>
                    ))}
                    <option value="">(없음 — Legacy mode 사용)</option>
                  </select>
                </label>
              )}
              {(showLegacyMode || orchPipelineId.length === 0) && (
                <label className="conversation-input__orch-field">
                  <span>Legacy Mode</span>
                  <select
                    value={orchMode}
                    onChange={(e) =>
                      setOrchMode(e.target.value as OrchestrationMode)
                    }
                    disabled={submitting || orchPipelineId.length > 0}
                  >
                    {ORCHESTRATION_MODES.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {pipelines.length > 0 && !showLegacyMode && (
                <button
                  type="button"
                  className="conversation-input__orch-toggle"
                  onClick={() => setShowLegacyMode(true)}
                  disabled={submitting}
                  style={{ alignSelf: "flex-start" }}
                >
                  Legacy mode 보기
                </button>
              )}
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
