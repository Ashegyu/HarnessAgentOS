import { useEffect, useState } from "react";
import type { RuntimeInfo } from "@harness/core";

type RuntimeState =
  | { kind: "loading" }
  | { kind: "ready"; info: RuntimeInfo }
  | { kind: "error"; message: string };

export const RuntimeStatusBar = (): JSX.Element => {
  const [state, setState] = useState<RuntimeState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await window.harness.app.getRuntimeInfo();
        if (!cancelled) setState({ kind: "ready", info });
      } catch (e) {
        if (!cancelled) {
          const message = e instanceof Error ? e.message : String(e);
          setState({ kind: "error", message });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <footer className="runtime-status-bar" aria-label="Runtime status">
      <span className="runtime-status-bar__group">
        <span
          className={
            state.kind === "ready"
              ? "status-dot status-dot--ok"
              : state.kind === "error"
                ? "status-dot status-dot--err"
                : "status-dot status-dot--loading"
          }
          aria-hidden
        />
        <span aria-label="Runtime status label">
          {state.kind === "ready"
            ? "런타임 준비됨"
            : state.kind === "error"
              ? "런타임 오류"
              : "런타임 확인 중"}
        </span>
      </span>
      {state.kind === "ready" && (
        <>
          <span className="runtime-status-bar__sep">·</span>
          <span className="runtime-status-bar__group">
            <span>v{state.info.appVersion}</span>
          </span>
          <span className="runtime-status-bar__sep">·</span>
          <span className="runtime-status-bar__group">
            <span>{state.info.platform}</span>
          </span>
          <span className="runtime-status-bar__sep">·</span>
          <span className="runtime-status-bar__group" title={state.info.appDataDir}>
            <span style={{ maxWidth: 460, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {state.info.appDataDir}
            </span>
          </span>
        </>
      )}
      {state.kind === "error" && (
        <>
          <span className="runtime-status-bar__sep">·</span>
          <span style={{ color: "var(--status-failed)" }}>{state.message}</span>
        </>
      )}
    </footer>
  );
};
