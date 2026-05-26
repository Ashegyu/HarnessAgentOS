import type {
  AgentProposedAction,
  WorkerHandoffChangedFile,
  WorkerHandoffEvidence,
  WorkerHandoffFinding,
  WorkerHandoffPayload,
  WorkerHandoffProducer,
  WorkerHandoffRecovery,
  WorkerHandoffVerification,
  WorkerOutputContract,
} from "@harness/core";

export const WORKER_HANDOFF_FENCE = "harness_worker_handoff_v1";

export type ParseWorkerHandoffPayloadResult =
  | { ok: true; payload: WorkerHandoffPayload }
  | { ok: false; reason: string; missing: boolean };

export type BuildWorkerHandoffPayloadStatus =
  | "structured"
  | "synthesized"
  | "warning";

export interface BuildWorkerHandoffPayloadInput {
  rawOutput: string;
  producer: WorkerHandoffProducer;
  outputContract?: WorkerOutputContract;
  proposedActions?: readonly AgentProposedAction[];
}

export interface BuildWorkerHandoffPayloadResult {
  status: BuildWorkerHandoffPayloadStatus;
  payload: WorkerHandoffPayload;
  parseError?: string;
}

const OUTPUT_CONTRACTS = new Set<WorkerOutputContract>([
  "plan",
  "diff_proposal",
  "review",
  "test_result",
]);

const HANDOFF_STATUSES = new Set(["success", "warning", "error"]);
const EVIDENCE_KINDS = new Set([
  "file",
  "test",
  "command",
  "artifact",
  "code_path",
]);
const FINDING_SEVERITIES = new Set(["info", "warning", "error"]);
const FINDING_BASES = new Set(["evidence", "inference", "uncertainty"]);
const CHANGE_RISKS = new Set(["low", "medium", "high"]);

const FENCED_BLOCK_RE = /```([a-zA-Z_][a-zA-Z0-9_-]*)?\s*([\s\S]*?)```/g;

