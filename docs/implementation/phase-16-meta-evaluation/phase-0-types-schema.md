# Phase 0 — Types · Zod Schema · Metrics

> **선행 조건**: 없음 (시작 phase)
> **다음 단계**: Phase 1
> **복잡도**: Small · **추정**: 1-2일

## 0. 목표

EDD (정의 먼저) 원칙에 따라 평가 도메인 모델을 **코드 작성 전**에 확정한다. Zod schema로 fixture 입력을 강제하고, 메트릭 함수(pass@1/@3/^3)는 단위 테스트로 RED → GREEN 검증한다.

## 1. 출력물 (Artifacts)

```
packages/evals/
├── package.json                # 새 패키지
├── tsconfig.json
├── README.md                   # case 종류 3개 + 임계 정의
└── src/
    ├── index.ts                # barrel export
    ├── types.ts                # 도메인 모델
    ├── fixture-schema.ts       # Zod schemas
    ├── grader-types.ts         # Grader discriminated union
    ├── metrics.ts              # pass@k / pass^k / consistency
    └── metrics.test.mjs        # 단위 테스트
```

## 2. 새 패키지 등록

### `packages/evals/package.json`

```json
{
  "name": "@harness/evals",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "scripts": {
    "check": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@harness/core": "*",
    "@harness/storage": "*",
    "@harness/agent": "*",
    "@harness/quality": "*",
    "zod": "*"
  }
}
```

루트 `package.json`의 `workspaces`는 이미 `packages/*` 패턴이라 **추가 등록 불필요**.

### `packages/evals/tsconfig.json`

기존 `packages/quality/tsconfig.json`을 복사하고 `references`만 추가:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "references": [
    { "path": "../core" },
    { "path": "../storage" },
    { "path": "../agent" },
    { "path": "../quality" }
  ]
}
```

## 3. 도메인 모델 (`src/types.ts`)

```ts
import type { Approval, TaskRun, QualityGateStatus } from "@harness/core";

export type EvalCaseKind = "capability" | "regression" | "safety";

export interface EvalCase {
  readonly id: string;                    // file basename, e.g. "file-write-readme"
  readonly kind: EvalCaseKind;
  readonly title: string;                 // human-readable
  readonly instruction: string;           // userRequest 전달
  readonly scenario: string;              // FakeModelCliAdapter scenario name
  readonly attempts: number;              // default 3
  readonly provider?: "claude" | "codex"; // v1: ignored (D5)
  readonly profile?: {                    // optional profile override
    readonly blockedActions?: ReadonlyArray<string>;
    readonly autoApprove?: boolean;
  };
  readonly grader: Grader;                // see grader-types.ts
  readonly thresholds?: {
    readonly passAt3?: number;            // capability default 0.9
    readonly passToThe3?: number;         // regression default 1.0
    readonly safetyFailures?: 0;          // safety: must be 0
  };
  readonly budgetTokens?: number;
}

export interface EvalAttemptResult {
  readonly attemptIdx: number;            // 0-based
  readonly passed: boolean;
  readonly tokens: number;
  readonly durationMs: number;
  readonly gateStatus: QualityGateStatus | null;
  readonly approvalsCreated: number;
  readonly approvalsManual: number;       // user-grade autonomy 지표
  readonly fsEscapeDetected: boolean;     // sandbox escape (Phase 1)
  readonly graderReason?: string;         // 실패 시 이유
  readonly partialPassAsFail?: boolean;   // Phase 3 — 3중 어설션 미달
}

export interface EvalCaseResult {
  readonly case: EvalCase;
  readonly attempts: ReadonlyArray<EvalAttemptResult>;
  readonly passAt1: number;               // tied to attemptIdx === 0
  readonly passAt3: number;               // any pass in N attempts
  readonly passToThe3: number;            // all pass in N attempts
  readonly consistency: number;           // pass rate across N
  readonly totalTokens: number;
  readonly totalDurationMs: number;
  readonly outcome: "passed" | "failed" | "partial";
}

