import { useCallback, useEffect, useMemo, useState } from "react";
import type { A2ARegistryEntry } from "@harness/core";
import {
  emptyRemoteAgentDraft,
  remoteAgentDraftFromEndpoint,
  serializeRemoteAgentDraft,
  validateRemoteAgentDraft,
  type RemoteAgentDraft,
} from "./remote-agent-form";

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; entries: A2ARegistryEntry[] }
  | { kind: "error"; message: string };

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const cardSummary = (entry: A2ARegistryEntry): string => {
  if (!entry.card) return "Agent Card 없음";
  const version = entry.card.version ? ` · v${entry.card.version}` : "";
  return `${entry.card.agentName}${version}`;
};

export const RemoteAgentsTab = (): JSX.Element => {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RemoteAgentDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const entries = await window.harness.remoteAgents.list();
      setList({ kind: "ready", entries });
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
      setDraft(emptyRemoteAgentDraft());
      return;
    }
    const found = list.entries.find((entry) => entry.endpoint.id === selectedId);
    setDraft(found ? remoteAgentDraftFromEndpoint(found.endpoint) : null);
  }, [selectedId, list]);

  const selectedEntry =
    list.kind === "ready" && draft?.id
      ? list.entries.find((entry) => entry.endpoint.id === draft.id) ?? null
      : null;

  const validationErrors = useMemo(
    () => (draft ? validateRemoteAgentDraft(draft) : []),
    [draft],
  );

  const updateDraft = <K extends keyof RemoteAgentDraft>(
    field: K,
    value: RemoteAgentDraft[K],
  ): void => {
    setDraft((d) => (d ? { ...d, [field]: value } : d));
  };

  const handleSave = async (): Promise<void> => {
    if (!draft || validationErrors.length > 0) return;
    setSaving(true);
    setError(null);
    try {
      const endpoint = await window.harness.remoteAgents.upsertEndpoint({
        endpoint: serializeRemoteAgentDraft(draft),
      });
      await refresh();
      setSelectedId(endpoint.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!draft?.id) return;
    if (!window.confirm(`"${draft.name}" Remote Agent를 제거하시겠습니까?`)) return;
    setSaving(true);
    setError(null);
    try {
      await window.harness.remoteAgents.delete({ endpointId: draft.id });
      await refresh();
      setSelectedId(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (entry: A2ARegistryEntry): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await window.harness.remoteAgents.toggle({
        endpointId: entry.endpoint.id,
        enabled: !entry.endpoint.enabled,
      });
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="remote-agents-tab">
      <div className="remote-agents-tab__banner" role="note">
        <strong>A2A Remote Agents</strong>
      </div>

      <div className="remote-agents-tab__split">
        <aside className="remote-agents-tab__list">
          <header className="remote-agents-tab__list-header">
            <span>Endpoint</span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setSelectedId("__new__")}
              disabled={saving}
            >
              + 새 Endpoint
            </button>
          </header>

          {list.kind === "loading" && (
            <div className="empty-state">불러오는 중...</div>
          )}
          {list.kind === "error" && (
            <div
              className="empty-state"
              style={{ color: "var(--status-failed)" }}
            >
              {list.message}
            </div>
          )}
          {list.kind === "ready" && list.entries.length === 0 && (
            <div className="empty-state">등록된 Remote Agent가 없습니다.</div>
          )}
          {list.kind === "ready" && (
            <ul className="remote-agents-tab__items">
              {list.entries.map((entry) => (
                <li key={entry.endpoint.id}>
                  <button
                    type="button"
                    className={`remote-agents-tab__item${
                      selectedId === entry.endpoint.id
                        ? " remote-agents-tab__item--selected"
                        : ""
                    }`}
                    onClick={() => setSelectedId(entry.endpoint.id)}
                  >
                    <span className="remote-agents-tab__item-name">
                      {entry.endpoint.name}
                      {!entry.endpoint.enabled && (
                        <span className="remote-agents-tab__item-disabled">
                          (off)
                        </span>
                      )}
                    </span>
                    <span className="remote-agents-tab__item-meta">
                      {entry.endpoint.preferredTransport} · {entry.endpoint.baseUrl}
                    </span>
                    <span className="remote-agents-tab__item-card">
                      {cardSummary(entry)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="remote-agents-tab__editor">
          {draft === null ? (
            <div className="empty-state">
              Remote Agent endpoint를 선택하거나 새로 만드세요.
            </div>
          ) : (
            <div className="remote-agents-tab__form">
              <h3 className="remote-agents-tab__heading">
                {draft.id === null ? "새 Remote Agent" : draft.name || "(이름 없음)"}
              </h3>

              <fieldset className="settings-fieldset">
                <legend>Endpoint</legend>
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
                    UI에 표시되는 이름입니다. AgentProfile의 worker 선택 목록과
                    pipeline step의 worker 후보에 노출됩니다.
                  </span>
                </label>
                <label className="settings-field">
                  <span className="settings-field__label">Base URL</span>
                  <input
                    type="text"
                    className="settings-field__input"
                    placeholder="https://agents.example.com/reviewer"
                    value={draft.baseUrl}
                    disabled={saving}
                    onChange={(e) => updateDraft("baseUrl", e.target.value)}
                  />
                  <span className="settings-field__hint">
                    A2A endpoint 루트. invocation 시 이 URL로 task/message 요청을 보냅니다.
                    HTTPS만 권장합니다.
                  </span>
                </label>
                <label className="settings-field">
                  <span className="settings-field__label">Agent Card URL</span>
                  <input
                    type="text"
                    className="settings-field__input"
                    placeholder="https://agents.example.com/reviewer/.well-known/agent-card.json"
                    value={draft.agentCardUrl}
                    disabled={saving}
                    onChange={(e) => updateDraft("agentCardUrl", e.target.value)}
                  />
                  <span className="settings-field__hint">
                    상대 endpoint가 자신을 설명하는 JSON 카드 URL. 비워두면 Base URL의
                    <code>/.well-known/agent-card.json</code>이 자동 시도됩니다.
                  </span>
                </label>
                <label className="settings-field">
                  <span className="settings-field__label">Transport</span>
                  <select
                    className="settings-field__input"
                    value={draft.preferredTransport}
                    disabled={saving}
                    onChange={(e) =>
                      updateDraft(
                        "preferredTransport",
                        e.target.value as RemoteAgentDraft["preferredTransport"],
                      )
                    }
                  >
                    <option value="json-rpc">json-rpc</option>
                    <option value="http-json">http-json</option>
                    <option value="grpc">grpc</option>
                  </select>
                  <span className="settings-field__hint">
                    Agent Card에 여러 transport가 선언돼 있을 때 우선 시도할 형식입니다.
                    실제 가용 transport가 다르면 카드의 첫 번째 선언으로 fallback됩니다.
                  </span>
                </label>
                <label className="settings-field">
                  <span className="settings-field__label">Auth secret ref</span>
                  <input
                    type="text"
                    className="settings-field__input"
                    placeholder="A2A_REMOTE_TOKEN"
                    value={draft.authSecretRef}
                    disabled={saving}
                    onChange={(e) => updateDraft("authSecretRef", e.target.value)}
                  />
                  <span className="settings-field__hint">
                    요청 헤더에 <code>Authorization: Bearer &lt;값&gt;</code>으로 주입할 Secret Vault 키 이름입니다.
                    값을 직접 적지 말고 Secrets 탭에 등록한 키 이름을 적으세요.
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
                  비활성화하면 worker 후보에서 빠지지만 카드와 설정은 그대로 보관됩니다.
                </span>
                <label className="settings-field settings-field--checkbox">
                  <input
                    type="checkbox"
                    checked={draft.trusted}
                    disabled={saving}
                    onChange={(e) => updateDraft("trusted", e.target.checked)}
                  />
                  <span className="settings-field__label">신뢰된 endpoint</span>
                </label>
                <span className="settings-field__hint">
                  신뢰 표시된 endpoint만 file/shell 류 부수효과 응답을 그대로 Approval로 변환합니다.
                  처음 등록하는 외부 endpoint는 꺼둔 채 응답 패턴을 검증한 뒤 승격하세요.
                </span>
              </fieldset>

              {selectedEntry?.card && (
                <fieldset className="settings-fieldset">
                  <legend>Agent Card</legend>
                  <div className="remote-agents-tab__card-grid">
                    <span>Agent</span>
                    <strong>{selectedEntry.card.agentName}</strong>
                    <span>Version</span>
                    <strong>{selectedEntry.card.version ?? "-"}</strong>
                    <span>Modes</span>
                    <strong>
                      {selectedEntry.card.inputModes.join(", ")} →{" "}
                      {selectedEntry.card.outputModes.join(", ")}
                    </strong>
                    <span>Skills</span>
                    <strong>
                      {selectedEntry.card.skills.map((skill) => skill.name).join(", ") ||
                        "-"}
                    </strong>
                  </div>
                </fieldset>
              )}

              {validationErrors.length > 0 && (
                <div
                  className="remote-agents-tab__errors"
                  role="alert"
                  style={{ color: "var(--status-failed)" }}
                >
                  <strong>저장 전 수정:</strong>
                  <ul>
                    {validationErrors.map((message, i) => (
                      <li key={i}>{message}</li>
                    ))}
                  </ul>
                </div>
              )}

              {error && (
                <div style={{ color: "var(--status-failed)", marginTop: 8 }}>
                  {error}
                </div>
              )}

              <div className="remote-agents-tab__actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void handleSave()}
                  disabled={saving || validationErrors.length > 0}
                >
                  {saving ? "저장 중..." : draft.id === null ? "생성" : "저장"}
                </button>
                {draft.id !== null && list.kind === "ready" && (
                  <>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => {
                        const target = list.entries.find(
                          (entry) => entry.endpoint.id === draft.id,
                        );
                        if (target) void handleToggle(target);
                      }}
                      disabled={saving}
                    >
                      {draft.enabled ? "비활성화" : "활성화"}
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
