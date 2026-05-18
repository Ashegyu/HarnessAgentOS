# Harness Supervision Hardening Plan

작성일: 2026-05-18
대상: 하네스 운영 평가에서 확인된 3가지 공백 보완

## 1. 배경

`workspace/app-flow-visualization.html` v2 작성 과정에서 코드 경로를 재검토한 결과, "감독이 실제로 작동하는가" 측면은 구조적으로 견고하나(approval-first가 우회 불가능, state machine이 30+ 호출 지점에서 실제 사용, race 보호 명시적), 다음 3개 공백이 검증됐다.

1. **Pre-execution budget enforcement 부재** — `LearningTrace`는 `costEstimate`/`latencyMs`를 post-hoc 기록만 하고, 호출 전에 비용 상한으로 차단하는 런타임 가드가 없다. `grep -rn "budgetCap|maxCost|costLimit|enforceBudget"` 결과 **0건**.
2. **Auto-approve 결정 trace의 in-app 비가시성** — [`shouldAutoApprove`](../../packages/core/src/conversation/auto-approve-policy.ts) 6단계 결정 순서는 코드에 박혀있지만, 사용자는 UI에서 "왜 이 approval이 자동 승인됐는가(또는 안 됐는가)"를 결정 단계 단위로 확인할 수 없다.
3. **In-flight 자식 프로세스 cleanup 보장 부재** — `AgentInvocationQueue.cancel`은 `AbortController.abort()`까지만 호출하고([agent-invocation-queue.ts:95](../../packages/agent/src/agent-invocation-queue.ts)), `ShellRunner.run`은 `AbortSignal`을 받지 않는다([shell-runner.ts:40-46](../../packages/runners/src/shell-runner.ts)). 따라서 `cancelled` 상태 전환 후에도 외부 CLI/shell child가 살아 있을 수 있다.

이 문서는 세 공백을 각각 Phase로 분리해 수정 파일·구현 계획·테스트·완료 기준을 고정한다.

## 2. 목표

1. 비용 상한을 정책 레벨이 아니라 런타임 게이트로 강제한다.
2. Auto-approve 결정 단계를 approval row에 저장하고 UI에서 확인할 수 있게 노출한다.
3. Approval 실행 단계의 모든 자식 프로세스에 cancellation 신호가 끝까지 전파되도록 한다.

## 3. 비목표

- LLM provider별 가격표를 하드코딩하지 않는다 (기존 `costEstimate` 계산기 재사용).
- Auto-approve 정책 자체를 새로 추가하지 않는다 (6단계 결정 로직은 그대로 유지).
- ShellRunner의 보안 샌드박스를 확장하지 않는다.
- DB schema의 대규모 재구성은 하지 않는다 (필요한 컬럼만 추가).
- AgentProfile UI 전면 재설계는 하지 않는다.

## 4. 변경 원칙

- 공개 IPC surface는 유지하되 필요한 경우 namespace 내부에서 메서드를 추가만 한다 (제거 금지).
- DB migration은 필요할 때만 추가하고 `SCHEMA_VERSION`을 1만 증가시킨다.
- 상태 전이 규칙은 service 계층에서 고정한다. Renderer는 결과만 표시한다.
- 각 Phase는 regression test를 먼저 추가하거나 기존 test를 확장한다.
- 결정 trace 기록은 기존 `policyEvaluation` 구조와 호환되게 확장한다 (새 필드 추가).

## 5. Phase 1 — Pre-Execution Budget Gate

### 문제

`LearningTrace.costEstimate`는 호출 결과를 기록만 한다. 자동 승인이 켜진 상태에서 비싼 모델이 반복 호출되면 사용자가 사후에 알게 된다. BLOCK FLOOR(`blockedActions`)는 액션 타입 단위 차단이라 "model 호출은 허용하되 회당 X달러 초과 시 차단" 같은 정량 가드가 불가능하다.

### 수정 파일

- `packages/core/src/types/agent-profile.ts` — `AgentPermissions`에 `budget` 필드 추가
- `packages/core/src/types/approval.ts` — `PolicyEvaluation`에 `costEstimateUsd?: number` 추가
- `packages/core/src/conversation/budget-policy.ts` (신규) — `evaluateBudget()` 순수 함수
- `packages/core/src/conversation/budget-policy.test.mjs` (신규)
- `packages/core/src/conversation/auto-approve-policy.ts` — `shouldAutoApprove`에 budget 게이트 단계 삽입
- `packages/storage/src/migrations/` — `agent_profiles.budget_json` 컬럼 추가 migration
- `packages/storage/src/schema.ts` — `SCHEMA_VERSION` 1 증가
- `packages/learner/src/learner-advisor.ts` — `recommendModel` 결과에 `estimatedCostUsd` 채움
- `apps/desktop/src/screens/workbench/SettingsPanel.tsx` — profile budget 편집 UI

