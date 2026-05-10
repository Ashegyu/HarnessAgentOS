# IPC Contracts

## 목적

이 문서는 React renderer와 Electron main process 사이의 public IPC 계약을 고정한다. Renderer는 이 문서에 정의된 `window.harness` API만 호출한다.

## 공통 규칙

- raw `ipcRenderer`는 노출하지 않는다.
- 모든 method는 Promise를 반환한다.
- 모든 input은 main process에서 schema 검증한다.
- 모든 오류는 `HarnessError` 형태로 normalize한다.
- renderer는 SQL, filesystem path operation, shell command 실행을 직접 요청할 수 없다. 반드시 domain method를 사용한다.
- Main IPC handler 내부는 `HarnessResult<T>`를 사용할 수 있지만, preload는 `ok: true`면 `value`를 resolve하고 `ok: false`면 `HarnessError`를 throw한다. 따라서 renderer-facing 계약은 이 문서처럼 raw `Promise<T>`로 유지한다.

## 공통 타입

IPC public type의 단일 source of truth는 이 문서다. 구현 단계에서 `packages/core`에 타입을 만들 때는 이 섹션을 그대로 옮기고, 이후 변경은 이 문서와 core 타입을 함께 갱신한다.

```ts
export interface HarnessError {
  code: string;
  message: string;
  details?: unknown;
}

export type TaskRunStatus =
  | "drafting"
  | "waiting_for_approval"
  | "running"
  | "paused"
  | "blocked"
  | "quality_failed"
  | "ready_for_review"
  | "done"
  | "cancelled";

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "always_approved_for_run";
export type ApprovalScope = "once" | "run_action_class";
export type ApprovalActionType =
  | "file_write"
  | "shell"
  | "dependency_install"
  | "git_commit"
  | "network"
  | "skill_script"
  | "orchestration_plan";
export type ArtifactKind = "plan" | "diff" | "log" | "test_result" | "quality_report" | "orchestration_plan" | "file" | "snapshot";

export interface TaskRun {
  id: string;
  threadId: string;
  userRequest: string;
  targetDir: string;
  status: TaskRunStatus;
  currentStepId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Step {
  id: string;
  taskRunId: string;
  index: number;
  kind: "inspect" | "plan" | "approval" | "edit" | "shell" | "test" | "quality_gate" | "summarize";
  title: string;
  status: StepStatus;
  inputSummary?: string;
  outputSummary?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface Checkpoint {
  id: string;
  taskRunId: string;
  stepId: string;
  reason: "before_edit" | "before_shell" | "after_failure" | "before_commit" | "before_orchestration" | "manual";
  stateRef: string;
  summary: string;
  createdAt: string;
}

export interface Approval {
  id: string;
  taskRunId: string;
  checkpointId: string;
  actionType: ApprovalActionType;
  actionSummary: string;
  status: ApprovalStatus;
  decisionMessage?: string;
  decidedAt?: string;
}

export interface Artifact {
  id: string;
  taskRunId: string;
  stepId?: string;
  kind: ArtifactKind;
  title: string;
  uri: string;
  summary?: string;
  createdAt: string;
}

export interface Capability {
  id: string;
  source: "builtin" | "skillify" | "imported_skill";
  name: string;
  description: string;
  triggerTerms: string[];
  riskLevel: "low" | "medium" | "high";
  requiresApproval: boolean;
}

export interface CapabilitySuggestion {
  capability: Capability;
  score: number;
  reason: string;
  matchedTerms: string[];
}

export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  sourceDir: string;
  riskLevel: "low" | "medium" | "high";
  allowedActions: string[];
  triggerTerms: string[];
  trusted: boolean;
}

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
  status: StepStatus;
}

export interface RepairPlanDraft {
  taskRun: TaskRun;
  planArtifact: Artifact;
  checkpoint: Checkpoint;
  approvals: Approval[];
}
```
## `window.harness.app`

```ts
app.getVersion(): Promise<string>;
app.getRuntimeInfo(): Promise<RuntimeInfo>;
/** Returns null when the user cancels the dialog. */
app.selectDirectory(): Promise<string | null>;
```

```ts
interface RuntimeInfo {
  platform: string;
  appDataDir: string;
  documentsDir?: string;
}
```

오류:

- `APP_RUNTIME_UNAVAILABLE`

## `window.harness.state`

```ts
state.listThreads(): Promise<Thread[]>;
state.getThread(input: { threadId: string }): Promise<ThreadDetail>;
state.createThread(input: { title: string; targetDir?: string }): Promise<Thread>;
```

```ts
interface Thread {
  id: string;
  title: string;
  targetDir?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

interface ThreadDetail {
  thread: Thread;
  taskRuns: TaskRun[];
}
```

오류:

- `STATE_THREAD_NOT_FOUND`
- `STATE_INVALID_INPUT`
- `STATE_DB_ERROR`

