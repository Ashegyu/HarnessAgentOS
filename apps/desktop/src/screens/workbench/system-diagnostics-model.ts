import type {
  AgentProviderProbe,
  DiagnosticsStatus,
  SystemDiagnostics,
} from "@harness/core";

export type DiagnosticsTone = "passed" | "warning" | "failed";

export const diagnosticsTone = (
  status: DiagnosticsStatus,
): DiagnosticsTone => {
  if (status === "error") return "failed";
  if (status === "warning") return "warning";
  return "passed";
};

export const formatDiagnosticBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 1 : 2)} MiB`;
};

export const diagnosticsHasWarnings = (
  diagnostics: SystemDiagnostics,
): boolean =>
  diagnostics.db.status !== "ok" ||
  diagnostics.queue.status !== "ok" ||
  diagnostics.providers.status !== "ok" ||
  diagnostics.runner.status !== "ok";

export const providerAvailabilityLabel = (
  available: boolean,
  version?: string,
): string => {
  if (!available) return "unavailable";
  return version && version.trim().length > 0 ? version : "available";
};

export const providerAvailabilityDetail = (
  probe: Pick<
    AgentProviderProbe,
    "available" | "version" | "error" | "command"
  >,
): string => {
  const lines = [providerAvailabilityLabel(probe.available, probe.version)];
  if (!probe.available && probe.error?.trim()) {
    lines.push(`error: ${probe.error.trim()}`);
  }
  if (probe.command?.trim()) {
    lines.push(`command: ${probe.command.trim()}`);
  }
  return lines.join("\n");
};
