import { useCallback, useEffect, useState } from "react";
import type {
  Approval,
  ApprovalStatus,
  Capability,
  CapabilitySuggestion,
  TaskRun,
} from "@harness/core";
import { SkillDetailDrawer } from "./SkillDetailDrawer";

interface CapabilityPanelProps {
  taskRun: TaskRun | null;
  approvals?: Approval[];
  /** Latest user prompt to use for suggestion ranking. */
  prompt: string;
  profileId?: string | null;
  /** Notify the parent when a script run approval is created. */
  onApprovalCreated: () => Promise<void>;
}

type SuggestionsState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; suggestions: CapabilitySuggestion[] }
  | { kind: "error"; message: string };

type CatalogState =
  | { kind: "loading" }
  | { kind: "ready"; capabilities: Capability[] }
  | { kind: "error"; message: string };

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export const CapabilityPanel = ({
  taskRun,
  approvals = [],
  prompt,
  profileId = null,
  onApprovalCreated,
}: CapabilityPanelProps): JSX.Element => {
  const [catalog, setCatalog] = useState<CatalogState>({ kind: "loading" });
  const [suggestions, setSuggestions] = useState<SuggestionsState>({
    kind: "idle",
  });
  const [openCapability, setOpenCapability] = useState<Capability | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchCatalog = useCallback(async () => {
    setCatalog({ kind: "loading" });
    try {
      const capabilities = await window.harness.capability.list();
      setCatalog({ kind: "ready", capabilities });
    } catch (e) {
      setCatalog({ kind: "error", message: errorMessage(e) });
    }
  }, []);

  const refreshFromDisk = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      const capabilities = await window.harness.capability.refresh();
      setCatalog({ kind: "ready", capabilities });
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const fetchSuggestions = useCallback(async () => {
    if (!taskRun) {
      setSuggestions({ kind: "idle" });
      return;
    }
    setSuggestions({ kind: "loading" });
    try {
      const result = await window.harness.capability.suggest({
        taskRunId: taskRun.id,
        prompt,
        profileId,
      });
      setSuggestions({ kind: "ready", suggestions: result });
    } catch (e) {
      setSuggestions({ kind: "error", message: errorMessage(e) });
    }
  }, [taskRun, prompt, profileId]);

  useEffect(() => {
    void fetchCatalog();
  }, [fetchCatalog]);

  useEffect(() => {
    void fetchSuggestions();
  }, [fetchSuggestions]);

  const handleProposeScript = useCallback(
    async (capability: Capability, scriptName: string): Promise<void> => {
      if (!taskRun) throw new Error("TaskRun이 선택되지 않았습니다");
      await window.harness.capability.proposeScriptRun({
        capabilityId: capability.id,
        taskRunId: taskRun.id,
        scriptName,
      });
      await onApprovalCreated();
    },
    [taskRun, onApprovalCreated],
  );

  const handleProposeCandidates = useCallback(async (): Promise<void> => {
    if (!taskRun) throw new Error("TaskRun이 선택되지 않았습니다");
    setBusy(true);
    setActionError(null);
    try {
      await window.harness.capability.proposeCandidates({
        taskRunId: taskRun.id,
        prompt,
        profileId,
      });
      await fetchSuggestions();
      await onApprovalCreated();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [fetchSuggestions, onApprovalCreated, profileId, prompt, taskRun]);

  const renderCatalog = (): JSX.Element => {
    if (catalog.kind === "loading") {
      return <div className="empty-state">등록 목록 불러오는 중…</div>;
    }
    if (catalog.kind === "error") {
      return <div className="error-message">{catalog.message}</div>;
    }
    if (catalog.capabilities.length === 0) {
      return (
        <div className="empty-state">
          등록된 capability가 없습니다. Skill 디렉터리 재스캔으로 등록 상태를
          확인하세요.
        </div>
      );
    }

    return (
      <section className="capability-panel__section" aria-label="등록된 capability">
        <header className="capability-panel__section-header">
          <span>등록된 capability</span>
          <span className="muted">{catalog.capabilities.length}개</span>
        </header>
        <p className="capability-item__reason">
          전체 registry에는 등록되어 있지만 현재 요청과 매칭되지 않을 수
          있습니다.
        </p>
        <ul className="capability-list capability-list--catalog">
          {catalog.capabilities.map((capability) => (
            <li key={capability.id} className="capability-item">
              <header className="capability-item__header">
                <span className="capability-item__name">{capability.name}</span>
                <span className="capability-item__badges">
                  <span
                    className={`status-pill status-pill--${riskClass(capability.riskLevel)}`}
                  >
                    {capability.riskLevel}
                  </span>
                  <span className="status-pill status-pill--neutral">
                    {capability.source}
                  </span>
                </span>
              </header>
              <p className="capability-item__desc">{capability.description}</p>
              {capability.triggerTerms.length > 0 ? (
                <p className="capability-item__reason">
                  trigger: {capability.triggerTerms.join(", ")}
                </p>
              ) : null}
              <div className="capability-item__actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setOpenCapability(capability)}
                >
                  상세 보기
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    );
  };

  const renderSuggestions = (): JSX.Element => {
    if (!taskRun) {
      return (
        <div className="empty-state">TaskRun을 선택하면 추천이 표시됩니다.</div>
      );
    }
    if (suggestions.kind === "loading") {
      return <div className="empty-state">추천 계산 중…</div>;
    }
    if (suggestions.kind === "error") {
      return <div className="error-message">{suggestions.message}</div>;
    }
    if (suggestions.kind === "idle" || suggestions.suggestions.length === 0) {
      return (
        <div className="empty-state">
          현재 요청과 일치하는 capability가 없습니다. 요청에 구체적인 작업
          단어를 포함하거나 Skill 디렉터리 재스캔으로 등록 상태를 확인하세요.
        </div>
      );
    }
    const statusByCapabilityId = new Map<string, ApprovalStatus>();
    for (const approval of approvals) {
      if (approval.actionType !== "capability_use") continue;
      const capabilityId = approval.proposedAction?.capabilityUse?.capabilityId;
      if (capabilityId) statusByCapabilityId.set(capabilityId, approval.status);
    }
    return (
      <ul className="capability-list">
        {suggestions.suggestions.map((s) => {
          const approvalStatus = statusByCapabilityId.get(s.capability.id);
          return (
            <li
              key={s.capability.id}
              className={`capability-item${s.capability.requiresApproval ? " capability-item--approval" : ""}`}
            >
              <header className="capability-item__header">
                <span className="capability-item__name">{s.capability.name}</span>
                <span className="capability-item__badges">
                  <span
                    className={`status-pill status-pill--${candidateStatusClass(approvalStatus)}`}
                  >
                    {candidateStatusLabel(approvalStatus)}
                  </span>
                  <span
                    className={`status-pill status-pill--${riskClass(s.capability.riskLevel)}`}
                  >
                    {s.capability.riskLevel}
                  </span>
                </span>
              </header>
              <p className="capability-item__desc">{s.capability.description}</p>
              <p className="capability-item__reason">
                자동 판단 근거 — {s.reason}
              </p>
              <p className="capability-item__reason">
                승인되면 이 Skill의 SKILL.md가 다음 Agent 프롬프트 컨텍스트에
                들어갑니다. 파일/명령 실행은 별도 approval이 필요합니다.
              </p>
              <div className="capability-item__actions">
                {!approvalStatus ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void handleProposeCandidates()}
                    disabled={busy}
                  >
                    후보 approval 생성
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn"
                  onClick={() => setOpenCapability(s.capability)}
                >
                  상세 보기
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div className="capability-panel">
      <div className="capability-panel__row">
        <span className="muted">
          {catalog.kind === "ready"
            ? `${catalog.capabilities.length}개 capability 등록됨`
            : catalog.kind === "loading"
              ? "불러오는 중…"
              : `로드 실패: ${catalog.message}`}
        </span>
        <button
          type="button"
          className="btn"
          onClick={() => void refreshFromDisk()}
          disabled={busy}
        >
          {busy ? "스캔 중…" : "Skill 디렉터리 재스캔"}
        </button>
      </div>
      <div className="capability-panel__summary">
        Skillify가 TaskRun 요청과 trigger term을 비교해 후보를 고르고,
        후보는 <strong>Skill 후보 사용</strong> approval로 올라갑니다. 승인된
        후보만 Claude/Codex Agent 프롬프트에 반영됩니다.
      </div>
      {actionError ? <div className="error-message">{actionError}</div> : null}
      {renderSuggestions()}
      {renderCatalog()}

      {openCapability ? (
        <SkillDetailDrawer
          capability={openCapability}
          taskRunId={taskRun?.id ?? null}
          onClose={() => setOpenCapability(null)}
          onProposeScriptRun={(scriptName) =>
            handleProposeScript(openCapability, scriptName)
          }
        />
      ) : null}
    </div>
  );
};

const riskClass = (level: Capability["riskLevel"]): string => {
  if (level === "high") return "failed";
  if (level === "medium") return "warning";
  return "passed";
};

const candidateStatusLabel = (status: ApprovalStatus | undefined): string => {
  switch (status) {
    case "pending":
      return "승인 대기";
    case "approved":
    case "always_approved_for_run":
    case "executed":
      return "승인됨";
    case "rejected":
      return "거절됨";
    default:
      return "추천";
  }
};

const candidateStatusClass = (
  status: ApprovalStatus | undefined,
): string => {
  switch (status) {
    case "pending":
      return "warning";
    case "approved":
    case "always_approved_for_run":
    case "executed":
      return "passed";
    case "rejected":
      return "failed";
    default:
      return "neutral";
  }
};