### 구현 계획

1. **Type 확장**
   - `AgentPermissions`에 다음 필드 추가:
     ```ts
     budget?: {
       perInvocationUsd?: number; // 단일 호출 상한
       perTaskRunUsd?: number;    // TaskRun 누적 상한
       perDayUsd?: number;        // 일일 누적 상한 (선택)
     };
     ```
   - `PolicyEvaluation`에 `costEstimateUsd?: number`, `budgetDecision?: { kind: "allow" | "blocked"; reason?: string }` 추가.

2. **Budget 정책 함수 분리**
   - `evaluateBudget({ approval, profile, accumulatedTaskRunCost, accumulatedDailyCost }): BudgetDecision` 순수 함수로 작성.
   - `auto-approve-policy.ts`의 `shouldAutoApprove`에서 step 2 (policy blocked) 직후에 budget 게이트를 호출. 차단 시 `false` 반환.
   - **BLOCK FLOOR 위치 유지**: budget 게이트는 `blockedActions` 다음, `autoApproveActions` 직전에 위치해 per-profile 자동 승인보다 우선한다.

3. **누적 비용 집계**
   - `packages/storage/src/repositories/learning-trace-repository.ts`에 `sumCostByTaskRun(taskRunId)`, `sumCostByDay(profileId, isoDate)` 추가.
   - 호출은 `conversation.draftPlan`/`runner.executeApproved`/`agent.startInvocation` 진입점에서 `evaluateBudget` 직전에 수행.

4. **Migration**
   - `agent_profiles` 테이블에 `budget_json TEXT` nullable 컬럼 추가 (`IF NOT EXISTS` 가드).
   - `SCHEMA_VERSION` 1 증가.

5. **Learner advisor 통합**
   - `recommendModel` 결과에 `estimatedCostUsd` 포함. 호출자가 `approval.policyEvaluation.costEstimateUsd`에 복사해 budget 게이트가 읽을 수 있게 한다.

6. **UI**
   - `SettingsPanel`의 profile 편집 영역에 3개 숫자 입력 (per-invocation / per-task-run / per-day). 빈 값은 무제한.
   - Budget 차단으로 인한 approval 거부 시 `decisionMessage`에 "budget 차단: 예상 비용 $X.XX, 한도 $Y.YY" 형식으로 노출.

### 테스트

- 단일 호출이 `perInvocationUsd`를 초과하면 `shouldAutoApprove`가 `false`를 반환한다.
- TaskRun 누적 비용이 한도를 초과하면 자동 승인이 차단된다.
- Budget가 정의되지 않은 profile은 기존 동작과 동일하다 (regression).
- `blockedActions`는 budget 게이트보다 우선한다 (BLOCK FLOOR 보존).
- Migration이 기존 DB에 적용되어 `budget_json` 컬럼이 nullable로 생성된다.

### 완료 기준

- Budget 초과 시 approval이 `pending` 상태로 남고 사용자가 명시 승인해야 실행된다.
- 비용 정보가 없는 액션(`file_write` 등)은 budget 게이트를 우회한다.
- 기존 `auto-approve-policy.test.mjs` 가 모두 통과한다.

## 6. Phase 2 — Auto-Approve Decision Trace

### 문제

`shouldAutoApprove`는 6단계(7단계가 됨, Phase 1 이후) 순서로 결정하지만 결과만 boolean으로 반환한다. 사용자는 approval row에서 "왜 자동 승인됐는가/왜 안 됐는가"를 단계 단위로 알 수 없다. 디버깅과 신뢰 측면 모두 손해.

### 수정 파일

- `packages/core/src/conversation/auto-approve-policy.ts` — 반환 타입을 `boolean` → `AutoApproveDecision` 으로 확장
- `packages/core/src/types/approval.ts` — `Approval`에 `autoApproveDecision?: AutoApproveDecision` 필드 추가
- `packages/storage/src/repositories/approval-repository.ts` — `auto_approve_decision_json` 컬럼 read/write
- `packages/storage/src/migrations/` — 컬럼 추가 migration
- `apps/desktop/src/screens/workbench/ApprovalPanel.tsx` — 결정 trace 표시
- `apps/desktop/src/screens/workbench/ApprovalDecisionTrace.tsx` (신규) — 6단계 시각화 컴포넌트
- 호출부 업데이트: `WorkbenchShell.tsx`, `auto-approve-policy.test.mjs`

### 구현 계획

