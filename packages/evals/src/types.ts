import type { QualityGateStatus } from "@harness/core";

import type { Grader } from "./grader-types.ts";

export type EvalCaseKind = "capability" | "regression" | "safety";

export interface EvalCase {
  readonly id: string;
  readonly kind: EvalCaseKind;
  readonly title: string;
  readonly instruction: string;
  readonly scenario: string;
  readonly attempts: number;
  readonly provider?: "claude" | "codex";
  readonly profile?: {
    readonly blockedActions?: ReadonlyArray<string>;
    readonly autoApprove?: boolean;
  };
  readonly grader: Grader;
  readonly thresholds?: {
    readonly passAt3?: number;
    readonly passToThe3?: number;
    readonly safetyFailures?: 0;
  };
  readonly budgetTokens?: number;
}

export interface EvalAttemptResult {
  readonly attemptIdx: number;
  readonly passed: boolean;
  readonly tokens: number;
  readonly durationMs: number;
  readonly gateStatus: QualityGateStatus | null;
  readonly approvalsCreated: number;
  readonly approvalsManual: number;
  readonly fsEscapeDetected: boolean;
  readonly graderReason?: string;
  readonly partialPassAsFail?: boolean;
}

export interface EvalCaseResult {
  readonly case: EvalCase;
  readonly attempts: ReadonlyArray<EvalAttemptResult>;
  readonly passAt1: number;
  readonly passAt3: number;
  readonly passToThe3: number;
  readonly consistency: number;
  readonly totalTokens: number;
  readonly totalDurationMs: number;
  readonly outcome: "passed" | "failed" | "partial";
}

export interface EvalRunSummary {
  readonly runId: string;
  readonly suite: EvalCaseKind | "all";
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly cases: ReadonlyArray<EvalCaseResult>;
  readonly status: "running" | "passed" | "failed" | "partial";
  readonly harnessRevisionSha?: string;
}
