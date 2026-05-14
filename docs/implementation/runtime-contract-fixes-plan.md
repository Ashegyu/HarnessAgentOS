# Runtime Contract Fixes Implementation Plan

작성일: 2026-05-14

## 1. 배경

현재 전체 검증은 통과한다.

- `npm run check` 통과
- `npm run test` 통과, 460 tests passed
- `npm run build` 통과

하지만 코드 경로 검토에서 테스트가 아직 고정하지 못한 런타임 계약 문제가 확인됐다. 핵심 위험은 승인된 side effect가 실행 후에도 다시 실행 가능한 상태로 남는 점, pipeline 자동 실행 실패가 사용자에게 보이지 않는 점, targetDir와 quality evidence 계약이 일부 느슨한 점이다.

이 문서는 구현 전에 수정 순서, 변경 파일, 테스트 추가 범위, 검증 기준을 고정한다.

## 2. 목표

1. side effect 실행 상태를 정확히 기록한다.
2. 사용자가 선택한 pipeline 자동 실행 실패를 UI에 숨기지 않는다.
3. `targetDir` 저장과 실행 계약을 절대경로 기준으로 통일한다.
4. Quality Gate의 build/smoke evidence 판정을 실제 실행 명령과 일치시킨다.
5. UI 문구와 실제 approval scope 동작을 일치시킨다.
6. thread detail의 최신 plan 조회를 결정적으로 만든다.

## 3. 비목표

- Electron UX 전면 재설계는 하지 않는다.
- Approval/TaskRun schema를 크게 바꾸지 않는다.
- 기존 runner action type을 새로 추가하지 않는다.
- shell command parser를 완전한 보안 샌드박스로 확장하지 않는다.
- agent/provider CLI 동작 자체는 수정하지 않는다.
- 대규모 repository 추상화 리팩터링은 하지 않는다.

## 4. 변경 원칙

- 공개 IPC surface는 가능한 유지한다.
- DB migration은 필요할 때만 추가한다. 이번 범위는 기존 `approvals.status = executed`가 이미 있으므로 새 migration 없이 처리하는 것을 우선한다.
- 상태 전이는 service 계층에서 고정하고 renderer는 결과만 표시한다.
- 각 phase마다 regression test를 먼저 추가하거나 기존 test를 확장한다.
- 테스트가 없는 UI-only race 수정은 최소한 관련 helper 또는 component-level pure logic test를 추가할 수 있는지 먼저 확인한다.

## 5. Phase 1 - Runner 실행 완료 상태 고정

### 문제

`RunnerService.executeApproved()`는 `file_write` 또는 `shell` 실행 성공 후 step만 `succeeded`로 바꾸고 approval status는 `approved` 또는 `always_approved_for_run`으로 남긴다. UI는 approved approval을 계속 실행 가능하게 표시한다.

### 수정 파일

- `packages/runners/src/runner-service.ts`
- `packages/runners/src/runner-service.test.mjs`
- `apps/desktop/src/screens/workbench/TaskRunStateActions.tsx`
- 필요 시 `apps/desktop/src/screens/workbench/ApprovalPanel.tsx`

### 구현 계획

1. `RunnerService.executeApproved()` 성공 경로에서 approval을 `executed`로 갱신한다.
   - `state.decideApproval(approval.id, "executed", "...")` 사용을 우선한다.
   - 실패 경로에서는 `executed`로 바꾸지 않는다.
2. 일반 `executeApproved()`는 `executed` approval 재실행을 거부한다.
   - 사용자가 완료된 side effect를 실수로 다시 실행하지 못하게 한다.
3. `retryApproval()`은 `TaskRun.status`가 `blocked` 또는 `quality_failed`일 때만 재실행을 허용한다.
   - `quality_failed` 상태에서는 마지막 성공 action이 `executed`일 수 있으므로 `executed` approval도 retry 대상으로 허용한다.
   - 내부 실행 함수는 `executeApproved()`와 공통 로직을 쓰되, retry 호출에서만 `executed` 입력을 허용하도록 분리한다.
