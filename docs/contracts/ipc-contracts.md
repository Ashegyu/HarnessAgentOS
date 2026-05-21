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
export type ApprovalStatus = "pending" | "approved" | "rejected" | "always_approved_for_run" | "executed";
export type ApprovalScope = "once" | "run_action_class";
export type ApprovalActionType =
  | "capability_use"
  | "model_use"
  | "file_write"
  | "shell"
  | "dependency_install"
  | "git_commit"
  | "network"
  | "skill_script"
  | "orchestration_plan";
export type AutoApproveStep =
  | "blocked_action"
  | "policy_blocked"
  | "budget_blocked"
  | "profile_auto_approve"
  | "policy_disallow_auto"
  | "worker_file_action"
  | "global_toggle";
export type ArtifactKind = "plan" | "diff" | "log" | "test_result" | "quality_report" | "orchestration_plan" | "file" | "snapshot";
export type PolicyDecision = "allowed" | "confirm" | "blocked";
export type PolicyOperation =
  | { kind: "approval_action"; actionType: ApprovalActionType }
  | { kind: "read_operation"; name: "read" | "list" | "inspect" }
  | { kind: "path_violation"; name: "target_outside_workspace" | "path_traversal" }
  | { kind: "remote_side_effect"; name: "git_push" | "remote_agent_write" };

export interface PolicyEvaluation {
  operation: PolicyOperation;
  decision: PolicyDecision;
  riskLevel: "low" | "medium" | "high" | "blocked";
  allowAutoApprove: boolean;
  reason: string;
  costEstimateUsd?: number;
  budgetDecision?: {
    kind: "allow" | "blocked";
    reason?: string;
    scope?: "per_invocation" | "per_task_run" | "per_day";
    costEstimateUsd?: number;
    accumulatedCostUsd?: number;
    limitUsd?: number;
  };
}

export interface AutoApproveDecision {
  approved: boolean;
  decidedAt: AutoApproveStep;
  reason: string;
}

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
  policyEvaluation?: PolicyEvaluation;
  autoApproveDecision?: AutoApproveDecision | null;
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
  /** Conditional runtime edges. Not part of dependsOn DAG validation. */
  backflowRules?: WorkerBackflowRule[];
  requiresApproval: true;
  sourcePipelineId?: string;
}

export interface WorkerStep {
  id: string;
  title: string;
  role:
    | "planner"
    | "coder"
    | "reviewer"
    | "tester"
    | "orchestrator"
    | "security-reviewer"
    | "build-error-resolver"
    | "refactor-cleaner"
    | "performance-reviewer";
  inputSummary: string;
  instruction?: string;
  expectedArtifactKinds: string[];
  status: StepStatus;
  agentProfileId?: string;
  remoteEndpointId?: string;
  dependsOn?: string[];
  allowedActions?: ApprovalActionType[];
  outputContract?: "plan" | "diff_proposal" | "review" | "test_result";
}

export type PipelineBackflowTrigger = "step_failed" | "quality_failed";

export interface AgentPipelineBackflowRule {
  id: string;
  trigger: PipelineBackflowTrigger;
  targetStepId: string;
  retryStepId: string;
  maxAttempts: number; // 1..5
  instruction?: string;
}

export interface WorkerBackflowRule {
  id: string;
  trigger: PipelineBackflowTrigger;
  targetStepId: string;
  retryStepId: string;
  maxAttempts: number; // 1..5
  instruction?: string;
}

export type PipelineBackflowAttemptStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "max_attempts_reached";

export type PipelineBackflowEventType =
  | "triggered"
  | "target_started"
  | "target_succeeded"
  | "retry_started"
  | "retry_succeeded"
  | "failed"
  | "max_attempts_reached";

