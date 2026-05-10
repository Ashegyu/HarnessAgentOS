import { useState, type KeyboardEvent } from "react";

interface ConversationInputProps {
  threadId: string | null;
  threadTargetDir?: string | undefined;
  onSubmit: (input: { userRequest: string; targetDir?: string }) => Promise<void>;
}

export const ConversationInput = ({
  threadId,
  threadTargetDir,
  onSubmit,
}: ConversationInputProps): JSX.Element => {
  const [text, setText] = useState("");
  const [overrideDir, setOverrideDir] = useState("");
  const [showDirOverride, setShowDirOverride] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetDir = overrideDir.trim() || threadTargetDir || "";
  const canSubmit = !submitting && text.trim().length > 0 && targetDir.length > 0;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload: { userRequest: string; targetDir?: string } = {
        userRequest: text.trim(),
      };
      if (overrideDir.trim().length > 0) payload.targetDir = overrideDir.trim();
      else if (!threadTargetDir) payload.targetDir = targetDir;
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
            ? "계획 생성 중…"
            : "전송하면 plan / before_edit checkpoint / approval이 생성됩니다."}
        </span>
        <button type="button" disabled={!canSubmit} onClick={() => void submit()}>
          {submitting ? "처리 중…" : "전송"}
        </button>
      </div>
    </div>
  );
};
