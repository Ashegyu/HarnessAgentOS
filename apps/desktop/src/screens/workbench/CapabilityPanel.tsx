import { useCallback, useEffect, useState } from "react";
import type { Capability, CapabilitySuggestion, TaskRun } from "@harness/core";
import { SkillDetailDrawer } from "./SkillDetailDrawer";

interface CapabilityPanelProps {
  taskRun: TaskRun | null;
  /** Latest user prompt to use for suggestion ranking. */
  prompt: string;
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
  prompt,
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
      });
      setSuggestions({ kind: "ready", suggestions: result });
    } catch (e) {
      setSuggestions({ kind: "error", message: errorMessage(e) });
    }
  }, [taskRun, prompt]);

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
          관련 추천이 없습니다. 좌측 입력에서 trigger term을 늘려보세요.
        </div>
      );
    }
    return (
      <ul className="capability-list">
        {suggestions.suggestions.map((s) => (
          <li
            key={s.capability.id}
            className={`capability-item${s.capability.requiresApproval ? " capability-item--approval" : ""}`}
          >
            <header className="capability-item__header">
              <span className="capability-item__name">{s.capability.name}</span>
              <span
                className={`status-pill status-pill--${riskClass(s.capability.riskLevel)}`}
              >
                {s.capability.riskLevel}
              </span>
            </header>
            <p className="capability-item__desc">{s.capability.description}</p>
            <p className="capability-item__reason">추천됨 — {s.reason}</p>
            <div className="capability-item__actions">
              <button
                type="button"
                className="btn"
                onClick={() => setOpenCapability(s.capability)}
              >
                상세 보기
              </button>
            </div>
          </li>
        ))}
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
      {actionError ? <div className="error-message">{actionError}</div> : null}
      {renderSuggestions()}

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