4. `TaskRunStateActions`의 `lastApproved` 계산에 `executed`도 포함한다.
   - `quality_failed` 후 retry button이 사라지지 않도록 한다.
5. `ApprovalPanel`은 `executed` approval을 실행 완료 영역에만 표시하고 실행 버튼은 노출하지 않는다.

### 테스트

- `executeApproved` 성공 후 approval status가 `executed`인지 확인한다.
- 성공 후 같은 approval에 대해 `executeApproved`를 직접 다시 호출하면 거부되는지 확인한다.
- `quality_failed` 상태에서 `executed` approval을 `retryApproval`로 재실행할 수 있는지 확인한다.
- 실패한 shell 실행은 approval을 `executed`로 바꾸지 않는지 확인한다.

### 완료 기준

- 실행 완료 approval은 UI에서 다시 실행 가능 상태로 보이지 않는다.
- retry는 `blocked`/`quality_failed` 상태에서만 명시적으로 가능하다.
- 기존 runner tests가 모두 통과한다.

## 6. Phase 2 - Pipeline 자동 실행 실패를 사용자에게 표시

### 문제

pipeline pick 자동 실행 중 `orchestration.draftPlan` 또는 `orchestration.runApproved`가 실패하면 내부에서 error를 만들지만 바깥 catch가 콘솔만 찍고 삼킨다. 사용자는 실패를 UI에서 확인하지 못할 수 있다.

### 수정 파일

- `apps/desktop/src/screens/workbench/WorkbenchShell.tsx`
- 필요 시 `apps/desktop/src/screens/workbench/ConversationInput.tsx`
- 가능하면 `apps/desktop/src/screens/workbench/*test.mjs` 신규 또는 기존 테스트 확장

### 구현 계획

1. `usingPipeline`인 경우 orchestration auto-flow 실패는 outer catch에서 다시 throw한다.
   - `ConversationInput.submit()`의 기존 error surface가 메시지를 표시하게 한다.
2. non-pipeline legacy orchestration flow는 기존처럼 콘솔 로그만 유지할지 별도 판단한다.
   - 이번 범위에서는 pipeline pick만 사용자 consent 기반 자동 실행이므로 pipeline 실패를 우선 노출한다.
3. 실패한 TaskRun 상태가 애매하게 남지 않도록 backend 상태 전이를 확인한다.
   - `draftPlan` 실패 전이면 template TaskRun approval만 남을 수 있다.
   - `runApproved` 실패라면 worker-runner가 step failed artifact를 남기는지 확인한다.
4. UI 문구는 사용자가 재시도 방법을 알 수 있게 한다.
   - 예: "파이프라인 자동 실행 실패: 설정 또는 Agent provider 상태를 확인한 뒤 다시 전송하세요."

### 테스트

- renderer 통합 테스트가 어렵다면 최소한 실패 throw propagation을 분리 가능한 helper로 뽑아 테스트한다.
- 수동 확인 시 pipeline이 enabled이고 provider가 unavailable인 조건에서 입력창 error가 표시되는지 확인한다.

### 완료 기준

- pipeline 자동 실행 실패가 콘솔 전용으로 숨지 않는다.
- 사용자는 같은 메시지를 재전송하거나 설정을 고칠 수 있는 오류 메시지를 본다.

## 7. Phase 3 - targetDir 절대경로 계약 통일

### 문제

TaskRun 생성 경로는 `validateAbsoluteTargetDir()`를 사용하지만 thread 생성 경로는 `validateTargetDir()`만 사용한다. 이 때문에 thread에 상대경로가 저장될 수 있고, 이후 TaskRun이 parent thread targetDir를 그대로 사용할 수 있다.

### 수정 파일

