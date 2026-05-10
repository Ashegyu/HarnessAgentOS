// ProposedFilePatch and ProposedActionDetails are owned by @harness/core
// (see core/types/approval.ts) so the storage and conversation layers
// can carry them across IPC without depending on @harness/runners.
export type { ProposedActionDetails, ProposedFilePatch } from "@harness/core";

import type { ProposedFilePatch } from "@harness/core";

export type RunnerKind = "file" | "shell" | "git" | "test";

export interface RunnerRequest {
  taskRunId: string;
  stepId: string;
  approvalId: string;
  kind: RunnerKind;
  targetDir: string;
  command?: string;
  args?: string[];
  filePatch?: ProposedFilePatch;
}

export interface RunnerResult {
  id: string;
  taskRunId: string;
  stepId: string;
  commandSummary: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  changedFiles?: string[];
  artifactIds: string[];
  startedAt: string;
  finishedAt: string;
}
