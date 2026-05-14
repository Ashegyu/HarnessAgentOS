export type DiagnosticSeverity = "info" | "warn" | "error";

export interface DiagnosticLogInput {
  at?: string;
  severity: DiagnosticSeverity;
  subsystem: string;
  phase: string;
  taskRunId?: string;
  stepId?: string;
  invocationId?: string;
  approvalId?: string;
  errorCode?: string;
  message: string;
  detail?: string;
}

export const formatDiagnosticLog = (input: DiagnosticLogInput): string => {
  const lines = [
    "# Diagnostic log",
    "",
    `- at: ${input.at ?? new Date().toISOString()}`,
    `- severity: ${input.severity}`,
    `- subsystem: ${sanitize(input.subsystem)}`,
    `- phase: ${sanitize(input.phase)}`,
  ];
  if (input.taskRunId) lines.push(`- taskRunId: ${sanitize(input.taskRunId)}`);
  if (input.stepId) lines.push(`- stepId: ${sanitize(input.stepId)}`);
  if (input.invocationId) {
    lines.push(`- invocationId: ${sanitize(input.invocationId)}`);
  }
  if (input.approvalId) lines.push(`- approvalId: ${sanitize(input.approvalId)}`);
  if (input.errorCode) lines.push(`- errorCode: ${sanitize(input.errorCode)}`);
  lines.push("", "## message", "", sanitize(input.message));
  if (input.detail && input.detail.trim().length > 0) {
    lines.push("", "## detail", "", sanitize(input.detail));
  }
  return lines.join("\n");
};

export const diagnosticErrorCode = (
  error: unknown,
  fallback: string,
): string => {
  if (hasStringProp(error, "code")) return error.code;
  return fallback;
};

export const diagnosticErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (hasStringProp(error, "message")) return error.message;
  return String(error);
};

const hasStringProp = <K extends string>(
  value: unknown,
  key: K,
): value is Record<K, string> =>
  typeof value === "object" &&
  value !== null &&
  key in value &&
  typeof (value as Record<K, unknown>)[key] === "string";

const sanitize = (value: string): string => value.replace(/\0/g, "\\0");