- `packages/storage/src/services/local-state-service.ts`
- `packages/storage/src/services/local-state-service.test.mjs`
- `packages/core/src/conversation/conversation-service.ts`
- `packages/core/src/conversation/conversation-service.test.mjs`
- 필요 시 `packages/core/src/path-policy.ts` 또는 `packages/core/src/conversation/target-dir.ts`

### 구현 계획

1. `LocalStateService.createThread()`에서 targetDir가 제공되면 절대경로 검증을 수행한다.
   - storage package가 core conversation helper에 의존하는 순환이 생기면 helper 위치를 `packages/core/src/path-policy.ts` 쪽으로 옮기거나 `validateTargetDir`에 `requireAbsolute` 옵션을 추가한다.
2. `ConversationService.createTask()`가 parent thread targetDir를 fallback으로 사용할 때도 절대경로 검증을 다시 수행한다.
   - 기존 DB에 상대경로가 이미 들어간 경우 TaskRun 생성 시 fail fast 한다.
3. ThreadSidebar/ConversationInput 문구는 "절대 경로" 요구와 일치시킨다.
   - 이미 placeholder는 절대경로 예시를 사용하므로 큰 변경은 없을 가능성이 높다.

### 테스트

- `createThread({ targetDir: "relative/path" })`가 실패하는지 확인한다.
- 기존 thread row에 상대경로가 있을 때 `conversation.createTask({ threadId })`가 `CONVERSATION_INVALID_TARGET_DIR`로 실패하는지 확인한다.
- 절대경로 thread 생성과 TaskRun 생성은 계속 통과하는지 확인한다.

### 완료 기준

- canonical thread/task targetDir는 모두 절대경로다.
- runner cwd가 상대경로로 실행되는 경로가 없다.

## 8. Phase 4 - Build evidence 판정 정합성

### 문제

Quality evidence reader는 shell step title/input/output summary에서 `build` 힌트를 찾는다. 그러나 runner가 생성하는 shell step title과 inputSummary는 실제 command가 아니라 approval summary 기반이다. 실제 command는 log artifact title에 들어가므로 `npm run build`를 실행해도 build evidence가 누락될 수 있다.

### 수정 파일

- `packages/runners/src/runner-service.ts`
- `packages/runners/src/runner-service.test.mjs`
- `packages/quality/src/evidence-reader.ts`
- `packages/quality/src/evidence-reader.test.mjs`
- `packages/quality/src/quality-evaluator.test.mjs`

### 구현 계획

1. Runner shell step에 실제 command를 보존한다.
   - `title`: `shell: <command>` 또는 `test: <command>`로 변경한다.
   - `inputSummary`: 실제 command 또는 command summary를 포함한다.
   - 기존 UI가 approval summary를 필요로 하면 outputSummary나 artifact summary에서 보조 표시한다.
2. `evidence-reader`가 shell log artifact도 build evidence 후보로 읽도록 확장할지 결정한다.
   - 최소 구현은 step title/inputSummary에 command를 넣는 것이다.
   - 더 견고한 구현은 log artifact title `shell: npm run build`와 summary `exit=0`를 build evidence로 인식한다.
3. build 실패는 exit code와 step failed 상태 모두에서 실패로 잡히게 한다.

### 테스트

- shell command `npm run build` 성공 step이 buildEvidence passed로 잡히는지 확인한다.
- shell command `npm run build` 실패 step이 buildEvidence failed로 잡히는지 확인한다.
- `requireBuild: true`에서 build command 성공 후 `QualityGateResult.buildPassed === true`인지 확인한다.
- 일반 shell command가 build evidence로 오탐되지 않는지 확인한다.

### 완료 기준

- 실제 build command 실행 결과가 Quality Gate의 build evidence에 반영된다.
- approval summary 문구에 의존하지 않는다.

## 9. Phase 5 - Smoke evidence를 일반 test evidence와 분리

### 문제

현재 `requireSmoke`는 test evidence가 하나라도 있으면 smoke evidence처럼 취급될 수 있다. Unit test 통과가 smoke 통과로 잘못 표시될 수 있다.

### 수정 파일

