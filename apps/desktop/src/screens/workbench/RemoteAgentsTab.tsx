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
                <label className="settings-field settings-field--checkbox">
                  <input
                    type="checkbox"
                    checked={draft.trusted}
                    disabled={saving}
                    onChange={(e) => updateDraft("trusted", e.target.checked)}
                  />
                  <span className="settings-field__label">신뢰된 endpoint</span>
                </label>
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
