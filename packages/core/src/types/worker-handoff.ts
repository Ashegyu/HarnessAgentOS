import type { AgentProposedAction } from "./agent-plan-output.ts";
import type { WorkerOutputContract, WorkerRole } from "./orchestration.ts";

export type WorkerHandoffStatus = "success" | "warning" | "error";

export type WorkerHandoffEvidenceKind =
  | "file"
  | "test"
  | "command"
  | "artifact"
  | "code_path";

export type WorkerHandoffFindingSeverity = "info" | "warning" | "error";

export type WorkerHandoffFindingBasis =
  | "evidence"
  | "inference"
  | "uncertainty";

export interface WorkerHandoffProducer {
  taskRunId: string;
  planId: string;
  stepId: string;
  role: WorkerRole;
  title: string;
  artifactId: string;
}

export interface WorkerHandoffEvidence {
  kind: WorkerHandoffEvidenceKind;
  ref: string;
  note: string;
}

export interface WorkerHandoffFinding {
  severity: WorkerHandoffFindingSeverity;
  claim: string;
  basis: WorkerHandoffFindingBasis;
  refs: string[];
}

export interface WorkerHandoffChangedFile {
  path: string;
  reason: string;
  risk: "low" | "medium" | "high";
}

export interface WorkerHandoffVerification {
  run: string[];
  passed: string[];
  failed: string[];
  notRun: string[];
}

export interface WorkerHandoffRecovery {
  retryable: boolean;
  rootCauseHint?: string;
  safeRetryInstruction?: string;
  stopCondition?: string;
}

export interface WorkerHandoffPayload {
  schemaVersion: 1;
  status: WorkerHandoffStatus;
  outputContract: WorkerOutputContract;
  producer: WorkerHandoffProducer;
  summary: string;
  evidence: WorkerHandoffEvidence[];
  findings: WorkerHandoffFinding[];
  proposedActions: AgentProposedAction[];
  changedFiles: WorkerHandoffChangedFile[];
  verification: WorkerHandoffVerification;
  risks: string[];
  nextActions: string[];
  recovery?: WorkerHandoffRecovery;
}
