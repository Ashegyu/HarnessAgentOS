import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import type { AgentPipeline, OrchestrationMode } from "@harness/core";
import { FeatureHelpButton } from "./FeatureHelpButton";

export type ConversationMode = "template" | "agent";

const shortText = (text: string, max: number): string => {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
};

interface ConversationInputProps {
  threadId: string | null;
  threadTargetDir?: string | undefined;
  followUpTaskRun?: {
    id: string;
    ordinal: number;
    userRequest: string;
  } | null;
  /**
   * AgentPipeline.id remembered on the thread. Used as the dropdown's
   * initial pre-selection so a thread "remembers" the user's last
   * choice, but no longer overrides per-message routing — the user
   * picks (or changes) the pipeline for every submission via the
   * inline dropdown.
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
    followUpTaskRunId?: string;
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
  followUpTaskRun,
  agentAvailable,
  composerSeed,
  onSubmit,
}: ConversationInputProps): JSX.Element => {
  const [text, setText] = useState("");
  const [overrideDir, setOverrideDir] = useState("");
  const [showDirOverride, setShowDirOverride] = useState(false);
  const [includeFollowUpContext, setIncludeFollowUpContext] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mode: ConversationMode = agentAvailable ? "agent" : "template";

  // Per-message pipeline picker. The thread's `pipelineId` (if any) and
  // `settings.orchestration.defaultPipelineId` pre-fill the dropdown, but
  // the user can change it for every submission. Legacy mode + ad-hoc
  // instruction stay available in the side OrchestrationPanel for users
  // who want fine-grained control.
  const [orchEnabled, setOrchEnabled] = useState(false);
  const [orchPipelineId, setOrchPipelineId] = useState<string>("");
  const [pipelines, setPipelines] = useState<AgentPipeline[]>([]);

  const refreshPipelines = useCallback(
    async (preferredId?: string): Promise<void> => {
      try {
        const list = await window.harness.pipeline.list();
        setPipelines(list);
        // Priority: explicit preferred (thread binding or settings
        // default) → current selection if still valid → empty (=
        // "(없음 — 일반 채팅)" so the user sees the no-pipeline option
        // unless they had something explicitly set).
        setOrchPipelineId((prev) => {
          if (preferredId && list.some((p) => p.id === preferredId)) {
            return preferredId;
          }
          if (prev.length > 0 && list.some((p) => p.id === prev)) {
            return prev;
          }
          return "";
        });
      } catch {
        // Pipeline namespace unavailable — the picker stays empty and
        // submissions go through the regular chat path.
      }
    },
    [],
  );

  // Resolve the preferred initial pipeline:
  // 1. thread binding (the per-thread "remembered" choice) — wins
  // 2. settings.orchestration.defaultPipelineId — global default
  // 3. empty — user must opt in for this message
  const computePreferredId = useCallback(
    (settingsDefault: string): string | undefined => {
      if (threadPipelineId && threadPipelineId.length > 0) {
        return threadPipelineId;
      }
      if (settingsDefault.length > 0) return settingsDefault;
      return undefined;
    },
    [threadPipelineId],
  );

  // On mount: load orchestration enabled flag + pipeline list. The
  // dropdown is then ready to use without further interaction.
  useEffect(() => {
    void (async () => {
      let settingsDefault = "";
      try {
        const s = await window.harness.settings.get();
        if (s.orchestration.enabled) setOrchEnabled(true);
        settingsDefault = s.orchestration.defaultPipelineId;
      } catch {
        // Settings unavailable — orch picker stays hidden.
      }
      await refreshPipelines(computePreferredId(settingsDefault));
    })();
  }, [refreshPipelines, computePreferredId]);

  // Whenever the user switches to a different thread that carries its
  // own pipelineId, re-seed the dropdown to that thread's remembered
  // choice. The settings default still loses to a thread-specific
  // value.
  useEffect(() => {
    if (!threadPipelineId) return;
    setOrchPipelineId((prev) => {
      // Only override if the currently-selected pipeline is no longer
      // valid; otherwise leave whatever the user picked alone.
      if (prev === threadPipelineId) return prev;
      if (pipelines.some((p) => p.id === threadPipelineId)) {
        return threadPipelineId;
      }
      return prev;
    });
  }, [threadPipelineId, pipelines]);

  // Suggestion chip → composer text injection. Parent updates the seed
  // object reference (key changes) each time, so re-clicking the same
  // chip still triggers the effect.
  useEffect(() => {
    if (composerSeed && composerSeed.text.length > 0) {
      setText(composerSeed.text);
    }
  }, [composerSeed]);

  useEffect(() => {
    setIncludeFollowUpContext(followUpTaskRun !== null && followUpTaskRun !== undefined);
  }, [followUpTaskRun?.id]);

  const targetDir = overrideDir.trim() || threadTargetDir || "";
  const canSubmit = !submitting && text.trim().length > 0 && targetDir.length > 0;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload: {
        userRequest: string;
        targetDir?: string;
        followUpTaskRunId?: string;
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
      if (followUpTaskRun && includeFollowUpContext) {
        payload.followUpTaskRunId = followUpTaskRun.id;
      }
      // Per-message pipeline pick. Empty value means "(없음 — 일반
      // 채팅)" so we deliberately omit orchPipelineId from the payload
      // and the regular agent flow runs.
      if (orchEnabled && orchPipelineId.length > 0) {
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
        <span className="conversation-input__label">
          대상 폴더
          <FeatureHelpButton featureId="targetDir" />
        </span>
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
      {orchEnabled && pipelines.length > 0 && (
        <label className="conversation-input__pipeline" title="이번 메시지를 거칠 파이프라인을 선택하세요. 매 메시지마다 자유롭게 바꿀 수 있습니다.">
          <span className="conversation-input__pipeline-label">
            Pipeline
            <FeatureHelpButton featureId="pipelines" />
          </span>
          <select
            className="conversation-input__pipeline-select"
            value={orchPipelineId}
            onChange={(e) => setOrchPipelineId(e.target.value)}
            onFocus={() => void refreshPipelines()}
            disabled={submitting}
          >
            <option value="">(없음 — 일반 채팅)</option>
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.steps.length} steps)
              </option>
            ))}
          </select>
          {threadPipelineId && orchPipelineId === threadPipelineId && (
            <span className="conversation-input__pipeline-hint">
              스레드 기본값
            </span>
          )}
        </label>
      )}
      {followUpTaskRun ? (
        <label
          className={`conversation-input__followup${
            includeFollowUpContext ? " conversation-input__followup--active" : ""
          }`}
          title={followUpTaskRun.userRequest}
        >
          <input
            type="checkbox"
            checked={includeFollowUpContext}
            onChange={(e) => setIncludeFollowUpContext(e.target.checked)}
            disabled={submitting}
          />
          <span>이어받기</span>
          <strong>Task {followUpTaskRun.ordinal}</strong>
          <span className="conversation-input__followup-text">
            {shortText(followUpTaskRun.userRequest, 86)}
          </span>
        </label>
      ) : null}
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
              : "CLI provider가 없어 기본 plan / checkpoint / approval을 생성합니다."}
        </span>
        <button type="button" disabled={!canSubmit} onClick={() => void submit()}>
          {submitting ? "처리 중…" : "전송"}
        </button>
      </div>
    </div>
  );
};
