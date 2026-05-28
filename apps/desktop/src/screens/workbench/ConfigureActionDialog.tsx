import { useState } from "react";
import type {
  Approval,
  ProposedActionDetails,
  ProposedFilePatch,
  ProposedUnifiedPatch,
} from "@harness/core";

interface ConfigureActionDialogProps {
  approval: Approval;
  taskRunTargetDir: string;
  onSave: (details: ProposedActionDetails) => Promise<void>;
  onClose: () => void;
}

/**
 * Phase 3 modal that lets the user fill in concrete execution details
 * (`ProposedActionDetails`) for an approval before it is approved and
 * executed. The deterministic plan-drafter from Phase 2 leaves these
 * details empty, so the runner refuses to execute until they exist.
 */
export const ConfigureActionDialog = ({
  approval,
  taskRunTargetDir,
  onSave,
  onClose,
}: ConfigureActionDialogProps): JSX.Element => {
  const existing = approval.proposedAction;
  const [command, setCommand] = useState(existing?.command ?? "");
  const [path, setPath] = useState(
    existing?.filePatch?.path ?? existing?.unifiedPatch?.path ?? "",
  );
  const [before, setBefore] = useState(existing?.filePatch?.before ?? "");
  const [after, setAfter] = useState(existing?.filePatch?.after ?? "");
  const [patch, setPatch] = useState(existing?.unifiedPatch?.patch ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    try {
      const details: ProposedActionDetails = { type: approval.actionType };
      if (approval.actionType === "shell") {
        if (command.trim().length === 0) {
          setError("실행할 command를 입력하세요");
          return;
        }
        details.command = command.trim();
      } else if (approval.actionType === "file_write") {
        if (path.trim().length === 0) {
          setError("대상 파일 경로를 입력하세요");
          return;
        }
        const filePatch: ProposedFilePatch = {
          path: path.trim(),
          after,
        };
        if (before.length > 0) filePatch.before = before;
        details.filePatch = filePatch;
      } else if (approval.actionType === "file_patch") {
        if (path.trim().length === 0) {
          setError("대상 파일 경로를 입력하세요");
          return;
        }
        if (patch.trim().length === 0) {
          setError("unified diff patch를 입력하세요");
          return;
        }
        const unifiedPatch: ProposedUnifiedPatch = {
          path: path.trim(),
          patch,
        };
        details.unifiedPatch = unifiedPatch;
      } else {
        setError(`${approval.actionType} 타입은 Phase 3 MVP에서 실행 불가`);
        return;
      }
      setSubmitting(true);
      await onSave(details);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <header className="modal__header">
          <span>실행 세부 지정</span>
          <button type="button" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </header>
        <form className="modal__body" onSubmit={submit}>
          <div className="modal__row">
            <span className="modal__label">action</span>
            <code>{approval.actionType}</code>
          </div>
          <div className="modal__row">
            <span className="modal__label">summary</span>
            <span>{approval.actionSummary}</span>
          </div>
          <div className="modal__row">
            <span className="modal__label">targetDir</span>
            <code>{taskRunTargetDir}</code>
          </div>

          {approval.actionType === "shell" && (
            <label className="modal__field">
              <span>실행할 command</span>
              <textarea
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="예: npm test"
                rows={3}
              />
              <small>
                rm/del/git push/dependency install/network 등 위험한 패턴은 차단됩니다.
              </small>
            </label>
          )}

          {(approval.actionType === "file_write" ||
            approval.actionType === "file_patch") && (
            <>
              <label className="modal__field">
                <span>대상 파일 경로 (targetDir 기준)</span>
                <div className="modal__inline">
                  <input
                    type="text"
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    placeholder="예: src/foo.ts"
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={async () => {
                      setError(null);
                      try {
                        const picked = await window.harness.app.selectFile({
                          defaultDir: taskRunTargetDir,
                        });
                        if (!picked) return;
                        const rel = toRelativePath(picked, taskRunTargetDir);
                        if (!rel) {
                          setError(
                            "선택한 파일이 targetDir 밖에 있습니다. targetDir 안에서 다시 선택하세요.",
                          );
                          return;
                        }
                        setPath(rel);
                      } catch (e) {
                        setError(
                          `파일 선택 실패: ${e instanceof Error ? e.message : String(e)}`,
                        );
                      }
                    }}
                  >
                    찾아보기…
                  </button>
                </div>
              </label>
              {approval.actionType === "file_write" ? (
                <>
                  <label className="modal__field">
                    <span>before (선택, 비교 baseline)</span>
                    <textarea
                      value={before}
                      onChange={(e) => setBefore(e.target.value)}
                      rows={4}
                    />
                  </label>
                  <label className="modal__field">
                    <span>after (필수, 전체 교체 본문)</span>
                    <textarea
                      value={after}
                      onChange={(e) => setAfter(e.target.value)}
                      rows={6}
                    />
                  </label>
                </>
              ) : (
                <label className="modal__field">
                  <span>patch (필수, single-file unified diff)</span>
                  <textarea
                    value={patch}
                    onChange={(e) => setPatch(e.target.value)}
                    placeholder={"--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new"}
                    rows={10}
                  />
                </label>
              )}
            </>
          )}

          {error && <div className="modal__error">{error}</div>}
          <div className="modal__actions">
            <button type="button" onClick={onClose} disabled={submitting}>
              취소
            </button>
            <button type="submit" disabled={submitting}>
              {submitting ? "저장 중…" : "저장"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

/**
 * Returns the picked path relative to targetDir, or null when the picked
 * path is outside the targetDir tree. Handles both Windows and POSIX
 * separators: targetDir's style wins. Case-insensitive on Win drive
 * paths so `C:\foo` matches `c:\foo\bar`.
 */
const toRelativePath = (picked: string, targetDir: string): string | null => {
  const isWin = /^[a-zA-Z]:[\\/]|^\\\\/.test(targetDir);
  const sep = isWin ? "\\" : "/";
  const norm = (p: string): string =>
    isWin ? p.replace(/\//g, "\\") : p.replace(/\\/g, "/");
  const stripTrailing = (p: string): string => p.replace(/[\\/]+$/, "");
  const normalizedPicked = norm(picked);
  const normalizedTarget = stripTrailing(norm(targetDir));
  const cmp = (s: string): string => (isWin ? s.toLowerCase() : s);
  const cmpPicked = cmp(normalizedPicked);
  const cmpTarget = cmp(normalizedTarget);
  if (cmpPicked === cmpTarget) return null;
  if (!cmpPicked.startsWith(cmpTarget + sep)) return null;
  const rel = normalizedPicked.slice(normalizedTarget.length + 1);
  // Always return forward-slash style (matches existing placeholder).
  return rel.length > 0 ? rel.replace(/\\/g, "/") : null;
};
