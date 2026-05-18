# Phase 7 — v2 Expansion Design Plan

> **상태**: 설계 완료 · Phase 7.1/7.2 구현 완료 · Phase 7.3+ 대기
> **선행 조건**: v1 fake eval 안정화, v1.5a real CLI smoke, v1.5b performance summary
> **목표**: provider 비교, LLM judge, viewer, cost trend, production latency 측정을 별도 gate로 안전하게 확장한다.

## 0. 범위 원칙

이 문서는 v2 구현 계획이다. v1/v1.5 경로는 계속 유지한다.

- `npm run eval`: fake adapter 기반 deterministic gate 유지
- `npm run eval:smoke`: 단일 real CLI smoke 유지
- `npm run eval:perf`: fake 반복 성능 요약 유지
- provider 비교, LLM judge, viewer UI, cost trend, production latency는 각각 독립 gate로 구현
- renderer viewer는 9-layer IPC 규칙을 반드시 따른다
- 비용이 발생하는 real provider / LLM judge는 명시 env gate와 budget cap 없이는 CI 기본 경로에 넣지 않는다

## 구현 체크포인트

| 단계 | 상태 | 완료 범위 |
|------|------|-----------|
| Phase 7.1 | 완료 | v2 provider/run/trend/latency 계약, fixture `providers`, CLI `--providers` parser |
| Phase 7.2 | 완료 | provider별 case 확장, provider별 target/artifact 분리, provider comparison report, `eval:providers` script |
| Phase 7.3 | 대기 | LLM judge calibration |
| Phase 7.4 | 대기 | viewer read-only UI |
| Phase 7.5 | 대기 | 장기간 cost trend |
| Phase 7.6 | 대기 | production workload p95/p99 latency |

## 1. 설계 목표

| 영역 | 검증 질문 | 성공 기준 |
|------|-----------|-----------|
| Provider head-to-head | 동일 case에서 Claude와 Codex가 어떤 성공률/비용/시간 차이를 보이는가 | provider별 Pass@, tokens, duration, approvals가 같은 report에 비교됨 |
| LLM judge | rule/code grader로 잡기 어려운 응답 품질을 평가할 수 있는가 | judge 결과가 calibration case에서 known good/bad를 구분 |
| Viewer UI | operator가 eval 결과와 실패 attempt를 UI에서 탐색할 수 있는가 | 최근 run, 상세, 비교, attempt drill-down이 renderer에서 동작 |
| Cost trend | run별 비용이 시간에 따라 증가하는지 볼 수 있는가 | 최근 N개 run의 token/cost/pass rate trend와 threshold warning 표시 |
| Production latency | 실제 workload에서 p95/p99 latency가 안정적인가 | task/run/invocation 이벤트 기반 p50/p95/p99 산출 및 regression warning |

## 2. 공통 데이터 계약

### 2.1 Eval provider 식별

현재 `EvalCase.provider?: "claude" | "codex"`는 단일 provider 힌트로 유지한다. v2에서는 복수 provider 비교를 위해 새 필드를 추가한다.

```ts
export type EvalProvider = "claude" | "codex";

export interface EvalCase {
  readonly provider?: EvalProvider;        // 기존 호환
  readonly providers?: ReadonlyArray<EvalProvider>; // v2 head-to-head
}
```

`provider`와 `providers`가 모두 있으면 `providers`를 우선한다. `providers`가 없으면 기존처럼 단일 provider 또는 default provider로 실행한다.

### 2.2 Provider-aware result

기존 `EvalCaseResult`를 깨지 않기 위해 provider 정보를 optional로 추가한다.

```ts
export interface EvalCaseResult {
  readonly provider?: EvalProvider;
  readonly providerGroupId?: string; // same logical case across providers
}
```

`providerGroupId`는 기본적으로 원래 fixture id다. head-to-head 실행 시 report는 `providerGroupId` 기준으로 묶고, persistence는 기존 `summary_json`에 같은 구조를 저장한다.

### 2.3 Run metadata 확장

`EvalRunSummary`에는 실제 실행 모드와 budget 상태를 추가한다.

```ts
export interface EvalRunSummary {
  readonly mode?: "fake" | "real" | "head_to_head" | "judge" | "production_latency";
  readonly budget?: {
    readonly maxTokens?: number;
    readonly maxUsd?: number;
    readonly exceeded: boolean;
  };
}
```

DB schema는 가능하면 `summary_json` 확장으로 시작한다. viewer에서 필터가 필요해지는 시점에만 `eval_runs`에 `mode`, `total_tokens`, `total_cost_usd` generated/cache column을 추가한다.

## 3. Provider Head-to-Head 비교

### 3.1 CLI

새 CLI 옵션을 추가한다.

```bash
npm run eval:providers -- --suite=capability --case=file-write-readme --providers=claude,codex --attempts=3
```

