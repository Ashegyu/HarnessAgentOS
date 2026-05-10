# Phase 07 - Optional Agent Orchestration

## 목표

기존 ClaudeAgentSystem의 CEO/pipeline 아이디어를 Harness OS 통제 아래의 고급 옵션으로 재도입할 수 있는 조건을 정의한다. 완료되면 agent orchestration은 기본 경로를 우회하지 않고, checkpoint/approval/quality gate를 반드시 통과해야 한다.

## 비범위

- MVP 기본 경로로 CEO/pipeline을 활성화하지 않는다.
- 숨겨진 inter-agent message queue를 복원하지 않는다.
- 77종 에이전트 UX를 노출하지 않는다.
- agent 자기 보고로 done 처리하지 않는다.
- 사용자가 볼 수 없는 자동 Todo 생성/진행을 허용하지 않는다.

## 구현 단위

```text
packages/orchestration/src/
  orchestration-types.ts
  orchestration-planner.ts
  worker-runner.ts
  orchestration-policy.ts
  orchestration-trace.ts
apps/desktop/electron/ipc/orchestration-ipc.ts
apps/desktop/src/screens/workbench/
  OrchestrationPanel.tsx
  WorkerStepView.tsx
```

이 package는 Phase 7 전까지 만들지 않는다. Phase 7에서도 feature flag 기본값은 off다.

## 주요 타입과 인터페이스

```ts
export interface OrchestrationPlan {
  id: string;
  taskRunId: string;
  mode: "single_worker" | "planner_worker" | "multi_worker";
  workerSteps: WorkerStep[];
  requiresApproval: true;
}

export interface WorkerStep {
  id: string;
  title: string;
  role: "planner" | "coder" | "reviewer" | "tester";
  inputSummary: string;
  expectedArtifactKinds: string[];
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
}
```

IPC:

```ts
orchestration.draftPlan(input: { taskRunId: string; mode: OrchestrationPlan["mode"] }): Promise<OrchestrationPlan>;
orchestration.approvePlan(input: { planId: string }): Promise<Approval>;
orchestration.runApproved(input: { approvalId: string }): Promise<RunnerResult>;
```

## 데이터 흐름

```text
User selects advanced orchestration
  -> OrchestrationPlanner drafts plan
  -> plan is saved as `orchestration_plan` artifact
  -> before_orchestration checkpoint created
  -> approval pending
  -> user approves
  -> worker steps execute one by one
  -> each worker output becomes artifact
  -> file/shell side effects still create normal approvals
  -> quality gate runs at the end
```

중요: worker가 내부적으로 파일 수정이나 shell 실행을 제안해도 Phase 3의 Runner/Approval 정책을 우회할 수 없다.

## UI 요구사항

- 기본 화면에서는 숨기거나 advanced toggle 아래에 둔다.
- 선택 가능한 mode는 `single_worker`, `planner_worker`, `multi_worker`로 제한한다.
- 각 worker step의 입력, 기대 artifact, 상태를 표시한다.
- worker 간 메시지를 숨기지 않고 artifact/timeline에 요약 표시한다.
- 중단, 재시도, skip을 TaskRun timeline과 연결한다.

## 보안/승인 정책

- orchestration plan 자체가 approval 대상이다.
- worker는 직접 file/shell runner를 호출할 수 없다. Harness Core를 통해 approval을 생성해야 한다.
- agent output은 신뢰된 실행 결과가 아니라 제안 또는 artifact로 취급한다.
- high risk action은 orchestration mode에서도 동일하게 차단한다.
- final done은 Quality Gate와 사용자 final approval을 거친다.

## 테스트 계획

Unit:

- orchestration policy가 direct runner 호출을 막는지.
- worker step status transition.
- orchestration plan validation.

Integration:

- draft plan -> artifact -> checkpoint -> approval 흐름.
- approved orchestration이 worker artifact를 만든다.
- worker가 file_write를 요청하면 별도 approval이 생성된다.
- quality gate 우회 시도 차단.

UI smoke:

- advanced orchestration toggle.
- worker timeline 표시.
- orchestration plan approval 표시.

Manual acceptance:

- orchestration을 켜도 사용자가 중간에 개입할 수 있다.
- worker가 무엇을 했는지 artifact로 볼 수 있다.
- 완료는 Harness quality gate가 담당한다.

## 완료 기준

- orchestration은 기본 경로가 아니다.
- orchestration plan과 worker output은 artifact로 보인다.
- checkpoint/approval/quality gate를 우회하지 않는다.
- 숨겨진 Todo 진행이 없다.
- 기존 ClaudeAgentSystem의 문제였던 사용자 통제 상실을 반복하지 않는다.

## 다음 Phase 인계

Phase 7 이후에는 실제 사용 기록을 바탕으로 orchestration mode를 유지할지, 단일 worker + skill/capability 구조로 충분한지 결정한다. 기본값은 계속 off로 둔다.




