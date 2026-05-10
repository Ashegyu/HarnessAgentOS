# Phase 04 - Quality Gates

## 목표

TaskRun 완료 전 evidence 기반 Quality Gate를 도입한다. 완료되면 테스트 미실행, build 실패, smoke evidence 부족, diff 미검토 같은 상태가 명확히 표시되고, 사용자는 repair/retry 또는 known risk 승인 중 하나를 선택할 수 있어야 한다.

## 비범위

- Skillify/Learner 추천은 Phase 5/6에서 한다.
- 완전한 eval framework는 만들지 않는다.
- 모든 언어/프레임워크의 자동 test discovery를 완성하지 않는다.
- agent 자기 보고만으로 done 처리하지 않는다.

## 구현 단위

```text
packages/quality/src/
  quality-types.ts
  quality-evaluator.ts
  evidence-reader.ts
  risk-policy.ts
packages/core/src/task-run/task-run-completion-service.ts
apps/desktop/electron/ipc/quality-ipc.ts
apps/desktop/src/screens/workbench/
  QualityPanel.tsx
  RiskApprovalDialog.tsx
```

## 주요 타입과 인터페이스

```ts
export interface QualityGateInput {
  taskRunId: string;
  requireBuild?: boolean;
  requireTests?: boolean;
  requireSmoke?: boolean;
}

export interface QualityGateResult {
  id: string;
  taskRunId: string;
  status: "passed" | "failed" | "warning" | "not_run";
  buildPassed?: boolean;
  testsPassed?: boolean;
  smokePassed?: boolean;
  changedFilesReviewed?: boolean;
  knownRisks: string[];
  evidenceArtifactIds: string[];
  createdAt: string;
}
```

IPC (단일 소스: `docs/contracts/ipc-contracts.md`):

```ts
quality.evaluate(input: QualityGateInput): Promise<QualityGateResult>;
quality.getLatest(input: { taskRunId: string }): Promise<QualityGateResult | null>;
quality.approveKnownRisks(input: { taskRunId: string; message: string }): Promise<TaskRun>;
quality.createRepairPlan(input: { taskRunId: string; instruction?: string }): Promise<RepairPlanDraft>;
quality.markReadyForReview(input: { taskRunId: string }): Promise<TaskRun>;
quality.markDone(input: { taskRunId: string }): Promise<TaskRun>;
```

`markDone`은 done으로의 유일한 전환 경로이며, `passed` 게이트 또는 `warning` 게이트 + 명시적 known-risk 승인 아티팩트가 있을 때만 통과한다. 성공 시 IPC 계층이 LearningTrace `recordOutcome`을 자동으로 호출한다.

## 데이터 흐름

```text
Runner phase completes
  -> user triggers quality.evaluate or auto-evaluate after test step
  -> EvidenceReader loads artifacts and runner results
  -> QualityEvaluator calculates gate result
  -> result row inserted
  -> TaskRun status = ready_for_review or quality_failed
  -> QualityPanel renders missing evidence and risks
```

Repair flow:

```text
quality_failed
  -> user requests repair plan
  -> new Step kind = plan
  -> plan artifact describes repair actions
  -> before_edit checkpoint and approval created
  -> flow returns to Phase 2 approval pattern
```

## UI 요구사항

Quality panel must show:

- build status: passed/failed/not run
- tests status: passed/failed/not run
- smoke status: passed/failed/not required/not run
- changed files reviewed status
- known risks list
- evidence artifact links
- available actions: retry tests, create repair plan, approve known risk, mark ready for review

Done button은 QualityGateResult가 passed이거나 warning + explicit known risk approval일 때만 활성화한다. `not_run` 상태에서는 절대 활성화하지 않는다.

## 보안/승인 정책

- Quality Gate는 side effect 없이 artifacts와 DB state를 읽는다.
- Retry tests는 Phase 3 runner policy와 approval을 재사용한다.
- known risk 승인은 사용자의 message가 필요하다.
- `done` 전환은 QualityService를 통해서만 가능하다.
- renderer는 TaskRun status를 직접 done으로 바꿀 수 없다.

## 테스트 계획

Unit:

- missing test artifact -> not_run/failed 판정.
- failed exit code artifact -> testsPassed false.
- no changed files but user requested code change -> risk 생성.
- known risk approval requirement.

Integration:

- `quality.evaluate`가 result row와 TaskRun status를 갱신한다.
- quality_failed에서 repair plan 생성 시 `RepairPlanDraft`가 반환되고 새 plan/checkpoint/approval 흐름으로 돌아간다.
- renderer가 직접 done status를 만들 수 없다.

UI smoke:

- passed/failed/not_run 상태 표시.
- missing evidence가 사용자에게 보인다.
- risk approval dialog에서 이유 입력 없이는 승인 불가.

Manual acceptance:

- 테스트를 실행하지 않은 작업은 완료할 수 없다.
- 실패 로그 artifact에서 품질 실패 원인을 따라갈 수 있다.
- known risk를 승인하면 그 기록이 남는다.

## 완료 기준

- QualityGateResult가 DB에 저장된다.
- 품질 실패가 TaskRun status에 반영된다.
- done 전환이 quality gate를 우회하지 못한다.
- repair plan 흐름이 다시 approval 모델로 연결된다.
- MVP 실행 가능성을 Phase 0-4만으로 확인할 수 있다.

## 다음 Phase 인계

Phase 5는 품질 게이트가 닫힌 기본 Harness 흐름 위에 Skillify capability 추천을 연결한다. Phase 4까지가 HarnessAgentOS의 최소 실행 가능한 코어다.