권장 script:

```json
{
  "eval:providers": "node --import tsx scripts/eval/run.mjs --suite=capability --attempts=3 --providers=claude,codex --real-cli"
}
```

이 script는 CI 기본 경로에 넣지 않는다. `EVAL_REAL_CLI=1` 또는 `--real-cli`가 없으면 실행을 거부한다.

### 3.2 Orchestrator 변경

`EvalOrchestrator.loadCases()`는 fixture를 논리 case로 읽고, run 단계에서 provider별 execution item으로 확장한다.

```ts
for (const testCase of cases) {
  for (const provider of providersFor(testCase)) {
    const result = await caseRunner.run({
      ...testCase,
      provider,
    });
    caseResults.push({
      ...result,
      provider,
      providerGroupId: testCase.id,
    });
  }
}
```

중요 제약:

- 같은 provider/case/attempt는 독립 DB와 독립 targetDir 사용
- provider 비교에서 provider 간 artifact path 충돌 금지
- threshold는 기본적으로 provider별로 계산한다
- overall status는 모든 provider threshold가 통과해야 `passed`

### 3.3 Report

기존 Summary by Suite 아래에 provider comparison section을 추가한다.

```md
## Provider Comparison

| Case | Provider | Attempts | Pass@3 | Pass^3 | Avg Time | P95 Time | Avg Tokens | Tokens/Passed |
|------|----------|----------|--------|--------|----------|----------|------------|---------------|
```

case detail은 기존 형식을 유지하되 제목에 provider를 붙인다.

```md
### `file-write-readme` - capability - claude
### `file-write-readme` - capability - codex
```

### 3.4 Tests

- `cli-options.test.mjs`: `--providers=claude,codex` parsing
- `orchestrator.test.mjs`: same fixture가 provider별로 2개 result를 생성
- `reporter.test.mjs`: provider comparison table 렌더링
- fake provider adapter 테스트: provider 값이 adapterFactory에 전달되는지 확인

### 3.5 DoD

- `npm run eval` 동작 불변
- `npm run eval:smoke` 동작 불변
- provider 비교 report가 provider별 Pass@/duration/token 차이를 보여줌
- provider별 artifact가 서로 덮어쓰지 않음

## 4. LLM Judge 기반 품질 평가

### 4.1 목적

LLM judge는 code/rule grader로 판정하기 어려운 품질을 평가한다. 예:

- 응답이 operator 요구를 충실히 반영했는가
- 구현 설명이 실제 diff와 일치하는가
- 안전상 중요한 caveat를 빠뜨리지 않았는가
- 설계 문서가 v2 deferred 범위를 침범하지 않았는가

### 4.2 Grader type

기존 `Grader` union에 `llm_judge`를 추가한다.

```ts
export interface LlmJudgeGrader {
  readonly kind: "llm_judge";
  readonly rubric: ReadonlyArray<{
    readonly id: string;
    readonly description: string;
    readonly weight: number;
  }>;
  readonly passThreshold: number; // default 0.8
  readonly judgeProvider?: EvalProvider;
  readonly judgeAttempts?: number; // default 3
  readonly maxJudgeTokens?: number;
}
```

### 4.3 Judge output schema

LLM judge는 반드시 JSON만 출력한다.

```json
{
  "score": 0.86,
  "passed": true,
  "rubric": [
    { "id": "correctness", "score": 0.9, "reason": "..." }
  ],
  "risks": ["..."]
}
```

Parser는 malformed JSON, missing score, score range 위반을 실패로 처리한다.

### 4.4 Calibration

LLM judge를 본 eval에 넣기 전에 calibration suite를 만든다.

```
packages/evals/fixtures/judge-calibration/
├── known-good.eval.json
└── known-bad.eval.json
```

DoD:

- known good 평균 score >= 0.8
- known bad 평균 score <= 0.5
- judgeAttempts=3에서 score 표준편차가 0.15 이하
- calibration 실패 시 LLM judge suite 전체 skip 또는 fail-fast

### 4.5 Cost safety

LLM judge는 비용이 커지기 쉽다. 다음 gate를 둔다.

- `EVAL_LLM_JUDGE=1` 없으면 실행 거부
- `EVAL_JUDGE_TOKEN_BUDGET` 기본값 50,000
- budget 초과 시 남은 judge case는 skipped로 기록
- skipped는 report에 명시하고 CI default에는 포함하지 않음

### 4.6 Tests

- `llm-judge-grader.test.mjs`: valid JSON score parsing
- malformed judge output 실패 처리
- calibration known good/bad 판정
- budget 초과 시 skip behavior
- report에 judge score/rubric reason 표시

## 5. Viewer UI 동작

### 5.1 UI 목표

