import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  A2ARegistryEntry,
  AgentPipeline,
  AgentProfile,
  ApprovalActionType,
  TopologyRecommendation,
  WorkerOutputContract,
} from "@harness/core";
import {
  emptyPipelineDraft,
  moveStep,
  PIPELINE_OUTPUT_CONTRACT_CHOICES,
  PIPELINE_WORKER_ACTION_CHOICES,
  pipelineInputToDraft,
  pipelineToDraft,
  serializePipelineDraft,
  topologyTaskRunOptionsFromThreadDetails,
  validatePipelineDraft,
  type PipelineDraft,
  type PipelineStepDraft,
  type TopologyTaskRunOption,
} from "./pipeline-form";

type ListState =
  | { kind: "loading" }
  | {
      kind: "ready";
      pipelines: AgentPipeline[];
      profiles: AgentProfile[];
      remoteEntries: A2ARegistryEntry[];
      taskRuns: TopologyTaskRunOption[];
    }
  | { kind: "error"; message: string };

interface PipelinesTabProps {
  initialTopologyTaskRunId?: string | null;
}

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const newStepId = (): string =>
  `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

const newStep = (
  firstProfileId: string,
  previousStepId?: string,
): PipelineStepDraft => ({
  id: newStepId(),
  agentProfileId: firstProfileId,
  remoteEndpointId: "",
  title: "",
  instruction: "",
  expectedArtifactKinds: ["log"],
  dependsOn: previousStepId ? [previousStepId] : [],
  allowedActions: null,
  outputContract: "",
});

export const PipelinesTab = ({
  initialTopologyTaskRunId = null,
}: PipelinesTabProps): JSX.Element => {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PipelineDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recommendTaskRunId, setRecommendTaskRunId] = useState("");
  const [recommendations, setRecommendations] = useState<
    TopologyRecommendation[]
  >([]);
  const [recommending, setRecommending] = useState(false);
  const [recommendationError, setRecommendationError] = useState<
    string | null
  >(null);
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [pipelines, profiles, remoteEntries, threads] = await Promise.all([
        window.harness.pipeline.list(),
        window.harness.agents.list(),
        window.harness.remoteAgents.list(),
        window.harness.state.listThreads(),
      ]);
      const details = await Promise.all(
        threads.slice(0, 25).map(async (thread) => {
          try {
            return await window.harness.state.getThread({
              threadId: thread.id,
            });
          } catch {
            return null;
          }
        }),
      );
      const taskRuns = topologyTaskRunOptionsFromThreadDetails(details);
      setList({
        kind: "ready",
        pipelines,
        profiles,
        remoteEntries,
        taskRuns,
      });
    } catch (e) {
      setList({ kind: "error", message: errorMessage(e) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (
      initialTopologyTaskRunId !== null &&
      initialTopologyTaskRunId.length > 0
    ) {
      setRecommendTaskRunId((current) =>
        current.length === 0 ? initialTopologyTaskRunId : current,
      );
    }
  }, [initialTopologyTaskRunId]);

  useEffect(() => {
    if (list.kind !== "ready") return;
    if (selectedId === null) {
      setDraft(null);
      return;
    }
    if (selectedId === "__new__") {
      setDraft((current) =>
        current !== null && current.id === null ? current : emptyPipelineDraft(),
      );
      return;
    }
    const found = list.pipelines.find((p) => p.id === selectedId);
    setDraft(found ? pipelineToDraft(found) : null);
  }, [selectedId, list]);

  const profiles = list.kind === "ready" ? list.profiles : [];
  const remoteEntries = list.kind === "ready" ? list.remoteEntries : [];
  const taskRunOptions = list.kind === "ready" ? list.taskRuns : [];
  const selectedTaskRunOption = taskRunOptions.find(
    (option) => option.id === recommendTaskRunId.trim(),
  );
  const selectableRemoteEntries = remoteEntries.filter(
    (entry) => entry.endpoint.enabled && entry.endpoint.trusted,
  );
  const validationErrors = useMemo(
    () => (draft ? validatePipelineDraft(draft, profiles, remoteEntries) : []),
    [draft, profiles, remoteEntries],
  );

  const updateDraft = (patch: Partial<PipelineDraft>): void => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };

  const updateStep = (i: number, patch: Partial<PipelineStepDraft>): void => {
    setDraft((d) =>
      d
        ? {
            ...d,
            steps: d.steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
          }
        : d,
    );
  };

  const handleAddStep = (): void => {
    if (!draft || profiles.length === 0) return;
    const firstProfileId = profiles[0]!.id;
    const previousStepId =
      draft.steps.length > 0 ? draft.steps[draft.steps.length - 1]!.id : undefined;
    setDraft({
      ...draft,
      steps: [...draft.steps, newStep(firstProfileId, previousStepId)],
    });
  };

  const handleRemoveStep = (i: number): void => {
    setDraft((d) =>
      d ? { ...d, steps: d.steps.filter((_, idx) => idx !== i) } : d,
    );
  };

  const handleMoveStep = (i: number, delta: number): void => {
    setDraft((d) => (d ? { ...d, steps: moveStep(d.steps, i, delta) } : d));
  };

  const handleSave = async (): Promise<void> => {
    if (!draft || validationErrors.length > 0) return;
    setSaving(true);
    setError(null);
    try {
      const payload = serializePipelineDraft(draft);
      let result: AgentPipeline;
      if (draft.id === null) {
        // create
        result = await window.harness.pipeline.create({
          pipeline: payload as Parameters<
            typeof window.harness.pipeline.create
          >[0]["pipeline"],
        });
      } else {
        const full = {
          ...(payload as AgentPipeline),
          // The IPC layer ignores these on the way in; satisfy the type.
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        };
        result = await window.harness.pipeline.update({ pipeline: full });
      }
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
    if (
      !window.confirm(`"${draft.name}" 파이프라인을 삭제하시겠습니까?`)
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await window.harness.pipeline.delete({ pipelineId: draft.id });
      await refresh();
      setSelectedId(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const profileName = (id: string): string =>
    profiles.find((p) => p.id === id)?.name ?? `(missing: ${id})`;
  const remoteName = (id: string): string =>
    remoteEntries.find((entry) => entry.endpoint.id === id)?.endpoint.name ??
    `(missing remote: ${id})`;
  const effectiveDependsOn = (
    step: PipelineStepDraft,
    index: number,
  ): string[] =>
    step.dependsOn ??
    (index > 0 && draft ? [draft.steps[index - 1]!.id] : []);
  const toggleDependency = (
    index: number,
    dependencyId: string,
    checked: boolean,
  ): void => {
    if (!draft) return;
    const step = draft.steps[index];
    if (!step) return;
    const current = new Set(effectiveDependsOn(step, index));
    if (checked) current.add(dependencyId);
    else current.delete(dependencyId);
    updateStep(index, { dependsOn: [...current] });
  };

  const handleRecommend = async (): Promise<void> => {
    const taskRunId = recommendTaskRunId.trim();
    if (taskRunId.length === 0) return;
    setRecommending(true);
    setRecommendationError(null);
    setFeedbackMessage(null);
    try {
      const result = await window.harness.topology.recommend({
        taskRunId,
        maxCandidates: 3,
      });
      setRecommendations(result);
      if (result.length === 0) {
        setRecommendationError(
          "추천 후보가 없습니다. AgentProfile 구성을 먼저 확인하세요.",
        );
      }
    } catch (e) {
      setRecommendations([]);
      setRecommendationError(errorMessage(e));
    } finally {
      setRecommending(false);
    }
  };

  const applyRecommendation = (
    recommendation: TopologyRecommendation,
  ): void => {
    setSelectedId("__new__");
    setDraft(pipelineInputToDraft(recommendation.pipelineDraft));
    setError(null);
    void recordTopologyFeedback(recommendation, "applied");
  };

  const dismissRecommendation = (
    recommendation: TopologyRecommendation,
  ): void => {
    setRecommendations((current) =>
      current.filter((item) => item.id !== recommendation.id),
    );
    void recordTopologyFeedback(recommendation, "dismissed");
  };

  const recordTopologyFeedback = async (
    recommendation: TopologyRecommendation,
    decision: "applied" | "dismissed",
  ): Promise<void> => {
    try {
      await window.harness.topology.recordFeedback({
        taskRunId: recommendation.taskRunId,
        recommendationId: recommendation.id,
        decision,
      });
      setFeedbackMessage(
        decision === "applied"
          ? "추천 적용 기록을 남겼습니다."
          : "추천 무시 기록을 남겼습니다.",
      );
    } catch (e) {
      setRecommendationError(errorMessage(e));
    }
  };
  const toggleAllowedAction = (
    index: number,
    action: ApprovalActionType,
    checked: boolean,
  ): void => {
    if (!draft) return;
    const current = new Set(draft.steps[index]?.allowedActions ?? []);
    if (checked) current.add(action);
    else current.delete(action);
    updateStep(index, { allowedActions: [...current] });
  };

  return (
    <div className="pipelines-tab">
      <div className="pipelines-tab__banner" role="note">
        <strong>Agent Pipeline.</strong>{" "}
        AgentProfile들을 순서대로 묶은 재사용 가능한 템플릿입니다. TaskRun을
        시작할 때 모드 대신 이 파이프라인을 선택하면 각 step이 지정한
        프로필로 실행됩니다.
      </div>

      <div className="pipelines-tab__split">
        <aside className="pipelines-tab__list">
          <header className="pipelines-tab__list-header">
            <span>파이프라인</span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setDraft(emptyPipelineDraft());
                setSelectedId("__new__");
              }}
              disabled={saving || profiles.length === 0}
              title={
                profiles.length === 0
                  ? "Agents 탭에서 먼저 프로필을 만드세요"
                  : undefined
              }
            >
              + 새 파이프라인
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
          {list.kind === "ready" && list.pipelines.length === 0 && (
            <div className="empty-state">
              등록된 파이프라인이 없습니다.
            </div>
          )}
          {list.kind === "ready" && (
            <ul className="pipelines-tab__items">
              {list.pipelines.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className={`pipelines-tab__item${
                      selectedId === p.id ? " pipelines-tab__item--selected" : ""
                    }`}
                    onClick={() => setSelectedId(p.id)}
                  >
                    <span className="pipelines-tab__item-name">{p.name}</span>
                    <span className="pipelines-tab__item-meta">
                      {p.steps.length} step{p.steps.length === 1 ? "" : "s"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="pipelines-tab__editor">
          {draft === null ? (
            <div className="empty-state">
              파이프라인을 선택하거나 새로 만들어 편집하세요.
            </div>
          ) : (
            <div className="pipelines-tab__form">
              <h3 className="pipelines-tab__heading">
                {draft.id === null ? "새 파이프라인" : draft.name || "(이름 없음)"}
              </h3>

              <fieldset className="settings-fieldset">
                <legend>Topology Recommendation</legend>
                <div className="pipeline-recommendation__controls">
                  <label className="settings-field pipeline-recommendation__task">
                    <span className="settings-field__label">TaskRun ID</span>
                    <input
                      type="text"
                      list="topology-task-runs"
                      className="settings-field__input"
                      value={recommendTaskRunId}
                      disabled={saving || recommending}
                      placeholder={
                        taskRunOptions.length > 0
                          ? "최근 TaskRun을 선택하거나 tsk_... 입력"
                          : "tsk_..."
                      }
                      onChange={(e) => setRecommendTaskRunId(e.target.value)}
                    />
                    <datalist id="topology-task-runs">
                      {taskRunOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </datalist>
                  </label>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={
                      saving ||
                      recommending ||
                      recommendTaskRunId.trim().length === 0
                    }
                    onClick={() => void handleRecommend()}
                  >
                    {recommending ? "추천 중…" : "추천 불러오기"}
                  </button>
                </div>
                {selectedTaskRunOption && (
                  <div className="pipeline-recommendation__selected">
                    <span>{selectedTaskRunOption.threadTitle}</span>
                    <strong>{selectedTaskRunOption.status}</strong>
                    <p>{selectedTaskRunOption.userRequest}</p>
                  </div>
                )}
                {recommendationError && (
                  <div
                    className="pipeline-recommendation__error"
                    role="alert"
                  >
                    {recommendationError}
                  </div>
                )}
                {feedbackMessage && (
                  <div className="pipeline-recommendation__feedback">
                    {feedbackMessage}
                  </div>
                )}
                {recommendations.length > 0 && (
                  <div className="pipeline-recommendation__list">
                    {recommendations.map((recommendation) => (
                      <article
                        key={recommendation.id}
                        className="pipeline-recommendation"
                      >
                        <header className="pipeline-recommendation__header">
                          <div>
                            <h4>{recommendation.title}</h4>
                            <p>{recommendation.description}</p>
                          </div>
                          <span className="pipeline-recommendation__confidence">
                            {Math.round(recommendation.confidence * 100)}%
                          </span>
                        </header>
                        <ol className="pipeline-recommendation__steps">
                          {recommendation.steps.map((entry) => (
                            <li key={entry.step.id}>
                              <strong>{entry.step.title}</strong>
                              <span>
                                {entry.step.allowedActions?.length
                                  ? entry.step.allowedActions.join(", ")
                                  : "no direct side effects"}
                              </span>
                            </li>
                          ))}
                        </ol>
                        {recommendation.warnings.length > 0 && (
                          <ul className="pipeline-recommendation__warnings">
                            {recommendation.warnings.map((warning, i) => (
                              <li key={i}>{warning}</li>
                            ))}
                          </ul>
                        )}
                        <div className="pipeline-recommendation__footer">
                          <span>
                            capability{" "}
                            {recommendation.source.capabilityIds.length} ·
                            instinct{" "}
                            {recommendation.source.instinctIds.length} · trace{" "}
                            {recommendation.source.traceIds.length}
                          </span>
                          <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            disabled={saving}
                            onClick={() =>
                              applyRecommendation(recommendation)
                            }
                          >
                            draft에 적용
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            disabled={saving}
                            onClick={() =>
                              dismissRecommendation(recommendation)
                            }
                          >
                            무시
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </fieldset>

              <fieldset className="settings-fieldset">
                <legend>Identity</legend>
                <label className="settings-field">
                  <span className="settings-field__label">이름</span>
                  <input
                    type="text"
                    className="settings-field__input"
                    value={draft.name}
                    disabled={saving}
                    onChange={(e) => updateDraft({ name: e.target.value })}
                  />
                </label>
                <label className="settings-field">
                  <span className="settings-field__label">설명</span>
                  <input
                    type="text"
                    className="settings-field__input"
                    value={draft.description}
                    disabled={saving}
                    onChange={(e) =>
                      updateDraft({ description: e.target.value })
                    }
                  />
                </label>
              </fieldset>

              <fieldset className="settings-fieldset">
                <legend>Steps (순서대로 실행)</legend>
                {draft.steps.length === 0 && (
                  <p className="settings-field__hint">
                    아래 "step 추가" 버튼으로 첫 step을 만드세요.
                  </p>
                )}
                <ol className="pipeline-steps">
                  {draft.steps.map((step, i) => (
                    <li key={step.id} className="pipeline-step">
                      <div className="pipeline-step__header">
                        <span className="pipeline-step__index">
                          {i + 1}
                        </span>
                        <input
                          type="text"
                          className="settings-field__input"
                          placeholder="Step 제목 (예: Plan)"
                          value={step.title}
                          disabled={saving}
                          onChange={(e) =>
                            updateStep(i, { title: e.target.value })
                          }
                        />
                        <div className="pipeline-step__controls">
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            disabled={saving || i === 0}
                            onClick={() => handleMoveStep(i, -1)}
                            aria-label={`${i + 1}번 step을 위로`}
                            title="위로"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            disabled={saving || i === draft.steps.length - 1}
                            onClick={() => handleMoveStep(i, 1)}
                            aria-label={`${i + 1}번 step을 아래로`}
                            title="아래로"
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm btn--danger"
                            disabled={saving}
                            onClick={() => handleRemoveStep(i)}
                            aria-label={`${i + 1}번 step 삭제`}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                      <label className="settings-field">
                        <span className="settings-field__label">
                          Agent Profile
                        </span>
                        <select
                          className="settings-field__input"
                          value={step.agentProfileId}
                          disabled={saving}
                          onChange={(e) =>
                            updateStep(i, { agentProfileId: e.target.value })
                          }
                        >
                          {profiles.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} ({p.role})
                            </option>
                          ))}
                          {/* If the step references a profile not in the list
                              (e.g. dangling), surface it so the user can see
                              and fix the mismatch. */}
                          {!profiles.some(
                            (p) => p.id === step.agentProfileId,
                          ) && (
                            <option value={step.agentProfileId}>
                              {profileName(step.agentProfileId)}
                            </option>
                          )}
                        </select>
                      </label>
                      <label className="settings-field">
                        <span className="settings-field__label">
                          Remote A2A Endpoint
                        </span>
                        <select
                          className="settings-field__input"
                          value={step.remoteEndpointId}
                          disabled={saving}
                          onChange={(e) =>
                            updateStep(i, { remoteEndpointId: e.target.value })
                          }
                        >
                          <option value="">Local CLI</option>
                          {selectableRemoteEntries.map((entry) => (
                            <option
                              key={entry.endpoint.id}
                              value={entry.endpoint.id}
                            >
                              {entry.endpoint.name}
                            </option>
                          ))}
                          {step.remoteEndpointId.length > 0 &&
                            !selectableRemoteEntries.some(
                              (entry) =>
                                entry.endpoint.id === step.remoteEndpointId,
                            ) && (
                              <option value={step.remoteEndpointId}>
                                {remoteName(step.remoteEndpointId)}
                              </option>
                            )}
                        </select>
                      </label>
                      <label className="settings-field">
                        <span className="settings-field__label">
                          Output Contract
                        </span>
                        <select
                          className="settings-field__input"
                          value={step.outputContract}
                          disabled={saving}
                          onChange={(e) =>
                            updateStep(i, {
                              outputContract: e.target
                                .value as WorkerOutputContract | "",
                            })
                          }
                        >
                          <option value="">Role default</option>
                          {PIPELINE_OUTPUT_CONTRACT_CHOICES.map((contract) => (
                            <option key={contract} value={contract}>
                              {contract}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="settings-field">
                        <span className="settings-field__label">
                          Dependencies
                        </span>
                        <div className="pipeline-step__option-grid">
                          {draft.steps
                            .filter((candidate) => candidate.id !== step.id)
                            .map((candidate) => (
                              <label
                                key={candidate.id}
                                className="pipeline-step__check"
                              >
                                <input
                                  type="checkbox"
                                  disabled={saving}
                                  checked={effectiveDependsOn(
                                    step,
                                    i,
                                  ).includes(candidate.id)}
                                  onChange={(e) =>
                                    toggleDependency(
                                      i,
                                      candidate.id,
                                      e.target.checked,
                                    )
                                  }
                                />
                                <span>
                                  {candidate.title.trim() || candidate.id}
                                </span>
                              </label>
                            ))}
                        </div>
                      </div>
                      <div className="settings-field">
                        <span className="settings-field__label">
                          Allowed Actions
                        </span>
                        <div className="pipeline-step__option-row">
                          {PIPELINE_WORKER_ACTION_CHOICES.map((action) => (
                            <label
                              key={action}
                              className="pipeline-step__check"
                            >
                              <input
                                type="checkbox"
                                disabled={saving}
                                checked={
                                  step.allowedActions?.includes(action) ??
                                  false
                                }
                                onChange={(e) =>
                                  toggleAllowedAction(
                                    i,
                                    action,
                                    e.target.checked,
                                  )
                                }
                              />
                              <span>{action}</span>
                            </label>
                          ))}
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            disabled={saving || step.allowedActions === null}
                            onClick={() =>
                              updateStep(i, { allowedActions: null })
                            }
                          >
                            Default
                          </button>
                        </div>
                      </div>
                      <label className="settings-field">
                        <span className="settings-field__label">
                          Instruction (이 step에 전달)
                        </span>
                        <textarea
                          className="settings-field__input settings-field__textarea"
                          rows={2}
                          value={step.instruction}
                          disabled={saving}
                          placeholder="예: 변경된 파일을 분석하고 위험 요소를 정리하세요."
                          onChange={(e) =>
                            updateStep(i, { instruction: e.target.value })
                          }
                        />
                      </label>
                    </li>
                  ))}
                </ol>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={saving || profiles.length === 0}
                  onClick={handleAddStep}
                >
                  + step 추가
                </button>
              </fieldset>

              {validationErrors.length > 0 && (
                <div
                  className="pipelines-tab__errors"
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

              <div className="pipelines-tab__actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void handleSave()}
                  disabled={saving || validationErrors.length > 0}
                >
                  {saving
                    ? "저장 중…"
                    : draft.id === null
                      ? "생성"
                      : "저장"}
                </button>
                {draft.id !== null && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--danger"
                    onClick={() => void handleDelete()}
                    disabled={saving}
                  >
                    삭제
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