## `window.harness.conversation`

```ts
conversation.createTask(input: CreateConversationTaskInput): Promise<ConversationTaskDraft>;
conversation.redirectTask(input: { taskRunId: string; instruction: string }): Promise<ConversationTaskDraft>;
conversation.approve(input: { approvalId: string; message?: string; scope?: ApprovalScope }): Promise<Approval>;
conversation.rejectApproval(input: { approvalId: string; message: string }): Promise<Approval>;
conversation.setProposedAction(input: { approvalId: string; details: ProposedActionDetails }): Promise<Approval>;
conversation.getTaskRunDetail(input: { taskRunId: string }): Promise<TaskRunDetail>;
conversation.pauseTask(input: { taskRunId: string }): Promise<TaskRun>;
conversation.resumeTask(input: { taskRunId: string }): Promise<TaskRun>;
conversation.cancelTask(input: { taskRunId: string; reason: string }): Promise<TaskRun>;
```

상태 전이 규칙:

- `pauseTask`: `running` 또는 `waiting_for_approval`에서만 허용 → `paused`. 그 외는 `CONVERSATION_INVALID_STATE`.
- `resumeTask`: `paused`에서만 허용. pending approval 존재 시 `waiting_for_approval`, currentStep 존재 시 `running`, 둘 다 없으면 `CONVERSATION_NOTHING_TO_RESUME`.
- `cancelTask`: 비종료 상태에서만 허용. 사유 누락 시 `CONVERSATION_REASON_REQUIRED`. pending approval 자동 거절 + `quality_report` 아티팩트 기록 후 `cancelled`.

```ts
interface CreateConversationTaskInput {
  threadId?: string;
  userRequest: string;
  targetDir?: string;
}

interface ConversationTaskDraft {
  taskRun: TaskRun;
  planArtifact: Artifact;
  checkpoint: Checkpoint;
  approvals: Approval[];
}
```

오류:

- `CONVERSATION_EMPTY_REQUEST`
- `CONVERSATION_INVALID_TARGET_DIR`
- `CONVERSATION_TASK_NOT_FOUND`
- `CONVERSATION_INVALID_STATE`
- `CONVERSATION_NOTHING_TO_RESUME`
- `CONVERSATION_REASON_REQUIRED`
- `APPROVAL_NOT_FOUND`
- `APPROVAL_MESSAGE_REQUIRED`

## `window.harness.runner`

```ts
runner.executeApproved(input: { approvalId: string }): Promise<RunnerResult>;
runner.listArtifacts(input: { taskRunId: string }): Promise<Artifact[]>;
runner.readArtifact(input: { artifactId: string }): Promise<{ artifact: Artifact; content: string }>;
runner.retryApproval(input: { approvalId: string }): Promise<RunnerResult>;
```

> `retryApproval`은 부모 TaskRun이 `blocked`/`quality_failed`일 때만 허용 (그 외는 `RUNNER_RETRY_NOT_BLOCKED`). 가장 최근 approved approval로 `executeApproved`와 같은 멱등 경로를 재실행한다.

```ts
interface RunnerResult {
  id: string;
  taskRunId: string;
  stepId: string;
  commandSummary: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  changedFiles?: string[];
  artifactIds: string[];
  startedAt: string;
  finishedAt: string;
}
```

오류:

- `RUNNER_APPROVAL_REQUIRED`
- `RUNNER_APPROVAL_REJECTED`
- `RUNNER_TARGET_OUTSIDE_WORKSPACE`
- `RUNNER_BLOCKED_HIGH_RISK`
- `RUNNER_EXECUTION_FAILED`
- `RUNNER_RETRY_NOT_BLOCKED`
- `ARTIFACT_NOT_FOUND`

## `window.harness.quality`

```ts
quality.evaluate(input: QualityGateInput): Promise<QualityGateResult>;
quality.getLatest(input: { taskRunId: string }): Promise<QualityGateResult | null>;
quality.approveKnownRisks(input: { taskRunId: string; message: string }): Promise<TaskRun>;
quality.createRepairPlan(input: { taskRunId: string; instruction?: string }): Promise<RepairPlanDraft>;
quality.markReadyForReview(input: { taskRunId: string }): Promise<TaskRun>;
quality.markDone(input: { taskRunId: string }): Promise<TaskRun>;
```

`markDone` 정책 (`TaskRunCompletionService.markDone` 기준):

- `passed` 게이트 → 항상 허용
- `warning` 게이트 → `kind="quality_report"`이고 URI가 `/<gate.id>`로 끝나는 known-risk 승인 아티팩트가 있을 때만 허용. (canonical artifact kind는 `quality_report` 하나이며, URI suffix로 일반 quality 보고서와 known-risk 승인을 구분한다 — `quality.approveKnownRisks`가 `harness:quality/<taskRunId>/<gate.id>` URI로 작성한다.)
- `failed`/`not_run` → 거부 (`QUALITY_DONE_BLOCKED`)
- 성공 시 LearningTrace `recordOutcome`이 IPC 계층에서 자동 갱신된다 (renderer는 별도 호출 불필요).

