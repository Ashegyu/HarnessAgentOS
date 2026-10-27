import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useI18n } from "../../app/i18n";

type CopyStatus = "idle" | "copying" | "copied" | "error";

export const AnswerCopyButton = ({ text, disabled = false }: { text: string; disabled?: boolean }): JSX.Element | null => {
  const { tk } = useI18n();
  const [status, setStatus] = useState<CopyStatus>("idle");
  const requestRef = useRef(0);
  const pendingRef = useRef(false);

  useEffect(() => {
    requestRef.current += 1;
    pendingRef.current = false;
    setStatus("idle");
    return () => { requestRef.current += 1; };
  }, [text]);

  const copy = async (event: MouseEvent<HTMLButtonElement>): Promise<void> => {
    // Copying a saved answer must not select another task or toggle a section.
    event.stopPropagation();
    if (disabled || pendingRef.current) return;
    pendingRef.current = true;
    const requestId = ++requestRef.current;
    setStatus("copying");
    try {
      await window.harness.app.copyText({ text });
      if (requestId === requestRef.current) setStatus("copied");
    } catch {
      if (requestId === requestRef.current) setStatus("error");
    } finally {
      if (requestId === requestRef.current) pendingRef.current = false;
    }
  };

  if (text.trim().length === 0) return null;
  const label = status === "copied" ? tk("answer.copied")
    : status === "copying" ? tk("answer.copying") : tk("answer.copy");
  return (
    <span className="answer-copy" data-ui-text>
      <button
        type="button"
        className="answer-copy__button"
        aria-label={tk("answer.copy")}
        title={tk("answer.copyHint")}
        disabled={disabled || status === "copying"}
        onClick={(event) => { void copy(event); }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <rect x="8" y="8" width="12" height="13" rx="2" />
          <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
        </svg>
        <span role="status" aria-live="polite">{label}</span>
      </button>
      {status === "error" && <span className="answer-copy__error" role="alert">{tk("answer.copyFailed")}</span>}
    </span>
  );
};
