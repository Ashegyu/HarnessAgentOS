# Orchestration "Agent orchestration is disabled" 분석

> 작성일: 2026-05-11
> 작성 컨텍스트: 사용자가 OrchestrationPanel에서 plan 초안(draftPlan)을 누르면
> 매번 다음 에러가 표시되어 동작하지 않는다고 보고함.
>
> ```
> ORCHESTRATION_DISABLED
> Agent orchestration is disabled. Enable the feature flag to use it.
> ```
>
> 본 문서는 **분석만** 한다. 구현이나 활성화 변경은 포함하지 않는다.

---

## 1. 에러 발생 지점

[packages/orchestration/src/orchestration-service.ts:150-157](../../packages/orchestration/src/orchestration-service.ts:150)

```ts
private assertEnabled(): void {
  if (!this.deps.enabled) {
    throw new OrchestrationError(
      "ORCHESTRATION_DISABLED",
      "Agent orchestration is disabled. Enable the feature flag to use it.",
    );
  }
}
```

이 가드는 `draftPlan()` ([orchestration-service.ts:44-47](../../packages/orchestration/src/orchestration-service.ts:44))과 `runApproved()` ([orchestration-service.ts:49-77](../../packages/orchestration/src/orchestration-service.ts:49)) 두 진입점에서 첫 줄에 호출된다. 따라서 UI에서 plan 초안을 누르면 IPC `orchestration:draftPlan` → 서비스 진입 → 즉시 `assertEnabled` → 에러.

`getLatestPlan()` (조회 전용)은 가드를 거치지 않지만, IPC handler가 별도로 `service.isEnabled()` 체크 후 `null`을 반환하므로 사용자가 보기엔 그냥 "plan 없음" 으로 보인다 ([orchestration-ipc.ts:62](../../apps/desktop/electron/ipc/orchestration-ipc.ts:62)).

## 2. Feature flag 위치

[apps/desktop/electron/main.ts:113-119](../../apps/desktop/electron/main.ts:113)

```ts
// Phase 7 feature flag — defaults off per phase-07 spec.
const orchestrationEnabled =
  process.env.HARNESS_ORCHESTRATION_ENABLED === "1";
const orchestrationService = new OrchestrationService({
  state,
  enabled: orchestrationEnabled,
});
```

- 환경 변수: **`HARNESS_ORCHESTRATION_ENABLED`**
- 값: 정확히 문자열 `"1"` 일 때만 true
- 그 외 모든 값(미설정 포함)에서 false → assertEnabled가 항상 실패

## 3. 왜 기본값이 off 인가

근거: [docs/implementation/phase-07-optional-agent-orchestration.md:30](../implementation/phase-07-optional-agent-orchestration.md:30)

> "이 package는 Phase 7 전까지 만들지 않는다. Phase 7에서도 feature flag 기본값은 off다."

phase-07 spec의 비범위 절(같은 문서 7~13행)이 더 명시적이다:

- MVP 기본 경로로 CEO/pipeline을 활성화하지 않는다
- 숨겨진 inter-agent message queue를 복원하지 않는다
- 77종 에이전트 UX를 노출하지 않는다
- 사용자가 볼 수 없는 자동 Todo 생성/진행을 허용하지 않는다

다시 말해 orchestration은 **이전 ClaudeAgentSystem이 노출했던 통제 상실 문제를 반복하지 않기 위한 안전장치**로서 기본 off 가 의도된 상태. 활성화는 명시적 옵트인 결정이어야 한다.

## 4. 활성화했을 때 실제로 일어나는 일

### 4.1 draftPlan 동작 ([orchestration-planner.ts:39](../../packages/orchestration/src/orchestration-planner.ts:39))

1. `taskRun` 검증 (없으면 `ORCH_TASK_NOT_FOUND`)
2. mode 별 `WorkerStep[]` 합성 — **deterministic, AI 호출 없음**:

| mode | worker step 구성 |
|---|---|
| `single_worker` | 1단계: `coder` 가 요청 분석 + 결과 요약 |
| `planner_worker` | `planner` → `coder` (2단계) |
| `multi_worker` | `planner` → `coder` → `reviewer` → `tester` (4단계) |

