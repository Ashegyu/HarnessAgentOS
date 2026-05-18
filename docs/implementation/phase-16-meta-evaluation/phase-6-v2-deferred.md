# Phase 6 — v2 Deferred (Real CLI · Provider 비교 · LLM Judge · Viewer UI)

> **선행 조건**: v1 (Phase 0~5) 안정화 + 회귀 트렌드 확인
> **트리거**: v1이 최소 2주 안정 운영 후 / 또는 실제 CLI 비교 needs가 명확해진 시점
> **복잡도**: Medium · **추정**: 별도 마일스톤

> **2026-05-18 업데이트**: Phase 7.1/7.2에서 provider 비교의 기본 계약, CLI 옵션, provider별 artifact 분리, markdown report 비교표는 구현됐다. Phase 7.3에서 `llm_judge` grader의 opt-in 실행 기반과 fake calibration 테스트도 추가됐다. Phase 7.4a에서 read-only eval viewer IPC와 Settings `Evals` 탭의 최근 run/detail 조회가 구현됐다. Phase 7.5에서 summary_json 기반 token/duration/pass rate trend와 viewer token trend 표시가 구현됐다. Phase 7.6a에서 기존 agent invocation latency row 기반 p50/p95/p99 summary가 구현됐다. 이 문서는 v2 deferred 배경 기록으로 유지한다. viewer의 attempt drill-down/비교 모드, USD pricing 기반 cost chart, task/approval/quality boundary latency capture는 계속 deferred다.

## 0. 왜 deferred인가

v1은 **fake adapter 결정적 실행**만으로 세 축(agent-eval, eval-harness, safety)을 모두 커버한다. Real CLI / Provider 비교 / LLM judge는 비용·시간이 크고 비결정성을 도입한다. **v1 안정화 → v2 추가**가 안전한 순서.

## 1. v2 범위

| 항목 | 무엇 | 왜 v2 |
|------|------|-------|
| Real CLI 어댑터 | `EVAL_REAL_CLI=1` 분기에서 `DefaultModelCliAdapter` 주입 | 실제 비용·시간 발생, 비결정성 |
| Provider head-to-head | claude vs codex 같은 케이스 동시 실행 + 비교 표 | Phase 7.2에서 기본 CLI/report 경로 구현 완료 |
| LLM judge | 자유 응답 평가 (코드 품질 등) | Phase 7.3에서 opt-in grader 기반 구현, 기본 CI 경로에서는 비활성 |
| Renderer viewer | Settings `Evals` 탭의 최근 run/detail 조회는 Phase 7.4a 완료. attempt drill-down, 비교 모드, trend chart는 후속 | 9-layer IPC 신설 비용 |
| Cost trend | token/duration/pass rate trend와 baseline warning은 Phase 7.5 완료. USD pricing 기반 cost chart는 후속 | pricing 정책이 아직 불안정 |

## 2. v2 작업 분해

### 2.1 Real CLI 어댑터 활성화

**파일**: `scripts/eval/run.mjs` — `EVAL_REAL_CLI=1` 분기에서 throw 대신 실제 adapter 주입.

```js
import { DefaultModelCliAdapter } from "@harness/agent";

const adapterFactory = () => realCli
  ? new DefaultModelCliAdapter({ /* 실제 CLI 설정 */ })
  : new FakeModelCliAdapter({ scenarios: ALL_FAKE_SCENARIOS });
```

**도전 과제**:
- 실제 CLI 호출은 케이스당 분 단위. 전체 suite는 1시간+ 가능. → `--parallel=N` 옵션
- 비결정성: 임계가 fake보다 느슨해야 함. 케이스 fixture별 별도 `thresholds` 허용 (이미 schema에 있음)
- 비용: 매 attempt 당 토큰 비용 누적. CI 시 별도 budget cap 필요. → `EVAL_TOKEN_BUDGET=100000` 환경변수

**DoD**:
- [ ] `EVAL_REAL_CLI=1 npm run eval:smoke` 통과 (capability 1-2 케이스로 시작)
- [ ] `--parallel=4` 동시 실행 안정
- [ ] 토큰 budget 초과 시 graceful skip + 경고

### 2.2 Provider Head-to-Head

**파일**: `packages/evals/src/orchestrator.ts` — case 하나당 다중 provider 실행.

```ts
async runCaseAcrossProviders(testCase: EvalCase): Promise<{
  byProvider: Map<AgentProvider, EvalCaseResult>;
}> {
  const providers = testCase.providers ?? ["claude", "codex"];
  const results = new Map();
  for (const p of providers) {
    const runner = new CaseRunner({
      adapterFactory: () => new DefaultModelCliAdapter({ provider: p }),
      /* ... */
    });
    results.set(p, await runner.run(testCase));
  }
  return { byProvider: results };
}
```