Renderer에서 markdown 파일을 직접 열지 않고 eval 결과를 탐색한다.

기능:

- 최근 eval run 목록
- run 상세: Summary, Performance Summary, Performance Notes
- case/attempt drill-down
- provider comparison
- run-to-run 비교
- cost/latency trend preview

### 5.2 9-layer IPC 계획

새 IPC 도메인 `evals`를 추가한다.

1. `packages/core/src/api.ts`
   - `HarnessDesktopApi.evals.listRuns`
   - `HarnessDesktopApi.evals.getRun`
   - `HarnessDesktopApi.evals.getAttemptArtifact`
   - `HarnessDesktopApi.evals.compareRuns`
2. `packages/core/src/types/eval.ts`
   - renderer-facing DTO 정의
3. `packages/storage`
   - 기존 `EvalRunRepository` 확장
   - list filter: suite, mode, status, date range
4. `packages/evals`
   - read model helper
   - compare helper
5. `apps/desktop/electron/ipc/evals-ipc.ts`
6. `apps/desktop/electron/ipc/evals-ipc-register.ts`
7. `apps/desktop/electron/ipc/index.ts`
8. `apps/desktop/electron/preload.ts`
9. `apps/desktop/src/types/window.d.ts`

### 5.3 Renderer screens

```
apps/desktop/src/screens/evals/
├── EvalsScreen.tsx
├── EvalRunList.tsx
├── EvalRunDetail.tsx
├── EvalPerformanceSummary.tsx
├── EvalProviderComparison.tsx
├── EvalAttemptDrawer.tsx
└── EvalRunCompare.tsx
```

UI 원칙:

- 기존 desktop renderer 스타일 사용
- polling 금지. 사용자가 화면을 열 때 load, run 변경 이벤트가 생기면 push 후 fresh pull
- markdown raw render만 하지 말고 structured summary를 우선 표시
- failure/notes는 눈에 띄게 표시하되 pass 상태와 혼동되지 않게 분리

### 5.4 Tests

- core API type compile
- IPC handler validation tests
- repository list/filter tests
- renderer utility tests: status badge, delta formatting
- Playwright smoke는 viewer가 실제 app route에 연결된 뒤 추가

### 5.5 DoD

- 최근 20개 run 목록 표시
- run detail에서 suite/case/attempt 확인
- provider 비교 table 표시
- attempt artifact JSON drill-down 가능
- renderer가 DB/file/process에 직접 접근하지 않음

## 6. 장기간 Cost Trend 시각화

### 6.1 저장 모델

초기에는 `eval_runs.summary_json`에서 trend point를 계산한다.

```ts
export interface EvalCostTrendPoint {
  readonly runId: string;
  readonly startedAt: string;
  readonly suite: string;
  readonly mode: string;
  readonly totalTokens: number;
  readonly totalDurationMs: number;
  readonly passRate: number;
  readonly estimatedCostUsd?: number;
}
```

run 수가 500개를 넘거나 viewer가 느려지면 materialized cache table을 추가한다.

```sql
CREATE TABLE IF NOT EXISTS eval_run_metrics (
  run_id TEXT PRIMARY KEY REFERENCES eval_runs(id) ON DELETE CASCADE,
  suite TEXT NOT NULL,
  mode TEXT,
  total_tokens INTEGER NOT NULL,
  total_duration_ms INTEGER NOT NULL,
  pass_rate REAL NOT NULL,
  estimated_cost_usd REAL,
  created_at TEXT NOT NULL
);
```

### 6.2 Cost estimation

처음에는 tokens만 canonical로 둔다. USD는 provider별 pricing이 자주 바뀌므로 선택 필드로 둔다.

- real CLI result에 model/provider/usage가 있으면 provider pricing table 적용
- pricing table은 코드 상수로 시작하지 말고 config file 또는 docs table에서 관리
- pricing 불명확 시 cost는 `unknown`, tokens만 표시

### 6.3 Trend warnings

최근 N개 baseline과 현재 run을 비교한다.

기본 정책:

- totalTokens가 최근 5개 median 대비 20% 이상 증가: warning
- p95DurationMs가 최근 5개 median 대비 30% 이상 증가: warning
- passRate 하락: failure 또는 warning

이건 CI fail이 아니라 viewer/report warning으로 먼저 시작한다.

### 6.4 Tests

- cost trend point 계산
- median baseline 계산
- 20% token 증가 warning
- missing cost는 `unknown` 표시
- viewer chart input DTO snapshot

## 7. 실제 Production Workload p95/p99 Latency

### 7.1 목적

eval fixture는 synthetic workload다. production latency는 실제 app 사용 경로에서 operator가 체감하는 지연을 측정한다.

측정 대상:

- task run created → ready_for_review/done
- approval approved → runner finished
- agent invocation queued → first token
- agent invocation queued → final result
- quality evaluation started → gate persisted

