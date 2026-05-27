import { useCallback, useEffect, useMemo, useState } from "react";
import type { HarnessDefinition } from "@harness/core";
import {
  primaryHarnessPackageIssue,
  summarizeHarnessPackage,
} from "./harness-package-ui";

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; packages: HarnessDefinition[] }
  | { kind: "error"; message: string };

interface Notice {
  kind: "success" | "warning" | "error";
  message: string;
}

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const formatTimestamp = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
};

const issueText = (definition: HarnessDefinition): string => {
  const issue = primaryHarnessPackageIssue(definition);
  if (!issue) return "No validation issues";
  return `${issue.code}: ${issue.message}`;
};

export const HarnessPackagesTab = (): JSX.Element => {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const refresh = useCallback(async () => {
    try {
      const packages = await window.harness.harnessPackages.list();
      setList({ kind: "ready", packages });
    } catch (e) {
      setList({ kind: "error", message: errorMessage(e) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (list.kind !== "ready") return;
    if (selectedId === null && list.packages.length > 0) {
      setSelectedId(list.packages[0]!.id);
      return;
    }
    if (
      selectedId !== null &&
      !list.packages.some((item) => item.id === selectedId)
    ) {
      setSelectedId(list.packages[0]?.id ?? null);
    }
  }, [list, selectedId]);

  const selectedPackage = useMemo(() => {
    if (list.kind !== "ready" || selectedId === null) return null;
    return list.packages.find((item) => item.id === selectedId) ?? null;
  }, [list, selectedId]);

  const selectedSummary = selectedPackage
    ? summarizeHarnessPackage(selectedPackage)
    : null;

  const handleImportDirectory = async (): Promise<void> => {
    setNotice(null);
    setBusy(true);
    try {
      const rootDir = await window.harness.app.selectDirectory();
      if (!rootDir) return;
      const result = await window.harness.harnessPackages.importDirectory({
        rootDir,
      });
      if (result.ok) {
        setNotice({
          kind:
            result.definition.validation.status === "needs_review"
              ? "warning"
              : "success",
          message: `${result.definition.name} imported as ${result.definition.source.format}.`,
        });
        setSelectedId(result.definition.id);
      } else {
        setNotice({
          kind: "warning",
          message: result.issues.map((issue) => issue.message).join(" "),
        });
      }
      await refresh();
    } catch (e) {
      setNotice({ kind: "error", message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (definition: HarnessDefinition): Promise<void> => {
    if (!window.confirm(`"${definition.name}" package snapshot을 제거하시겠습니까?`)) {
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await window.harness.harnessPackages.remove({
        packageId: definition.id,
      });
      setNotice({
        kind: "success",
        message: `${definition.name} removed from registry.`,
      });
      setSelectedId(null);
      await refresh();
    } catch (e) {
      setNotice({ kind: "error", message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="harness-packages-tab">
      <div className="harness-packages-tab__banner" role="note">
        <strong>Harness Packages</strong>
        <span>Claude, Codex, Harness-native metadata snapshots</span>
      </div>

      {notice && (
        <div
          className={`harness-packages-tab__notice harness-packages-tab__notice--${notice.kind}`}
        >
          {notice.message}
        </div>
      )}

      <div className="harness-packages-tab__split">
        <aside className="harness-packages-tab__list">
          <header className="harness-packages-tab__list-header">
            <span>Packages</span>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => void handleImportDirectory()}
              disabled={busy}
            >
              {busy ? "Importing..." : "Import"}
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
          {list.kind === "ready" && list.packages.length === 0 && (
            <div className="empty-state">등록된 harness package가 없습니다.</div>
          )}
          {list.kind === "ready" && (
            <ul className="harness-packages-tab__items">
              {list.packages.map((definition) => {
                const summary = summarizeHarnessPackage(definition);
                return (
                  <li key={definition.id}>
                    <button
                      type="button"
                      className={`harness-packages-tab__item${
                        selectedId === definition.id
                          ? " harness-packages-tab__item--selected"
                          : ""
                      }`}
                      onClick={() => setSelectedId(definition.id)}
                    >
                      <span className="harness-packages-tab__item-name">
                        {definition.name}
                      </span>
                      <span className="harness-packages-tab__item-meta">
                        {summary.formatLabel} · {summary.statusLabel}
                      </span>
                      <span className="harness-packages-tab__item-meta">
                        {summary.skills} skills · {summary.agents} agents ·{" "}
                        {summary.workflows} workflows
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <section className="harness-packages-tab__detail">
          {selectedPackage === null || selectedSummary === null ? (
            <div className="empty-state">
              Harness package snapshot을 import하거나 선택하세요.
            </div>
          ) : (
            <div className="harness-packages-tab__detail-inner">
              <header className="harness-packages-tab__detail-header">
                <div>
                  <h3>{selectedPackage.name}</h3>
                  <code title={selectedPackage.source.rootDir}>
                    {selectedPackage.source.rootDir}
                  </code>
                </div>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm btn--danger"
                  onClick={() => void handleRemove(selectedPackage)}
                  disabled={busy}
                >
                  Remove
                </button>
              </header>

              <div className="harness-packages-tab__badges">
                <span>{selectedSummary.formatLabel}</span>
                <span
                  className={`harness-packages-tab__status harness-packages-tab__status--${selectedPackage.validation.status}`}
                >
                  {selectedSummary.statusLabel}
                </span>
                {selectedSummary.blocksExecution && (
                  <span className="harness-packages-tab__status harness-packages-tab__status--blocked">
                    Execution blocked
                  </span>
                )}
              </div>

              <dl className="harness-packages-tab__metrics">
                <div>
                  <dt>Files</dt>
                  <dd>{selectedSummary.files}</dd>
                </div>
                <div>
                  <dt>Skills</dt>
                  <dd>{selectedSummary.skills}</dd>
                </div>
                <div>
                  <dt>Agents</dt>
                  <dd>{selectedSummary.agents}</dd>
                </div>
                <div>
                  <dt>Workflows</dt>
                  <dd>{selectedSummary.workflows}</dd>
                </div>
                <div>
                  <dt>Capabilities</dt>
                  <dd>{selectedSummary.capabilities}</dd>
                </div>
                <div>
                  <dt>Imported</dt>
                  <dd>{formatTimestamp(selectedPackage.source.importedAt)}</dd>
                </div>
              </dl>

              <section className="harness-packages-tab__section">
                <h4>Overview</h4>
                <p>{selectedPackage.overview.summary || selectedPackage.name}</p>
              </section>

              <section className="harness-packages-tab__section">
                <h4>Validation</h4>
                {selectedPackage.validation.issues.length === 0 ? (
                  <p>No validation issues.</p>
                ) : (
                  <>
                    <p>{issueText(selectedPackage)}</p>
                    <ul className="harness-packages-tab__issues">
                      {selectedPackage.validation.issues.map((issue, index) => (
                        <li key={`${issue.code}-${index}`}>
                          <span>{issue.severity}</span>
                          <strong>{issue.code}</strong>
                          <p>{issue.message}</p>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>

              <section className="harness-packages-tab__section">
                <h4>Skills</h4>
                {selectedPackage.skills.length === 0 ? (
                  <p>No skills imported.</p>
                ) : (
                  <ul className="harness-packages-tab__compact-list">
                    {selectedPackage.skills.map((skill) => (
                      <li key={skill.id}>
                        <strong>{skill.name}</strong>
                        <span>{skill.sourceFile}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="harness-packages-tab__section">
                <h4>Agents</h4>
                {selectedPackage.agents.length === 0 ? (
                  <p>No agents imported.</p>
                ) : (
                  <ul className="harness-packages-tab__compact-list">
                    {selectedPackage.agents.map((agent) => (
                      <li key={agent.id}>
                        <strong>{agent.name}</strong>
                        <span>{agent.sourceFile}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