export interface EvalRunSummary {
  readonly runId: string;                 // evrun_xxxxx
  readonly suite: "capability" | "regression" | "safety" | "all";
  readonly startedAt: string;             // ISO
  readonly finishedAt: string | null;
  readonly cases: ReadonlyArray<EvalCaseResult>;
  readonly status: "running" | "passed" | "failed" | "partial";
  readonly harnessRevisionSha?: string;   // optional, git HEAD
}
```

## 4. Grader 타입 (`src/grader-types.ts`)

Discriminated union으로 향후 LLM judge 확장 여지를 둔다 (D6):

```ts
export interface CodeGrader {
  readonly kind: "code";
  readonly assertion:
    | { type: "file_contains"; path: string; pattern: string }
    | { type: "fs_unchanged_outside"; root: string }
    | { type: "approval_status"; actionType: string; expected: "approved" | "rejected" | "pending" }
    | { type: "recorded_request_contains"; needle: string }
    | { type: "repair_attempts_eq"; expected: number };
}

export interface RuleGrader {
  readonly kind: "rule";
  readonly rules: ReadonlyArray<{
    readonly description: string;
    readonly check: "regex" | "schema" | "count";
    readonly target: string;
    readonly pattern?: string;
    readonly schemaRef?: string;
    readonly count?: { min?: number; max?: number };
  }>;
}

// v2 추가 예정
// export interface LlmGrader { readonly kind: "llm"; readonly prompt: string; }

export type Grader = CodeGrader | RuleGrader;
```

## 5. Zod schema (`src/fixture-schema.ts`)

```ts
import { z } from "zod";

export const codeAssertionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("file_contains"), path: z.string(), pattern: z.string() }),
  z.object({ type: z.literal("fs_unchanged_outside"), root: z.string() }),
  z.object({
    type: z.literal("approval_status"),
    actionType: z.string(),
    expected: z.enum(["approved", "rejected", "pending"]),
  }),
  z.object({ type: z.literal("recorded_request_contains"), needle: z.string() }),
  z.object({ type: z.literal("repair_attempts_eq"), expected: z.number().int().nonnegative() }),
]);

export const codeGraderSchema = z.object({
  kind: z.literal("code"),
  assertion: codeAssertionSchema,
});

export const ruleGraderSchema = z.object({
  kind: z.literal("rule"),
  rules: z.array(z.object({/* ... */})),
});

export const graderSchema = z.discriminatedUnion("kind", [codeGraderSchema, ruleGraderSchema]);

export const evalCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  kind: z.enum(["capability", "regression", "safety"]),
  title: z.string().min(1),
  instruction: z.string().min(1),
  scenario: z.string(),
  attempts: z.number().int().min(1).max(10).default(3),
  provider: z.enum(["claude", "codex"]).optional(),
  profile: z
    .object({
      blockedActions: z.array(z.string()).optional(),
      autoApprove: z.boolean().optional(),
    })
    .optional(),
  grader: graderSchema,
  thresholds: z
    .object({
      passAt3: z.number().min(0).max(1).optional(),
      passToThe3: z.number().min(0).max(1).optional(),
      safetyFailures: z.literal(0).optional(),
    })
    .optional(),
  budgetTokens: z.number().int().positive().optional(),
});

export type EvalCaseInput = z.infer<typeof evalCaseSchema>;
```

## 6. 메트릭 함수 (`src/metrics.ts`)

순수 함수. 모든 입력은 `ReadonlyArray<EvalAttemptResult>`.

```ts
export const computePassAt1 = (attempts: ReadonlyArray<EvalAttemptResult>): number => {
  if (attempts.length === 0) return 0;
  const first = attempts.find((a) => a.attemptIdx === 0);
  return first?.passed ? 1 : 0;
};

export const computePassAtK = (
  attempts: ReadonlyArray<EvalAttemptResult>,
  k: number,
): number => {
  const slice = attempts.filter((a) => a.attemptIdx < k);
  if (slice.length === 0) return 0;
  return slice.some((a) => a.passed) ? 1 : 0;
};

export const computePassToTheK = (
  attempts: ReadonlyArray<EvalAttemptResult>,
  k: number,
): number => {
  const slice = attempts.filter((a) => a.attemptIdx < k);
  if (slice.length < k) return 0;
  return slice.every((a) => a.passed) ? 1 : 0;
};

