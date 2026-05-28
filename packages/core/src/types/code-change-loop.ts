export type CodeChangeAttemptStatus =
  | "verified"
  | "applied_unverified"
  | "verification_failed"
  | "apply_failed"
  | "no_changes";

export type CodeChangeNextAction =
  | "ready_for_review"
  | "repair_required"
  | "blocked";

export interface CodeChangeVerificationResult {
  approvalId: string;
  commandSummary: string;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  artifactIds: string[];
}

export interface CodeChangeAttemptResult {
  attemptNumber: number;
  taskRunId: string;
  status: CodeChangeAttemptStatus;
  nextAction: CodeChangeNextAction;
  appliedApprovalIds: string[];
  verificationApprovalIds: string[];
  changedFiles: string[];
  artifactIds: string[];
  verificationResults: CodeChangeVerificationResult[];
  failureMessage?: string;
}

export interface CodeChangeLoopRunInput {
  taskRunId: string;
  changeApprovalIds: readonly string[];
  verificationApprovalIds?: readonly string[];
  attemptNumber?: number;
}
