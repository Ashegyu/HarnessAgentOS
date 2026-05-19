import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ApprovalActionType,
  Capability,
  CapabilityRiskLevel,
  SkillAuthorPreview,
  SkillSource,
} from "@harness/core";
import {
  SKILL_AUTHOR_ACTION_CHOICES,
  SKILL_AUTHOR_RISK_CHOICES,
  ORIGIN_LABELS,
  capabilityCountForSource,
  describeStatus,
  emptyAddDraft,
  emptySkillAuthorDraft,
  skillSourceCapabilitySourceKey,
  skillAuthorInputToFormDraft,
  skillAuthorDraftToInput,
  skillSlugFromName,
  validateAddDraft,
  validateSkillAuthorDraft,
  type AddSourceDraft,
  type SkillAuthorFormDraft,
} from "./skill-source-form";

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; sources: SkillSource[] }
  | { kind: "error"; message: string };

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export const SkillSourcesTab = (): JSX.Element => {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addDraft, setAddDraft] = useState<AddSourceDraft>(emptyAddDraft());
  const [authorDraft, setAuthorDraft] =
    useState<SkillAuthorFormDraft | null>(null);
  const [authorPreview, setAuthorPreview] =
    useState<SkillAuthorPreview | null>(null);
  const [authorIntent, setAuthorIntent] = useState("");
  const [authorRationale, setAuthorRationale] = useState<string | null>(null);
  const [authorBusy, setAuthorBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [sources, nextCapabilities] = await Promise.all([
        window.harness.skillSource.list(),
        window.harness.capability.list(),
      ]);
      setList({ kind: "ready", sources });
      setCapabilities(nextCapabilities);
    } catch (e) {
      setList({ kind: "error", message: errorMessage(e) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const existing = list.kind === "ready" ? list.sources : [];
  const addErrors = useMemo(
    () => validateAddDraft(addDraft, existing),
    [addDraft, existing],
  );
  const authorErrors = useMemo(
    () => (authorDraft ? validateSkillAuthorDraft(authorDraft) : []),
    [authorDraft],
  );
  const selectedAuthorSource =
    authorDraft !== null
      ? existing.find((source) => source.id === authorDraft.sourceId) ?? null
      : null;

  const pickDirectory = async (): Promise<void> => {
    setError(null);
    try {
      const picked = await window.harness.app.selectDirectory();
      if (picked) {
        setAddDraft((d) => ({
          ...d,
          rootDir: picked,
          // If the name field is still empty, default it to the trailing
          // segment of the path so the user has a reasonable starting label.
          name:
            d.name.length > 0
              ? d.name
              : picked.split(/[\\/]/).filter(Boolean).pop() ?? picked,
        }));
      }
    } catch (e) {
      setError(`폴더 선택 실패: ${errorMessage(e)}`);
    }
  };

  const handleAdd = async (): Promise<void> => {
    if (addErrors.length > 0) return;
    setBusyId("__new__");
    setError(null);
    try {
      await window.harness.skillSource.add({
        name: addDraft.name.trim(),
        rootDir: addDraft.rootDir.trim(),
      });
      setAddDraft(emptyAddDraft());
      setShowAdd(false);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleEnabled = async (s: SkillSource): Promise<void> => {
    setBusyId(s.id);
    setError(null);
    try {
      await window.harness.skillSource.update({
        source: { ...s, enabled: !s.enabled },
      });
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleTrust = async (s: SkillSource): Promise<void> => {
    // Promoting an untrusted custom source to trusted means every SKILL.md
    // under it will be evaluated and skill_script approvals can run its
    // scripts. That's high-risk → require explicit acknowledgement.
    if (!s.trusted) {
      const ok = window.confirm(
        `"${s.name}" 디렉터리의 모든 SKILL.md를 신뢰하시겠습니까?\n\n` +
          `경로: ${s.rootDir}\n\n` +
          `Trust 승격 후에는 이 디렉터리의 skill_script 액션이 자동승인 ` +
          `대상이 됩니다. 자신이 직접 작성했거나 출처를 확인한 디렉터리만 ` +
          `승격하세요.`,
      );
      if (!ok) return;
    }
    setBusyId(s.id);
    setError(null);
    try {
      await window.harness.skillSource.update({
        source: { ...s, trusted: !s.trusted },
      });
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const handleRefresh = async (s: SkillSource): Promise<void> => {
    setBusyId(s.id);
    setError(null);
    try {
      const result = await window.harness.skillSource.refresh({
        sourceId: s.id,
      });
      // Surface the count via a transient banner instead of a modal.
      setError(
        `재스캔 완료 — scanned ${result.scannedCount}, 추천 후보 ${result.updatedCount}개 반영, total ${result.skillCount}`,
      );
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const openAuthor = (s: SkillSource): void => {
    setAuthorDraft(emptySkillAuthorDraft(s.id));
    setAuthorPreview(null);
    setAuthorIntent("");
    setAuthorRationale(null);
    setError(null);
  };

  const updateAuthor = (patch: Partial<SkillAuthorFormDraft>): void => {
    setAuthorDraft((draft) => (draft ? { ...draft, ...patch } : draft));
    setAuthorPreview(null);
    setAuthorRationale(null);
  };

  const toggleAuthorAction = (
    action: ApprovalActionType,
    checked: boolean,
  ): void => {
    setAuthorDraft((draft) => {
      if (!draft) return draft;
      const actions = new Set(draft.allowedActions);
      if (checked) actions.add(action);
      else actions.delete(action);
      return { ...draft, allowedActions: [...actions] };
    });
    setAuthorPreview(null);
  };

  const handlePreviewSkill = async (): Promise<void> => {
    if (!authorDraft || authorErrors.length > 0) return;
    setAuthorBusy(true);
    setError(null);
    try {
      const preview = await window.harness.skillSource.previewSkillDraft({
        draft: skillAuthorDraftToInput(authorDraft),
      });
      setAuthorPreview(preview);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setAuthorBusy(false);
    }
  };

  const handleGenerateSkillDraft = async (): Promise<void> => {
    if (!authorDraft || authorIntent.trim().length === 0) return;
    setAuthorBusy(true);
    setError(null);
    try {
      const result = await window.harness.skillSource.generateSkillDraft({
        request: {
          sourceId: authorDraft.sourceId,
          userIntent: authorIntent.trim(),
          profileIds: [],
          evidenceArtifactIds: [],
        },
      });
      setAuthorDraft(skillAuthorInputToFormDraft(result.draft));
      setAuthorPreview(result.preview);
      setAuthorRationale(result.draft.rationale);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setAuthorBusy(false);
    }
  };

  const handleProposeSkillFile = async (): Promise<void> => {
    if (!authorDraft || !authorPreview?.ok || authorErrors.length > 0) return;
    setAuthorBusy(true);
    setError(null);
    try {
      const result = await window.harness.skillSource.proposeSkillFile({
        draft: skillAuthorDraftToInput(authorDraft),
      });
      setError(
        `file_write 승인 대기 생성 — ${result.preview.relativePath} (${result.approval.id}). 승인 실행 후 재스캔되어 추천 후보에 반영됩니다.`,
      );
      setAuthorDraft(null);
      setAuthorPreview(null);
      setAuthorIntent("");
      setAuthorRationale(null);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setAuthorBusy(false);
    }
  };

  const handleRemove = async (s: SkillSource): Promise<void> => {
    // Project/user sentinels are seeded by main.ts on every boot, so a
    // delete would just resurrect on the next launch. Block the action
    // up front rather than silently lying to the user.
    if (s.origin !== "custom") {
      setError("내장(project / user) 소스는 제거할 수 없습니다.");
      return;
    }
    if (!window.confirm(`"${s.name}" 소스를 제거하시겠습니까?`)) return;
    setBusyId(s.id);
    setError(null);
    try {
      await window.harness.skillSource.remove({ sourceId: s.id });
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="skill-sources-tab">
      <header className="skill-sources-tab__header">
        <div>
          <h3 className="skill-sources-tab__heading">Skill 소스</h3>
          <p className="settings-field__hint" style={{ margin: 0 }}>
            SKILL.md 파일들이 들어 있는 디렉터리를 등록합니다. Custom 소스는
            trust 승격 후에야 <code>skill_script</code> 액션을 실행할 수 있습니다.
          </p>
        </div>
        {!showAdd && (
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => {
              setAddDraft(emptyAddDraft());
              setShowAdd(true);
              setError(null);
            }}
          >
            + 디렉터리 추가
          </button>
        )}
      </header>

      {error && (
        <div
          className="skill-sources-tab__notice"
          style={{
            color:
              error.startsWith("재스캔 완료") ||
              error.startsWith("file_write 승인")
              ? "var(--text-secondary)"
              : "var(--status-failed)",
          }}
        >
          {error}
        </div>
      )}

      {showAdd && (
        <div className="skill-sources-tab__add">
          <label className="settings-field">
            <span className="settings-field__label">이름</span>
            <input
              type="text"
              className="settings-field__input"
              value={addDraft.name}
              onChange={(e) =>
                setAddDraft((d) => ({ ...d, name: e.target.value }))
              }
              placeholder="예: 팀 공통 skills"
              disabled={busyId !== null}
            />
            <span className="settings-field__hint">
              UI에 표시되는 이름입니다. 디렉터리를 고르면 마지막 폴더명으로 자동 채워집니다.
            </span>
          </label>
          <label className="settings-field">
            <span className="settings-field__label">디렉터리</span>
            <div className="thread-create-form__path-row">
              <input
                type="text"
                className="settings-field__input"
                value={addDraft.rootDir}
                onChange={(e) =>
                  setAddDraft((d) => ({ ...d, rootDir: e.target.value }))
                }
                placeholder="C:\\... 또는 /home/..."
                disabled={busyId !== null}
              />
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void pickDirectory()}
                disabled={busyId !== null}
              >
                찾아보기…
              </button>
            </div>
            <span className="settings-field__hint">
              <code>&lt;rootDir&gt;/&lt;id&gt;/SKILL.md</code> 구조의 폴더입니다.
              추가하면 path-policy whitelist에 자동 등록되고 재스캔으로 capability에 반영됩니다.
            </span>
          </label>
          {addErrors.length > 0 && (
            <ul
              style={{
                color: "var(--status-failed)",
                fontSize: 12,
                margin: 0,
                paddingLeft: 20,
              }}
            >
              {addErrors.map((e, i) => (
                <li key={i}>{e.message}</li>
              ))}
            </ul>
          )}
          <div className="skill-sources-tab__add-actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setShowAdd(false);
                setAddDraft(emptyAddDraft());
              }}
              disabled={busyId !== null}
            >
              취소
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => void handleAdd()}
              disabled={busyId !== null || addErrors.length > 0}
            >
              {busyId === "__new__" ? "추가 중…" : "추가"}
            </button>
          </div>
        </div>
      )}

      {authorDraft !== null && (
        <div className="skill-sources-tab__author">
          <header className="skill-sources-tab__author-header">
            <div>
              <strong>SKILL.md 작성</strong>
              <span>{selectedAuthorSource?.name ?? authorDraft.sourceId}</span>
            </div>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={authorBusy}
              onClick={() => {
                setAuthorDraft(null);
                setAuthorPreview(null);
                setAuthorIntent("");
                setAuthorRationale(null);
              }}
            >
              닫기
            </button>
          </header>
          <label className="settings-field">
            <span className="settings-field__label">자동 초안 요청</span>
            <textarea
              className="settings-field__input settings-field__textarea settings-field__textarea--compact"
              rows={3}
              value={authorIntent}
              disabled={authorBusy}
              placeholder="예: 리뷰 전에 위험한 diff와 승인 필요 액션을 정리하는 skill"
              onChange={(e) => setAuthorIntent(e.target.value)}
            />
            <span className="settings-field__hint">
              어떤 상황에 이 skill을 쓰고 싶은지 자연어로 적습니다.
              "자동 초안 생성" 버튼이 이 의도로부터 slug·trigger·allowed actions·본문 초안을 생성합니다.
            </span>
          </label>
          <div className="skill-sources-tab__add-actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={authorBusy || authorIntent.trim().length === 0}
              onClick={() => void handleGenerateSkillDraft()}
            >
              {authorBusy ? "생성 중…" : "자동 초안 생성"}
            </button>
            {authorRationale && (
              <span className="settings-field__hint">{authorRationale}</span>
            )}
          </div>
          <div className="skill-sources-tab__author-grid">
            <label className="settings-field">
              <span className="settings-field__label">Skill ID</span>
              <input
                type="text"
                className="settings-field__input"
                value={authorDraft.slug}
                disabled={authorBusy}
                placeholder="review-helper"
                onChange={(e) => updateAuthor({ slug: e.target.value })}
              />
              <span className="settings-field__hint">
                SKILL.md 파일 경로(<code>&lt;slug&gt;/SKILL.md</code>)와 capability id에 그대로 사용됩니다.
                소문자/숫자/-/_만, 2-63자.
              </span>
            </label>
            <label className="settings-field">
              <span className="settings-field__label">이름</span>
              <input
                type="text"
                className="settings-field__input"
                value={authorDraft.name}
                disabled={authorBusy}
                placeholder="Review Helper"
                onChange={(e) => {
                  const name = e.target.value;
                  updateAuthor({
                    name,
                    slug:
                      authorDraft.slug.trim().length === 0
                        ? skillSlugFromName(name)
                        : authorDraft.slug,
                  });
                }}
              />
              <span className="settings-field__hint">
                사용자가 보는 표시 이름입니다. Skill ID가 비어 있으면 이 이름으로부터 자동 생성됩니다.
              </span>
            </label>
            <label className="settings-field">
              <span className="settings-field__label">설명</span>
              <textarea
                className="settings-field__input settings-field__textarea settings-field__textarea--compact"
                value={authorDraft.description}
                disabled={authorBusy}
                onChange={(e) =>
                  updateAuthor({ description: e.target.value })
                }
              />
              <span className="settings-field__hint">
                추천 엔진이 "이 요청에 이 skill이 맞는가"를 판단하는 핵심 텍스트입니다.
                언제 쓰면 좋은지 한두 문장으로.
              </span>
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Risk</span>
              <select
                className="settings-field__input"
                value={authorDraft.riskLevel}
                disabled={authorBusy}
                onChange={(e) =>
                  updateAuthor({
                    riskLevel: e.target.value as CapabilityRiskLevel,
                  })
                }
              >
                {SKILL_AUTHOR_RISK_CHOICES.map((risk) => (
                  <option key={risk} value={risk}>
                    {risk}
                  </option>
                ))}
              </select>
              <span className="settings-field__hint">
                low는 정보 정리만, medium은 파일/명령 등 부수 효과, high는 비밀·삭제·배포 같은 위험 동작이 포함된 경우입니다.
              </span>
            </label>
          </div>
          <label className="settings-field">
            <span className="settings-field__label">Trigger terms</span>
            <input
              type="text"
              className="settings-field__input"
              value={authorDraft.triggerTermsText}
              disabled={authorBusy}
              placeholder="review, diff, approval"
              onChange={(e) =>
                updateAuthor({ triggerTermsText: e.target.value })
              }
            />
            <span className="settings-field__hint">
              사용자 요청에 이 단어가 등장하면 이 skill을 후보로 올립니다. 쉼표로 구분.
            </span>
          </label>
          <div className="settings-field">
            <span className="settings-field__label">Declared actions</span>
            <span className="settings-field__hint">
              이 skill이 수행할 수 있는 side effect 종류를 미리 선언합니다.
              체크 안 된 액션은 실행 시 거부됩니다. <code>skill_script</code>는 trusted source에서만 실행 가능합니다.
            </span>
            <div className="pipeline-step__option-row">
              {SKILL_AUTHOR_ACTION_CHOICES.map((action) => (
                <label key={action} className="pipeline-step__check">
                  <input
                    type="checkbox"
                    disabled={authorBusy}
                    checked={authorDraft.allowedActions.includes(action)}
                    onChange={(e) =>
                      toggleAuthorAction(action, e.target.checked)
                    }
                  />
                  <span>{action}</span>
                </label>
              ))}
            </div>
          </div>
          <label className="settings-field">
            <span className="settings-field__label">본문</span>
            <textarea
              className="settings-field__input settings-field__textarea"
              rows={5}
              value={authorDraft.body}
              disabled={authorBusy}
              onChange={(e) => updateAuthor({ body: e.target.value })}
            />
            <span className="settings-field__hint">
              agent가 이 skill을 발동했을 때 system prompt에 주입되는 본문입니다.
              "approval bypass", "사용자에게 숨김" 같은 표현은 preview 단계에서 경고로 표시됩니다.
            </span>
          </label>
          {authorErrors.length > 0 && (
            <ul className="skill-sources-tab__author-errors">
              {authorErrors.map((e, i) => (
                <li key={i}>{e.message}</li>
              ))}
            </ul>
          )}
          {authorPreview !== null && (
            <div className="skill-sources-tab__preview">
              <div className="skill-sources-tab__preview-meta">
                <span>{authorPreview.relativePath}</span>
                <strong>{authorPreview.ok ? "valid" : "invalid"}</strong>
                {authorPreview.wouldOverwrite && <em>overwrite</em>}
              </div>
              {authorPreview.riskyActions.length > 0 && (
                <div className="skill-sources-tab__risk">
                  risky actions: {authorPreview.riskyActions.join(", ")}
                </div>
              )}
              {authorPreview.errors.length > 0 && (
                <ul className="skill-sources-tab__author-errors">
                  {authorPreview.errors.map((issue, i) => (
                    <li key={i}>{issue.message}</li>
                  ))}
                </ul>
              )}
              {authorPreview.warnings.length > 0 && (
                <ul className="skill-sources-tab__author-warnings">
                  {authorPreview.warnings.map((warning, i) => (
                    <li key={i}>{warning}</li>
                  ))}
                </ul>
              )}
              <pre>{authorPreview.content}</pre>
            </div>
          )}
          <div className="skill-sources-tab__add-actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={authorBusy || authorErrors.length > 0}
              onClick={() => void handlePreviewSkill()}
            >
              {authorBusy ? "검증 중…" : "검증 preview"}
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={
                authorBusy ||
                authorErrors.length > 0 ||
                authorPreview?.ok !== true
              }
              onClick={() => void handleProposeSkillFile()}
            >
              file_write 승인 생성
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
      {list.kind === "ready" && list.sources.length === 0 && !showAdd && (
        <div className="empty-state">
          등록된 skill 소스가 없습니다. "+ 디렉터리 추가" 버튼으로 시작하세요.
        </div>
      )}

      {list.kind === "ready" && list.sources.length > 0 && (
        <ul className="skill-sources-tab__list">
          {list.sources.map((s) => {
            const status = describeStatus(s);
            const busy = busyId === s.id;
            const capabilityCount = capabilityCountForSource(s, capabilities);
            return (
              <li key={s.id} className="skill-source-row">
                <div className="skill-source-row__head">
                  <div className="skill-source-row__name">
                    <strong>{s.name}</strong>
                    <span
                      className="skill-source-row__origin"
                      title={`origin: ${s.origin}`}
                    >
                      {ORIGIN_LABELS[s.origin]}
                    </span>
                    {status.ready ? (
                      <span className="skill-source-row__status skill-source-row__status--ready">
                        Ready
                      </span>
                    ) : (
                      <span
                        className="skill-source-row__status skill-source-row__status--blocked"
                        title={status.reason}
                      >
                        {status.reason}
                      </span>
                    )}
                    <span
                      className={`skill-source-row__status ${
                        capabilityCount > 0
                          ? "skill-source-row__status--ready"
                          : "skill-source-row__status--blocked"
                      }`}
                      title="현재 Capability 추천 후보로 반영된 SKILL 수"
                    >
                      추천 {capabilityCount}
                    </span>
                  </div>
                  <code className="skill-source-row__path" title={s.rootDir}>
                    {s.rootDir}
                  </code>
                </div>
                <div className="skill-source-row__actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void handleToggleEnabled(s)}
                    disabled={busy}
                  >
                    {s.enabled ? "비활성화" : "활성화"}
                  </button>
                  <button
                    type="button"
                    className={`btn btn--ghost btn--sm${
                      !s.trusted ? " btn--accent" : ""
                    }`}
                    onClick={() => void handleToggleTrust(s)}
                    disabled={busy}
                    title={
                      s.trusted
                        ? "Trust 해제"
                        : "Trust 승격 (이 디렉터리의 모든 skill을 신뢰)"
                    }
                  >
                    {s.trusted ? "Trust 해제" : "Trust 승격"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void handleRefresh(s)}
                    disabled={busy}
                  >
                    {busy ? "..." : "재스캔"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => openAuthor(s)}
                    disabled={busy || authorBusy}
                  >
                    SKILL 작성
                  </button>
                  {s.origin === "custom" && (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm btn--danger"
                      onClick={() => void handleRemove(s)}
                      disabled={busy}
                    >
                      제거
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