### 7.2 이벤트 수집

처음에는 runtime event를 DB에 모두 쓰지 않는다. 기존 repository/service 경계에서 timing artifact 또는 metrics row를 선택적으로 남긴다.

후보 table:

```sql
CREATE TABLE IF NOT EXISTS runtime_latency_events (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  task_run_id TEXT,
  invocation_id TEXT,
  kind TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  success INTEGER NOT NULL,
  metadata_json TEXT
);
```

수집은 feature flag로 시작한다.

```ts
settings.evals.productionLatencyEnabled
```

### 7.3 Percentile 계산

작은 표본에서는 exact percentile을 사용한다. 장기적으로 row가 많아지면 daily aggregate table을 추가한다.

```ts
export interface LatencySummary {
  readonly kind: string;
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}
```

표본 수가 부족하면 표시를 제한한다.

- count < 20: p95/p99는 `insufficient sample`
- 20 <= count < 100: p95 표시, p99는 `insufficient sample`
- count >= 100: p95/p99 모두 표시

### 7.4 Production privacy/safety

- prompt/output 원문 저장 금지
- metadata에는 id, provider, model, action kind, status만 저장
- targetDir/file path는 필요하면 root-relative 또는 hash 처리
- 실패 reason은 code enum으로 저장, raw stderr는 저장하지 않음

### 7.5 Report / viewer

report에는 current run의 latency summary만 넣지 않는다. production latency는 장기 trend라 viewer 중심이다.

Viewer:

- 기간 선택: 24h / 7d / 30d
- kind별 p50/p95/p99 table
- regression warning
- sample count 부족 경고

### 7.6 Tests

- percentile exact 계산
- insufficient sample 표시
- metadata redaction
- feature flag off이면 event 미기록
- feature flag on이면 selected service boundary에서 event 기록

## 8. 단계별 구현 순서

### Phase 7.1 — Contract-only foundation

목표: v2 data type과 parser를 추가하되 실행 동작은 바꾸지 않는다.

변경:

- `EvalProvider`, `providers?`, provider-aware result type
- trend/latency DTO type
- tests only for parsing/type helpers

검증:

- `npm run check`
- eval unit tests
- `npm run eval`

### Phase 7.2 — Provider head-to-head

목표: CLI/report에서 Claude vs Codex 비교 가능.

검증:

- fake provider expansion test
- real smoke는 opt-in
- artifact collision test

### Phase 7.3 — LLM judge calibration

목표: judge를 본 eval에 넣기 전 calibration을 먼저 통과.

검증:

- known good/bad fixtures
- budget cap
- malformed output handling

### Phase 7.4 — Viewer read-only UI

목표: eval_runs 조회와 attempt artifact drill-down.

검증:

- IPC tests
- renderer utility tests
- manual app smoke

### Phase 7.5 — Cost trend

목표: recent run tokens/duration/pass trend.

검증:

- trend helper tests
- viewer chart DTO
- no pricing claim when cost unknown

### Phase 7.6 — Production latency

목표: feature-flagged production latency event capture와 p95/p99 summary.

검증:

- feature flag off/on tests
- percentile tests
- privacy redaction tests

## 9. Non-goals

- v2 기능을 `npm run verify`에 바로 포함하지 않는다.
- provider 비교 결과를 model ranking이나 auto routing에 바로 사용하지 않는다.
- LLM judge를 deterministic gate처럼 취급하지 않는다.
- viewer UI에서 raw filesystem path를 직접 열지 않는다.
- production latency 수집에서 prompt/output 원문을 저장하지 않는다.

## 10. 주요 위험과 완화

| 위험 | 영향 | 완화 |
------|------|------|
| Provider 비교 비용 폭증 | 토큰/시간 증가 | explicit env gate, attempts cap, budget cap |
| LLM judge 비결정성 | false positive/negative | calibration suite, judgeAttempts=3, variance report |
| Viewer IPC 범위 확대 | 9-layer 누락/보안 위험 | IPC checklist + core DTO tests |
| Trend cost 오판 | 잘못된 비용 판단 | tokens를 canonical metric으로 두고 USD는 optional |
| Production telemetry 과수집 | 개인정보/비밀 노출 | prompt/output 저장 금지, metadata redaction |
| p99 표본 부족 | 오해 소지 | insufficient sample 표시 |

## 11. 최종 DoD

- fake eval 기본 경로는 계속 deterministic
- real/provider/judge 경로는 explicit opt-in
- provider별 report 비교가 가능
- judge calibration 없이 LLM judge suite 실행 불가
- viewer에서 최근 run과 attempt artifact 조회 가능
- cost trend는 tokens 기준으로 먼저 신뢰 가능
- production latency p95/p99는 표본 수 조건과 함께 표시
