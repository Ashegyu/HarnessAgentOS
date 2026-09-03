import { useCallback, useEffect, useState } from "react";
import type {
  AgentProviderStatusMap,
  AgentStreamEvent,
} from "@harness/core";

type ProvidersState =
  | { kind: "loading" }
  | { kind: "ready"; providers: AgentProviderStatusMap }
  | { kind: "error"; message: string };

const labelFor = (
  name: "codex",
  probe: AgentProviderStatusMap[keyof AgentProviderStatusMap],
): string => {
  if (!probe.available) return `${name} ✗`;
  const depth = probe.queueDepth > 0 ? ` (queue ${probe.queueDepth})` : "";
  return `${name} ✓${depth}`;
};

const detailFor = (
  name: "codex",
  probe: AgentProviderStatusMap[keyof AgentProviderStatusMap],
): string => {
  const status = probe.available
    ? probe.version ?? "available"
    : probe.error ?? "unavailable";
  return probe.command
    ? `${name} ${status}\ncommand ${probe.command}`
    : `${name} ${status}`;
};

/**
 * Phase 8 — small pill rendered inside RuntimeStatusBar. Probes
 * `agent.checkProviders()` on mount, refreshes when a stream event
 * marks a started/result/failed boundary. Doesn't refresh on every
 * `raw` chunk to avoid a probe storm during long invocations.
 */
export const AgentProviderStatus = (): JSX.Element | null => {
  const [state, setState] = useState<ProvidersState>({ kind: "loading" });

  const refresh = useCallback(async () => {
    try {
      const providers = await window.harness.agent.checkProviders();
      setState({ kind: "ready", providers });
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const off = window.harness.events.onAgentStreamEvent(
      (event: AgentStreamEvent) => {
        if (
          event.type === "started" ||
          event.type === "result" ||
          event.type === "failed"
        ) {
          void refresh();
        }
      },
    );
    return off;
  }, [refresh]);

  if (state.kind === "loading") {
    return (
      <span className="runtime-status-bar__group" aria-label="Agent providers">
        <span>agent: 확인 중</span>
      </span>
    );
  }
  if (state.kind === "error") {
    return (
      <span
        className="runtime-status-bar__group"
        title={state.message}
        aria-label="Agent providers"
      >
        <span style={{ color: "var(--status-failed)" }}>agent: 오류</span>
      </span>
    );
  }
  const { codex } = state.providers;
  return (
    <span
      className="runtime-status-bar__group"
      aria-label="Codex provider"
      title={detailFor("codex", codex)}
    >
      <button
        type="button"
        className="runtime-status-bar__refresh"
        onClick={() => void refresh()}
        title="다시 확인"
      >
        ↻
      </button>
      <span style={{ color: codex.available ? "var(--text-primary)" : "var(--text-muted)" }}>
        {labelFor("codex", codex)}
      </span>
    </span>
  );
};
