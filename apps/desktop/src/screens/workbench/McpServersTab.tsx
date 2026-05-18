import { useCallback, useEffect, useMemo, useState } from "react";
import type { McpServerConfig, McpServerHealth } from "@harness/core";
import {
  emptyServerDraft,
  serializeServerDraft,
  serverDraftFromConfig,
  validateServerDraft,
  type ServerDraft,
} from "./mcp-server-form";

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; servers: McpServerConfig[] }
  | { kind: "error"; message: string };

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const summarizeHealth = (h: McpServerHealth | undefined): string => {
  if (!h) return "체크 안 함";
  if (h.error) return `실패: ${h.error}`;
  if (h.okAt) return `OK · ${new Date(h.okAt).toLocaleTimeString()}`;
  return `검사: ${new Date(h.checkedAt).toLocaleTimeString()}`;
};

export const McpServersTab = (): JSX.Element => {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ServerDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const servers = await window.harness.mcp.list();
      setList({ kind: "ready", servers });
    } catch (e) {
      setList({ kind: "error", message: errorMessage(e) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (list.kind !== "ready") return;
    if (selectedId === null) {
      setDraft(null);
      return;
    }
    if (selectedId === "__new__") {
      setDraft(emptyServerDraft());
      return;
    }
    const found = list.servers.find((s) => s.id === selectedId);
    setDraft(found ? serverDraftFromConfig(found) : null);
  }, [selectedId, list]);

  const validationErrors = useMemo(
    () => (draft ? validateServerDraft(draft) : []),
    [draft],
  );

  const updateDraft = <K extends keyof ServerDraft>(
    field: K,
    value: ServerDraft[K],
  ): void => {
    setDraft((d) => (d ? { ...d, [field]: value } : d));
  };

  const handleSave = async (): Promise<void> => {
    if (!draft || validationErrors.length > 0) return;
    setSaving(true);
    setError(null);
    try {
      const payload = serializeServerDraft(draft);
      // For brand-new drafts the IPC layer ignores `id` and mints one;
      // for updates we pass the existing id through.
      const result = await window.harness.mcp.upsert({
        server: {
          ...(payload as McpServerConfig),
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      });
      await refresh();
      setSelectedId(result.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!draft || draft.id === null) return;
    if (!window.confirm(`"${draft.name}" MCP 서버를 제거하시겠습니까?`)) return;
    setSaving(true);
    setError(null);
    try {
      await window.harness.mcp.delete({ serverId: draft.id });
      await refresh();
      setSelectedId(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (s: McpServerConfig): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await window.harness.mcp.toggle({ serverId: s.id, enabled: !s.enabled });
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const handleHealthCheck = async (s: McpServerConfig): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const health = await window.harness.mcp.healthCheck({ serverId: s.id });
      const msg = health.error
        ? `Health check 실패: ${health.error}`
        : health.okAt
          ? "Health check OK"
          : `Health check 완료: ${new Date(health.checkedAt).toLocaleTimeString()}`;
      setError(msg);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mcp-servers-tab">
      <div className="mcp-servers-tab__banner" role="note">
        <strong>Claude CLI MCP 통합 활성화됨.</strong>{" "}
        활성화된 서버는 다음 agent invocation에서 `--mcp-config` 인자를 통해
        자동으로 연결됩니다. <em>per-agent</em> scope 서버는 현재 활성
        AgentProfile의 <code>mcpServerIds</code>에 포함된 경우에만 연결됩니다.
        Codex CLI MCP 인자 형식은 아직 검증되지 않아 claude provider에서만
        동작합니다.
      </div>

      <div className="mcp-servers-tab__split">
        <aside className="mcp-servers-tab__list">
          <header className="mcp-servers-tab__list-header">
            <span>서버</span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setSelectedId("__new__")}
              disabled={saving}
            >
              + 새 서버
            </button>
          </header>
          {list.kind === "loading" && (
            <div className="empty-state">불러오는 중…</div>
          )}
          {list.kind === "error" && (
            <div
              className="empty-state"
              style={{ color: "var(--status-failed)" }}
            >
              {list.message}
            </div>
          )}
          {list.kind === "ready" && list.servers.length === 0 && (
            <div className="empty-state">
              등록된 MCP 서버가 없습니다.
            </div>
          )}
          {list.kind === "ready" && (
            <ul className="mcp-servers-tab__items">
              {list.servers.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`mcp-servers-tab__item${
                      selectedId === s.id ? " mcp-servers-tab__item--selected" : ""
                    }`}
                    onClick={() => setSelectedId(s.id)}
                  >
                    <span className="mcp-servers-tab__item-name">
                      {s.name}{" "}
                      {!s.enabled && (
                        <span className="mcp-servers-tab__item-disabled">
                          (off)
                        </span>
                      )}
                    </span>
                    <span className="mcp-servers-tab__item-meta">
                      {s.transport}
                      {s.transport === "stdio" && s.command
                        ? ` · ${s.command.split(/[\\/]/).pop()}`
                        : s.url
                          ? ` · ${s.url}`
                          : ""}
                    </span>
                    <span className="mcp-servers-tab__item-health">
                      {summarizeHealth(s.lastHealth)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="mcp-servers-tab__editor">
          {draft === null ? (
            <div className="empty-state">
              MCP 서버를 선택하거나 새로 만들어 편집하세요.
            </div>
          ) : (
            <div className="mcp-servers-tab__form">
              <h3 className="mcp-servers-tab__heading">
                {draft.id === null ? "새 MCP 서버" : draft.name || "(이름 없음)"}
              </h3>

              <fieldset className="settings-fieldset">
                <legend>Identity</legend>
                <label className="settings-field">
                  <span className="settings-field__label">이름</span>
                  <input
                    type="text"
                    className="settings-field__input"
                    value={draft.name}
                    disabled={saving}
                    onChange={(e) => updateDraft("name", e.target.value)}
                  />
                </label>
                <label className="settings-field">
                  <span className="settings-field__label">설명</span>
                  <textarea
                    className="settings-field__input settings-field__textarea settings-field__textarea--compact"
                    value={draft.description}
                    disabled={saving}
                    onChange={(e) =>
                      updateDraft("description", e.target.value)
                    }
                  />
                </label>
                <label className="settings-field">
                  <span className="settings-field__label">Scope</span>
                  <select
                    className="settings-field__input"
                    value={draft.scope}
                    disabled={saving}
                    onChange={(e) =>
                      updateDraft(
                        "scope",
                        e.target.value as ServerDraft["scope"],
                      )
                    }
                  >
                    <option value="global">global (모든 프로필 후보)</option>
                    <option value="per-agent">per-agent (특정 프로필만)</option>
                  </select>
                </label>
                <label className="settings-field settings-field--checkbox">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    disabled={saving}
                    onChange={(e) => updateDraft("enabled", e.target.checked)}
                  />
                  <span className="settings-field__label">활성화</span>
                </label>
              </fieldset>

              <fieldset className="settings-fieldset">
                <legend>Transport</legend>
                <label className="settings-field">
                  <span className="settings-field__label">Transport</span>
                  <select
                    className="settings-field__input"
                    value={draft.transport}
                    disabled={saving}
                    onChange={(e) =>
                      updateDraft(
                        "transport",
                        e.target.value as ServerDraft["transport"],
                      )
                    }
                  >
                    <option value="stdio">stdio (로컬 프로세스 spawn)</option>
                    <option value="http">http (원격 endpoint)</option>
                    <option value="sse">sse (server-sent events)</option>
                  </select>
                </label>

                {draft.transport === "stdio" ? (
                  <>
                    <label className="settings-field">
                      <span className="settings-field__label">
                        실행 파일 경로
                      </span>
                      <input
                        type="text"
                        className="settings-field__input"
                        placeholder="/usr/local/bin/mcp-fs"
                        value={draft.command}
                        disabled={saving}
                        onChange={(e) => updateDraft("command", e.target.value)}
                      />
                    </label>
                    <label className="settings-field">
                      <span className="settings-field__label">
                        인자 (공백 구분)
                      </span>
                      <input
                        type="text"
                        className="settings-field__input"
                        placeholder="--root /tmp"
                        value={draft.argsText}
                        disabled={saving}
                        onChange={(e) =>
                          updateDraft("argsText", e.target.value)
                        }
                      />
                    </label>
                  </>
                ) : (
                  <label className="settings-field">
                    <span className="settings-field__label">URL</span>
                    <input
                      type="text"
                      className="settings-field__input"
                      placeholder="https://mcp.example.com/v1"
                      value={draft.url}
                      disabled={saving}
                      onChange={(e) => updateDraft("url", e.target.value)}
                    />
                  </label>
                )}
              </fieldset>

              <fieldset className="settings-fieldset">
                <legend>환경변수</legend>
                <label className="settings-field">
                  <span className="settings-field__label">
                    env (각 줄 KEY=VALUE)
                  </span>
                  <textarea
                    className="settings-field__input settings-field__textarea"
                    rows={3}
                    value={draft.envText}
                    placeholder={"LOG_LEVEL=info\nFLAG="}
                    disabled={saving}
                    onChange={(e) => updateDraft("envText", e.target.value)}
                  />
                </label>
                <label className="settings-field">
                  <span className="settings-field__label">
                    envSecretRefs (KEY=secret_vault_key)
                  </span>
                  <textarea
                    className="settings-field__input settings-field__textarea"
                    rows={3}
                    value={draft.envSecretRefsText}
                    placeholder={"API_TOKEN=mcp_fs_token"}
                    disabled={saving}
                    onChange={(e) =>
                      updateDraft("envSecretRefsText", e.target.value)
                    }
                  />
                  <span className="settings-field__hint">
                    Vault에 저장된 secret 키 이름만 적습니다. 실제 값은 spawn
                    시점에 main process가 복호화하여 주입합니다.
                  </span>
                </label>
              </fieldset>

              {validationErrors.length > 0 && (
                <div
                  className="mcp-servers-tab__errors"
                  role="alert"
                  style={{ color: "var(--status-failed)" }}
                >
                  <strong>저장 전 수정:</strong>
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

              <div className="mcp-servers-tab__actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void handleSave()}
                  disabled={saving || validationErrors.length > 0}
                >
                  {saving ? "저장 중…" : draft.id === null ? "생성" : "저장"}
                </button>
                {draft.id !== null && list.kind === "ready" && (
                  <>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => {
                        const target = list.servers.find(
                          (s) => s.id === draft.id,
                        );
                        if (target) void handleToggle(target);
                      }}
                      disabled={saving}
                    >
                      {draft.enabled ? "비활성화" : "활성화"}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => {
                        const target = list.servers.find(
                          (s) => s.id === draft.id,
                        );
                        if (target) void handleHealthCheck(target);
                      }}
                      disabled={saving}
                    >
                      Health check
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--danger"
                      onClick={() => void handleDelete()}
                      disabled={saving}
                    >
                      삭제
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
