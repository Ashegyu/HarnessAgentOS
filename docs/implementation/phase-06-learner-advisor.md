# Phase 06 - Learner Advisor

## 목표

Learner를 자동 적용자가 아니라 추천 근거 제공자로 연결한다. 완료되면 TaskRun마다 model/capability 선택과 결과가 LearningTrace로 저장되고, 이후 유사 작업에서 cost/latency/reward 기반 추천이 UI에 표시되어야 한다.

## 비범위

- 자동 prompt promotion 금지.
- 자동 pipeline activation 금지.
- 자동 agent type promotion 금지.
- high risk action 자동 승인 금지.
- 복잡한 reinforcement learning 구현은 하지 않는다.

## 구현 단위

```text
packages/learner/src/
  learning-trace.ts
  trace-recorder.ts
  reward-evaluator.ts
  model-selection-feedback.ts
  learner-advisor.ts
apps/desktop/electron/ipc/learner-ipc.ts
apps/desktop/src/screens/workbench/
  LearnerPanel.tsx
  RecommendationCard.tsx
```

## 주요 타입과 인터페이스

```ts
export interface LearningTrace {
  id: string;
  taskRunId: string;
  selectedModel?: string;
  selectedCapabilities: string[];
  reward?: number;
  costEstimate?: number;
  latencyMs?: number;
  success?: boolean;
  failureReason?: string;
  createdAt: string;
}

export interface LearnerRecommendation {
  id: string;
  recommendedModel?: string;
  recommendedCapabilities: CapabilitySuggestion[];
  rationale: string;
  costHint?: "low" | "medium" | "high";
  latencyHint?: "low" | "medium" | "high";
  confidence: number;
}
```

IPC:

```ts
learner.getTrace(input: { taskRunId: string }): Promise<LearningTrace | null>;
learner.recommend(input: { taskRunId: string }): Promise<LearnerRecommendation>;
learner.recordDecision(input: {
  taskRunId: string;
  recommendationId: string; // LearnerRecommendation.id
  decision: "accepted" | "rejected";
  reason?: string;
}): Promise<void>;
```

## 데이터 흐름

```text
TaskRun starts
  -> trace draft created
  -> selected capabilities/model recorded when chosen
Runner/Quality completes
  -> latency/cost/success/failure recorded
  -> reward evaluator computes score
Future TaskRun
  -> learner.recommend reads similar traces
  -> recommendation shown in UI
  -> user accepts or rejects
  -> decision recorded as trace metadata
```

## UI 요구사항

Learner panel:

- 추천 모델, 추천 capability, confidence 표시.
- 비용/지연 힌트 표시.
- 추천 이유를 한 문단으로 표시.
- `자동 적용` 버튼은 없다.
- `이 추천 사용`, `거절` 버튼만 제공한다.

Trace view:

- 현재 TaskRun의 selected capabilities.
- reward, latency, cost estimate.
- 실패 원인.

## 보안/승인 정책

- Learner recommendation은 실행 권한이 없다.
- 추천 채택은 action을 실행하지 않고 plan/context에만 반영한다.
- high risk capability는 추천할 수 있지만 approval policy를 약화하지 않는다.
- trace에는 secret과 전체 stdout/stderr를 저장하지 않는다. artifact id와 요약만 연결한다.

## 테스트 계획

Unit:

- reward evaluator scoring.
- latency/cost hint bucketing.
- recommendation ranking fallback.
- secret-looking text exclusion.

Integration:

- TaskRun 완료 후 LearningTrace 생성/갱신.
- `learner.recommend`가 capability suggestions와 trace history를 합친다.
- accepted/rejected decision이 저장된다.

UI smoke:

- recommendation card 표시.
- accept/reject 기록.
- trace metrics 표시.

Manual acceptance:

- 추천은 보이지만 자동 실행되지 않는다.
- 추천을 거절해도 TaskRun이 실패하지 않는다.
- 과거 trace가 없으면 보수적인 fallback 추천이 표시된다.

## 완료 기준

- LearningTrace가 저장된다.
- reward/cost/latency/success/failure가 기록된다.
- Learner recommendation이 UI에 표시된다.
- 자동 적용 경로가 없다.
- Skillify capability와 trace가 연결된다.

## 다음 Phase 인계

Phase 7은 Learner와 Skillify 기반 추천 위에 선택적 agent orchestration을 얹는다. Phase 6은 orchestration도 trace에 기록할 수 있는 일반 LearningTrace 구조를 제공해야 한다.







