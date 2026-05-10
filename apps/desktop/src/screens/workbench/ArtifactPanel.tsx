import { useEffect, useState } from "react";
import type { Artifact, ArtifactKind } from "@harness/core";
import { DiffViewer } from "./DiffViewer";
import { LogViewer } from "./LogViewer";

interface ArtifactPanelProps {
  artifacts: Artifact[];
}

const KIND_LABEL: Record<ArtifactKind, string> = {
  plan: "계획",
  diff: "Diff",
  log: "Log",
  test_result: "테스트 결과",
  quality_report: "품질 리포트",
  orchestration_plan: "Orchestration 계획",
  file: "파일",
  snapshot: "스냅샷",
};

const groupByKind = (
  artifacts: Artifact[],
): Map<ArtifactKind, Artifact[]> => {
  const groups = new Map<ArtifactKind, Artifact[]>();
  for (const a of artifacts) {
    const list = groups.get(a.kind) ?? [];
    list.push(a);
    groups.set(a.kind, list);
  }
  return groups;
};

export const ArtifactPanel = ({
  artifacts,
}: ArtifactPanelProps): JSX.Element => {
  const [openId, setOpenId] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (openId === null) {
      setContent(null);
      setError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setContent(null);
      setError(null);
      try {
        const r = await window.harness.runner.readArtifact({
          artifactId: openId,
        });
        if (!cancelled) setContent(r.content);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openId]);

  const opened = openId
    ? artifacts.find((a) => a.id === openId) ?? null
    : null;
  const groups = groupByKind(artifacts);
  const visibleKinds = Array.from(groups.keys());

  if (artifacts.length === 0) {
    return <div className="empty-state">아티팩트 없음</div>;
  }

  return (
    <div className="artifact-panel">
      <div className="artifact-panel__list">
        {visibleKinds.map((kind) => (
          <div key={kind} className="artifact-panel__group">
            <header className="artifact-panel__group-header">
              {KIND_LABEL[kind]}
            </header>
            <ul>
              {(groups.get(kind) ?? []).map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    className={`artifact-panel__item${
                      openId === a.id ? " artifact-panel__item--active" : ""
                    }`}
                    onClick={() =>
                      setOpenId((prev) => (prev === a.id ? null : a.id))
                    }
                  >
                    <span className="artifact-panel__title">{a.title}</span>
                    <span className="artifact-panel__meta">
                      {new Date(a.createdAt).toLocaleString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {opened && (
        <div className="artifact-panel__viewer">
          <header className="artifact-panel__viewer-header">
            <span>{opened.title}</span>
            <code>{opened.kind}</code>
          </header>
          {error && (
            <div className="empty-state" style={{ color: "var(--status-failed)" }}>
              {error}
            </div>
          )}
          {!error && content === null && (
            <div className="empty-state">불러오는 중…</div>
          )}
          {!error && content !== null && opened.kind === "diff" && (
            <DiffViewer content={content} />
          )}
          {!error &&
            content !== null &&
            (opened.kind === "log" || opened.kind === "test_result") && (
              <LogViewer content={content} />
            )}
          {!error &&
            content !== null &&
            opened.kind !== "diff" &&
            opened.kind !== "log" &&
            opened.kind !== "test_result" && (
              <pre className="artifact-panel__plain">{content}</pre>
            )}
        </div>
      )}
    </div>
  );
};