3. `validatePlanShape` — 빈 plan / mode-step 수 불일치 / 금지 artifact kind 차단
4. `orchestration_plan` artifact 생성 (summary 안에 markdown + `<!-- orchestration-plan:json --> \`\`\`json ... \`\`\``)
5. `before_orchestration` checkpoint 생성
6. `actionType: "orchestration_plan"` approval (pending) 생성

### 4.2 runApproved 동작 ([worker-runner.ts:42](../../packages/orchestration/src/worker-runner.ts:42))

1. approval 상태/타입 검증 (`approved` 또는 `always_approved_for_run` 이어야 함)
2. plan 의 worker step 들을 순차 실행 — `runWorkerStepBody` 가 role 별 **하드코딩된 텍스트**를 반환:
   - planner: "Identify scope of change / Decompose into approval-bound actions"
   - coder: "No file writes performed; create approvals via conversation flow"
   - reviewer: "Verify tests cover changed paths / Confirm targetDir scope"
   - tester: "Run existing suite / Add a regression test for the failing path"
3. 각 step 마다 `kind: "log"` artifact 생성, step status 업데이트
4. 첫 실패 시 break

즉 현재 구현은 **실제 모델/agent 를 부르지 않는 placeholder**다. Phase 7 spec ([phase-07:38](../implementation/phase-07-optional-agent-orchestration.md:38))이 명시했듯 "Phase 7은 worker bodies를 deterministic으로 유지 — 실제 model invocation은 추후 `runWorkerStepBody` 를 갈아끼우는 식으로 도입".

## 5. 정책 보호장치 (활성화해도 유지되는 것)

[orchestration-policy.ts](../../packages/orchestration/src/orchestration-policy.ts)

| 보호 항목 | 위치 | 내용 |
|---|---|---|
| `FORBIDDEN_DIRECT_ACTIONS` | line 24 | shell, file_write, dependency_install, git_commit, network, skill_script — worker 가 직접 호출 불가 |
| `ALLOWED_WORKER_ARTIFACT_KINDS` | line 13 | worker 가 만들 수 있는 artifact kind 화이트리스트 |
| `validatePlanShape` | line 51 | mode/step 수 불일치, 빈 plan 거부 |
| `assertActionTypeAllowed` | line 76 | runtime 에서 worker 가 side-effecting action 을 요청하면 `ORCH_DIRECT_ACTION_BLOCKED` |

추가로 `RunnerService.executeApproved` 자체가 `orchestration_plan` action type 을 **block** 한다 ([runner-service.ts:138](../../packages/runners/src/runner-service.ts:138)). 즉 orchestration 의 approval 은 runner 가 아니라 `orchestration.runApproved` IPC 로만 실행된다.

## 6. 전체 호출 흐름

```
[UI] OrchestrationPanel
  └─ window.harness.orchestration.draftPlan({taskRunId, mode})
      │
[Preload] preload.ts:225-230
      │  IPC_CHANNELS.orchestration.draftPlan
      ▼
[Main] orchestration-ipc.ts:70-117
      │  service.draftPlan(payload)
      ▼
[Service] orchestration-service.ts:44
      │  this.assertEnabled()  ◄── ★ 여기서 throw 발생
      │  └─ deps.enabled = (env HARNESS_ORCHESTRATION_ENABLED === "1")
      │
      ▼ (enabled 인 경우)
      planner.draftPlan(input)
        ├─ taskRun 확인
        ├─ workerSteps 합성 (mode 별)
        ├─ validatePlanShape
        ├─ orchestration_plan artifact 생성
        ├─ checkpoint 생성
        └─ approval 생성 (actionType=orchestration_plan, status=pending)
```

## 7. 의존성 / 책임 분리

- `OrchestrationService` 는 `LocalStateService` 만 의존 (DB 게이트웨이)
- `model-cli-adapter` 와 **무관** — claude/codex CLI 가 없어도 orchestration 자체는 동작 (현재는 deterministic worker 라서)
- `AgentPlanningService`(Phase 8) 와도 별개 — 두 시스템은 같은 TaskRun 위에서 공존하지만 서로를 호출하지 않음

따라서 orchestration 을 켠다는 결정과 agent CLI 를 쓴다는 결정은 직교한다.

## 8. UI 측 동작

[OrchestrationPanel.tsx](../../apps/desktop/src/screens/workbench/OrchestrationPanel.tsx)

