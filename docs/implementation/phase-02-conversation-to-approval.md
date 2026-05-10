# Phase 02 - Conversation To Approval

## 목표

사용자 대화 입력을 추적 가능한 `TaskRun`으로 바꾸고, 실행 전 계획과 승인 대기 상태를 만든다. 완료되면 사용자는 요청을 입력하고, HarnessOS가 계획 artifact와 `before_edit` checkpoint를 만들며, 파일 수정 전 approval pending 상태를 볼 수 있어야 한다.

## 비범위

- 실제 파일 수정은 Phase 3에서 한다.
- shell/test runner 실행은 Phase 3에서 한다.
- 품질 게이트는 Phase 4에서 한다.
- Skillify/Learner 추천은 placeholder만 허용하고 실제 연결은 Phase 5/6에서 한다.
- 자동 CEO/pipeline routing은 도입하지 않는다.

## 구현 단위

```text
packages/core/src/conversation/
  conversation-service.ts
  target-dir.ts
  plan-drafter.ts
  approval-policy.ts
apps/desktop/electron/ipc/conversation-ipc.ts
apps/desktop/src/screens/workbench/
  ConversationInput.tsx
  TaskRunTimeline.tsx
  ApprovalPanel.tsx
  PlanArtifactView.tsx
```

`PlanDrafter`는 MVP에서 deterministic template 기반으로 시작한다. 모델 호출이 있더라도 파일 수정 전 단계까지만 사용하고, side effect는 만들지 않는다.

## 주요 타입과 인터페이스

```ts
export interface CreateConversationTaskInput {
  threadId?: string;
  userRequest: string;
  targetDir?: string;
}

export interface ConversationTaskDraft {
  taskRun: TaskRun;
  planArtifact: Artifact;
  checkpoint: Checkpoint;
  approvals: Approval[];
}

export type ApprovalScope = "once" | "run_action_class";

export type ApprovalActionType =
  | "file_write"
  | "shell"
  | "dependency_install"
  | "git_commit"
  | "network"
  | "skill_script"
  | "orchestration_plan";

export interface ProposedAction {
  type: ApprovalActionType;
  summary: string;
  riskLevel: "low" | "medium" | "high";
  requiresApproval: true;
}
```

IPC:

```ts
conversation.createTask(input: CreateConversationTaskInput): Promise<ConversationTaskDraft>;
conversation.redirectTask(input: { taskRunId: string; instruction: string }): Promise<ConversationTaskDraft>;
conversation.rejectApproval(input: { approvalId: string; message: string }): Promise<Approval>;
conversation.approve(input: { approvalId: string; message?: string; scope?: ApprovalScope }): Promise<Approval>;
```

## 데이터 흐름

```text
User submits prompt
  -> renderer calls conversation.createTask
  -> main validates input and targetDir
  -> Thread created or loaded
  -> TaskRun status = drafting
  -> Step inspect created/succeeded with summary
  -> Step plan created/succeeded
  -> Plan artifact saved
  -> Checkpoint reason = before_edit
  -> Approval rows created for proposed side effects
  -> TaskRun status = waiting_for_approval
  -> renderer shows plan + approval buttons
```

Reject/redirect:

```text
User rejects approval with reason
  -> approval.status = rejected
  -> TaskRun status = paused
  -> redirect instruction can create a new plan Step
  -> new plan artifact/checkpoint/approval replaces current pending action
```

## UI 요구사항

- Conversation input은 Enter submit, Shift+Enter newline을 지원한다.
- targetDir 표시와 변경 버튼을 둔다.
- submit 중 중복 입력을 방지한다.
- 계획 제목, 요약, 예상 변경 영역을 표시한다.
- proposed action을 action card로 표시한다.
- `승인`, `거절`, `수정 지시` 버튼을 둔다.
- 거절 시 이유 입력은 필수다.
- 승인 전에는 실행 버튼을 노출하지 않는다.
- Timeline에는 `Inspect`, `Plan`, `Approval` step을 표시한다.

## 보안/승인 정책

- `targetDir`는 절대경로로 normalize한다.
- 존재하지 않는 경로는 TaskRun 생성 전에 막는다.
- MVP에서는 targetDir 내부만 허용한다.
- 모델이 제안한 action은 실행하지 않고 approval row로만 저장한다.
- Renderer는 plan artifact를 수정할 수 없다. redirect instruction만 보낼 수 있다.

## 테스트 계획

Unit:

- targetDir normalization/validation.
- plan drafter가 side effect 없이 artifact content를 생성하는지.
- approval policy가 file_write/shell에 approval을 요구하는지.

Integration:

- conversationCreateTask가 TaskRun, Step, Artifact, Checkpoint, Approval을 한 transaction으로 만든다.
- invalid targetDir에서 아무 row도 남기지 않는다.
- reject 후 status가 paused가 된다.
- redirect 후 새 plan artifact와 approval이 생성된다.

UI smoke:

- prompt 입력 후 plan과 approval panel이 보인다.
- 승인/거절/수정 지시 버튼 상태가 맞다.
- targetDir 오류가 inline으로 표시된다.

Manual acceptance:

- 실제 파일은 수정되지 않는다.
- 사용자는 실행 전 무엇이 제안됐는지 볼 수 있다.
- 거절 이유가 기록된다.

## 완료 기준

- 대화 입력이 TaskRun으로 저장된다.
- 계획 artifact가 생성된다.
- `before_edit` checkpoint가 생성된다.
- approval pending 상태가 UI에 표시된다.
- approval 전 side effect가 없다.
- 사용자가 reject/redirect를 할 수 있다.

## 다음 Phase 인계

Phase 3은 Phase 2가 만든 approved action을 실제 runner로 실행한다. Phase 2는 approval row에 실행에 필요한 action summary와 type을 안정적으로 저장해야 한다.