export const formatWorkerHandoffPayload = (
  payload: WorkerHandoffPayload,
): string =>
  [
    `\`\`\`${WORKER_HANDOFF_FENCE}`,
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");

export const parseWorkerHandoffPayload = (
  rawOutput: string,
): ParseWorkerHandoffPayloadResult => {
  const json = extractFencedJson(rawOutput, WORKER_HANDOFF_FENCE);
  if (json === null) {
    return {
      ok: false,
      missing: true,
      reason: `No fenced JSON block tagged \`${WORKER_HANDOFF_FENCE}\` found.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return {
      ok: false,
      missing: false,
      reason: `Worker handoff JSON parse error: ${errorMessage(e)}`,
    };
  }
  return validateWorkerHandoffPayload(parsed);
};

export const buildWorkerHandoffPayload = (
  input: BuildWorkerHandoffPayloadInput,
): BuildWorkerHandoffPayloadResult => {
  const parsed = parseWorkerHandoffPayload(input.rawOutput);
  const proposedActions = [...(input.proposedActions ?? [])];
  if (parsed.ok) {
    return {
      status: "structured",
      payload: {
        ...parsed.payload,
        outputContract: input.outputContract ?? parsed.payload.outputContract,
        producer: input.producer,
        proposedActions,
      },
    };
  }

  const outputContract = input.outputContract ?? "plan";
  if (parsed.missing) {
    return {
      status: "synthesized",
      payload: synthesizedPayload({
        rawOutput: input.rawOutput,
        producer: input.producer,
        outputContract,
        proposedActions,
      }),
    };
  }

  return {
    status: "warning",
    parseError: parsed.reason,
    payload: warningPayload({
      rawOutput: input.rawOutput,
      producer: input.producer,
      outputContract,
      proposedActions,
      reason: parsed.reason,
    }),
  };
};

const extractFencedJson = (raw: string, tag: string): string | null => {
  FENCED_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCED_BLOCK_RE.exec(raw)) !== null) {
    const lang = (match[1] ?? "").trim();
    if (lang === tag) return (match[2] ?? "").trim();
  }
  return null;
};

const validateWorkerHandoffPayload = (
  value: unknown,
): ParseWorkerHandoffPayloadResult => {
  if (!isObject(value)) {
    return invalid("Worker handoff payload must be a JSON object.");
  }
  if (value.schemaVersion !== 1) {
    return invalid("schemaVersion must be 1.");
  }
  if (typeof value.status !== "string" || !HANDOFF_STATUSES.has(value.status)) {
    return invalid("status must be success | warning | error.");
  }
  if (
    typeof value.outputContract !== "string" ||
    !OUTPUT_CONTRACTS.has(value.outputContract as WorkerOutputContract)
  ) {
    return invalid("outputContract is invalid.");
  }
  const producer = parseProducer(value.producer);
  if (!producer.ok) return invalid(producer.reason);
  const summary = value.summary;
  if (typeof summary !== "string" || summary.trim().length === 0) {
    return invalid("summary must be a non-empty string.");
  }
  const evidence = parseEvidenceArray(value.evidence);
  if (!evidence.ok) return invalid(evidence.reason);
  const findings = parseFindingArray(value.findings);
  if (!findings.ok) return invalid(findings.reason);
  const proposedActions = parseProposedActions(value.proposedActions);
  if (!proposedActions.ok) return invalid(proposedActions.reason);
  const changedFiles = parseChangedFiles(value.changedFiles);
  if (!changedFiles.ok) return invalid(changedFiles.reason);
  const verification = parseVerification(value.verification);
  if (!verification.ok) return invalid(verification.reason);
  const risks = parseStringArray(value.risks, "risks");
  if (!risks.ok) return invalid(risks.reason);
  const nextActions = parseStringArray(value.nextActions, "nextActions");
  if (!nextActions.ok) return invalid(nextActions.reason);
  const recovery = parseRecovery(value.recovery);
  if (!recovery.ok) return invalid(recovery.reason);

  const payload: WorkerHandoffPayload = {
    schemaVersion: 1,
    status: value.status as WorkerHandoffPayload["status"],
    outputContract: value.outputContract as WorkerOutputContract,
    producer: producer.value,
    summary,
    evidence: evidence.value,
    findings: findings.value,
    proposedActions: proposedActions.value,
    changedFiles: changedFiles.value,
    verification: verification.value,
    risks: risks.value,
    nextActions: nextActions.value,
    ...(recovery.value !== undefined ? { recovery: recovery.value } : {}),
  };
  return { ok: true, payload };
};

const synthesizedPayload = (input: {
  rawOutput: string;
  producer: WorkerHandoffProducer;
  outputContract: WorkerOutputContract;
  proposedActions: AgentProposedAction[];
}): WorkerHandoffPayload => ({
  schemaVersion: 1,
  status: "success",
  outputContract: input.outputContract,
  producer: input.producer,
  summary: summarizeRawOutput(input.rawOutput, input.producer.title),
  evidence: [
    {
      kind: "artifact",
      ref: input.producer.artifactId,
      note: "Full worker output artifact.",
    },
  ],
  findings: [],
  proposedActions: input.proposedActions,
  changedFiles: [],
  verification: { run: [], passed: [], failed: [], notRun: [] },
  risks: [],
  nextActions: [],
});

const warningPayload = (input: {
  rawOutput: string;
  producer: WorkerHandoffProducer;
  outputContract: WorkerOutputContract;
  proposedActions: AgentProposedAction[];
  reason: string;
}): WorkerHandoffPayload => ({
  schemaVersion: 1,
  status: "warning",
  outputContract: input.outputContract,
  producer: input.producer,
  summary: "Worker output did not include a valid structured handoff payload.",
  evidence: [
    {
      kind: "artifact",
      ref: input.producer.artifactId,
      note: "Full worker output artifact.",
    },
  ],
  findings: [
    {
      severity: "warning",
      claim: input.reason,
      basis: "uncertainty",
      refs: [input.producer.artifactId],
    },
  ],
  proposedActions: input.proposedActions,
  changedFiles: [],
  verification: { run: [], passed: [], failed: [], notRun: [] },
  risks: ["Downstream workers received synthesized context from raw output."],
  nextActions: [],
});

const summarizeRawOutput = (rawOutput: string, fallbackTitle: string): string => {
  const firstLine = rawOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return `${fallbackTitle} completed without textual output.`;
  return firstLine.length <= 240 ? firstLine : `${firstLine.slice(0, 240)}...`;
};

const invalid = (reason: string): ParseWorkerHandoffPayloadResult => ({
  ok: false,
  missing: false,
  reason,
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseProducer = (
  value: unknown,
): { ok: true; value: WorkerHandoffProducer } | { ok: false; reason: string } => {
  if (!isObject(value)) return { ok: false, reason: "producer must be an object." };
  const required = [
    "taskRunId",
    "planId",
    "stepId",
    "role",
    "title",
    "artifactId",
  ] as const;
  for (const key of required) {
    if (typeof value[key] !== "string" || value[key].trim().length === 0) {
      return { ok: false, reason: `producer.${key} must be a non-empty string.` };
    }
  }
  return {
    ok: true,
    value: {
      taskRunId: value.taskRunId as string,
      planId: value.planId as string,
      stepId: value.stepId as string,
      role: value.role as WorkerHandoffProducer["role"],
      title: value.title as string,
      artifactId: value.artifactId as string,
    },
  };
};

const parseEvidenceArray = (
  value: unknown,
): { ok: true; value: WorkerHandoffEvidence[] } | { ok: false; reason: string } => {
  if (!Array.isArray(value)) return { ok: false, reason: "evidence must be an array." };
  const out: WorkerHandoffEvidence[] = [];
  for (const [index, item] of value.entries()) {
    if (!isObject(item)) {
      return { ok: false, reason: `evidence[${index}] must be an object.` };
    }
    if (typeof item.kind !== "string" || !EVIDENCE_KINDS.has(item.kind)) {
      return { ok: false, reason: `evidence[${index}].kind is invalid.` };
    }
    if (typeof item.ref !== "string" || item.ref.trim().length === 0) {
      return { ok: false, reason: `evidence[${index}].ref must be non-empty.` };
    }
    if (typeof item.note !== "string") {
      return { ok: false, reason: `evidence[${index}].note must be a string.` };
    }
    out.push({
      kind: item.kind as WorkerHandoffEvidence["kind"],
      ref: item.ref,
      note: item.note,
    });
  }
  return { ok: true, value: out };
};

const parseFindingArray = (
  value: unknown,
): { ok: true; value: WorkerHandoffFinding[] } | { ok: false; reason: string } => {
  if (!Array.isArray(value)) return { ok: false, reason: "findings must be an array." };
  const out: WorkerHandoffFinding[] = [];
  for (const [index, item] of value.entries()) {
    if (!isObject(item)) {
      return { ok: false, reason: `findings[${index}] must be an object.` };
    }
    if (
      typeof item.severity !== "string" ||
      !FINDING_SEVERITIES.has(item.severity)
    ) {
      return { ok: false, reason: `findings[${index}].severity is invalid.` };
    }
    if (typeof item.claim !== "string" || item.claim.trim().length === 0) {
      return { ok: false, reason: `findings[${index}].claim must be non-empty.` };
    }
    if (typeof item.basis !== "string" || !FINDING_BASES.has(item.basis)) {
      return { ok: false, reason: `findings[${index}].basis is invalid.` };
    }
    const refs = parseStringArray(item.refs, `findings[${index}].refs`);
    if (!refs.ok) return refs;
    out.push({
      severity: item.severity as WorkerHandoffFinding["severity"],
      claim: item.claim,
      basis: item.basis as WorkerHandoffFinding["basis"],
      refs: refs.value,
    });
  }
  return { ok: true, value: out };
};

const parseChangedFiles = (
  value: unknown,
):
  | { ok: true; value: WorkerHandoffChangedFile[] }
  | { ok: false; reason: string } => {
  if (!Array.isArray(value)) {
    return { ok: false, reason: "changedFiles must be an array." };
  }
  const out: WorkerHandoffChangedFile[] = [];
  for (const [index, item] of value.entries()) {
    if (!isObject(item)) {
      return { ok: false, reason: `changedFiles[${index}] must be an object.` };
    }
    if (typeof item.path !== "string" || item.path.trim().length === 0) {
      return { ok: false, reason: `changedFiles[${index}].path must be non-empty.` };
    }
    if (typeof item.reason !== "string") {
      return { ok: false, reason: `changedFiles[${index}].reason must be a string.` };
    }
    if (typeof item.risk !== "string" || !CHANGE_RISKS.has(item.risk)) {
      return { ok: false, reason: `changedFiles[${index}].risk is invalid.` };
    }
    out.push({
      path: item.path,
      reason: item.reason,
      risk: item.risk as WorkerHandoffChangedFile["risk"],
    });
  }
  return { ok: true, value: out };
};

const parseVerification = (
  value: unknown,
):
  | { ok: true; value: WorkerHandoffVerification }
  | { ok: false; reason: string } => {
  if (!isObject(value)) {
    return { ok: false, reason: "verification must be an object." };
  }
  const run = parseStringArray(value.run, "verification.run");
  if (!run.ok) return run;
  const passed = parseStringArray(value.passed, "verification.passed");
  if (!passed.ok) return passed;
  const failed = parseStringArray(value.failed, "verification.failed");
  if (!failed.ok) return failed;
  const notRun = parseStringArray(value.notRun, "verification.notRun");
  if (!notRun.ok) return notRun;
  return {
    ok: true,
    value: {
      run: run.value,
      passed: passed.value,
      failed: failed.value,
      notRun: notRun.value,
    },
  };
};

const parseRecovery = (
  value: unknown,
): { ok: true; value?: WorkerHandoffRecovery } | { ok: false; reason: string } => {
  if (value === undefined) return { ok: true };
  if (!isObject(value)) return { ok: false, reason: "recovery must be an object." };
  if (typeof value.retryable !== "boolean") {
    return { ok: false, reason: "recovery.retryable must be boolean." };
  }
  for (const key of [
    "rootCauseHint",
    "safeRetryInstruction",
    "stopCondition",
  ] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      return { ok: false, reason: `recovery.${key} must be a string.` };
    }
  }
  return {
    ok: true,
    value: {
      retryable: value.retryable,
      ...(typeof value.rootCauseHint === "string"
        ? { rootCauseHint: value.rootCauseHint }
        : {}),
      ...(typeof value.safeRetryInstruction === "string"
        ? { safeRetryInstruction: value.safeRetryInstruction }
        : {}),
      ...(typeof value.stopCondition === "string"
        ? { stopCondition: value.stopCondition }
        : {}),
    },
  };
};

const parseProposedActions = (
  value: unknown,
): { ok: true; value: AgentProposedAction[] } | { ok: false; reason: string } => {
  if (!Array.isArray(value)) {
    return { ok: false, reason: "proposedActions must be an array." };
  }
  const out: AgentProposedAction[] = [];
  for (const [index, item] of value.entries()) {
    if (!isObject(item)) {
      return { ok: false, reason: `proposedActions[${index}] must be an object.` };
    }
    if (item.type === "file_write") {
      if (typeof item.path !== "string" || item.path.trim().length === 0) {
        return {
          ok: false,
          reason: `proposedActions[${index}].path must be non-empty.`,
        };
      }
      if (typeof item.after !== "string") {
        return {
          ok: false,
          reason: `proposedActions[${index}].after must be a string.`,
        };
      }
      if (typeof item.rationale !== "string") {
        return {
          ok: false,
          reason: `proposedActions[${index}].rationale must be a string.`,
        };
      }
      out.push({
        type: "file_write",
        path: item.path,
        after: item.after,
        rationale: item.rationale,
        ...(typeof item.before === "string" ? { before: item.before } : {}),
      });
      continue;
    }
    if (item.type === "shell") {
      if (typeof item.command !== "string" || item.command.trim().length === 0) {
        return {
          ok: false,
          reason: `proposedActions[${index}].command must be non-empty.`,
        };
      }
      if (typeof item.rationale !== "string") {
        return {
          ok: false,
          reason: `proposedActions[${index}].rationale must be a string.`,
        };
      }
      const args =
        item.args === undefined
          ? { ok: true as const, value: [] }
          : parseStringArray(item.args, `proposedActions[${index}].args`);
      if (!args.ok) return args;
      out.push({
        type: "shell",
        command: item.command,
        rationale: item.rationale,
        ...(item.args !== undefined ? { args: args.value } : {}),
      });
      continue;
    }
    return {
      ok: false,
      reason: `proposedActions[${index}].type must be file_write or shell.`,
    };
  }
  return { ok: true, value: out };
};

const parseStringArray = (
  value: unknown,
  field: string,
): { ok: true; value: string[] } | { ok: false; reason: string } => {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return { ok: false, reason: `${field} must be string[].` };
  }
  return { ok: true, value: value.slice() };
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
