import { useEffect, useState } from "react";
import type { Capability, SkillResources } from "@harness/core";

interface SkillDetailDrawerProps {
  capability: Capability;
  taskRunId: string | null;
  onClose: () => void;
  onProposeScriptRun: (scriptName: string) => Promise<void>;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; instructions: string; resources: SkillResources }
  | { kind: "error"; message: string };

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export const SkillDetailDrawer = ({
  capability,
  taskRunId,
  onClose,
  onProposeScriptRun,
}: SkillDetailDrawerProps): JSX.Element => {
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [selectedScript, setSelectedScript] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const { instructions, resources } =
          await window.harness.capability.readSkill({
            capabilityId: capability.id,
          });
        if (!cancelled) {
          setLoadState({ kind: "ready", instructions, resources });
          if (resources.scripts.length > 0 && resources.scripts[0]) {
            setSelectedScript(resources.scripts[0]);
          }
        }
      } catch (e) {
        if (!cancelled) setLoadState({ kind: "error", message: errorMessage(e) });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [capability.id]);

  const canPropose =
    selectedScript.trim().length > 0 && !!taskRunId && !busy;

  const handlePropose = async (): Promise<void> => {
    if (!canPropose) return;
    setBusy(true);
    setActionError(null);
    try {
      await onProposeScriptRun(selectedScript.trim());
      onClose();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const isHighRisk = capability.riskLevel === "high";

  return (
    <div role="dialog" aria-modal="true" className="dialog-backdrop">
      <div className="dialog">
        <header className="dialog__header">
          <h3>{capability.name}</h3>
          <span
            className={`status-pill status-pill--${riskClass(capability.riskLevel)}`}
          >
            {capability.riskLevel} risk
          </span>
        </header>
        <div className="dialog__body">
          <p className="dialog__lede">{capability.description}</p>
          {isHighRisk ? (
            <div className="error-message">
              ⚠ High-risk skill. 모든 작업은 명시적 승인이 필요합니다.
            </div>
          ) : null}
          {loadState.kind === "loading" ? (
            <div className="empty-state">SKILL.md 불러오는 중…</div>
          ) : null}
          {loadState.kind === "error" ? (
            <div className="error-message">{loadState.message}</div>
          ) : null}
          {loadState.kind === "ready" ? (
            <>
              <pre className="skill-detail__instructions">
                {loadState.instructions}
              </pre>
              <ResourceList
                title="Scripts"
                items={loadState.resources.scripts}
                selectable
                selected={selectedScript}
                onSelect={setSelectedScript}
                emptyHint="scripts/ 폴더가 비어 있습니다."
              />
              <ResourceList
                title="Templates"
                items={loadState.resources.templates}
                emptyHint="templates/ 폴더가 비어 있습니다."
              />
              <ResourceList
                title="Examples"
                items={loadState.resources.examples}
                emptyHint="examples/ 폴더가 비어 있습니다."
              />
            </>
          ) : null}
          {!taskRunId ? (
            <div className="muted">
              TaskRun을 먼저 선택해야 script 실행 요청이 가능합니다.
            </div>
          ) : null}
          {actionError ? <div className="error-message">{actionError}</div> : null}
        </div>
        <footer className="dialog__footer">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            닫기
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void handlePropose()}
            disabled={!canPropose}
            title={
              !taskRunId
                ? "TaskRun을 먼저 선택하세요"
                : selectedScript.trim().length === 0
                  ? "Scripts 목록에서 하나를 선택하세요"
                  : "Approval이 생성됩니다 (자동 실행 안 됨)"
            }
          >
            {busy
              ? "처리 중…"
              : selectedScript
                ? `${selectedScript} 실행 요청 (Approval 생성)`
                : "실행 요청"}
          </button>
        </footer>
      </div>
    </div>
  );
};

interface ResourceListProps {
  title: string;
  items: string[];
  selectable?: boolean;
  selected?: string;
  onSelect?: (name: string) => void;
  emptyHint: string;
}

const ResourceList = ({
  title,
  items,
  selectable,
  selected,
  onSelect,
  emptyHint,
}: ResourceListProps): JSX.Element => {
  return (
    <section className="skill-detail__resource">
      <header className="skill-detail__resource-header">
        <span>{title}</span>
        <span className="muted">{items.length} 항목</span>
      </header>
      {items.length === 0 ? (
        <div className="muted skill-detail__resource-empty">{emptyHint}</div>
      ) : (
        <ul className="skill-detail__resource-list">
          {items.map((name) => (
            <li key={name}>
              {selectable && onSelect ? (
                <label className="skill-detail__resource-item">
                  <input
                    type="radio"
                    name={`resource-${title}`}
                    checked={selected === name}
                    onChange={() => onSelect(name)}
                  />
                  <span>{name}</span>
                </label>
              ) : (
                <span className="skill-detail__resource-item">{name}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const riskClass = (level: Capability["riskLevel"]): string => {
  if (level === "high") return "failed";
  if (level === "medium") return "warning";
  return "passed";
};