- 마운트 시 `getPlan` 호출 → `enabled=false` 면 IPC 가 `null` 반환 → 빈 패널이 보임
- "초안 생성" 버튼 누르면 `draftPlan` 호출 → `ORCHESTRATION_DISABLED` 에러를 message 로 표시 (`setError`)
- 즉 **UI 는 기능을 숨기지 않고 노출은 하되 실행만 막는** 형태. phase-07 spec 의 "advanced toggle 아래에 둔다"는 요구를 완전히 충족하진 않음 — 패널이 항상 보임.

## 9. 활성화 시 알려진 trade-off

| 항목 | 영향 |
|---|---|
| 기본 흐름 | 변경 없음. 일반 conversation/agent 흐름과 독립 |
| 보안 | policy 가 worker 의 side effect 차단. runner-service 가 orchestration_plan action type 도 차단 |
| 실제 가치 | **현재 worker body 는 하드코딩 텍스트** — agent 결과 품질 향상 없음. 학습/검증 목적 외에는 효용이 제한적 |
| 사용자 통제 | 매 step 가 artifact 로 timeline 에 기록됨. 자동 진행은 plan approval 한 번 받은 후 4단계까지 수행 (multi_worker 의 경우) |
| 회귀 위험 | 낮음. test 가 single_worker / planner_worker / multi_worker 의 step 카운트와 정책 위반을 모두 검증 |

## 10. 활성화 방법 (분석 목적의 기록)

지금 구조상 두 가지 경로가 있다. **본 문서는 구현 변경을 하지 않는다는 점을 다시 강조**한다.

### Option A: 환경 변수로 1회성 활성화

Electron 을 다음과 같이 실행:

```powershell
$env:HARNESS_ORCHESTRATION_ENABLED = "1"
npm --workspace apps/desktop run dev
```

또는 단발 실행:

```powershell
$env:HARNESS_ORCHESTRATION_ENABLED = "1"; & node_modules/.bin/electron .
```

장점: 코드 변경 없이 즉시 토글. 비활성화로 복귀하기 쉬움.
단점: 사용자가 매번 env 를 켜야 함. 일반 클릭으로 켜기 불가능.

### Option B: 사용자 설정으로 승격

[settings.ts](../../packages/core/src/types/settings.ts) 의 `HarnessSettings` 에 `orchestration: { enabled: boolean }` 추가하고, `main.ts:113` 에서 env 대신 settings 를 읽도록 변경. SettingsPanel UI 에서 toggle.

장점: 사용자 친화적, GUI 토글, 영구 기억.
단점: schema/IPC 변경 동반. phase-07 의 "기본값은 계속 off" 원칙을 유지하려면 default false 보장 필요.

### Option C: 부분 활성화 — getPlan 만 항상 허용

조회는 항상 허용하고, draftPlan/runApproved 만 flag 게이트. 사실 `getPlan` 은 이미 그렇게 동작 ([orchestration-ipc.ts:62](../../apps/desktop/electron/ipc/orchestration-ipc.ts:62)) — 추가 변경 없음.

## 11. 결론

- 에러는 **버그가 아니라 phase-07 의 명시적 설계**다. orchestration 은 기본 off, 환경변수로 옵트인.
- 활성화 즉시 동작은 하지만 현재 worker 본체가 deterministic placeholder 이므로 실제 LLM agent orchestration 의 가치는 아직 없다. Phase 7 spec ([phase-07:131](../implementation/phase-07-optional-agent-orchestration.md:131))이 "기본값은 계속 off로 둔다" 고 한 이유 중 하나.
- 사용자가 학습/검증 목적으로 plan 흐름(`draftPlan` → approval → `runApproved` → worker artifacts)을 보고 싶다면 환경변수 활성화로 충분. 일반 사용 흐름에서는 키지 않는 게 spec 의도.

## 12. 추후 결정해야 할 사항 (참고)

- worker body 를 실제 agent CLI 호출(예: claude `--resume` 으로 thread session 활용)로 갈아끼울지
- orchestration mode 를 settings 로 승격할지, 영구히 env 토글로 둘지
- UI 에서 패널 자체를 advanced toggle 뒤로 숨길지 (phase-07:80 요구사항)
- multi_worker 의 4단계가 일반 agent 의 단일 응답보다 실제로 더 나은 결과를 내는지 — 실측 비교 필요