export interface PipelineBackflowAttempt {
  id: string;
  taskRunId: string;
  planId: string;
  ruleId: string;
  trigger: PipelineBackflowTrigger;
  targetStepId: string;
  retryStepId: string;
  maxAttempts: number;
  attemptIndex: number;
  status: PipelineBackflowAttemptStatus;
  reason?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface PipelineBackflowEvent {
  id: string;
  taskRunId: string;
  threadId: string;
  threadTitle: string;
  taskRunUserRequest: string;
  taskRunStatus: TaskRunStatus;
  attemptId: string;
  ruleId: string;
  trigger: PipelineBackflowTrigger;
  targetStepId: string;
  retryStepId: string;
  attemptIndex: number;
  eventType: PipelineBackflowEventType;
  status: PipelineBackflowAttemptStatus;
  summary: string;
  reason?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AgentPipelineStep {
  id: string;
  agentProfileId: string;
  remoteEndpointId?: string;
  title: string;
  instruction: string;
  expectedArtifactKinds: ArtifactKind[];
  /** Missing means legacy linear dependency on the previous step. */
  dependsOn?: string[];
  /** Missing preserves legacy proposal behavior; [] makes the step read-only. */
  allowedActions?: ApprovalActionType[];
  /** Missing means the planner applies the role default. */
  outputContract?: "plan" | "diff_proposal" | "review" | "test_result";
}

export interface RepairPlanDraft {
  taskRun: TaskRun;
  planArtifact: Artifact;
  checkpoint: Checkpoint;
  approvals: Approval[];
}

export type RepairAttemptStatus =
  | "planned"
  | "waiting_for_approval"
  | "executed"
  | "passed"
  | "failed"
  | "stopped";

export interface RepairAttempt {
  id: string;
  taskRunId: string;
  qualityGateId: string;
  attemptIndex: number;
  failureSignature: string;
  status: RepairAttemptStatus;
  invocationId?: string;
  generatedApprovalIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type A2ARefinementStatus =
  | "pending_approval"
  | "queued"
  | "running"
  | "input_required"
  | "auth_required"
  | "succeeded"
  | "failed"
  | "stopped"
  | "cancelled";

export type A2ARefinementFeedbackSourceKind =
  | "user"
  | "quality_gate"
  | "worker"
  | "system";

export type A2ARefinementStopReason =
  | "max_attempts_for_signature"
  | "max_attempts_for_task_run"
  | "repeated_feedback_signature"
  | "endpoint_unavailable"
  | "context_rejected_by_endpoint"
  | "missing_remote_task_ref"
  | "user_cancelled"
  | "auth_required"
  | "input_required";

export interface A2ARefinementAttempt {
  id: string;
  taskRunId: string;
  targetInvocationId: string;
  endpointId: string;
  feedbackSourceKind: A2ARefinementFeedbackSourceKind;
  feedbackSourceStepId?: string;
  feedbackSourceInvocationId?: string;
  feedbackArtifactId?: string;
  qualityGateId?: string;
  parentRemoteTaskId?: string;
  parentRemoteContextId?: string;
  remoteTaskId?: string;
  remoteContextId?: string;
  referenceTaskIds: readonly string[];
  referenceArtifactIds: readonly string[];
  feedbackSignature: string;
  attemptIndex: number;
  status: A2ARefinementStatus;
  stopReason?: A2ARefinementStopReason;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type A2ARefinementProposalSourceKind =
  | "worker_finding"
  | "quality_gate";

export interface A2ARefinementProposal {
  id: string;
  sourceKind: A2ARefinementProposalSourceKind;
  taskRunId: string;
  targetInvocationId: string;
  endpointId: string;
  feedbackSourceKind: A2ARefinementFeedbackSourceKind;
  feedbackSourceStepId?: string;
  feedbackSourceInvocationId?: string;
  feedbackArtifactId?: string;
  qualityGateId?: string;
  instruction: string;
  referencedArtifactIds: readonly string[];
  sourceLabel: string;
  targetLabel: string;
  reason: string;
}

export type A2ARefinementActivityEventType =
  | "created"
  | "started"
  | "succeeded"
  | "failed"
  | "stopped"
  | "cancelled"
  | "input_required"
  | "auth_required";

export interface A2ARefinementActivityEvent {
  id: string;
  taskRunId: string;
  threadId: string;
  threadTitle: string;
  taskRunUserRequest: string;
  taskRunStatus: TaskRunStatus;
  attemptId: string;
  targetInvocationId: string;
  endpointId: string;
  feedbackSourceKind: A2ARefinementFeedbackSourceKind;
  attemptIndex: number;
  eventType: A2ARefinementActivityEventType;
  status: A2ARefinementStatus;
  summary: string;
  parentRemoteTaskId?: string;
  parentRemoteContextId?: string;
  remoteTaskId?: string;
  remoteContextId?: string;
  stopReason?: A2ARefinementStopReason;
  referenceArtifactIds: readonly string[];
  payload: Record<string, unknown>;
  createdAt: string;
}
```

`LocalStateService.createApproval` attaches a default `policyEvaluation` for every
new `approval_action` when the caller does not supply one. The default decision is
`confirm`; `dependency_install`, `network`, `git_commit`, `skill_script`, and
`orchestration_plan` are marked `allowAutoApprove=false`, so global auto approval
cannot approve them unless a narrower profile-level policy explicitly permits it.
`decision=blocked` approvals are refused by the runner even if their status is
manually changed to `approved`.

## `window.harness.app`

```ts
app.getVersion(): Promise<string>;
app.getRuntimeInfo(): Promise<RuntimeInfo>;
app.getDiagnostics(): Promise<SystemDiagnostics>;
/** Returns null when the user cancels the dialog. */
app.selectDirectory(): Promise<string | null>;
/** Returns null when the user cancels the dialog. */
app.selectFile(input?: { defaultDir?: string }): Promise<string | null>;
```

```ts
interface RuntimeInfo {
  platform: string;
  appDataDir: string;
  documentsDir?: string;
}

interface SystemDiagnostics {
  generatedAt: string;
  thresholds: { dbWarnBytes: number; queueDepthWarn: number };
  db: {
    mainBytes: number;
    walBytes: number;
    shmBytes: number;
    totalBytes: number;
    walCheckpoint: { busy: number; log: number; checkpointed: number };
    status: "ok" | "warning" | "error";
    warning?: string;
  };
  queue: {
    claude: number;
    codex: number;
    total: number;
    status: "ok" | "warning" | "error";
    warning?: string;
  };
  providers: {
    status: "ok" | "warning" | "error";
    items: AgentProviderStatusMap;
    warning?: string;
  };
  runner: {
    inflightCount: number;
    status: "ok" | "warning" | "error";
  };
}
```

오류:

- `APP_RUNTIME_UNAVAILABLE`

## `window.harness.state`

```ts
state.listThreads(): Promise<Thread[]>;
state.getThread(input: { threadId: string }): Promise<ThreadDetail>;
state.createThread(input: {
  title: string;
  targetDir?: string;
  pipelineId?: string;
}): Promise<Thread>;
state.deleteThread(input: { threadId: string }): Promise<void>;
state.exportDbSnapshot(input: { targetPath: string }): Promise<ExportApprovalResult>;
state.exportThreadMarkdown(input: {
  threadId: string;
  targetPath: string;
}): Promise<ExportApprovalResult>;
```

```ts
interface Thread {
  id: string;
  title: string;
  targetDir?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  agentSessionId?: string;
  pipelineId?: string;
}

interface ThreadDetail {
  thread: Thread;
  taskRuns: TaskRun[];
  agentAnswers?: Record<string, string>;
}

interface ExportApprovalResult {
  thread: Thread;
  taskRun: TaskRun;
  checkpoint: Checkpoint;
  approval: Approval;
  targetPath: string;
}
```

오류:

- `STATE_THREAD_NOT_FOUND`
- `STATE_INVALID_INPUT`
- `STATE_DB_ERROR`

`state.exportDbSnapshot`와 `state.exportThreadMarkdown`는 파일을 즉시 쓰지 않고
`file_write` approval을 생성한다. 승인 후 `runner.executeApproved`가
DB snapshot은 `VACUUM INTO ?`, thread markdown은 승인 payload의 `filePatch`로
실제 파일 쓰기를 수행한다.

## `window.harness.conversation`

```ts
conversation.createTask(input: CreateConversationTaskInput): Promise<ConversationTaskDraft>;
conversation.redirectTask(input: { taskRunId: string; instruction: string }): Promise<ConversationTaskDraft>;
conversation.approve(input: { approvalId: string; message?: string; scope?: ApprovalScope; autoApproveDecision?: AutoApproveDecision | null }): Promise<Approval>;
conversation.rejectApproval(input: { approvalId: string; message: string }): Promise<Approval>;
conversation.setProposedAction(input: { approvalId: string; details: ProposedActionDetails }): Promise<Approval>;
conversation.getTaskRunDetail(input: { taskRunId: string }): Promise<TaskRunDetail>;
conversation.listDecisions(input: DecisionLogInput): Promise<DecisionLogPage>;
conversation.listRefinementEvents(input: A2ARefinementActivityInput): Promise<A2ARefinementActivityPage>;
conversation.listBackflowEvents(input: PipelineBackflowActivityInput): Promise<PipelineBackflowActivityPage>;
conversation.pauseTask(input: { taskRunId: string }): Promise<TaskRun>;
conversation.resumeTask(input: { taskRunId: string }): Promise<TaskRun>;
conversation.cancelTask(input: { taskRunId: string; reason: string }): Promise<TaskRun>;
conversation.deleteTask(input: { taskRunId: string }): Promise<void>;
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
  /**
   * Conversation mode:
   * - "template" (default): deterministic plan-drafter — creates plan / before_edit
   *   checkpoint / approvals immediately and flips TaskRun to `waiting_for_approval`.
   * - "agent": Phase 8 CLI-backed planner — creates a placeholder step/checkpoint/
   *   plan artifact and leaves the TaskRun in `drafting` until `agent.generatePlan`
   *   produces the real plan and approvals.
   */
  mode?: "template" | "agent";
}

interface ConversationTaskDraft {
  taskRun: TaskRun;
  planArtifact: Artifact;
  checkpoint: Checkpoint;
  approvals: Approval[];
}

interface TaskRunDetail {
  taskRun: TaskRun;
  steps: Step[];
  artifacts: Artifact[];
  checkpoints: Checkpoint[];
  approvals: Approval[];
  qualityGates: QualityGateResult[];
  repairAttempts: RepairAttempt[];
  /**
   * Phase 8 — agent CLI invocations associated with this TaskRun.
   * Empty for template-mode TaskRuns. The renderer uses the latest entry to
   * render the inline AgentPanel/AgentStreamView.
   */
  agentInvocations: AgentInvocation[];
  /**
   * Remote A2A task refs keyed by AgentInvocation.id, included on the same
   * fresh-detail pull so the renderer does not poll remote state separately.
   */
  a2aRemoteTaskRefs: A2ARemoteTaskRef[];
  /**
   * Harness-owned A2A refinement/backflow attempt ledger rows for this TaskRun.
   * A refinement row is audit evidence; remote output is never promoted to a
   * local side effect without the existing approval flow.
   */
  a2aRefinementAttempts: A2ARefinementAttempt[];
  /**
   * Pipeline conditional backflow attempt ledger rows for this TaskRun.
   * These are pipeline-runtime reruns, not A2A remote refinement attempts.
   */
  pipelineBackflowAttempts: PipelineBackflowAttempt[];
  /**
   * Read-only targeted A2A refinement proposals derived from worker/quality
   * evidence. Creating one still goes through `agent.requestRefinement`.
   */
  a2aRefinementProposals: A2ARefinementProposal[];
  /**
   * Persisted spend totals used by renderer-side auto-approve budget gates.
   * Empty or missing means callers should treat both totals as zero.
   */
  budgetUsage?: {
    accumulatedTaskRunCostUsd: number;
    accumulatedDailyCostUsd: number;
    isoDate: string;
  };
}

interface DecisionLogInput {
  limit: number; // 1..100, Activity Log uses 50
  offset: number;
  filter?: {
    decidedAtSteps?: AutoApproveStep[];
    actionTypes?: ApprovalActionType[];
    sinceIso?: string;
    untilIso?: string;
  };
}

interface DecisionLogPage {
  items: Array<{
    approval: Approval & {
      autoApproveDecision: AutoApproveDecision;
      decidedAt: string;
    };
    threadId: string;
    threadTitle: string;
    taskRunId: string;
    taskRunUserRequest: string;
    taskRunStatus: TaskRunStatus;
  }>;
  total: number;
  limit: number;
  offset: number;
  hasNext: boolean;
}

type A2ARefinementActivityEventType =
  | "created"
  | "started"
  | "succeeded"
  | "failed"
  | "stopped"
  | "cancelled"
  | "input_required"
  | "auth_required";

interface A2ARefinementActivityEvent {
  id: string;
  taskRunId: string;
  threadId: string;
  threadTitle: string;
  taskRunUserRequest: string;
  taskRunStatus: TaskRunStatus;
  attemptId: string;
  targetInvocationId: string;
  endpointId: string;
  feedbackSourceKind: A2ARefinementFeedbackSourceKind;
  attemptIndex: number;
  eventType: A2ARefinementActivityEventType;
  status: A2ARefinementStatus;
  summary: string;
  parentRemoteTaskId?: string;
  parentRemoteContextId?: string;
  remoteTaskId?: string;
  remoteContextId?: string;
  stopReason?: A2ARefinementStopReason;
  referenceArtifactIds: readonly string[];
  payload: Record<string, unknown>;
  createdAt: string;
}

interface A2ARefinementActivityInput {
  limit: number; // 1..100, Activity Log uses 25 for A2A rows
  offset: number;
  sinceIso?: string;
  untilIso?: string;
}

interface A2ARefinementActivityPage {
  items: A2ARefinementActivityEvent[];
  total: number;
  limit: number;
  offset: number;
  hasNext: boolean;
}

interface PipelineBackflowActivityInput {
  limit: number; // 1..100, Activity Log uses 25 for backflow rows
  offset: number;
  sinceIso?: string;
  untilIso?: string;
}

interface PipelineBackflowActivityPage {
  items: PipelineBackflowEvent[];
  total: number;
  limit: number;
  offset: number;
  hasNext: boolean;
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
runner.cancelExecution(input: { taskRunId: string }): Promise<{ cancelled: boolean }>;
runner.listArtifacts(input: { taskRunId: string }): Promise<Artifact[]>;
runner.readArtifact(input: { artifactId: string }): Promise<{ artifact: Artifact; content: string }>;
runner.retryApproval(input: { approvalId: string }): Promise<RunnerResult>;
```

> `retryApproval`은 부모 TaskRun이 `blocked`/`quality_failed`일 때만 허용 (그 외는 `RUNNER_RETRY_NOT_BLOCKED`). 가장 최근 approved approval로 `executeApproved`와 같은 멱등 경로를 재실행한다.
> `cancelExecution`은 현재 실행 중인 RunnerService 작업이 있을 때만 `{ cancelled: true }`를 반환하고 해당 TaskRun의 AbortSignal을 중단한다. 존재하지 않거나 실행 중이 아닌 `taskRunId`는 throw하지 않고 `{ cancelled: false }`를 반환한다.

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
- `RUNNER_CANCELLED`
- `ARTIFACT_NOT_FOUND`

## `window.harness.shadow`

```ts
shadow.createPreview(input: { approvalId: string }): Promise<ShadowPreview>;
```

`shadow.createPreview`는 `file_write` approval 전용 preview 경로다. 임시
shadow workspace에 제안된 파일 내용을 쓰고 `diff`/`snapshot` artifact를
남기지만 `TaskRun.targetDir`에는 쓰지 않는다. 실제 workspace 변경은 기존
`runner.executeApproved` 경로로만 수행한다.

```ts
interface ShadowPreview {
  id: string;
  taskRunId: string;
  approvalId: string;
  targetDir: string;
  relativePath: string;
  shadowPath: string;
  baselineHash?: string;
  artifactIds: string[];
  createdAt: string;
}
```

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
capability.proposeCandidates(input: { taskRunId: string; prompt: string }): Promise<{
  suggestions: CapabilitySuggestion[];
  approvals: Approval[];
  skipped: CapabilitySuggestion[];
}>;
capability.readSkill(input: { capabilityId: string }): Promise<{
  capability: Capability;
  instructions: string;
  resources: {
    scripts: string[];
    templates: string[];
    examples: string[];
    references: string[];
  };
}>;
capability.proposeScriptRun(input: { capabilityId: string; taskRunId: string; scriptName: string }): Promise<Approval>;
```

동작:

- `suggest`는 TaskRun userRequest + 추가 prompt를 기준으로 triggerTerms를 매칭한다.
- `proposeCandidates`는 매칭된 trusted capability를 `capability_use` approval로 자동 큐잉한다. 이 approval은 runner 실행 대상이 아니며, 승인된 후보만 이후 agent prompt의 Skill 컨텍스트로 들어간다.
- `proposeScriptRun`은 script 실행 요청을 바로 실행하지 않고 `skill_script` approval을 만든다.

오류:

- `CAPABILITY_NOT_FOUND`
- `CAPABILITY_UNTRUSTED_SKILL`
- `CAPABILITY_SCRIPT_NOT_FOUND`
- `CAPABILITY_SCRIPT_REQUIRES_APPROVAL`
- `CAPABILITY_SCRIPT_TRAVERSAL` — script 경로가 skill sourceDir 밖으로 escape

## `window.harness.learner`

```ts
interface LearnerRecommendation {
  id: string;
  recommendedModel?: string;
  estimatedCostUsd?: number;
  recommendedCapabilities: CapabilitySuggestion[];
  rationale: string;
  costHint?: "low" | "medium" | "high";
  latencyHint?: "low" | "medium" | "high";
  confidence: number;
}

interface TaskRunCostSummary {
  taskRunId: string;
  totalCostUsd: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalTokens?: number;
  knownTokenInvocationCount?: number;
  unknownTokenInvocationCount?: number;
  totalLatencyMs: number;
  invocationCount: number;
  perModel: Array<{
    model: string;
    cost: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    knownTokenInvocationCount?: number;
    unknownTokenInvocationCount?: number;
    latencyMs: number;
    count: number;
  }>;
  invocations: Array<{
    id: string;
    model: string;
    cost: number;
    costKnown?: boolean;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    usageApproximate?: boolean;
    latencyMs: number;
    success?: boolean;
    createdAt: string;
  }>;
  budget?: {
    profileId: string;
    profileName: string;
    limits: {
      perInvocationUsd?: number;
      perTaskRunUsd?: number;
      perDayUsd?: number;
    };
    progress: Array<{
      scope: "per_invocation" | "per_task_run" | "per_day";
      label: string;
      usedUsd: number;
      limitUsd: number;
      ratio: number;
      exceeded: boolean;
    }>;
    isoDate: string;
  };
}

interface BudgetUsageSummary {
  sinceIso: string;
  untilIso: string;
  todayIso: string;
  days: number;
  todayCostUsd: number;
  windowCostUsd: number;
  averageDailyCostUsd: number;
  todayTokens?: number;
  windowTokens?: number;
  averageDailyTokens?: number;
  knownTokenInvocationCount?: number;
  unknownTokenInvocationCount?: number;
  profiles: Array<{
    profileId: string;
    profileName: string;
    model: string;
    budget?: {
      perInvocationUsd?: number;
      perTaskRunUsd?: number;
      perDayUsd?: number;
    };
    todayCostUsd: number;
    windowCostUsd: number;
    averageDailyCostUsd: number;
    todayTokens?: number;
    windowTokens?: number;
    averageDailyTokens?: number;
    knownTokenInvocationCount?: number;
    unknownTokenInvocationCount?: number;
    dailyBudgetRatio?: number;
    daily: Array<{
      dateIso: string;
      totalCostUsd: number;
      totalInputTokens?: number;
      totalOutputTokens?: number;
      totalTokens?: number;
      knownTokenInvocationCount?: number;
      unknownTokenInvocationCount?: number;
      count: number;
    }>;
  }>;
  topModels: Array<{
    model: string;
    totalCostUsd: number;
    totalInputTokens?: number;
    totalOutputTokens?: number;
    totalTokens?: number;
    knownTokenInvocationCount?: number;
    unknownTokenInvocationCount?: number;
    invocationCount: number;
  }>;
}

learner.getTrace(input: { taskRunId: string }): Promise<LearningTrace | null>;
learner.summarizeTaskRunCost(input: {
  taskRunId: string;
}): Promise<TaskRunCostSummary>;
learner.summarizeBudgetUsage(input?: {
  days?: number;
  profileId?: string;
}): Promise<BudgetUsageSummary>;
learner.recommend(input: { taskRunId: string }): Promise<LearnerRecommendation>;
learner.proposeRecommendation(input: {
  taskRunId: string;
}): Promise<{
  recommendation: LearnerRecommendation;
  approvals: Approval[];
  skipped: Array<{
    kind: "model" | "capability";
    id: string;
    reason: string;
  }>;
}>;
learner.recordSelection(input: {
  taskRunId: string;
  selectedModel?: string;
  selectedCapabilities?: string[];
}): Promise<LearningTrace>;
learner.recordOutcome(input: {
  taskRunId: string;
  latencyMs?: number;
  costEstimate?: number;
  success?: boolean;
  failureReason?: string;
}): Promise<LearningTrace>;
learner.recordDecision(input: {
  taskRunId: string;
  recommendationId: string; // LearnerRecommendation.id
  decision: "accepted" | "rejected";
  reason?: string;
}): Promise<void>;
```

`recordSelection`은 user/policy가 모델·capability를 골랐을 때 호출되어 LearningTrace의 `selectedModel`/`selectedCapabilities`를 갱신한다.
`recordOutcome`은 `quality.markDone` 성공 직후 IPC 계층이 자동 호출하므로 renderer가 명시적으로 부르는 일은 드물지만, 외부 통합용으로 노출되어 있다.
`proposeRecommendation`은 현재 TaskRun의 trace 기반 추천을 approval 후보로 올린다. 추천 모델은 `model_use`, 추천 capability는 `capability_use` approval이 되며 둘 다 runner 실행 대상이 아니다. 승인된 `model_use`만 다음 `agent.generatePlan` 호출의 모델 override로 반영된다.

오류:

- `LEARNER_TASK_NOT_FOUND`
- `LEARNER_TRACE_NOT_FOUND`
- `LEARNER_RECOMMENDATION_NOT_FOUND`
- `LEARNER_INVALID_DECISION`

## `window.harness.topology`

Agent Framework adoption Phase 6 — Skill metadata, LearningTrace, and active Instinct rows are combined into read-only AgentPipeline topology recommendations. The namespace does not create pipeline rows, approvals, TaskRuns, or artifacts.

```ts
interface TopologyRecommendation {
  id: string;
  taskRunId: string;
  title: string;
  description: string;
  confidence: number;
  rationale: string;
  warnings: string[];
  source: {
    capabilityIds: string[];
    instinctIds: string[];
    traceIds: string[];
    templatePipelineIds: string[];
  };
  steps: Array<{
    step: AgentPipelineStep;
    rationale: string;
    sourceCapabilityIds: string[];
    sourceInstinctIds: string[];
  }>;
  pipelineDraft: CreateAgentPipelineInput;
}

topology.recommend(input: {
  taskRunId: string;
  maxCandidates?: number; // clamped to 0..3
}): Promise<TopologyRecommendation[]>;
topology.recordFeedback(input: {
  taskRunId: string;
  recommendationId: string;
  decision: "applied" | "dismissed";
  reason?: string;
}): Promise<void>;
```

동작:

- `recommend`는 TaskRun의 userRequest를 기준으로 capability triggerTerms를 매칭하고, Skill metadata의 trusted/risk/action 정보를 읽기 전용으로 참고한다.
- untrusted Skill metadata는 추천 source에서 제외하고 `warnings`에 남긴다. SKILL.md 본문, scripts, templates는 읽지 않는다.
- active Instinct는 `targetDir`에서 파생한 projectKey + global scope 기준으로 읽고, 관련 role score와 rationale에만 반영한다.
- LearningTrace는 긍정 reward가 있는 과거 capability 선택을 추천 신뢰도와 source trace로 반영한다.
- 결과의 `pipelineDraft.steps`는 `dependsOn`, `allowedActions`, `outputContract`를 명시한다. 이 값은 draft일 뿐이며, 저장은 `pipeline.create/update`, 실행은 `orchestration.draftPlan` + `orchestration_plan` approval을 계속 사용한다.
- `recordFeedback`은 추천 적용/무시 행동을 `source="learner"` observation으로 남긴다. generic `recordObservation` IPC는 만들지 않으며, 추천 결과 자체를 canonical DB row로 저장하지도 않는다.

오류:

- `TOPOLOGY_TASK_NOT_FOUND`
- `STATE_INVALID_INPUT`

## `window.harness.instinct`

Agent Framework adoption Phase 4 — repeated approval/quality signals are recorded internally by main-process services. The renderer can review candidates and manage approved instincts, but it cannot call `recordObservation` directly.

```ts
interface Observation {
  id: string;
  taskRunId?: string;
  threadId?: string;
  projectKey?: string;
  source: "approval" | "quality" | "learner" | "runner" | "skill" | "agent";
  eventType: string;
  signal: string;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface EvolutionCandidate {
  id: string;
  projectKey?: string;
  title: string;
  proposedRule: string;
  rationale: string;
  confidence: number;
  status: "pending" | "approved" | "rejected" | "stale";
  observationIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface Instinct {
  id: string;
  projectKey?: string;
  scope: "global" | "project" | "thread";
  title: string;
  rule: string;
  rationale: string;
  confidence: number;
  status: "active" | "disabled" | "rejected";
  sourceObservationIds: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

instinct.list(input?: {
  projectKey?: string;
  includeDisabled?: boolean;
}): Promise<Instinct[]>;
instinct.listCandidates(input?: {
  projectKey?: string;
}): Promise<EvolutionCandidate[]>;
instinct.approveCandidate(input: {
  candidateId: string;
  message?: string;
}): Promise<Instinct>;
instinct.rejectCandidate(input: {
  candidateId: string;
  message: string;
}): Promise<EvolutionCandidate>;
instinct.disable(input: {
  instinctId: string;
  reason: string;
}): Promise<Instinct>;
```

동작:

- `conversation.approve` / `conversation.rejectApproval`은 승인 결정을 저장한 뒤 advisory observation을 남긴다. observation 기록 실패는 approval 성공을 막지 않는다.
- `quality.evaluate`는 QualityGate 적용 후 advisory observation을 남긴다. `not_run`은 기록하지 않는다.
- candidate 생성은 approval/quality observation 직후 내부 observer가 수행하며, 같은 observation set + proposedRule 후보를 중복 생성하지 않는다.
- `listCandidates`는 pending 후보를 조회만 한다.
- `approveCandidate`는 `EvolutionCandidate`를 `approved`로 전환하고 같은 rule을 active `Instinct`로 만든다.
- `rejectCandidate`와 `disable`은 후보/instinct 상태만 변경한다. 후보 자체를 다시 observation으로 기록하지 않는다.
- observation 수집 API는 public IPC가 아니다.

오류:

- `INSTINCT_CANDIDATE_NOT_FOUND`
- `INSTINCT_CANDIDATE_INVALID_STATE`
- `INSTINCT_NOT_FOUND`
- `STATE_INVALID_INPUT`

## `window.harness.orchestration`

Phase 7 전까지 feature flag off다.

```ts
orchestration.getPlan(input: { taskRunId: string }): Promise<OrchestrationPlan | null>;
orchestration.draftPlan(input: {
  taskRunId: string;
  mode: "single_worker" | "planner_worker" | "multi_worker";
  instruction?: string;
  pipelineId?: string;
}): Promise<{
  plan: OrchestrationPlan;
  artifact: Artifact;
  approval: Approval;
}>;
orchestration.runApproved(input: { approvalId: string }): Promise<OrchestrationRunResult>;
```

> Plan approval은 별도 메서드 없이 `conversation.approve` 흐름을 그대로 사용한다(approval action_type=`orchestration_plan`). 사용자가 approve 처리한 뒤 `runApproved`로 worker step 실행을 트리거한다.

오류:

- `ORCHESTRATION_DISABLED` — feature flag off 상태에서 draftPlan/runApproved 호출
- `ORCHESTRATION_PLAN_NOT_FOUND` — 복구할 orchestration_plan artifact를 찾지 못함
- `ORCHESTRATION_APPROVAL_REQUIRED` — approval이 존재하지 않거나 approved 상태가 아님
- `ORCHESTRATION_APPROVAL_TYPE_MISMATCH` — approval.actionType이 `orchestration_plan`이 아님
- `ORCHESTRATION_INVALID_PLAN` — `mode`가 허용 enum이 아님
- `ORCHESTRATION_TASK_NOT_FOUND` — taskRunId 미존재
- `ORCHESTRATION_DIRECT_ACTION_BLOCKED` — worker가 approval 게이트를 우회하려 시도

## `window.harness.agent`

Phase 8 — CLI 기반 agent planner. `conversation.createTask({mode: "agent"})`로 생성된 TaskRun에 대해 `generatePlan`을 호출하면 `claude` 또는 `codex` CLI가 main process에서 실행되어 plan artifact와 0..N approval row를 만든다. agent는 절대 파일을 직접 쓰지 않으며, 모든 side effect는 기존 approval 흐름을 통과한다.

```ts
agent.checkProviders(): Promise<AgentProviderStatusMap>;
agent.generatePlan(input: {
  taskRunId: string; // must be a TaskRun created with mode="agent"
  provider?: AgentProvider;
  model?: string;
  instruction?: string;
}): Promise<{
  invocation: AgentInvocation;
  planArtifact: Artifact;
  approvals: Approval[]; // 0 allowed for answer-only responses
}>;
agent.cancelInvocation(input: { invocationId: string }): Promise<AgentInvocation>;
agent.retryInvocation(input: { invocationId: string }): Promise<{
  invocation: AgentInvocation;
  planArtifact: Artifact;
  approvals: Approval[];
}>;
agent.useTemplateFallback(input: { taskRunId: string }): Promise<{
  planArtifact: Artifact;
  approvals: Approval[];
}>;
agent.requestRefinement(input: {
  taskRunId: string;
  targetInvocationId: string;
  feedbackSourceKind: "user" | "quality_gate" | "worker" | "system";
  feedbackSourceStepId?: string;
  feedbackSourceInvocationId?: string;
  feedbackArtifactId?: string;
  qualityGateId?: string;
  instruction: string;
  referencedArtifactIds: string[];
}): Promise<{
  attempt: A2ARefinementAttempt;
  approval: Approval; // actionType="network", pending until the operator approves
}>;
```

`agent.requestRefinement`은 즉시 원격 네트워크 요청을 실행하지 않는다. 먼저
`A2ARefinementAttempt(status="pending_approval")`와 `network` approval을 만들고,
승인 후 `runner.executeApproved({ approvalId })`가 checkpoint `stateRef`의
`a2aRefinementAttemptId`를 확인한 경우에만 전용 A2A refinement executor를
실행한다. 일반 `network` approval은 기존 runner 정책대로 계속 차단된다.
`TaskRunDetail.a2aRefinementProposals`는 read-only 후보 목록이며, renderer가
후보를 선택하면 같은 `agent.requestRefinement` 계약으로 pending approval을
생성한다.
`conversation.listRefinementEvents`는 refinement attempt의 Activity Log
전용 감사 이벤트를 반환한다. `created`, `started`, terminal 상태 이벤트는
관찰용이며 이벤트 조회 자체는 원격 호출이나 runner 실행을 유발하지 않는다.

```ts
type AgentProvider = "claude" | "codex";

interface AgentProviderProbe {
  available: boolean;
  version?: string;
  error?: string;
  /**
   * In-process FIFO depth for this provider (waiting + in-flight).
   * Surfaced so RuntimeStatusBar can show queue pressure without a new
   * push channel. Refreshed every `agent.checkProviders()` call.
   */
  queueDepth: number;
}

interface AgentProviderStatusMap {
  claude: AgentProviderProbe;
  codex: AgentProviderProbe;
}

interface AgentInvocation {
  id: string;
  taskRunId: string;
  stepId?: string;
  provider: AgentProvider;
  model: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  promptArtifactId: string;
  rawOutputArtifactId?: string;
  parsedPlanArtifactId?: string;
  errorCode?: string;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  latencyMs?: number;
  costEstimate?: number;
  createdAt: string;
  updatedAt: string;
}
```

`generatePlan` 정책:

- TaskRun이 `drafting` 또는 `blocked`(재시도) 상태일 때만 허용. 다른 상태는 `AGENT_MODE_MISMATCH`.
- provider 미설치 시 `AGENT_PROVIDER_UNAVAILABLE`. UI는 deterministic template fallback을 권장한다.
- CLI 출력의 fenced JSON 블록(`harness_agent_plan`)을 파싱한다. 실패 시 `AGENT_INVALID_OUTPUT`.
- 각 `proposedActions[i]`는 기존 `validateProposedActionDetails` 게이트(절대경로/`..`/NUL 차단)를 통과해야 approval row가 만들어진다. 통과 못 한 항목은 drop되고 `quality_report` artifact에 사유가 기록된다 (filter, not all-or-nothing).
- `proposedActions.length === 0` → TaskRun을 `ready_for_review`로 (answer-only 경로).
- `proposedActions.length > 0` → TaskRun을 `waiting_for_approval`로.
- prompt/raw_output artifact는 저장 직전 `redactSecrets`로 마스킹된다.

오류:

- `AGENT_SPAWN_FAILED` — CLI 바이너리 미설치/권한
- `AGENT_CANCELLED` — 사용자 cancel
- `AGENT_STALL` — stallTimeoutMs 동안 출력 없음
- `AGENT_TIMEOUT` — timeoutMs 초과
- `AGENT_INVALID_OUTPUT` — JSON 또는 스키마 위반
- `AGENT_RATE_LIMITED` — provider rate limit
- `AGENT_PROVIDER_UNAVAILABLE` — provider probe 실패 / 환경 미인증
- `AGENT_PROPOSED_ACTION_INVALID` — path traversal 등 정책 차단
- `AGENT_INVOCATION_NOT_FOUND` — invocationId 미존재
- `AGENT_INVOCATION_BUSY` — 같은 invocation이 큐에 남아있거나 실행 중인 상태에서 retry/fallback 시도 — `cancelInvocation` 먼저 호출 필요
- `AGENT_TASK_RUN_NOT_FOUND` — taskRunId 미존재
- `AGENT_MODE_MISMATCH` — TaskRun이 agent mode가 아니거나 적절한 상태가 아님

## `window.harness.settings`

전역 Harness 설정을 읽고 저장한다. 설정은 SQLite canonical state에 저장되며,
renderer는 settings 객체를 직접 파일로 쓰지 않는다.

```ts
settings.get(): Promise<HarnessSettings>;
settings.update(input: HarnessSettings): Promise<HarnessSettings>;
```

주요 필드:

- `agent`: legacy single-agent fallback 설정
- `orchestration`: orchestration enable/default mode/default pipeline 설정
- `approval`: auto approval 편의 설정. 실제 실행 가능 여부는 service-layer `PolicyEvaluation`이 최종 결정한다.
- `activeAgentProfileId`: 새 TaskRun에 사용할 active AgentProfile id

## `window.harness.evals`

Phase 16 eval 결과 조회용 read-only namespace다. Renderer는 markdown report 파일,
SQLite DB, attempt artifact 경로를 직접 열지 않고 main process가 반환한 DTO만 사용한다.

```ts
type EvalRunSuite = "capability" | "regression" | "safety" | "all";
type EvalRunStatus = "running" | "passed" | "failed" | "partial";

interface EvalRunListFilters {
  suite?: EvalRunSuite;
  status?: EvalRunStatus;
  limit?: number;
}

interface EvalRunListItem {
  id: string;
  suite: EvalRunSuite;
  status: EvalRunStatus;
  mode?: string;
  startedAt: string;
  finishedAt: string | null;
  harnessSha: string | null;
  caseCount: number;
  attemptCount: number;
  passedAttempts: number;
  passRate: number;
  totalTokens: number;
  totalDurationMs: number;
}

interface EvalRunCaseView {
  caseId: string;
  title: string;
  suite: "capability" | "regression" | "safety";
  provider?: "claude" | "codex";
  outcome: "passed" | "failed" | "partial";
  attemptCount: number;
  passedAttempts: number;
  passAt3: number;
  passToThe3: number;
  totalTokens: number;
  totalDurationMs: number;
}

interface EvalRunDetailView {
  run: EvalRunListItem;
  cases: EvalRunCaseView[];
}

interface EvalCostTrendFilters {
  suite?: EvalRunSuite;
  limit?: number;
  baselineWindow?: number;
}

interface EvalCostTrendPoint {
  runId: string;
  startedAt: string;
  suite: EvalRunSuite;
  mode: "fake" | "real" | "head_to_head" | "judge" | "production_latency" | "unknown";
  totalTokens: number;
  totalDurationMs: number;
  passRate: number;
  estimatedCostUsd?: number;
}

interface EvalCostTrendWarning {
  kind: "tokens_increase" | "duration_increase" | "pass_rate_drop";
  runId: string;
  observed: number;
  baseline: number;
  threshold: number;
  message: string;
}

interface EvalCostTrendView {
  points: EvalCostTrendPoint[];
  warnings: EvalCostTrendWarning[];
  baselineRunCount: number;
}

type RuntimeLatencyKind =
  | "task_run_to_ready"
  | "approval_to_runner_finished"
  | "agent_invocation_to_first_token"
  | "agent_invocation_to_final_result"
  | "quality_evaluation_to_gate";

interface RuntimeLatencyFilters {
  limit?: number;
}

interface RuntimeLatencySummary {
  kind: RuntimeLatencyKind;
  count: number;
  p50Ms: number;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number;
}

evals.listRuns(input?: EvalRunListFilters): Promise<EvalRunListItem[]>;
evals.getRun(input: { runId: string }): Promise<EvalRunDetailView>;
evals.getCostTrend(input?: EvalCostTrendFilters): Promise<EvalCostTrendView>;
evals.getRuntimeLatencySummary(input?: RuntimeLatencyFilters): Promise<RuntimeLatencySummary[]>;
```

동작:

- `listRuns`는 최근 eval run을 SQLite canonical state에서 조회한다. `limit`은 main process에서 1..100으로 제한한다.
- `getRun`은 summary_json을 renderer-safe detail DTO로 변환한다. raw filesystem path, raw artifact content, process handle은 반환하지 않는다.
- `getCostTrend`는 최근 run의 tokens, duration, pass rate를 summary_json에서 계산한다. USD 비용은 provider pricing을 확정하지 않은 경우 반환하지 않는다.
- `getRuntimeLatencySummary`는 기존 `agent_invocations.latency_ms` row에서 agent final latency summary를 계산한다. p95는 20개 이상, p99는 100개 이상 표본이 있을 때만 반환한다.
- 이 namespace는 read-only다. eval 실행은 기존 `scripts/eval/run.mjs` CLI와 npm script가 담당한다.

오류:

- `EVAL_RUN_NOT_FOUND`
- `STATE_INVALID_INPUT`

## `window.harness.agents`

AgentProfile CRUD. renderer는 plaintext secret을 이 namespace로 읽지 않는다.
CLI 환경 secret은 `cli.envSecretRefs`에 SecretVault key로만 저장한다.

```ts
agents.list(): Promise<AgentProfile[]>;
agents.get(input: { profileId: string }): Promise<AgentProfile>;
agents.create(input: {
  profile: Omit<AgentProfile, "id" | "createdAt" | "updatedAt">;
}): Promise<AgentProfile>;
agents.update(input: { profile: AgentProfile }): Promise<AgentProfile>;
agents.delete(input: { profileId: string }): Promise<void>;
agents.setDefault(input: { profileId: string }): Promise<AgentProfile>;
agents.setActive(input: { profileId: string | null }): Promise<HarnessSettings>;
```

동작:

- `setDefault`는 exactly-one default profile 규칙을 유지한다.
- `setActive(null)`은 active profile override를 해제하고 default profile fallback으로 돌아간다.
- profile permissions는 approval UI 자동화보다 우선하는 block/allow context로 사용된다.
- profile permissions의 optional `budget`은 per-invocation / per-TaskRun / per-day USD 자동 승인 상한으로 사용된다. `agent_profiles.budget_json`이 NULL이면 무제한이다.

## `window.harness.mcp`

MCP server registry. plaintext secret은 반환하지 않으며, main process가 spawn/probe
시점에 SecretVault에서 복호화한다.

```ts
mcp.list(): Promise<McpServerConfig[]>;
mcp.generateServerDraft(input: { request: McpServerGenerationRequest }): Promise<McpServerGenerationPreviewResult>;
mcp.generateServerScaffoldDraft(input: { request: McpServerScaffoldGenerationRequest }): Promise<McpServerScaffoldPreviewResult>;
mcp.proposeServerScaffold(input: { draft: GeneratedMcpServerScaffoldDraft }): Promise<McpServerScaffoldProposalResult>;
mcp.generateProfileBindingProposal(input: { request: McpServerBindingProposalRequest }): Promise<McpServerBindingProposalResult>;
mcp.applyProfileBindingProposal(input: { request: McpServerBindingProposalRequest }): Promise<McpServerBindingApplyResult>;
mcp.upsert(input: { server: McpServerConfig }): Promise<McpServerConfig>;
mcp.delete(input: { serverId: string }): Promise<void>;
mcp.toggle(input: { serverId: string; enabled: boolean }): Promise<McpServerConfig>;
mcp.healthCheck(input: { serverId: string }): Promise<McpServerHealth>;
```

동작:

- `upsert`는 `server.id`가 기존 row와 매칭되면 update, 아니면 create로 동작한다.
- `generateServerDraft`는 저장/파일쓰기/probe 없이 사용자 의도에서 MCP 서버 초안과 preview warning만 생성한다.
- `generateServerScaffoldDraft`는 저장/파일쓰기/probe 없이 TypeScript stdio MCP scaffold 파일 후보를 생성한다. 생성 후보에는 stdout logging lint, TypeScript build, stdio MCP initialize smoke test가 포함된다.
- `proposeServerScaffold`는 scaffold 파일별 pending `file_write` approval을 만들며, approval/runner 실행 전에는 파일을 쓰지 않는다.
- `generateProfileBindingProposal`은 저장된 MCP 서버와 AgentProfile을 읽어 binding diff만 반환하며, AgentProfile row를 수정하지 않는다.
- `applyProfileBindingProposal`은 같은 diff를 재계산한 뒤 `AgentProfile.mcpServerIds`만 갱신한다. global scope 서버는 no-op으로 남긴다.
- `envSecretRefs`가 있는 서버는 referenced SecretVault key가 존재하지 않으면 `enabled=true` 저장, `toggle(... enabled=true)`, `healthCheck`를 거부한다. disabled draft 저장은 허용한다.
- sanitized Claude MCP config key가 이미 enabled 서버와 충돌하면 `enabled=true` 저장 또는 `toggle(... enabled=true)`를 거부한다. disabled draft 저장은 허용한다.
- `healthCheck`는 renderer가 직접 process/network probe를 하지 않도록 main process handler로 격리한다.

## `window.harness.skillSource`

신뢰 가능한 SKILL.md root를 등록하고 CapabilityRegistry refresh를 트리거한다.

```ts
skillSource.list(): Promise<SkillSource[]>;
skillSource.add(input: { name: string; rootDir: string }): Promise<SkillSource>;
skillSource.update(input: { source: SkillSource }): Promise<SkillSource>;
skillSource.remove(input: { sourceId: string }): Promise<void>;
skillSource.refresh(input: { sourceId: string }): Promise<SkillSourceRefreshResult>;
skillSource.generateSkillDraft(input: { request: SkillGenerationRequest }): Promise<SkillGenerationPreviewResult>;
skillSource.previewSkillDraft(input: { draft: SkillAuthorDraft }): Promise<SkillAuthorPreview>;
skillSource.proposeSkillFile(input: { draft: SkillAuthorDraft }): Promise<SkillFileProposalResult>;
skillSource.generateProfileBindingProposal(input: { request: SkillProfileBindingProposalRequest }): Promise<SkillProfileBindingProposalResult>;
skillSource.applyProfileBindingProposal(input: { request: SkillProfileBindingProposalRequest }): Promise<SkillProfileBindingApplyResult>;
```

```ts
interface SkillProfileBindingProposalRequest {
  sourceId: string;
  profileId: string;
  capabilityIds?: readonly string[];
}

interface SkillProfileBindingProposalResult {
  sourceId: string;
  sourceName: string;
  profileId: string;
  profileName: string;
  proposal: CapabilityBindingProposal;
  preview: AgentProfileBindingPreview;
}

interface SkillProfileBindingApplyResult extends SkillProfileBindingProposalResult {
  profile: AgentProfile;
}
```

동작:

- custom source는 기본 `trusted=false`이며, script 실행은 별도 `skill_script` approval을 요구한다.
- `refresh`는 directory scan 결과를 capability registry에 반영하지만 script를 실행하지 않으며,
  `scannedCount`, `updatedCount`, `skillCount`를 반환한다.
- `generateSkillDraft`는 user intent를 `SkillAuthorDraft`로 구조화하고 같은 preview validation을 통과시킨다.
  파일 쓰기, profile binding, source trust 승격은 수행하지 않는다.
- `previewSkillDraft`는 생성될 `SKILL.md`를 loader 기준으로 검증하고 preview만 반환한다.
- `proposeSkillFile`은 파일을 직접 쓰지 않고 `file_write` approval을 생성한다.
- `proposeSkillFile`로 생성된 approval이 runner에서 실행되면 main process가 해당 source를 refresh해 capability registry를 갱신한다.
- `generateProfileBindingProposal`은 저장된 SkillSource와 AgentProfile을 읽어 `skillSourceIds` 및 필요한 경우 `allowedSkillIds` diff만 반환하며, AgentProfile row를 수정하지 않는다.
- `applyProfileBindingProposal`은 같은 diff를 재계산한 뒤 `AgentProfile.skillSourceIds`와 explicit `permissions.allowedSkillIds`만 갱신한다. `allowedSkillIds=[]`는 전체 enabled Skill 허용 의미이므로 자동으로 좁히지 않는다.

## `window.harness.secret`

SecretVault 관리. plaintext 값은 renderer에서 main으로 단방향 전달만 허용하고,
main process는 decrypted value를 renderer에 반환하지 않는다.

```ts
secret.write(input: { key: string; value: string }): Promise<void>;
secret.clear(input: { key: string }): Promise<void>;
secret.listKeys(): Promise<string[]>;
```

규칙:

- `secret.read`는 public IPC에 존재하지 않는다.
- `listKeys`는 UI의 stored/cleared 상태 표시용 key 이름만 반환한다.

## `window.harness.pipeline`

AgentPipeline template CRUD. 저장은 template registry만 담당하고, 실행은 항상
`orchestration.draftPlan` + `orchestration_plan` approval + `orchestration.runApproved`
흐름을 사용한다.

```ts
pipeline.list(): Promise<AgentPipeline[]>;
pipeline.get(input: { pipelineId: string }): Promise<AgentPipeline>;
pipeline.create(input: {
  pipeline: CreateAgentPipelineInput;
}): Promise<AgentPipeline>;
pipeline.update(input: { pipeline: AgentPipeline }): Promise<AgentPipeline>;
pipeline.delete(input: { pipelineId: string }): Promise<void>;
```

동작:

- pipeline step은 `agentProfileId`를 필수로 참조한다.
- `remoteEndpointId`, `dependsOn`, `allowedActions`, `outputContract`는 orchestration planner가 immutable plan snapshot으로 확장할 때 사용한다.
- pipeline template은 optional `backflowRules: AgentPipelineBackflowRule[]`을 저장할 수 있다. 저장소는 `backflow_rules_json`에 보관하고, planner는 pipeline step id를 worker step id로 remap해 `OrchestrationPlan.backflowRules`에 포함한다.
- Backflow rule은 정상 `dependsOn` DAG에 포함하지 않는다. UI에서는 각 Agent step 안에서 backflow 연결을 편집하며, `retryStepId`는 해당 연결을 소유한 Agent step이고 `targetStepId`는 되돌아갈 이전 Agent step이다.
- `targetStepId`는 `retryStepId`보다 앞선 step이어야 하며, 정상 `dependsOn` 경로에서 `retryStepId`의 ancestor여야 한다. `maxAttempts`는 1..5다.
- Backflow 실행은 `targetStepId`에서 `retryStepId`까지의 정상 dependency path를 새 Step/Artifact row로 재실행한다. 단순히 target 다음 retry만 직접 호출하지 않는다.
- `step_failed` rule은 실행 중 실패한 worker step과 `retryStepId`가 일치할 때만 자동 실행된다. `quality_failed` rule은 `QualityGateResult.status === "failed"`에서만 실행되며 `warning`은 기존 known-risk 승인 흐름을 유지한다.
- 앱 시작 시 role-aware 기본 템플릿을 idempotent하게 seed한다: `Product PRD Discovery`, `Evidence-First Bug Investigation`, `Docs-First Contract Reconciliation`, `Runtime Approval Hardening`, `A2A Federation Safety Review`, `Eval-Driven Release Verification`, `Cross-Harness Agent Baseline`, `Architecture RFC`, `Visual Design Delivery`, `Image Asset Prompt Flow`, `New Project Delivery`, `Frontend Product Delivery`, `Skill and Agent Expansion`, `Supervised Delivery`, `Refactor Safety`, `Parallel Review Hardening`, `Build Recovery`.
- 기본 AgentProfile seed의 description/persona, rich system prompt prefix/suffix, 기본 pipeline step instruction은 한국어 UI 표시와 HarnessAgentOS approval/IPC/storage 계약을 기준으로 저장한다.
- 기본 템플릿 seed는 저장된 선택지를 추가할 뿐이며, 기본 실행 pipeline 지정이나 자동 실행을 수행하지 않는다.
- `pipeline.run` 같은 직접 실행 IPC는 없다.

## `window.harness.remoteAgents`

A2A remote agent registry. 이 namespace는 registry/card snapshot 저장만 담당한다.
실제 remote worker 호출은 orchestration/agent worker 경로에서 main process가 수행하며,
renderer는 A2A SDK 객체나 network client를 받지 않는다.

```ts
remoteAgents.list(): Promise<A2ARegistryEntry[]>;
remoteAgents.get(input: { endpointId: string }): Promise<A2ARegistryEntry>;
remoteAgents.upsertEndpoint(input: {
  endpoint: A2AEndpoint | Omit<A2AEndpoint, "id" | "createdAt" | "updatedAt">;
}): Promise<A2AEndpoint>;
remoteAgents.delete(input: { endpointId: string }): Promise<void>;
remoteAgents.toggle(input: { endpointId: string; enabled: boolean }): Promise<A2AEndpoint>;
remoteAgents.upsertCardSnapshot(input: {
  snapshot: A2AAgentCardSnapshot;
}): Promise<A2AAgentCardSnapshot>;
```

동작:

- registry 저장은 SQLite WAL canonical state에만 반영한다.
- inbound listener, localhost server, WebSocket server는 이 namespace에 포함하지 않는다.
- `remoteAgents.invoke`, `remoteAgents.register`, `remoteAgents.refreshCard`는 public IPC가 아니다.

## `window.harness.events`

단방향 main → renderer push. `invoke`가 아니라 `ipcRenderer.on` 기반이며, 두 분류로 운영한다:

| 분류 | 채널 | 페이로드 |
|---|---|---|
| id-only push | `events:taskRunChanged` | `{ taskRunId: string }` — renderer가 fresh state를 다시 fetch |
| scoped chunk push | `events:agentStreamEvent` | `AgentStreamEvent` — invocationId-tagged, secret-redacted |
| health heartbeat | `events:diagnosticsHeartbeat` | `SystemDiagnostics` — main-owned 10초 heartbeat + 즉시 변경 push |

```ts
events.onTaskRunChanged(
  listener: (payload: { taskRunId: string }) => void,
): () => void; // unsubscribe

events.onAgentStreamEvent(
  listener: (event: AgentStreamEvent) => void,
): () => void; // unsubscribe — renderer filters by invocationId

events.onDiagnosticsChanged(
  listener: (diagnostics: SystemDiagnostics) => void,
): () => void; // unsubscribe — renderer must not poll
```

발생 조건:

- `events:taskRunChanged`: 모든 state-changing IPC 핸들러(`conversation.*`, `runner.executeApproved/retryApproval/cancelExecution`, `shadow.createPreview`, `quality.*`, `orchestration.draftPlan/runApproved`, `agent.*`)가 성공 직후 발행한다. `runner.executeApproved/retryApproval`은 runner가 실패/취소 상태를 DB에 기록한 뒤 에러를 반환하는 경우에도 발행한다.
- 장시간 실행되는 `orchestration.runApproved`는 전체 run 종료 전에도 worker artifact 또는 worker action approval이 저장될 때 `events:taskRunChanged`를 발행할 수 있다. renderer는 이 이벤트를 받으면 fresh TaskRun detail을 pull해서 중간 worker 결과와 approval을 표시해야 한다.
- `events:agentStreamEvent`: `agent.generatePlan`/worker invocation이 진행 중일 때 CLI stdout/stderr 청크 + `started`/`assistant_text`/`result`/`failed` 메시지를 발행한다. 각 이벤트는 가능한 경우 `taskRunId`를 포함해 renderer가 invocation row를 즉시 refetch할 수 있게 한다. renderer는 자기 invocationId가 아닌 이벤트는 무시한다.
- `events:diagnosticsHeartbeat`: main process가 10초 interval로 발행하고, TaskRun status 변경, agent invocation 시작/종료, runner cancel 시점에는 즉시 발행한다. renderer는 `app.getDiagnostics()`로 initial fetch 후 이 이벤트만 구독한다.
- 페이로드는 위 표에 명시된 shape만 — 채널 자체로 임의의 도메인 객체를 전달하지 않는다.
- read-only IPC (예: `quality.getLatest`, `state.listThreads`)는 발행하지 않는다.

규칙:

- 새 push 채널을 추가하기 전에 이 문서를 먼저 갱신한다.
- preload는 `ipcRenderer`를 직접 노출하지 않고 `onXxx(cb): () => void` 형태로만 expose한다.
- listener는 unsubscribe를 컴포넌트 unmount 시 반드시 호출한다.

## Contract 변경 규칙

- IPC method 추가 시 이 문서를 먼저 갱신한다.
- 기존 method의 input/output을 breaking change로 바꾸면 migration note를 남긴다.
- renderer에 임시 channel string 호출을 추가하지 않는다.