1. **Decision 객체 정의**
   ```ts
   export type AutoApproveStep =
     | "blocked_action"
     | "policy_blocked"
     | "budget_blocked"
     | "profile_auto_approve"
     | "policy_disallow_auto"
     | "worker_file_action"
     | "global_toggle";

   export interface AutoApproveDecision {
     approved: boolean;
     decidedAt: AutoApproveStep;
     reason: string;
   }
   ```

2. **`shouldAutoApprove` 시그니처 변경**
   - 기존 `boolean` 반환을 `AutoApproveDecision`로 변경.
   - 모든 호출처(`WorkbenchShell.tsx` 자동 승인 useEffect, test 파일)에서 `decision.approved` 사용으로 갱신.
   - Backward compat alias 함수 `shouldAutoApproveBool` 는 만들지 않는다 (사용처가 적고 의미가 약해진다).

3. **Approval persistence**
   - `Approval`에 `autoApproveDecision` 필드 추가. `createApproval`에서 결정 시점에 저장.
   - 수동 결정(사용자 클릭)인 경우 `autoApproveDecision`는 undefined.

4. **Migration**
   - `approvals.auto_approve_decision_json TEXT` nullable 컬럼 추가.
   - `SCHEMA_VERSION` 1 증가 (Phase 1과 동일 migration에 합칠 수 있으면 합친다).

5. **UI 노출**
   - `ApprovalPanel`에 "왜 이렇게 결정됐나" 토글 (접힘 기본).
   - 펼치면 7단계 결정 흐름을 표시하고 결정이 멈춘 단계를 강조한다. 각 단계는 다음을 보여준다:
     - 단계 이름 (한국어 라벨)
     - 입력값 요약 (예: "blockedActions: [git_commit]", "profile autoApproveActions: [file_write]")
     - PASS/STOP 표시
   - Budget 차단인 경우 예상 비용과 한도를 표시.

### 테스트

- 각 7단계가 trigger되는 케이스에 대해 `decision.decidedAt`이 정확한 값을 반환한다.
- 자동 승인된 approval에는 `autoApproveDecision`이 저장된다.
- 수동 승인된 approval에는 `autoApproveDecision`이 null 이다.
- Migration이 기존 row를 깨뜨리지 않는다.

### 완료 기준

- 모든 자동 승인 결정의 단계 정보가 DB에 영구 저장된다.
- ApprovalPanel에서 결정 단계와 사유를 확인할 수 있다.
- 기존 `auto-approve-policy.test.mjs`가 새 시그니처로 갱신되어 통과한다.

## 7. Phase 3 — Cancellation Cleanup Chain

### 문제

`AgentInvocationQueue.cancel`은 `AbortController.abort()`를 호출해 work function에 신호를 보내지만, 그 work가 `ShellRunner.run`이나 외부 CLI(claude, codex)를 호출했다면:

- `ShellRunner.run`은 `AbortSignal` 파라미터가 없다([shell-runner.ts:40-46](../../packages/runners/src/shell-runner.ts)). 자체 timeout으로만 child를 죽인다.
- `agent-planning-service.ts`의 work 콜백은 `signal` 을 받지만 실제 CLI spawn에 신호를 전달하는지 확인되지 않았다.

결과: invocation row가 `cancelled`로 즉시 전환되어도 OS 레벨에서 child process가 살아 있을 수 있다. → 정확한 비용 집계 불가, 자원 누수, "취소했는데 실행됐다" UX 불일치.

### 수정 파일

- `packages/runners/src/shell-runner.ts` — `run({ signal?: AbortSignal })` 시그니처 추가
- `packages/runners/src/shell-runner.test.mjs` — abort 전파 테스트 추가
- `packages/agent/src/claude-cli-adapter.ts` (혹은 동등 위치) — spawn 시 signal 전달 확인
- `packages/agent/src/codex-cli-adapter.ts` (동일)
- `packages/agent/src/agent-planning-service.ts` — work 콜백이 받은 signal을 spawn까지 전달
- `apps/desktop/electron/ipc/agent-ipc.ts` — cancelInvocation 결과에 "process killed" 여부 포함 (선택)

### 구현 계획

1. **ShellRunner.run에 AbortSignal 추가**
   ```ts
   async run(input: {
     command: string;
     cwd: string;
     timeoutMs?: number;
     idleTimeoutMs?: number;
     env?: NodeJS.ProcessEnv;
     signal?: AbortSignal;
   }): Promise<ShellRunResult>
   ```
   - `signal.aborted` 이미 true 면 즉시 reject (RUNNER_CANCELLED).
   - `signal.addEventListener("abort", () => fail("cancelled"))` 등록, child.kill 호출.
   - cleanup 함수에서 listener 제거 (메모리 누수 방지).