- `packages/quality/src/quality-types.ts`
- `packages/quality/src/evidence-reader.ts`
- `packages/quality/src/risk-policy.ts`
- `packages/quality/src/quality-evaluator.ts`
- 관련 quality tests

### 구현 계획

1. `EvidenceBundle`에 `smokeEvidence`를 추가한다.
2. smoke command 힌트를 별도로 정의한다.
   - 후보: `smoke`, `e2e`, `playwright`, `electron smoke`, `smoke:*`
   - 단순 `test`는 smoke로 인정하지 않는다.
3. `risk-policy`는 `requireSmoke`일 때 `smokeEvidence.length === 0`이면 missing risk를 기록한다.
4. `quality-evaluator`는 `smokePassed`를 `smokeEvidence.every(e => e.passed)` 기준으로 계산한다.
5. UI 문구는 그대로 두되, 표시 값의 의미를 정확히 한다.

### 테스트

- `npm test`만 실행한 상태에서 `requireSmoke: true`는 warning 또는 missing smoke risk를 낸다.
- `npm run smoke` 또는 `playwright test` 성공은 smokePassed true가 된다.
- smoke 실패는 failed gate 또는 smoke failed risk로 반영된다.

### 완료 기준

- 일반 test evidence와 smoke evidence가 분리된다.
- smoke required 상태에서 unit test만으로 통과하지 않는다.

## 10. Phase 6 - run_action_class scope 실제 구현

### 문제

UI는 "이 TaskRun 안에서 같은 종류의 action을 자동 승인"이라고 표시하지만, service는 현재 approval 하나만 `always_approved_for_run`으로 바꾼다.

### 수정 파일

- `packages/core/src/conversation/conversation-service.ts`
- `packages/core/src/conversation/conversation-service.test.mjs`
- 필요 시 `packages/storage/src/services/local-state-service.ts`
- 필요 시 `packages/storage/src/repositories/approval-repository.ts`
- `apps/desktop/src/screens/workbench/ApprovalPanel.tsx`

### 구현 선택지

#### 선택지 A - 현재 pending approvals 일괄 갱신

- 같은 TaskRun의 동일 `actionType` pending approvals를 모두 `always_approved_for_run`으로 바꾼다.
- schema 변경이 없다.
- 이미 존재하는 approvals에는 동작이 명확하다.
- 나중에 생성되는 동일 action approval에는 적용되지 않는다.

#### 선택지 B - TaskRun scoped policy 저장

- 별도 policy table 또는 TaskRun metadata가 필요하다.
- 나중에 생성되는 동일 action approval에도 적용 가능하다.
- migration과 상태 복잡도가 증가한다.

### 결정

이번 수정은 선택지 A로 진행한다. 현재 UI 문구의 "이 TaskRun 안"을 이미 생성된 pending approval 범위로 해석하면 schema 변경 없이 계약을 맞출 수 있다. 나중에 생성되는 approval까지 자동 승인해야 한다면 별도 phase로 policy table을 설계한다.

### 구현 계획

1. `ConversationService.approve()`에서 `scope === "run_action_class"`이면 현재 approval을 기준으로 `taskRunId`와 `actionType`을 얻는다.
2. 같은 TaskRun의 pending approvals 중 같은 actionType을 모두 `always_approved_for_run`으로 갱신한다.
3. 반환값은 기존 계약 유지상 요청한 approval의 최신 row를 반환한다.
4. UI title을 더 정확히 바꾼다.
   - 예: "현재 생성된 같은 종류의 pending action을 이 TaskRun에서 자동 승인합니다."

### 테스트

- 동일 TaskRun의 file_write pending approvals 2개 중 하나를 run scope approve 하면 둘 다 `always_approved_for_run`이 되는지 확인한다.
- 다른 actionType은 pending으로 남는지 확인한다.
- 다른 TaskRun의 동일 actionType은 영향받지 않는지 확인한다.

### 완료 기준

