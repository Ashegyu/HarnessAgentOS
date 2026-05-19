import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentProfile, ApprovalActionType } from "@harness/core";
import { APPROVAL_ACTION_TYPES, WORKER_ROLES } from "@harness/core";
import {
  draftFromProfile,
  emptyDraft,
  serializeDraft,
  validateDraft,
  type PermissionMode,
  type ProfileDraft,
} from "./agent-profile-form";
import {
  planLegacyMigration,
  type MigrationPlan,
} from "./legacy-profile-migration";
import {
  WORKER_ROLE_METADATA,
  roleLabel,
  roleOptionLabel,
} from "./role-metadata";

interface Props {
  /** Used to flash a saved-confirmation back to the parent. */
  onSaved?: () => void;
}

type ListState =
  | { kind: "loading" }
  | {
      kind: "ready";
      profiles: AgentProfile[];
      activeId: string | undefined;
      migrationPlan: MigrationPlan | null;
    }
  | { kind: "error"; message: string };

const ACTION_LABELS: Record<ApprovalActionType, string> = {
  capability_use: "Skill 후보 사용",
  model_use: "Learner 모델 추천",
  file_write: "파일 쓰기",
  shell: "쉘 명령",
  dependency_install: "의존성 설치",
  git_commit: "git commit",
  network: "네트워크 요청",
  skill_script: "skill 스크립트",
  orchestration_plan: "오케스트레이션 plan",
};

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export const AgentProfilesTab = ({ onSaved }: Props): JSX.Element => {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setList({ kind: "loading" });
    try {
      const [profiles, settings] = await Promise.all([
        window.harness.agents.list(),
        window.harness.settings.get(),
      ]);
      // Detect legacy data the user can promote into AgentProfile rows.
      // Plan returns null when there's nothing to migrate (either there
      // are already profile rows, or the user has pristine defaults).
      const migrationPlan = planLegacyMigration({
        legacyAgent: settings.agent,
        workerProfiles: settings.orchestration.workerProfiles,
        existingProfiles: profiles,
      });
      setList({
        kind: "ready",
        profiles,
        activeId: settings.activeAgentProfileId,
        migrationPlan,
      });
    } catch (e) {
      setList({ kind: "error", message: errorMessage(e) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep draft in sync with selection. Selecting a profile loads it;
  // selecting "new" resets to an empty draft.
  useEffect(() => {
    if (list.kind !== "ready") return;
    if (selectedId === null) {
      setDraft(null);
      return;
    }
    if (selectedId === "__new__") {
      setDraft(emptyDraft());
      return;
    }
    const found = list.profiles.find((p) => p.id === selectedId);
    setDraft(found ? draftFromProfile(found) : null);
  }, [selectedId, list]);

  const validationErrors = useMemo(
    () => (draft ? validateDraft(draft) : []),
    [draft],
  );

  const categories = useMemo(() => {
    if (list.kind !== "ready") return [];
    return [...new Set(list.profiles.map((p) => p.category).filter(Boolean))].sort();
  }, [list]);

  const visibleProfiles = useMemo(() => {
    if (list.kind !== "ready") return [];
    if (categoryFilter === "all") return list.profiles;
    return list.profiles.filter((p) => p.category === categoryFilter);
  }, [categoryFilter, list]);
  const selectedRoleMetadata = draft
    ? WORKER_ROLE_METADATA[draft.role]
    : null;

  const handleSave = async (): Promise<void> => {
    if (!draft || validationErrors.length > 0) return;
    setSaving(true);
    setError(null);
    try {
      const payload = serializeDraft(draft);
      if (draft.id === null) {
        // Create
        const { id: _stripId, ...createInput } = payload;
        void _stripId;
        const created = await window.harness.agents.create({
          profile: createInput as unknown as Omit<
            AgentProfile,
            "id" | "createdAt" | "updatedAt"
          >,
        });
        await refresh();
        setSelectedId(created.id);
      } else {
        // Update — caller-supplied timestamps don't matter; main re-stamps.
        const full: AgentProfile = {
          ...(payload as AgentProfile),
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        };
        await window.harness.agents.update({ profile: full });
        await refresh();
      }
      onSaved?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!draft || draft.id === null) return;
    if (
      !window.confirm(
        `"${draft.name}" 프로필을 삭제하시겠습니까? 활성 프로필이었다면 default로 폴백합니다.`,
      )
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await window.harness.agents.delete({ profileId: draft.id });
      await refresh();
      setSelectedId(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const handleSetActive = async (): Promise<void> => {
    if (!draft || draft.id === null) return;
    setSaving(true);
    setError(null);
    try {
      await window.harness.agents.setActive({ profileId: draft.id });
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const handleRunMigration = async (): Promise<void> => {
    if (list.kind !== "ready" || !list.migrationPlan) return;
    if (
      !window.confirm(
        `${list.migrationPlan.description}\n\n` +
          `생성된 후에는 페르소나/권한을 자유롭게 편집할 수 있습니다.`,
      )
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Sequential create — `agents.create` is cheap and we want a stable
      // order so the first input lands as default. setDefault is implied
      // by isDefault=true on the input itself.
      let firstId: string | null = null;
      for (const input of list.migrationPlan.inputs) {
        const { id: _stripId, ...payload } = {
          ...input,
          id: "ap_placeholder", // serializer ignores this on create
        };
        void _stripId;
        const created = await window.harness.agents.create({
          profile: payload as unknown as Omit<
            AgentProfile,
            "id" | "createdAt" | "updatedAt"
          >,
        });
        if (firstId === null) firstId = created.id;
      }
      await refresh();
      if (firstId) setSelectedId(firstId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const handleSetDefault = async (): Promise<void> => {
    if (!draft || draft.id === null) return;
    setSaving(true);
    setError(null);
    try {
      await window.harness.agents.setDefault({ profileId: draft.id });
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const updateDraft = <K extends keyof ProfileDraft>(
    field: K,
    value: ProfileDraft[K],
  ): void => {
    setDraft((d) => (d ? { ...d, [field]: value } : d));
  };

  const updatePermission = (
    actionType: ApprovalActionType,
    mode: PermissionMode,
  ): void => {
    setDraft((d) =>
      d
        ? {
            ...d,
            permissionMap: { ...d.permissionMap, [actionType]: mode },
          }
        : d,
    );
  };

  return (
    <div className="agent-profiles-tab">
      <aside className="agent-profiles-tab__list">
        <header className="agent-profiles-tab__list-header">
          <span>프로필</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setSelectedId("__new__")}
            disabled={saving}
          >
            + 새 프로필
          </button>
        </header>
        {list.kind === "loading" && (
          <div className="empty-state">불러오는 중…</div>
        )}
        {list.kind === "error" && (
          <div className="empty-state" style={{ color: "var(--status-failed)" }}>
            {list.message}
          </div>
        )}
        {list.kind === "ready" && list.migrationPlan && (
          <div className="agent-profiles-tab__migrate" role="note">
            <div className="agent-profiles-tab__migrate-body">
              <strong>마이그레이션 가능</strong>
              <p>{list.migrationPlan.description}</p>
            </div>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => void handleRunMigration()}
              disabled={saving}
            >
              {saving ? "변환 중…" : "변환 실행"}
            </button>
          </div>
        )}
        {list.kind === "ready" &&
          list.profiles.length === 0 &&
          !list.migrationPlan && (
            <div className="empty-state">
              등록된 프로필이 없습니다. "새 프로필" 버튼으로 시작하세요.
            </div>
          )}
        {list.kind === "ready" && list.profiles.length > 0 && (
          <div className="agent-profiles-tab__filters">
            <label className="settings-field">
              <span className="settings-field__label">분류</span>
              <select
                className="settings-field__input"
                value={categoryFilter}
                disabled={saving}
                onChange={(e) => setCategoryFilter(e.target.value)}
              >
                <option value="all">전체</option>
                {categories.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {list.kind === "ready" && (
          <ul className="agent-profiles-tab__items">
            {visibleProfiles.map((p) => {
              const isActive = list.activeId === p.id;
              const isSelected = selectedId === p.id;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    className={`agent-profiles-tab__item${
                      isSelected ? " agent-profiles-tab__item--selected" : ""
                    }`}
                    onClick={() => setSelectedId(p.id)}
                  >
                    <span className="agent-profiles-tab__item-name">
                      {p.name}
                    </span>
                    <span className="agent-profiles-tab__item-meta">
                      {p.provider} · {roleLabel(p.role)} · {p.category}
                      {p.isDefault && " · 기본"}
                      {isActive && " · 활성"}
                    </span>
                    {p.tags.length > 0 && (
                      <span className="agent-profiles-tab__tag-row">
                        {p.tags.slice(0, 4).map((tag) => (
                          <span className="agent-profiles-tab__tag" key={tag}>
                            {tag}
                          </span>
                        ))}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      <section className="agent-profiles-tab__editor">
        {draft === null ? (
          <div className="empty-state">
            프로필을 선택하거나 새로 만들어 편집을 시작하세요.
          </div>
        ) : (
          <div className="agent-profiles-tab__form">
            <h3 className="agent-profiles-tab__heading">
              {draft.id === null ? "새 프로필" : draft.name || "(이름 없음)"}
            </h3>

            <fieldset className="settings-fieldset">
              <legend>기본 정보</legend>
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
                  onChange={(e) => updateDraft("description", e.target.value)}
                />
              </label>
              <label className="settings-field">
                <span className="settings-field__label">분류</span>
                <input
                  type="text"
                  className="settings-field__input"
                  value={draft.category}
                  disabled={saving}
                  onChange={(e) => updateDraft("category", e.target.value)}
                />
              </label>
              <label className="settings-field">
                <span className="settings-field__label">태그</span>
                <input
                  type="text"
                  className="settings-field__input"
                  placeholder="security, review, dotnet"
                  value={draft.tagsText}
                  disabled={saving}
                  onChange={(e) => updateDraft("tagsText", e.target.value)}
                />
              </label>
              <label className="settings-field">
                <span className="settings-field__label">실행 Provider</span>
                <select
                  className="settings-field__input"
                  value={draft.provider}
                  disabled={saving}
                  onChange={(e) =>
                    updateDraft("provider", e.target.value as ProfileDraft["provider"])
                  }
                >
                  <option value="auto">auto</option>
                  <option value="claude">claude</option>
                  <option value="codex">codex</option>
                </select>
              </label>
              <label className="settings-field">
                <span className="settings-field__label">역할(Role)</span>
                <select
                  className="settings-field__input"
                  value={draft.role}
                  disabled={saving}
                  onChange={(e) =>
                    updateDraft("role", e.target.value as ProfileDraft["role"])
                  }
                >
                  {WORKER_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {roleOptionLabel(role)}
                    </option>
                  ))}
                </select>
              </label>
              {selectedRoleMetadata && (
                <div className="agent-profiles-tab__role-help" role="note">
                  <strong>{selectedRoleMetadata.label}</strong>
                  <p>{selectedRoleMetadata.description}</p>
                  <span>{selectedRoleMetadata.whenToUse}</span>
                </div>
              )}
            </fieldset>

            <fieldset className="settings-fieldset">
              <legend>에이전트 프롬프트</legend>
              <p className="settings-field__hint">
                이 내용은 시스템 프롬프트의 ROLE 블록에 들어갑니다. 기본 제공
                에이전트 프롬프트는 한국어로 작성되어 있으며, 필요하면 이
                화면에서 직접 조정할 수 있습니다.
              </p>
              <textarea
                className="settings-field__input settings-field__textarea"
                rows={4}
                placeholder="예: 보안 관점에서 PR을 리뷰하고, 심각도별로 근거와 수정 방향을 정리하세요."
                value={draft.persona}
                disabled={saving}
                onChange={(e) => updateDraft("persona", e.target.value)}
              />
            </fieldset>

            <fieldset className="settings-fieldset">
              <legend>모델 튜닝</legend>
              <label className="settings-field">
                <span className="settings-field__label">모델</span>
                <input
                  type="text"
                  className="settings-field__input"
                  placeholder="기본값 사용 (비워두기)"
                  value={draft.model}
                  disabled={saving}
                  onChange={(e) => updateDraft("model", e.target.value)}
                />
              </label>
              <label className="settings-field">
                <span className="settings-field__label">
                  Temperature (0-2, 비워두면 기본)
                </span>
                <input
                  type="text"
                  className="settings-field__input"
                  value={draft.temperatureText}
                  disabled={saving}
                  onChange={(e) =>
                    updateDraft("temperatureText", e.target.value)
                  }
                />
              </label>
              <label className="settings-field">
                <span className="settings-field__label">
                  최대 토큰 (비워두면 기본)
                </span>
                <input
                  type="text"
                  className="settings-field__input"
                  value={draft.maxTokensText}
                  disabled={saving}
                  onChange={(e) =>
                    updateDraft("maxTokensText", e.target.value)
                  }
                />
              </label>
              <label className="settings-field">
                <span className="settings-field__label">전체 제한 시간 (ms)</span>
                <input
                  type="text"
                  className="settings-field__input"
                  value={draft.timeoutMsText}
                  disabled={saving}
                  onChange={(e) => updateDraft("timeoutMsText", e.target.value)}
                />
              </label>
              <label className="settings-field">
                <span className="settings-field__label">
                  무응답 제한 시간 (ms)
                </span>
                <input
                  type="text"
                  className="settings-field__input"
                  value={draft.stallTimeoutMsText}
                  disabled={saving}
                  onChange={(e) =>
                    updateDraft("stallTimeoutMsText", e.target.value)
                  }
                />
              </label>
              <label className="settings-field">
                <span className="settings-field__label">컨텍스트 깊이</span>
                <input
                  type="text"
                  className="settings-field__input"
                  value={draft.contextDepthText}
                  disabled={saving}
                  onChange={(e) =>
                    updateDraft("contextDepthText", e.target.value)
                  }
                />
              </label>
              <label className="settings-field">
                <span className="settings-field__label">
                  시스템 프롬프트 앞부분 (조직 정책)
                </span>
                <textarea
                  className="settings-field__input settings-field__textarea"
                  rows={2}
                  value={draft.systemPromptPrefix}
                  disabled={saving}
                  onChange={(e) =>
                    updateDraft("systemPromptPrefix", e.target.value)
                  }
                />
              </label>
              <label className="settings-field">
                <span className="settings-field__label">
                  시스템 프롬프트 뒷부분 (말미 알림)
                </span>
                <textarea
                  className="settings-field__input settings-field__textarea"
                  rows={2}
                  value={draft.systemPromptSuffix}
                  disabled={saving}
                  onChange={(e) =>
                    updateDraft("systemPromptSuffix", e.target.value)
                  }
                />
              </label>
              <label className="settings-field">
                <span className="settings-field__label">
                  CLI 경로 override (선택)
                </span>
                <input
                  type="text"
                  className="settings-field__input"
                  placeholder="기본 $PATH 검색 사용"
                  value={draft.cliPathOverride}
                  disabled={saving}
                  onChange={(e) =>
                    updateDraft("cliPathOverride", e.target.value)
                  }
                />
              </label>
            </fieldset>

            <fieldset className="settings-fieldset">
              <legend>권한 정책</legend>
              <p className="settings-field__hint">
                기본값은 전역 자동 승인 설정을 따릅니다. 차단은 전역 자동
                승인보다 항상 우선합니다.
              </p>
              <table className="permissions-table">
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>기본</th>
                    <th>자동 승인</th>
                    <th>차단</th>
                  </tr>
                </thead>
                <tbody>
                  {APPROVAL_ACTION_TYPES.map((t) => (
                    <tr key={t}>
                      <td>{ACTION_LABELS[t]}</td>
                      {(["default", "auto", "block"] as const).map((mode) => (
                        <td key={mode} style={{ textAlign: "center" }}>
                          <input
                            type="radio"
                            name={`perm-${t}`}
                            checked={draft.permissionMap[t] === mode}
                            disabled={saving}
                            onChange={() => updatePermission(t, mode)}
                            aria-label={`${ACTION_LABELS[t]} - ${mode}`}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </fieldset>

            <fieldset className="settings-fieldset">
              <legend>MCP / Skill binding</legend>
              <label className="settings-field">
                <span className="settings-field__label">
                  MCP server ids
                </span>
                <textarea
                  className="settings-field__input settings-field__textarea settings-field__textarea--compact"
                  rows={3}
                  value={draft.mcpServerIdsText}
                  disabled={saving}
                  onChange={(e) =>
                    updateDraft("mcpServerIdsText", e.target.value)
                  }
                />
              </label>
              <label className="settings-field">
                <span className="settings-field__label">
                  Skill source ids
                </span>
                <textarea
                  className="settings-field__input settings-field__textarea settings-field__textarea--compact"
                  rows={3}
                  value={draft.skillSourceIdsText}
                  disabled={saving}
                  onChange={(e) =>
                    updateDraft("skillSourceIdsText", e.target.value)
                  }
                />
              </label>
              <label className="settings-field">
                <span className="settings-field__label">
                  Allowed skill ids
                </span>
                <textarea
                  className="settings-field__input settings-field__textarea settings-field__textarea--compact"
                  rows={3}
                  value={draft.allowedSkillIdsText}
                  disabled={saving}
                  onChange={(e) =>
                    updateDraft("allowedSkillIdsText", e.target.value)
                  }
                />
              </label>
              <label className="settings-field">
                <span className="settings-field__label">
                  Tool allow patterns
                </span>
                <textarea
                  className="settings-field__input settings-field__textarea settings-field__textarea--compact"
                  rows={3}
                  value={draft.toolAllowlistText}
                  disabled={saving}
                  onChange={(e) =>
                    updateDraft("toolAllowlistText", e.target.value)
                  }
                />
              </label>
              <label className="settings-field">
                <span className="settings-field__label">
                  Tool deny patterns
                </span>
                <textarea
                  className="settings-field__input settings-field__textarea settings-field__textarea--compact"
                  rows={3}
                  value={draft.toolDenylistText}
                  disabled={saving}
                  onChange={(e) =>
                    updateDraft("toolDenylistText", e.target.value)
                  }
                />
              </label>
            </fieldset>

            <fieldset className="settings-fieldset">
              <legend>비용 한도</legend>
              <label className="settings-field">
                <span className="settings-field__label">
                  단일 호출 한도 (USD)
                </span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  className="settings-field__input"
                  value={draft.perInvocationUsdText}
                  disabled={saving}
                  onChange={(e) =>
                    updateDraft("perInvocationUsdText", e.target.value)
                  }
                />
              </label>
              <label className="settings-field">
                <span className="settings-field__label">
                  TaskRun 누적 한도 (USD)
                </span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  className="settings-field__input"
                  value={draft.perTaskRunUsdText}
                  disabled={saving}
                  onChange={(e) =>
                    updateDraft("perTaskRunUsdText", e.target.value)
                  }
                />
              </label>
              <label className="settings-field">
                <span className="settings-field__label">
                  일일 누적 한도 (USD)
                </span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  className="settings-field__input"
                  value={draft.perDayUsdText}
                  disabled={saving}
                  onChange={(e) =>
                    updateDraft("perDayUsdText", e.target.value)
                  }
                />
              </label>
            </fieldset>

            {validationErrors.length > 0 && (
              <div
                className="agent-profiles-tab__errors"
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

            <div className="agent-profiles-tab__actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void handleSave()}
                disabled={saving || validationErrors.length > 0}
              >
                {saving ? "저장 중…" : draft.id === null ? "생성" : "저장"}
              </button>
              {draft.id !== null && (
                <>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => void handleSetActive()}
                    disabled={saving}
                  >
                    이 프로필 활성화
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => void handleSetDefault()}
                    disabled={saving || draft.isDefault}
                  >
                    기본으로 지정
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
  );
};
