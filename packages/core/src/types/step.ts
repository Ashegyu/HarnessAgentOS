export type StepKind =
  | "inspect"
  | "plan"
  | "approval"
  | "edit"
  | "shell"
  | "test"
  | "quality_gate"
  | "summarize";

export type StepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export const STEP_STATUSES: readonly StepStatus[] = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
];

export interface Step {
  id: string;
  taskRunId: string;
  index: number;
  kind: StepKind;
  title: string;
  status: StepStatus;
  inputSummary?: string;
  outputSummary?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface CreateStepInput {
  taskRunId: string;
  index: number;
  kind: StepKind;
  title: string;
  status?: StepStatus;
  inputSummary?: string;
}
