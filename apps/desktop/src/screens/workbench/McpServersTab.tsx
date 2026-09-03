import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  McpServerConfig,
  McpServerGenerationPreviewResult,
  McpServerHealth,
  McpServerScaffoldPreviewResult,
  McpServerScaffoldProposalResult,
} from "@harness/core";
import {
  emptyServerDraft,
  MCP_PROVIDER_BOUNDARY_TEXT,
  mcpGeneratedDraftToFormDraft,
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
  const [generating, setGenerating] = useState(false);
  const [generationIntent, setGenerationIntent] = useState("");
  const [generationResult, setGenerationResult] =
    useState<McpServerGenerationPreviewResult | null>(null);
  const [scaffoldIntent, setScaffoldIntent] = useState("");
  const [scaffoldTargetDir, setScaffoldTargetDir] = useState("");
  const [scaffoldGenerating, setScaffoldGenerating] = useState(false);
  const [scaffoldProposing, setScaffoldProposing] = useState(false);
  const [scaffoldResult, setScaffoldResult] =
    useState<McpServerScaffoldPreviewResult | null>(null);
  const [scaffoldProposal, setScaffoldProposal] =
    useState<McpServerScaffoldProposalResult | null>(null);
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
      setDraft((current) =>
        current?.id === null ? current : emptyServerDraft(),
      );
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

  const handleNewServer = (): void => {
    setGenerationResult(null);
    setError(null);
    setDraft(emptyServerDraft());
    setSelectedId("__new__");
  };

  const handleGenerateDraft = async (): Promise<void> => {
    const userIntent = generationIntent.trim();
    if (userIntent.length === 0) {
      setError("MCP 서버 용도를 먼저 입력하세요.");
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      const result = await window.harness.mcp.generateServerDraft({
        request: { userIntent },
      });
      setGenerationResult(result);
      setSelectedId("__new__");
      setDraft(mcpGeneratedDraftToFormDraft(result.draft));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setGenerating(false);
    }
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
      setGenerationResult(null);
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
      setGenerationResult(null);
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

  const handleSelectScaffoldDir = async (): Promise<void> => {
    const selected = await window.harness.app.selectDirectory();
    if (selected) setScaffoldTargetDir(selected);
  };

  const handleGenerateScaffold = async (): Promise<void> => {
    const userIntent = scaffoldIntent.trim();
    const targetDir = scaffoldTargetDir.trim();
    if (userIntent.length === 0) {
      setError("MCP scaffold 용도를 먼저 입력하세요.");
      return;
    }
    if (targetDir.length === 0) {
      setError("MCP scaffold 대상 디렉터리를 선택하세요.");
      return;
    }
    setScaffoldGenerating(true);
    setScaffoldProposal(null);
    setError(null);
    try {
      const result = await window.harness.mcp.generateServerScaffoldDraft({
        request: { userIntent, targetDir },
      });
      setScaffoldResult(result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setScaffoldGenerating(false);
    }
  };

  const handleProposeScaffold = async (): Promise<void> => {
    if (!scaffoldResult || !scaffoldResult.preview.ok) return;
    setScaffoldProposing(true);
    setError(null);
    try {
      const result = await window.harness.mcp.proposeServerScaffold({
        draft: scaffoldResult.draft,
      });
      setScaffoldProposal(result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setScaffoldProposing(false);
    }
  };

  return (
    <div className="mcp-servers-tab">
      <div className="mcp-servers-tab__banner" role="note">
        <strong>Agent invocation MCP 통합 활성화됨.</strong>{" "}
        {MCP_PROVIDER_BOUNDARY_TEXT} <em>per-agent</em> scope 서버는 현재
        활성 AgentProfile의 <code>mcpServerIds</code>에 포함된 경우에만
        연결됩니다.
      </div>

      <div className="mcp-servers-tab__split">
        <aside className="mcp-servers-tab__list">
          <header className="mcp-servers-tab__list-header">
            <span>서버</span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={handleNewServer}
              disabled={saving || generating}
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
                    onClick={() => {
                      setGenerationResult(null);
                      setError(null);
                      setSelectedId(s.id);
                    }}
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
          <div className="mcp-servers-tab__generator">
            <label className="settings-field">
              <span className="settings-field__label">자동 초안</span>
              <textarea
                className="settings-field__input settings-field__textarea settings-field__textarea--compact"
                value={generationIntent}
                disabled={saving || generating}
                placeholder="예: GitHub 이슈를 읽는 stdio MCP 서버가 필요합니다. 토큰은 vault 키로만 연결합니다."
                onChange={(e) => setGenerationIntent(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void handleGenerateDraft()}
              disabled={saving || generating}
            >
              {generating ? "초안 생성 중…" : "초안 생성"}
            </button>
          </div>

          {generationResult && (
            <div className="mcp-servers-tab__preview" role="note">
              <strong>Preview:</strong>{" "}
              Codex config key{" "}
              <code>{generationResult.preview.sanitizedConfigKey}</code>
              {generationResult.draft.recommendedProfileIds.length > 0 && (
                <>
                  {" "}
                  · profile 후보{" "}
                  <code>
                    {generationResult.draft.recommendedProfileIds.join(", ")}
                  </code>
                </>
              )}
              <div>{generationResult.draft.rationale}</div>
              {generationResult.preview.errors.length > 0 && (
                <div
                  className="mcp-servers-tab__errors"
                  style={{ color: "var(--status-failed)" }}
                >
                  <strong>오류:</strong>
                  <ul>
                    {generationResult.preview.errors.map((issue, i) => (
                      <li key={i}>{issue.message}</li>
                    ))}
                  </ul>
                </div>
              )}
              {generationResult.preview.warnings.length > 0 && (
                <div className="mcp-servers-tab__warnings">
                  <strong>확인:</strong>
                  <ul>
                    {generationResult.preview.warnings.map((warning, i) => (
                      <li key={i}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="mcp-servers-tab__preview" role="region">
            <strong>MCP scaffold</strong>
            <label className="settings-field">
              <span className="settings-field__label">Scaffold intent</span>
              <textarea
                className="settings-field__input settings-field__textarea settings-field__textarea--compact"
                value={scaffoldIntent}
                disabled={saving || scaffoldGenerating || scaffoldProposing}
                placeholder="예: 현재 repo 검색을 위한 로컬 stdio MCP 서버 scaffold"
                onChange={(e) => {
                  setScaffoldIntent(e.target.value);
                  setScaffoldResult(null);
                  setScaffoldProposal(null);
                }}
              />
            </label>
            <div className="mcp-servers-tab__generator">
              <label className="settings-field">
                <span className="settings-field__label">대상 디렉터리</span>
                <input
                  type="text"
                  className="settings-field__input"
                  value={scaffoldTargetDir}
                  disabled={saving || scaffoldGenerating || scaffoldProposing}
                  onChange={(e) => {
                    setScaffoldTargetDir(e.target.value);
                    setScaffoldResult(null);
                    setScaffoldProposal(null);
                  }}
                />
              </label>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => void handleSelectScaffoldDir()}
                disabled={saving || scaffoldGenerating || scaffoldProposing}
              >
                선택
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => void handleGenerateScaffold()}
                disabled={saving || scaffoldGenerating || scaffoldProposing}
              >
                {scaffoldGenerating ? "생성 중…" : "scaffold preview"}
              </button>
            </div>

            {scaffoldResult && (
              <div>
                <div>{scaffoldResult.draft.rationale}</div>
                <div>
                  smoke: <code>{scaffoldResult.preview.smokeTestCommand}</code>
                </div>
                <ul>
                  {scaffoldResult.preview.files.map((file) => (
                    <li key={file.path}>
                      <code>{file.path}</code> · {file.rationale}
                    </li>
                  ))}
                </ul>
                {scaffoldResult.preview.errors.length > 0 && (
                  <div
                    className="mcp-servers-tab__errors"
                    style={{ color: "var(--status-failed)" }}
                  >
                    <strong>오류:</strong>
                    <ul>
                      {scaffoldResult.preview.errors.map((issue, i) => (
                        <li key={i}>{issue.message}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {scaffoldResult.preview.warnings.length > 0 && (
                  <div className="mcp-servers-tab__warnings">
                    <strong>확인:</strong>
                    <ul>
                      {scaffoldResult.preview.warnings.map((warning, i) => (
                        <li key={i}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {scaffoldResult.preview.ok && (
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    onClick={() => void handleProposeScaffold()}
                    disabled={saving || scaffoldProposing}
                  >
                    {scaffoldProposing
                      ? "proposal 생성 중…"
                      : "file_write approvals 생성"}
                  </button>
                )}
              </div>
            )}

            {scaffoldProposal && (
              <div className="mcp-servers-tab__warnings">
                <strong>Approval proposal:</strong>{" "}
                <code>{scaffoldProposal.approvals.length}</code>개 file_write
                approval 생성됨 · taskRun{" "}
                <code>{scaffoldProposal.taskRunId}</code>
              </div>
            )}
          </div>

          {error && draft === null && (
            <div style={{ color: "var(--status-failed)", marginBottom: 8 }}>
              {error}
            </div>
          )}

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
                  <span className="settings-field__hint">
                    UI에 노출되는 표시 이름입니다. 영문/숫자/하이픈으로 자동 정규화된 값이 Codex MCP config key가 되므로, 다른 enabled 서버와 충돌하지 않게 지으세요.
                  </span>
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
                  <span className="settings-field__hint">
                    이 서버가 어떤 tool을 노출하는지 한두 줄로. AgentProfile 편집 화면의 binding 목록에 노출됩니다.
                  </span>
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
                  <span className="settings-field__hint">
                    global은 활성화된 모든 Codex invocation에 자동 연결됩니다.
                    per-agent는 AgentProfile의 <code>mcpServerIds</code>에 포함된 경우에만 연결됩니다.
                  </span>
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
                <span className="settings-field__hint">
                  비활성화된 서버는 저장은 되지만 invocation에 연결되지 않습니다. envSecretRefs가 Vault에 등록되어 있고 config key 충돌이 없을 때만 활성화할 수 있습니다.
                </span>
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
                  <span className="settings-field__hint">
                    stdio는 로컬에서 명령을 spawn해 stdin/stdout으로 통신합니다.
                    http/sse는 원격 endpoint를 HEAD/GET으로 reach해 통신합니다.
                  </span>
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
                      <span className="settings-field__hint">
                        절대 경로 또는 PATH에서 찾을 수 있는 명령. <code>npx</code> 같은 launcher도 가능합니다 (인자에 패키지명을 적으세요).
                      </span>
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
                      <span className="settings-field__hint">
                        공백으로 구분합니다. 따옴표가 포함된 인자는 미지원 — 그런 경우 wrapper 스크립트를 만들어 command에 지정하세요.
                      </span>
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
                    <span className="settings-field__hint">
                      MCP endpoint의 전체 URL. Health check는 HEAD → 실패 시 GET으로 reach를 확인합니다 (3초 timeout).
                    </span>
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
                  <span className="settings-field__hint">
                    spawn 시점에 자식 프로세스에게 그대로 전달되는 평문 환경변수입니다. 비밀 값은 여기 적지 말고 아래 envSecretRefs를 쓰세요.
                  </span>
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