export const computeConsistency = (
  attempts: ReadonlyArray<EvalAttemptResult>,
): number => {
  if (attempts.length === 0) return 0;
  const passed = attempts.filter((a) => a.passed).length;
  return passed / attempts.length;
};
```

## 7. 단위 테스트 (`src/metrics.test.mjs`)

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computePassAt1,
  computePassAtK,
  computePassToTheK,
  computeConsistency,
} from "./metrics.ts";

const mkAttempt = (idx, passed) => ({
  attemptIdx: idx, passed, tokens: 0, durationMs: 0,
  gateStatus: null, approvalsCreated: 0, approvalsManual: 0, fsEscapeDetected: false,
});

test("computePassAt1 returns 1 when first attempt passes", () => {
  assert.equal(computePassAt1([mkAttempt(0, true), mkAttempt(1, false)]), 1);
});

test("computePassAt1 returns 0 when first attempt fails (regardless of later)", () => {
  assert.equal(computePassAt1([mkAttempt(0, false), mkAttempt(1, true), mkAttempt(2, true)]), 0);
});

test("computePassAtK=3 returns 1 when ANY of first 3 passes", () => {
  assert.equal(computePassAtK([mkAttempt(0, false), mkAttempt(1, false), mkAttempt(2, true)], 3), 1);
});

test("computePassAtK=3 returns 0 when none of first 3 pass", () => {
  assert.equal(computePassAtK([mkAttempt(0, false), mkAttempt(1, false), mkAttempt(2, false)], 3), 0);
});

test("computePassToTheK=3 returns 1 only when ALL first 3 pass", () => {
  assert.equal(computePassToTheK([mkAttempt(0, true), mkAttempt(1, true), mkAttempt(2, true)], 3), 1);
});

test("computePassToTheK=3 returns 0 when any of first 3 fails", () => {
  assert.equal(computePassToTheK([mkAttempt(0, true), mkAttempt(1, false), mkAttempt(2, true)], 3), 0);
});

test("computeConsistency returns 0.67 when 2 of 3 pass", () => {
  const c = computeConsistency([mkAttempt(0, true), mkAttempt(1, false), mkAttempt(2, true)]);
  assert.ok(Math.abs(c - 2 / 3) < 0.001);
});
```

## 8. README (`packages/evals/README.md`)

3개 케이스 종류 + 3개 임계 + grader 종류를 한 페이지로:

```markdown
# @harness/evals

HarnessAgentOS 자체의 회귀·품질·안전성을 측정하는 메타 평가 시스템.

## 케이스 종류
- capability — 새 기능. 임계: pass@3 >= 0.9
- regression — 기존 안 깨짐. 임계: pass^3 = 1.0
- safety — 게이트 안 뚫림. 임계: 3회 모두 통과 (1회라도 실패 시 FAIL)

## Grader
- code — 결정적 어설션 (file_contains, fs_unchanged_outside, approval_status, ...)
- rule — regex/schema/count
- llm — v2 deferred

## 사용
- npm run eval -- --suite=all (CLI는 Phase 5에서 도입)
```

## 9. DoD (체크리스트)

- [ ] `packages/evals/package.json` 생성, root workspace에 자동 포함됨
- [ ] `tsconfig.json` references가 core/storage/agent/quality에 의존
- [ ] `types.ts`의 모든 export가 readonly 또는 immutable
- [ ] `evalCaseSchema.parse({ id: "x", ... })`로 invalid fixture 즉시 거부
- [ ] `metrics.test.mjs` 7개 케이스 통과
- [ ] `npm run check --workspace=@harness/evals` 통과
- [ ] `packages/core`에 import 추가 없음 (core MUST NOT import storage 규칙 보호)
- [ ] README가 grader 종류와 임계 정의를 명시

## 10. 이 phase에서 *하지 않을* 일

- ❌ CaseRunner 구현 (Phase 1)
- ❌ FakeAdapter 수정 (Phase 1)
- ❌ DB 변경 (Phase 4)
- ❌ Fixture 파일 작성 (Phase 1부터)
- ❌ CLI entry (Phase 5)

## 11. 잠재 위험

| 등급 | 위험 | 완화 |
|-----|------|------|
| LOW | Zod 버전 conflict | 루트 package-lock 확인, agent/storage가 이미 사용하는 버전 고정 |
| LOW | tsconfig references 순서 | 기존 quality/runners 패턴 그대로 복사 |
