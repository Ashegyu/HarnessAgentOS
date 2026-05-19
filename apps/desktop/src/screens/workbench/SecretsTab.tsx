import { useCallback, useEffect, useMemo, useState } from "react";
import {
  emptySecretDraft,
  validateSecretDraft,
  type SecretDraft,
} from "./secret-form";

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; keys: string[] }
  | { kind: "error"; message: string };

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export const SecretsTab = (): JSX.Element => {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [draft, setDraft] = useState<SecretDraft>(emptySecretDraft());
  const [showAdd, setShowAdd] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const keys = await window.harness.secret.listKeys();
      setList({ kind: "ready", keys: [...keys].sort() });
    } catch (e) {
      setList({ kind: "error", message: errorMessage(e) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const existing = list.kind === "ready" ? list.keys : [];
  const validationErrors = useMemo(
    () => validateSecretDraft(draft, existing),
    [draft, existing],
  );

  const handleAdd = async (): Promise<void> => {
    if (validationErrors.length > 0) return;
    setBusyKey("__new__");
    setError(null);
    try {
      await window.harness.secret.write({
        key: draft.key.trim(),
        value: draft.value,
      });
      setDraft(emptySecretDraft());
      setShowAdd(false);
      setReveal(false);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyKey(null);
    }
  };

  const handleClear = async (key: string): Promise<void> => {
    if (!window.confirm(`"${key}" secret을 삭제하시겠습니까? 복구할 수 없습니다.`))
      return;
    setBusyKey(key);
    setError(null);
    try {
      await window.harness.secret.clear({ key });
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="secrets-tab">
      <div className="secrets-tab__notice" role="note">
        <strong>Secret Vault.</strong> 저장된 값은 OS의 보안 저장소 (Windows
        DPAPI, macOS Keychain, libsecret) 로 암호화되며, renderer는 키 이름만
        볼 수 있습니다. 값을 다시 보거나 export하는 방법은 없습니다 — 잊어버린
        경우 삭제 후 재등록하세요.
      </div>

      <div className="secrets-tab__header">
        <h3 className="secrets-tab__heading">등록된 Secret 키</h3>
        {!showAdd && (
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => {
              setShowAdd(true);
              setDraft(emptySecretDraft());
              setError(null);
            }}
          >
            + 새 Secret
          </button>
        )}
      </div>

      {showAdd && (
        <div className="secrets-tab__add" aria-label="새 Secret 등록">
          <label className="settings-field">
            <span className="settings-field__label">키 이름</span>
            <input
              type="text"
              className="settings-field__input"
              placeholder="fs_token_key"
              autoComplete="off"
              spellCheck={false}
              value={draft.key}
              disabled={busyKey === "__new__"}
              onChange={(e) =>
                setDraft((d) => ({ ...d, key: e.target.value }))
              }
            />
            <span className="settings-field__hint">
              envSecretRefs에서 <code>ENV_NAME={"{이 키}"}</code> 형태로
              참조됩니다.
            </span>
          </label>
          <label className="settings-field">
            <span className="settings-field__label">값</span>
            <div className="secrets-tab__value-row">
              <input
                type={reveal ? "text" : "password"}
                className="settings-field__input"
                placeholder="값 (저장 후 다시 볼 수 없음)"
                autoComplete="off"
                spellCheck={false}
                value={draft.value}
                disabled={busyKey === "__new__"}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, value: e.target.value }))
                }
              />
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setReveal((r) => !r)}
                aria-label={reveal ? "값 숨기기" : "값 보기"}
              >
                {reveal ? "🙈" : "👁"}
              </button>
            </div>
            <span className="settings-field__hint">
              저장 직후 OS keychain에 암호화되어 보관되고 이 화면에서 평문으로
              다시 표시되지 않습니다. 잃어버리면 다시 입력해야 합니다.
            </span>
          </label>

          {validationErrors.length > 0 && (
            <div
              className="secrets-tab__errors"
              role="alert"
              style={{ color: "var(--status-failed)" }}
            >
              <ul>
                {validationErrors.map((e, i) => (
                  <li key={i}>{e.message}</li>
                ))}
              </ul>
            </div>
          )}

          {error && (
            <div style={{ color: "var(--status-failed)", marginTop: 8 }}>
              {error}
            </div>
          )}

          <div className="secrets-tab__add-actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setShowAdd(false);
                setDraft(emptySecretDraft());
                setError(null);
                setReveal(false);
              }}
              disabled={busyKey === "__new__"}
            >
              취소
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => void handleAdd()}
              disabled={
                busyKey === "__new__" || validationErrors.length > 0
              }
            >
              {busyKey === "__new__" ? "저장 중…" : "저장"}
            </button>
          </div>
        </div>
      )}

      {list.kind === "loading" && (
        <div className="empty-state">불러오는 중…</div>
      )}
      {list.kind === "error" && (
        <div className="empty-state" style={{ color: "var(--status-failed)" }}>
          {list.message}
        </div>
      )}
      {list.kind === "ready" && list.keys.length === 0 && (
        <div className="empty-state">
          저장된 secret이 없습니다. MCP 서버의 envSecretRefs에 사용할 키를
          여기에서 먼저 등록하세요.
        </div>
      )}
      {list.kind === "ready" && list.keys.length > 0 && (
        <ul className="secrets-tab__list">
          {list.keys.map((k) => (
            <li key={k} className="secrets-tab__item">
              <span className="secrets-tab__key">{k}</span>
              <span className="secrets-tab__status">●●●●●●●● (저장됨)</span>
              <button
                type="button"
                className="btn btn--ghost btn--sm btn--danger"
                onClick={() => void handleClear(k)}
                disabled={busyKey !== null}
                aria-label={`${k} 삭제`}
              >
                삭제
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