**Report 확장** (`report-template.ts`):

```markdown
### `file-write-readme` — capability · head-to-head

| Provider | Pass@3 | Tokens | Time |
|----------|--------|--------|------|
| claude   | 100%   | 4,200  | 12s  |
| codex    | 67%    | 5,800  | 18s  |
```

**DoD**:
- [ ] Fixture에 `providers?: AgentProvider[]` 명시한 케이스 1개 동작
- [ ] Report에 provider별 표 표시
- [ ] 동일 fixture, 다른 provider 결과 결정적 비교

### 2.3 LLM Judge

**파일**: `packages/evals/src/grader-types.ts` — discriminated union에 추가.

```ts
export interface LlmGrader {
  readonly kind: "llm";
  readonly judgePrompt: string;        // "Does this implementation handle edge cases?"
  readonly judgeModel?: string;        // default: project default model
  readonly passThreshold?: number;     // judge score 1-5, default >= 4
}

export type Grader = CodeGrader | RuleGrader | LlmGrader;
```

**Runner** (`packages/evals/src/graders/llm-grader.ts`):

```ts
export const runLlmGrader = async (
  grader: LlmGrader,
  ctx: GraderContext,
): Promise<{ passed: boolean; score: number; reason: string }> => {
  const targetCode = await collectCodeContext(ctx);
  const judgeAdapter = new DefaultModelCliAdapter({ model: grader.judgeModel ?? DEFAULT_JUDGE_MODEL });
  const response = await judgeAdapter.invoke({
    prompt: `${grader.judgePrompt}\n\n## Code to evaluate\n${targetCode}\n\n## Response format\nScore (1-5):\nReason:\n`,
    model: grader.judgeModel ?? DEFAULT_JUDGE_MODEL,
  });
  const parsed = parseJudgeResponse(response.output);
  const threshold = grader.passThreshold ?? 4;
  return {
    passed: parsed.score >= threshold,
    score: parsed.score,
    reason: parsed.reason,
  };
};
```

**도전 과제**:
- Judge의 비결정성 → 케이스마다 judge를 3회 돌려 평균 점수 사용
- Judge 모델 비용 → fixture에 `judgeBudgetTokens` 명시
- Anti-overfitting: judge가 너무 관대하면 신호 약화 → 주기적으로 *known good* / *known bad* 페어로 calibration

**DoD**:
- [ ] LLM grader 케이스 1개 동작 (e.g. "코드가 readable한가?")
- [ ] Judge 3회 평균 점수가 결정적 (variance < 0.5)
- [ ] Known good/bad calibration 케이스로 judge가 둘을 구분

### 2.4 Renderer Viewer (9-layer IPC 도입)

**v2의 가장 큰 작업**. Renderer에서 eval 결과를 보고 비교할 수 있는 UI.

**9-layer 풀 스택**:

1. `packages/core/src/api.ts` — `HarnessDesktopApi.evals.{list, get, compare}`
2. `packages/core/src/types/eval.ts` — renderer-facing 타입
3. `packages/storage` — 이미 `EvalRunRepository` 존재 (Phase 4)
4. `packages/evals` — read API 노출
5. `apps/desktop/electron/ipc/evals-ipc.ts` — IPC handler
6. `apps/desktop/electron/ipc/evals-ipc-register.ts`
7. `apps/desktop/electron/ipc/index.ts` — registerAllIpc 추가
8. `apps/desktop/electron/preload.ts` — contextBridge expose
9. `apps/desktop/src/types/window.d.ts` — renderer 타입

**UI**: `apps/desktop/src/screens/evals/EvalsScreen.tsx` — 새 화면 또는 사이드바 새 메뉴.

**기능**:
- 최근 run 목록 (suite별 필터)
- run 상세 페이지 (markdown report 렌더링 + 메트릭 차트)
- 두 run 비교 모드 (커밋 A vs B의 동일 케이스 결과 차트)
- 실패 케이스 drill-down (attempt 별 `result.json` 조회)

**한국어 라벨** (전 phase에서 미뤘던 것 — 여기서 적용):
- "평가 결과" / "케이스 실행" / "회귀 비교" 등

**DoD**:
- [ ] 9-layer IPC 신설 완료, 기존 패턴 일치
- [ ] EvalsScreen에서 최근 10개 run 조회 가능
- [ ] 두 run 비교 mode에서 메트릭 delta 표시
- [ ] 실패 attempt drill-down 가능

### 2.5 Cost Trend & Budget Alert

**파일**: `packages/evals/src/cost-trend.ts` — 시계열 분석.

```ts
export const computeCostTrend = async (
  state: LocalStateService,
  options: { suite?: string; days?: number },
): Promise<CostTrendPoint[]> => {
  const runs = await state.evalRuns.list({ /* ... */ });
  return runs.map((r) => ({
    runId: r.id,
    startedAt: r.startedAt,
    totalTokens: r.summary.cases.reduce((s, c) => s + c.totalTokens, 0),
    passRate: /* ... */,
  }));
};
```

**Alert 정책**:
- 직전 5개 run 대비 토큰 20% 이상 증가 → 경고
- 다음 PR이 비용을 또 늘리면 → CI fail

**DoD**:
- [ ] 트렌드 차트 UI (EvalsScreen)
- [ ] Budget alert 정책 적용 (CI에서)

## 3. v2 진행 조건 (Gate)

v2를 시작하기 전에 *반드시* 확인:

1. **v1이 2주 이상 안정 운영** (CI에서 false-positive 없음)
2. **회귀 1건 이상 실제로 잡은 경험** — v1이 가치를 증명한 후 확장
3. **모델 API 비용 예산 확보** — real CLI / LLM judge 둘 다 비용 발생
4. **9-layer IPC 신설 작업 일정** — viewer는 minimum 3-5일

조건 미충족 시 v2 시작 안 함. v1.5로 부분 도입 가능:
- v1.5a: real CLI만 (viewer 없이)
- v1.5b: 기존 markdown report에 attempt-level performance summary 추가 (viewer 없이)
- v1.5c 이후 후보: LLM judge만 (provider 비교 없이)

### 3.1 현재 gate 판정

Phase 0~5 v1은 구현 완료됐고 `npm run eval`은 fake adapter 기반 deterministic suite로 동작한다. Phase 6 v2는 다음 조건이 아직 충족되지 않아 deferred 상태를 유지한다.

| 조건 | 현재 판정 |
|------|-----------|
| v1이 2주 이상 안정 운영 | 미충족 |
| v1이 실제 회귀 1건 이상 포착 | 미충족 |
| real CLI / LLM judge 비용 예산 | 미정 |
| 9-layer IPC viewer 일정 | 미정 |

따라서 현재 Phase 6 완료 기준은 전체 v2 구현이 아니라, v1.5a 범위에서 `EVAL_REAL_CLI=1` / `npm run eval:smoke`가 단일 capability smoke 케이스를 실제 `DefaultModelCliAdapter`로 실행하고, v1 fake eval gate가 안정적으로 통과하는 상태다.

v1.5b는 existing eval report의 `Summary by Suite` 아래에 attempt-level `Performance Summary` markdown table과 current-run `Performance Notes`를 추가하는 범위까지 완료됐다. 이 표는 suite별 attempt 수, 평균/ p50 / p95 duration, 평균 tokens, passed attempt당 tokens, approval 합계, manual approval 합계, attempt pass rate를 보여준다. 3회 미만 smoke에서는 `Pass^3`를 `n/a`로 표시하고, 50,000 tokens 이상 또는 30초 이상 걸린 attempt는 Performance Notes에 표시한다. `npm run eval:perf`는 fake adapter 기반 `--suite=all --attempts=10` 반복 실행용 단축 스크립트다.

Provider 비교와 LLM judge opt-in 기반, read-only viewer list/detail, token trend 표시, agent invocation final latency summary는 구현됐다. viewer attempt drill-down/비교 모드, USD pricing 기반 cost chart, task/approval/quality boundary latency capture는 여전히 v2 deferred이며, gate 충족 후 별도 TDD phase로 진행한다.

구현 재개 시 세부 설계는 [Phase 7 v2 Expansion Design Plan](./phase-7-v2-expansion-plan.md)을 기준으로 한다.

## 4. 일정 추정 (Optimistic)

| 작업 | 추정 |
|------|------|
| Real CLI 어댑터 활성화 | 2-3일 |
| Provider head-to-head | 1-2일 |
| LLM judge | 3-4일 (calibration 포함) |
| Renderer viewer (9-layer IPC + UI) | 5-7일 |
| Cost trend & alert | 2-3일 |
| **v2 합계** | **13-19일** |

## 5. v3 미지의 영역 (예상)

v2 완료 후 자연스럽게 떠오를 후속 작업들:

- **Multi-repo eval** — 여러 프로젝트에 대해 같은 케이스 돌리기 (HarnessAgentOS가 다른 codebase에서도 잘 동작하는지)
- **Promp regression** — 시스템 프롬프트 변경 시 자동 평가
- **Agent profile evolution** — 평가 결과 기반으로 profile 자동 튜닝 (`learner`와 연결)
- **Public benchmark** — 외부 공개 가능한 안전 케이스 셋 (jailbreak 방어 능력 비교)

이건 v3+ 영역. 명확한 우선순위 없음.
