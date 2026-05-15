import { useCallback, useEffect, useMemo, useState } from "react";
import type { EvolutionCandidate, Instinct } from "@harness/core";

type InstinctState =
  | { kind: "loading" }
  | {
      kind: "ready";
      candidates: EvolutionCandidate[];
      instincts: Instinct[];
    }
  | { kind: "error"; message: string };

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export const InstinctPanel = (): JSX.Element => {
  const [state, setState] = useState<InstinctState>({ kind: "loading" });
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [candidateNotes, setCandidateNotes] = useState<Record<string, string>>(
    {},
  );
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setState({ kind: "loading" });
    try {
      const [candidates, instincts] = await Promise.all([
        window.harness.instinct.listCandidates({}),
        window.harness.instinct.list({ includeDisabled }),
      ]);
      setState({ kind: "ready", candidates, instincts });
    } catch (e) {
      setState({ kind: "error", message: errorMessage(e) });
    }
  }, [includeDisabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const stats = useMemo(() => {
    if (state.kind !== "ready") return null;
    return {
      pending: state.candidates.length,
      active: state.instincts.filter((i) => i.status === "active").length,
      disabled: state.instincts.filter((i) => i.status === "disabled").length,
    };
  }, [state]);

  const setCandidateNote = useCallback((candidateId: string, note: string) => {
    setCandidateNotes((prev) => ({ ...prev, [candidateId]: note }));
  }, []);

  const approveCandidate = useCallback(
    async (candidate: EvolutionCandidate): Promise<void> => {
      setBusyId(candidate.id);
      setActionMessage(null);
      try {
        const note = candidateNotes[candidate.id]?.trim();
        await window.harness.instinct.approveCandidate({
          candidateId: candidate.id,
          ...(note ? { message: note } : {}),
        });
        setActionMessage("후보를 Instinct로 승인했습니다.");
        await refresh();
      } catch (e) {
        setActionMessage(errorMessage(e));
      } finally {
        setBusyId(null);
      }
    },
    [candidateNotes, refresh],
  );

  const rejectCandidate = useCallback(
    async (candidate: EvolutionCandidate): Promise<void> => {
      const note = candidateNotes[candidate.id]?.trim() || "사용자 거절";
      setBusyId(candidate.id);
      setActionMessage(null);
      try {
        await window.harness.instinct.rejectCandidate({
          candidateId: candidate.id,
          message: note,
        });
        setActionMessage("후보를 거절했습니다.");
        await refresh();
      } catch (e) {
        setActionMessage(errorMessage(e));
      } finally {
        setBusyId(null);
      }
    },
    [candidateNotes, refresh],
  );

  const disableInstinct = useCallback(
    async (instinct: Instinct): Promise<void> => {
      const reason = window.prompt("비활성화 사유", "현재 프로젝트에 맞지 않음");
      if (!reason || reason.trim().length === 0) return;
      setBusyId(instinct.id);
      setActionMessage(null);
      try {
        await window.harness.instinct.disable({
          instinctId: instinct.id,
          reason: reason.trim(),
        });
        setActionMessage("Instinct를 비활성화했습니다.");
        await refresh();
      } catch (e) {
        setActionMessage(errorMessage(e));
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  return (
    <div className="instinct-panel">
      <div className="capability-panel__row">
        <span className="muted">
          {stats
            ? `후보 ${stats.pending}개 · active ${stats.active}개 · disabled ${stats.disabled}개`
            : "불러오는 중…"}
        </span>
        <label className="instinct-panel__toggle">
          <input
            type="checkbox"
            checked={includeDisabled}
            onChange={(e) => setIncludeDisabled(e.currentTarget.checked)}
          />
          disabled 표시
        </label>
        <button type="button" className="btn" onClick={() => void refresh()}>
          새로고침
        </button>
      </div>

      {actionMessage ? <div className="muted">{actionMessage}</div> : null}

      {state.kind === "loading" ? (
        <div className="empty-state">Instinct 불러오는 중…</div>
      ) : null}
      {state.kind === "error" ? (
        <div className="error-message">{state.message}</div>
      ) : null}
      {state.kind === "ready" ? (
        <div className="instinct-panel__stack">
          <section className="instinct-panel__section">
            <header className="learner-panel__trace-header">후보 검토</header>
            {state.candidates.length === 0 ? (
              <div className="empty-state">대기 중인 후보 없음</div>
            ) : (
              <ul className="capability-list">
                {state.candidates.map((candidate) => (
                  <li key={candidate.id} className="capability-item">
                    <header className="capability-item__header">
                      <span className="capability-item__name">
                        {candidate.title}
                      </span>
                      <span className="capability-item__badges">
                        <span className="status-pill status-pill--warning">
                          pending
                        </span>
                        <span className="status-pill status-pill--neutral">
                          {(candidate.confidence * 100).toFixed(0)}%
                        </span>
                      </span>
                    </header>
                    <p className="capability-item__desc">
                      {candidate.proposedRule}
                    </p>
                    <p className="capability-item__reason">
                      {candidate.rationale} · observations{" "}
                      {candidate.observationIds.length}
                    </p>
                    <textarea
                      className="textarea"
                      rows={2}
                      value={candidateNotes[candidate.id] ?? ""}
                      onChange={(e) =>
                        setCandidateNote(candidate.id, e.currentTarget.value)
                      }
                      placeholder="승인/거절 메모"
                    />
                    <div className="capability-item__actions">
                      <button
                        type="button"
                        className="btn btn--primary"
                        onClick={() => void approveCandidate(candidate)}
                        disabled={busyId === candidate.id}
                      >
                        승인
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void rejectCandidate(candidate)}
                        disabled={busyId === candidate.id}
                      >
                        거절
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="instinct-panel__section">
            <header className="learner-panel__trace-header">Instinct</header>
            {state.instincts.length === 0 ? (
              <div className="empty-state">활성 Instinct 없음</div>
            ) : (
              <ul className="capability-list">
                {state.instincts.map((instinct) => (
                  <li key={instinct.id} className="capability-item">
                    <header className="capability-item__header">
                      <span className="capability-item__name">
                        {instinct.title}
                      </span>
                      <span className="capability-item__badges">
                        <span
                          className={`status-pill status-pill--${instinctStatusClass(
                            instinct.status,
                          )}`}
                        >
                          {instinct.status}
                        </span>
                        <span className="status-pill status-pill--neutral">
                          {instinct.scope}
                        </span>
                      </span>
                    </header>
                    <p className="capability-item__desc">{instinct.rule}</p>
                    <p className="capability-item__reason">
                      {instinct.rationale} · confidence{" "}
                      {(instinct.confidence * 100).toFixed(0)}%
                    </p>
                    {instinct.status === "active" ? (
                      <div className="capability-item__actions">
                        <button
                          type="button"
                          className="btn"
                          onClick={() => void disableInstinct(instinct)}
                          disabled={busyId === instinct.id}
                        >
                          비활성화
                        </button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
};

const instinctStatusClass = (status: Instinct["status"]): string => {
  switch (status) {
    case "active":
      return "passed";
    case "disabled":
      return "neutral";
    case "rejected":
      return "failed";
  }
};
