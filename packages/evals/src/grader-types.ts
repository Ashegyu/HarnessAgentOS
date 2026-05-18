export interface CodeGrader {
  readonly kind: "code";
  readonly assertion:
    | {
        readonly type: "file_contains";
        readonly path: string;
        readonly pattern: string;
      }
    | {
        readonly type: "fs_unchanged_outside";
        readonly root: string;
      }
    | {
        readonly type: "approval_status";
        readonly actionType: string;
        readonly expected: "approved" | "rejected" | "pending";
      }
    | {
        readonly type: "recorded_request_contains";
        readonly needle: string;
      }
    | {
        readonly type: "repair_attempts_eq";
        readonly expected: number;
      };
}

export interface RuleGrader {
  readonly kind: "rule";
  readonly rules: ReadonlyArray<{
    readonly description: string;
    readonly check: "regex" | "schema" | "count";
    readonly target: string;
    readonly pattern?: string;
    readonly schemaRef?: string;
    readonly count?: {
      readonly min?: number;
      readonly max?: number;
    };
  }>;
}

export interface LlmJudgeGrader {
  readonly kind: "llm_judge";
  readonly rubric: ReadonlyArray<{
    readonly id: string;
    readonly description: string;
    readonly weight: number;
  }>;
  readonly passThreshold?: number;
  readonly judgeProvider?: "claude" | "codex";
  readonly judgeAttempts?: number;
  readonly maxJudgeTokens?: number;
}

export type Grader = CodeGrader | RuleGrader | LlmJudgeGrader;