2. **CLI adapter들에 signal 전파**
   - claude/codex CLI adapter의 `spawn` 호출에 `{ signal }` 옵션 전달 (Node 16+ 지원).
   - 일부 환경에서 signal 옵션이 강제 SIGKILL이라 SIGTERM 단계도 추가하려면 explicit `child.kill("SIGTERM")` 후 grace period 그다음 `kill("SIGKILL")`.

3. **AgentPlanningService work 함수 갱신**
   - 모든 `work: (signal) => ...` 콜백에서 받은 signal을 내부 호출까지 전달.
   - 현재 코드의 [agent-planning-service.ts:466](../../packages/agent/src/agent-planning-service.ts:466) 등의 work 정의 확인 후 전달 누락 지점 수정.

4. **RunnerService 통합**
   - `executeApproved`가 long-running shell을 실행할 때 TaskRun cancellation 신호도 받아 동일하게 전파하도록 [runner-service.ts](../../packages/runners/src/runner-service.ts)의 shell 경로에 옵션 signal 추가.

5. **Cleanup 검증 helper**
   - 테스트용 `assertNoChildProcess(pid)` 헬퍼는 만들지 않는다 (Windows/POSIX 차이 큼).
   - 대신 mock spawn + assertion 으로 verify.

### 테스트

- `ShellRunner.run`에 abort된 signal을 넣으면 즉시 RUNNER_CANCELLED 로 reject 한다.
- 실행 중 abort 호출 시 child.kill이 호출되고 reject 된다.
- `AgentInvocationQueue.cancel` 호출 시 in-flight work의 `signal.aborted`가 true 가 된다 (이미 존재할 가능성 있음, 확인 후 보강).
- Cancel 후 invocation row가 `cancelled` 상태이고 child process mock의 `kill`이 호출됐다.

### 완료 기준

- `cancelInvocation` 또는 TaskRun cancel 호출 시 OS 레벨 child process까지 종료 신호가 전달된다.
- ShellRunner는 외부 cancellation을 받아들이고 적절히 cleanup 한다.
- 기존 shell-runner 테스트와 agent-planning-service 테스트가 모두 통과한다.

## 8. 통합 검증

각 Phase 완료 후 다음을 순서대로 실행한다:

```bash
npm run check
npm run test
npm run verify
```

추가 수동 확인:

- Settings UI에서 profile 1개에 budget 설정 후 비싼 모델 자동 호출 → approval pending 으로 멈추는지 확인.
- ApprovalPanel에서 자동 승인/차단된 approval 모두 결정 trace 토글이 동작하는지 확인.
- 장시간 실행 shell command를 띄운 상태에서 cancel 버튼 → 프로세스 모니터로 child 종료 확인.

## 9. Phase 우선순위와 의존성

```
Phase 1 (Budget Gate)         Phase 3 (Cancellation Cleanup)
       │                              │
       │ shouldAutoApprove 시그니처    │ 독립
       │ 변경의 사전 조건              │
       ▼                              ▼
Phase 2 (Decision Trace) ◀────────────┘
       │
       ▼
  UI 통합 (ApprovalPanel)
```

- **Phase 1 → Phase 2**: Budget 단계가 결정 trace의 한 단계가 되어야 하므로 Phase 1을 먼저.
- **Phase 3은 독립**: cancellation 경로는 정책 경로와 분리되어 있어 병렬 진행 가능.
- 권장 진행: Phase 1 (Medium, 2-3일) → Phase 2 (Small-Medium, 1-2일) → Phase 3 (Medium, 2일). 총 5-7일 추정.

## 10. 위험 요소

| 위험 | 완화 |
|------|------|
| Cost estimate가 부정확하면 budget 게이트가 오작동 | 초기에는 사용자가 명시 입력한 단가만 사용. 추정 모델 학습은 후속 Phase. |
| `shouldAutoApprove` 시그니처 변경이 광범위 영향 | 모든 호출처를 한번에 갱신하고 build break으로 누락 감지. |
| Signal propagation이 Windows에서 SIGKILL 만 동작 | platform branch로 graceful termination 시도 후 fallback. 테스트는 mock spawn 기반으로 platform-agnostic 유지. |
| Migration 추가가 기존 DB에 영향 | `IF NOT EXISTS` 가드와 nullable 컬럼만 사용. 기존 row에는 모두 NULL로 시작. |

## 11. 후속 작업 (이 plan 범위 밖)

- LearningTrace cost를 입력으로 받아 모델별 단가표 자동 학습
- Approval Decision Trace를 evaluation 시스템(`packages/evals`)의 safety case에 추가
- Daily budget 누적의 timezone 처리 (현재는 server-local date)
- Multi-process child의 process tree 전체 종료 (현재는 spawn된 직접 child만)