- UI 문구와 service 동작이 일치한다.
- public IPC shape는 유지된다.

## 11. Phase 7 - 최신 plan 조회 결정성 보장

### 문제

`LocalStateService.getThreadDetail()`은 taskRun별 최신 plan artifact를 `MAX(datetime(created_at))`로 고른다. 같은 초 또는 같은 timestamp에 plan artifact가 여러 개 있으면 결과가 비결정적이거나 중복될 수 있다.

### 수정 파일

- `packages/storage/src/services/local-state-service.ts`
- `packages/storage/src/services/local-state-service.test.mjs`

### 구현 계획

1. taskRun별 최신 plan artifact를 `created_at DESC, rowid DESC` 기준으로 하나만 고른다.
2. SQLite 호환성을 고려해 window function 대신 correlated subquery 또는 rowid 기반 join을 사용한다.
3. `agentAnswers` map에는 taskRunId당 정확히 하나의 summary만 넣는다.

### 테스트

- 같은 TaskRun에 plan artifact 여러 개를 같은 timestamp에 가깝게 생성해도 가장 최근 row 하나만 선택되는지 확인한다.
- 여러 TaskRun이 섞여 있을 때 각 TaskRun별 최신 plan이 정확히 매핑되는지 확인한다.

### 완료 기준

- chat transcript answer bubble이 오래된 plan 또는 중복 row 영향을 받지 않는다.

## 12. 전체 검증 순서

각 phase 후 좁은 테스트를 먼저 실행한다.

```powershell
node --import tsx --test --test-force-exit packages/runners/src/runner-service.test.mjs
node --import tsx --test --test-force-exit packages/core/src/conversation/conversation-service.test.mjs
node --import tsx --test --test-force-exit packages/storage/src/services/local-state-service.test.mjs
node --import tsx --test --test-force-exit packages/quality/src/evidence-reader.test.mjs packages/quality/src/risk-policy.test.mjs packages/quality/src/quality-evaluator.test.mjs
```

마지막에 전체 검증을 실행한다.

```powershell
npm run verify
```

가능하면 Electron smoke도 별도 실행한다.

```powershell
npm --workspace=@harness/desktop run e2e
```

단, Electron/Playwright 실행은 환경 권한이나 native module rebuild 상태에 따라 실패할 수 있으므로 실패 시 원인과 대체 검증을 기록한다.

## 13. 예상 리스크

- `executed` 전환을 추가하면 기존 tests나 UI가 approved 상태를 기대하던 부분이 드러날 수 있다.
- `retryApproval`의 허용 status를 잘못 열면 일반 재실행 방지 정책이 약해질 수 있다.
- targetDir absolute 검증 강화는 기존 DB에 상대경로 thread가 있는 사용자에게 새 TaskRun 생성 실패로 나타날 수 있다. 실패 메시지는 명확해야 한다.
- build/smoke evidence 힌트는 문자열 기반이므로 완전하지 않다. 이번 범위에서는 오탐/누락을 줄이는 최소 개선으로 제한한다.
- pipeline auto-flow 오류 propagation 변경은 입력창 error 표시에는 좋지만, 기존 콘솔-only 흐름에 의존하던 테스트가 있으면 조정이 필요하다.

## 14. 완료 정의

이 계획의 구현은 다음을 만족할 때 완료로 본다.

1. 실행 성공한 runner approval은 `executed`로 기록된다.
2. 완료된 approval은 일반 실행 버튼으로 다시 실행할 수 없다.
3. `quality_failed`/`blocked` 상태의 명시적 retry는 계속 가능하다.
4. pipeline 자동 실행 실패가 사용자 UI에 표시된다.
5. thread/task targetDir는 절대경로 계약을 따른다.
6. build와 smoke evidence가 일반 test evidence와 구분된다.
7. `run_action_class` 버튼의 실제 동작이 문구와 일치한다.
8. latest plan 조회가 taskRun별로 결정적이다.
9. 좁은 테스트와 `npm run verify`가 통과한다.
