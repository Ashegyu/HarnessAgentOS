import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type {
  AgentProvider,
  AgentProviderProbe,
  SystemDiagnostics,
} from "@harness/core";
import {
  diagnosticsHasWarnings,
  diagnosticsTone,
  formatDiagnosticBytes,
  providerAvailabilityLabel,
} from "./system-diagnostics-model";

type DiagnosticsState =
  | { kind: "loading" }
  | { kind: "ready"; diagnostics: SystemDiagnostics }
  | { kind: "error"; message: string };

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const SystemDiagnosticsTab = (): JSX.Element => {
  const [state, setState] = useState<DiagnosticsState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.harness.events.onDiagnosticsChanged(
      (diagnostics) => {
        if (!cancelled) setState({ kind: "ready", diagnostics });
      },
    );
    window.harness.app
      .getDiagnostics()
      .then((diagnostics) => {
        if (!cancelled) setState({ kind: "ready", diagnostics });
      })
      .catch((error) => {
        if (!cancelled) setState({ kind: "error", message: errorMessage(error) });
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return (
    <div className="system-diagnostics">
      <header className="system-diagnostics__toolbar">
        <div>
          <h3>System Diagnostics</h3>
          <span>
            {state.kind === "ready"
              ? `updated ${formatTime(state.diagnostics.generatedAt)}`
              : "DB / Queue / Providers / Runner"}
          </span>
        </div>
        {state.kind === "ready" ? (
          <span
            className={`status-pill status-pill--${
              diagnosticsHasWarnings(state.diagnostics) ? "warning" : "passed"
            }`}
          >
            {diagnosticsHasWarnings(state.diagnostics) ? "warning" : "ok"}
          </span>
        ) : null}
      </header>

      {state.kind === "loading" ? (
        <div className="empty-state">System diagnostics를 불러오는 중...</div>
      ) : null}
      {state.kind === "error" ? (
        <div className="empty-state" style={{ color: "var(--status-failed)" }}>
          {state.message}
        </div>
      ) : null}
      {state.kind === "ready" ? (
        <DiagnosticsCards diagnostics={state.diagnostics} />
      ) : null}
    </div>
  );
};

const DiagnosticsCards = ({
  diagnostics,
}: {
  diagnostics: SystemDiagnostics;
}): JSX.Element => (
  <section className="system-diagnostics__grid" aria-label="System diagnostics cards">
    <DiagnosticsCard
      title="Database"
      status={diagnostics.db.status}
      value={formatDiagnosticBytes(diagnostics.db.totalBytes)}
      warning={diagnostics.db.warning}
    >
      <Metric label="Main" value={formatDiagnosticBytes(diagnostics.db.mainBytes)} />
      <Metric label="WAL" value={formatDiagnosticBytes(diagnostics.db.walBytes)} />
      <Metric label="SHM" value={formatDiagnosticBytes(diagnostics.db.shmBytes)} />
      <Metric
        label="Checkpoint"
        value={`${diagnostics.db.walCheckpoint.checkpointed}/${diagnostics.db.walCheckpoint.log}`}
      />
    </DiagnosticsCard>

    <DiagnosticsCard
      title="Queue"
      status={diagnostics.queue.status}
      value={`${diagnostics.queue.total}`}
      warning={diagnostics.queue.warning}
    >
      <Metric label="Claude" value={`${diagnostics.queue.claude}`} />
      <Metric label="Codex" value={`${diagnostics.queue.codex}`} />
      <Metric label="Warn at" value={`${diagnostics.thresholds.queueDepthWarn + 1}+`} />
    </DiagnosticsCard>

    <DiagnosticsCard
      title="Providers"
      status={diagnostics.providers.status}
      value={
        diagnostics.providers.items.claude.available ||
        diagnostics.providers.items.codex.available
          ? "available"
          : "offline"
      }
      warning={diagnostics.providers.warning}
    >
      <ProviderMetric
        provider="claude"
        probe={diagnostics.providers.items.claude}
      />
      <ProviderMetric provider="codex" probe={diagnostics.providers.items.codex} />
    </DiagnosticsCard>

    <DiagnosticsCard
      title="Runner"
      status={diagnostics.runner.status}
      value={`${diagnostics.runner.inflightCount}`}
    >
      <Metric label="Inflight" value={`${diagnostics.runner.inflightCount}`} />
    </DiagnosticsCard>
  </section>
);

const DiagnosticsCard = ({
  title,
  status,
  value,
  warning,
  children,
}: {
  title: string;
  status: SystemDiagnostics["db"]["status"];
  value: string;
  warning?: string;
  children: ReactNode;
}): JSX.Element => (
  <article className="system-diagnostics__card">
    <div className="system-diagnostics__card-head">
      <div>
        <h4>{title}</h4>
        <strong>{value}</strong>
      </div>
      <span className={`status-pill status-pill--${diagnosticsTone(status)}`}>
        {status}
      </span>
    </div>
    <dl className="system-diagnostics__metrics">{children}</dl>
    {warning ? <p className="system-diagnostics__warning">{warning}</p> : null}
  </article>
);

const Metric = ({
  label,
  value,
}: {
  label: string;
  value: string;
}): JSX.Element => (
  <div>
    <dt>{label}</dt>
    <dd>{value}</dd>
  </div>
);

const ProviderMetric = ({
  provider,
  probe,
}: {
  provider: AgentProvider;
  probe: AgentProviderProbe;
}): JSX.Element => (
  <div>
    <dt>{provider}</dt>
    <dd>
      {providerAvailabilityLabel(probe.available, probe.version)}
      {!probe.available && probe.error ? (
        <span className="system-diagnostics__provider-error">{probe.error}</span>
      ) : null}
    </dd>
  </div>
);

const formatTime = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};
