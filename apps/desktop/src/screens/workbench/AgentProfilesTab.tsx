import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentProfile,
  ApprovalActionType,
  Capability,
  McpServerConfig,
  SkillSource,
} from "@harness/core";
import {
  AGENT_REASONING_EFFORTS,
  APPROVAL_ACTION_TYPES,
  WORKER_ROLES,
} from "@harness/core";
import {
  buildBindingPolicyHints,
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
import { skillSourceCapabilitySourceKey } from "./skill-source-form";

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

/**
 * Parse the underlying text state for an *IdsText draft field — the same
 * splitter used by `parseList` in agent-profile-form. Keeping the parse
 * here makes the checkbox UI authoritative without duplicating the saver.
 */
const parseIdSet = (text: string): Set<string> => {
  const out = new Set<string>();
  for (const raw of text.split(/[\r\n,]+/)) {
    const item = raw.trim();
    if (item.length > 0) out.add(item);
  }
  return out;
};

const toggleIdInText = (
  text: string,
  id: string,
  checked: boolean,
): string => {
  const set = parseIdSet(text);
  if (checked) set.add(id);
  else set.delete(id);
  return [...set].join("\n");
};

const removeIdFromText = (text: string, id: string): string =>
  toggleIdInText(text, id, false);

export const AgentProfilesTab = ({ onSaved }: Props): JSX.Element => {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  const [skillSources, setSkillSources] = useState<SkillSource[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);

  const refresh = useCallback(async () => {
    setList({ kind: "loading" });
    try {
      const [profiles, settings, mcp, sources, caps] = await Promise.all([
        window.harness.agents.list(),
        window.harness.settings.get(),
        window.harness.mcp.list(),
        window.harness.skillSource.list(),
        window.harness.capability.list(),
      ]);
      setMcpServers(mcp);
      setSkillSources(sources);
      setCapabilities(caps);
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
  const bindingPolicyHints = useMemo(
    () => (draft ? buildBindingPolicyHints(draft) : []),
    [draft],
  );

  const selectedMcpIds = useMemo(
    () => (draft ? parseIdSet(draft.mcpServerIdsText) : new Set<string>()),
    [draft?.mcpServerIdsText, draft],
  );
  const selectedSkillSourceIds = useMemo(
    () => (draft ? parseIdSet(draft.skillSourceIdsText) : new Set<string>()),
    [draft?.skillSourceIdsText, draft],
  );
  const selectedAllowedSkillIds = useMemo(
    () => (draft ? parseIdSet(draft.allowedSkillIdsText) : new Set<string>()),
    [draft?.allowedSkillIdsText, draft],
  );
  const staleMcpIds = useMemo(() => {
    const known = new Set(mcpServers.map((s) => s.id));
    return [...selectedMcpIds].filter((id) => !known.has(id));
  }, [selectedMcpIds, mcpServers]);
  const staleSkillSourceIds = useMemo(() => {
    const known = new Set(skillSources.map((s) => s.id));
    return [...selectedSkillSourceIds].filter((id) => !known.has(id));
  }, [selectedSkillSourceIds, skillSources]);
  // Allowed skill candidates are scoped to the currently selected sources;
  // a capability is "in scope" iff its source key matches a selected
  // SkillSource. This mirrors how the runner resolves allowedSkillIds.
  const allowedSkillCandidates = useMemo(() => {
    if (selectedSkillSourceIds.size === 0) return [] as Capability[];
    const selectedSourceKeys = new Set(
      skillSources
        .filter((src) => selectedSkillSourceIds.has(src.id))
        .map((src) => skillSourceCapabilitySourceKey(src)),
    );
    return capabilities.filter((cap) => selectedSourceKeys.has(cap.source));
  }, [selectedSkillSourceIds, skillSources, capabilities]);
  const staleAllowedSkillIds = useMemo(() => {
    const known = new Set(allowedSkillCandidates.map((c) => c.id));
    return [...selectedAllowedSkillIds].filter((id) => !known.has(id));
  }, [selectedAllowedSkillIds, allowedSkillCandidates]);

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
                <span className="settings-field__hint">
                  프로필을 구분하는 표시 이름입니다. 사이드바, thread 헤더, 추천 카드에 그대로 노출됩니다.
                </span>
              </label>
              <label className="settings-field">
                <span className="settings-field__label">설명</span>
                <textarea
                  className="settings-field__input settings-field__textarea settings-field__textarea--compact"
                  value={draft.description}
                  disabled={saving}
                  onChange={(e) => updateDraft("description", e.target.value)}
                />
                <span className="settings-field__hint">
                  이 프로필이 어떤 시나리오에 적합한지 한두 줄로 적습니다. 프로필 선택 UI 툴팁에 사용됩니다.
                </span>
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
                <span className="settings-field__hint">
                  사이드바 그룹화와 분류 필터에 사용되는 소문자 키 (예: <code>core</code>, <code>review</code>, <code>security</code>).
                </span>
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
                <span className="settings-field__hint">
                  쉼표로 구분하는 키워드입니다. orchestration planner의 worker 선택과 검색 인덱싱에 사용됩니다.
                </span>
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
                <span className="settings-field__hint">
                  auto는 General 탭의 Provider 설정을 따릅니다. Codex MCP binding은 검증된 stdio/no-secret 서버만 per-run override로 전달되고, tool 정책은 현재 claude provider에서만 enforced입니다.
                </span>
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
                <span className="settings-field__hint">
                  비워두면 General 탭의 전역 Model을 따릅니다. <code>claude-sonnet-4-6</code> 같은 ID로 이 프로필만 덮어쓸 수 있습니다.
                </span>
              </label>
              <label className="settings-field">
                <span className="settings-field__label">
                  Reasoning effort
                </span>
                <select
                  className="settings-field__input"
                  value={draft.reasoningEffort}
                  disabled={saving}
                  onChange={(e) =>
                    updateDraft(
                      "reasoningEffort",
                      e.target.value as ProfileDraft["reasoningEffort"],
                    )
                  }
                >
                  <option value="">provider 기본값</option>
                  {AGENT_REASONING_EFFORTS.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
                <span className="settings-field__hint">
                  Codex 실행에서는 <code>model_reasoning_effort</code> override로 전달됩니다. Claude provider에는 검증된 CLI 플래그가 없어 전달하지 않습니다.
                </span>
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
                <span className="settings-field__hint">
                  낮을수록(0에 가까울수록) 결정적, 높을수록 창의적인 응답이 나옵니다. 리뷰·정밀 작업은 낮게, 브레인스토밍은 높게 잡으세요.
                </span>
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
                <span className="settings-field__hint">
                  단일 응답이 생성할 수 있는 최대 토큰 수입니다. 짧게 잡으면 비용을 줄이지만 답이 잘릴 수 있습니다.
                </span>
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
                <span className="settings-field__hint">
                  이 프로필의 invocation이 넘으면 강제 종료되는 한계입니다. General 탭의 Hard timeout보다 짧게 잡으면 이 값이 우선합니다.
                </span>
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
                <span className="settings-field__hint">
                  마지막 stream 출력 이후 이 시간 동안 아무 응답이 없으면 stall로 간주하고 invocation을 중단합니다. 전체 제한 시간보다 짧게 잡으세요.
                </span>
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
                <span className="settings-field__hint">
                  prompt에 함께 전달할 최근 step/checkpoint 개수입니다. 1 이상의 정수만 허용됩니다.
                </span>
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
                <span className="settings-field__hint">
                  ROLE 블록 앞에 자동으로 붙는 조직·언어 정책입니다 (예: "항상 한국어로 답하세요"). 이 프로필의 모든 invocation에 적용됩니다.
                </span>
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
                <span className="settings-field__hint">
                  ROLE 블록 끝에 붙는 마지막 알림입니다 (예: "모든 파일 변경은 Approval을 거쳐야 합니다").
                </span>
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
                <span className="settings-field__hint">
                  비워두면 PATH에서 claude/codex CLI를 검색합니다. 특정 빌드를 쓰려면 실행 파일의 절대 경로를 적으세요.
                </span>
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
              {bindingPolicyHints.length > 0 && (
                <ul className="agent-profile-policy-hints">
                  {bindingPolicyHints.map((hint) => (
                    <li
                      key={hint.message}
                      className={`agent-profile-policy-hints__item agent-profile-policy-hints__item--${hint.tone}`}
                    >
                      {hint.message}
                    </li>
                  ))}
                </ul>
              )}
              <div className="settings-field">
                <span className="settings-field__label">MCP servers</span>
                <span className="settings-field__hint">
                  per-agent scope만 체크 가능합니다. global scope는 활성화된 모든
                  agent invocation에서 자동 적용되므로 여기서 선택할 필요가 없습니다.
                </span>
                {mcpServers.length === 0 ? (
                  <div className="settings-field__hint">
                    등록된 MCP 서버가 없습니다. MCP 탭에서 먼저 등록하세요.
                  </div>
                ) : (
                  <ul className="agent-profile-binding-list">
                    {mcpServers.map((s) => {
                      const isPerAgent = s.scope === "per-agent";
                      return (
                        <li key={s.id} className="agent-profile-binding-item">
                          <label>
                            <input
                              type="checkbox"
                              disabled={
                                saving ||
                                (!isPerAgent && !selectedMcpIds.has(s.id))
                              }
                              checked={selectedMcpIds.has(s.id)}
                              onChange={(e) =>
                                updateDraft(
                                  "mcpServerIdsText",
                                  toggleIdInText(
                                    draft.mcpServerIdsText,
                                    s.id,
                                    e.target.checked,
                                  ),
                                )
                              }
                            />
                            <span className="agent-profile-binding-item__name">
                              {s.name}
                            </span>
                            <span className="agent-profile-binding-item__meta">
                              {isPerAgent ? "per-agent" : "global · 자동 적용"}
                              {!s.enabled && " · off"}
                              {" · "}
                              <code>{s.id}</code>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {staleMcpIds.length > 0 && (
                  <div className="agent-profile-binding-stale">
                    <strong>현재 등록된 서버에 없는 id:</strong>
                    <ul>
                      {staleMcpIds.map((id) => (
                        <li key={id}>
                          <code>{id}</code>{" "}
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            disabled={saving}
                            onClick={() =>
                              updateDraft(
                                "mcpServerIdsText",
                                removeIdFromText(draft.mcpServerIdsText, id),
                              )
                            }
                          >
                            제거
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className="settings-field">
                <span className="settings-field__label">Skill sources</span>
                <span className="settings-field__hint">
                  이 프로필이 사용할 SKILL.md 디렉터리를 선택합니다. trust 승격
                  안 된 source는 <code>skill_script</code> 액션이 차단됩니다.
                </span>
                {skillSources.length === 0 ? (
                  <div className="settings-field__hint">
                    등록된 Skill source가 없습니다. Skill 탭에서 먼저 등록하세요.
                  </div>
                ) : (
                  <ul className="agent-profile-binding-list">
                    {skillSources.map((src) => (
                      <li key={src.id} className="agent-profile-binding-item">
                        <label>
                          <input
                            type="checkbox"
                            disabled={saving}
                            checked={selectedSkillSourceIds.has(src.id)}
                            onChange={(e) =>
                              updateDraft(
                                "skillSourceIdsText",
                                toggleIdInText(
                                  draft.skillSourceIdsText,
                                  src.id,
                                  e.target.checked,
                                ),
                              )
                            }
                          />
                          <span className="agent-profile-binding-item__name">
                            {src.name}
                          </span>
                          <span className="agent-profile-binding-item__meta">
                            {src.origin}
                            {!src.enabled && " · disabled"}
                            {!src.trusted && " · untrusted"}
                            {" · "}
                            <code>{src.id}</code>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
                {staleSkillSourceIds.length > 0 && (
                  <div className="agent-profile-binding-stale">
                    <strong>현재 등록된 source에 없는 id:</strong>
                    <ul>
                      {staleSkillSourceIds.map((id) => (
                        <li key={id}>
                          <code>{id}</code>{" "}
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            disabled={saving}
                            onClick={() =>
                              updateDraft(
                                "skillSourceIdsText",
                                removeIdFromText(draft.skillSourceIdsText, id),
                              )
                            }
                          >
                            제거
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className="settings-field">
                <span className="settings-field__label">Allowed skill ids</span>
                <span className="settings-field__hint">
                  비워두면 선택된 source의 enabled skill을 전부 허용합니다.
                  특정 skill만 허용하려면 아래에서 골라주세요.
                </span>
                {selectedSkillSourceIds.size === 0 ? (
                  <div className="settings-field__hint">
                    Skill source를 먼저 선택하면 그 안의 skill 후보가 나타납니다.
                  </div>
                ) : allowedSkillCandidates.length === 0 ? (
                  <div className="settings-field__hint">
                    선택된 source에 등록된 capability가 없습니다. Skill 탭에서
                    재스캔하거나 SKILL.md를 추가하세요.
                  </div>
                ) : (
                  <ul className="agent-profile-binding-list">
                    {allowedSkillCandidates.map((cap) => (
                      <li key={cap.id} className="agent-profile-binding-item">
                        <label>
                          <input
                            type="checkbox"
                            disabled={saving}
                            checked={selectedAllowedSkillIds.has(cap.id)}
                            onChange={(e) =>
                              updateDraft(
                                "allowedSkillIdsText",
                                toggleIdInText(
                                  draft.allowedSkillIdsText,
                                  cap.id,
                                  e.target.checked,
                                ),
                              )
                            }
                          />
                          <span className="agent-profile-binding-item__name">
                            {cap.name}
                          </span>
                          <span className="agent-profile-binding-item__meta">
                            {cap.riskLevel}
                            {" · "}
                            <code>{cap.id}</code>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
                {staleAllowedSkillIds.length > 0 && (
                  <div className="agent-profile-binding-stale">
                    <strong>현재 후보에 없는 id:</strong>
                    <ul>
                      {staleAllowedSkillIds.map((id) => (
                        <li key={id}>
                          <code>{id}</code>{" "}
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            disabled={saving}
                            onClick={() =>
                              updateDraft(
                                "allowedSkillIdsText",
                                removeIdFromText(draft.allowedSkillIdsText, id),
                              )
                            }
                          >
                            제거
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
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
                <span className="settings-field__hint">
                  허용할 MCP tool 이름 패턴 (한 줄당 하나). 비우면 모두 허용입니다.
                  와일드카드 사용 예: <code>read_*</code>, <code>list_*</code>. claude provider에서만 enforced.
                </span>
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
                <span className="settings-field__hint">
                  차단할 MCP tool 패턴 (한 줄당 하나). allow보다 항상 우선합니다.
                  예: <code>shell_exec</code>, <code>network_*</code>.
                </span>
              </label>
            </fieldset>

            <fieldset className="settings-fieldset">
              <legend>비용 한도</legend>
              <p className="settings-field__hint">
                비워두면 무제한입니다. 한도를 넘기 직전 invocation은 pre-execution budget gate에서 차단됩니다.
              </p>
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
                <span className="settings-field__hint">
                  agent invocation 1회의 예상 비용이 이 값을 넘으면 시작 전에 차단됩니다.
                </span>
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
                <span className="settings-field__hint">
                  하나의 TaskRun 안에서 이 프로필이 누적으로 쓸 수 있는 한도입니다.
                </span>
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
                <span className="settings-field__hint">
                  로컬 자정~자정까지 이 프로필이 누적으로 쓸 수 있는 한도입니다. Budget 탭에서 현재 사용량을 확인할 수 있습니다.
                </span>
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