```ts
interface QualityGateInput {
  taskRunId: string;
  requireBuild?: boolean;
  requireTests?: boolean;
  requireSmoke?: boolean;
}

interface QualityGateResult {
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

오류:

- `QUALITY_TASK_NOT_FOUND`
- `QUALITY_EVIDENCE_MISSING`
- `QUALITY_RISK_MESSAGE_REQUIRED`
- `QUALITY_DONE_BLOCKED`

## `window.harness.capability`

```ts
capability.list(): Promise<Capability[]>;
capability.refresh(): Promise<Capability[]>;
capability.suggest(input: { taskRunId: string; prompt: string }): Promise<CapabilitySuggestion[]>;
capability.readSkill(input: { capabilityId: string }): Promise<{
  capability: Capability;
  instructions: string;
  resources: { scripts: string[]; templates: string[]; examples: string[] };
}>;
capability.proposeScriptRun(input: { capabilityId: string; taskRunId: string; scriptName: string }): Promise<Approval>;
```

오류:

- `CAPABILITY_NOT_FOUND`
- `CAPABILITY_UNTRUSTED_SKILL`
- `CAPABILITY_SCRIPT_NOT_FOUND`
- `CAPABILITY_SCRIPT_REQUIRES_APPROVAL`

## `window.harness.learner`

```ts
interface LearnerRecommendation {
  id: string;
  recommendedModel?: string;
  recommendedCapabilities: CapabilitySuggestion[];
  rationale: string;
  costHint?: "low" | "medium" | "high";
  latencyHint?: "low" | "medium" | "high";
  confidence: number;
}

learner.getTrace(input: { taskRunId: string }): Promise<LearningTrace | null>;
learner.recommend(input: { taskRunId: string }): Promise<LearnerRecommendation>;
learner.recordDecision(input: {
  taskRunId: string;
  recommendationId: string; // LearnerRecommendation.id
  decision: "accepted" | "rejected";
  reason?: string;
}): Promise<void>;
```

오류:

- `LEARNER_TRACE_NOT_FOUND`
- `LEARNER_RECOMMENDATION_NOT_FOUND`
- `LEARNER_INVALID_DECISION`

## `window.harness.orchestration`

Phase 7 전까지 feature flag off다.

```ts
orchestration.getPlan(input: { taskRunId: string }): Promise<OrchestrationPlan | null>;
orchestration.draftPlan(input: { taskRunId: string; mode: "single_worker" | "planner_worker" | "multi_worker"; instruction?: string }): Promise<{
  plan: OrchestrationPlan;
  artifact: Artifact;
  approval: Approval;
}>;
orchestration.runApproved(input: { approvalId: string }): Promise<OrchestrationRunResult>;
```

> Plan approval은 별도 메서드 없이 `conversation.approve` 흐름을 그대로 사용한다(approval action_type=`orchestration_plan`). 사용자가 approve 처리한 뒤 `runApproved`로 worker step 실행을 트리거한다.

오류:

- `ORCHESTRATION_DISABLED`
- `ORCHESTRATION_PLAN_NOT_FOUND`
- `ORCHESTRATION_APPROVAL_REQUIRED`

## `window.harness.events`

단방향 main → renderer push. `invoke`가 아니라 `ipcRenderer.on` 기반이며, 이 namespace에는 현재 한 채널만 둔다 — 임의 상태/페이로드를 broadcast하지 않는다.

```ts
events.onTaskRunChanged(
  listener: (payload: { taskRunId: string }) => void,
): () => void; // unsubscribe
```

발생 조건:

- 모든 state-changing IPC 핸들러(`conversation.*`, `runner.executeApproved/retryApproval`, `quality.*`, `orchestration.draftPlan/runApproved`)가 성공 직후 발행한다.
- 페이로드는 `{ taskRunId }` 한 필드뿐이며, renderer가 `getTaskRunDetail`을 다시 호출해 fresh 상태를 가져온다(채널 자체로 도메인 객체를 전달하지 않음).
- read-only IPC (예: `quality.getLatest`, `state.listThreads`)는 발행하지 않는다.

규칙:

- 새 push 채널을 추가하기 전에 이 문서를 먼저 갱신한다.
- preload는 `ipcRenderer`를 직접 노출하지 않고 `onXxx(cb): () => void` 형태로만 expose한다.
- listener는 unsubscribe를 컴포넌트 unmount 시 반드시 호출한다.

## Contract 변경 규칙

- IPC method 추가 시 이 문서를 먼저 갱신한다.
- 기존 method의 input/output을 breaking change로 바꾸면 migration note를 남긴다.
- renderer에 임시 channel string 호출을 추가하지 않는다.



