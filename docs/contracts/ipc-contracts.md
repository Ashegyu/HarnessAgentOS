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

## 작업 계약 확장 (2026-09-07, schema v39)

- 기존 `conversation.createTask` payload에 선택적인 `intent`만 추가한다. 새 IPC 채널이나 renderer의 파일/SQL 접근은 추가하지 않는다. main에서 enum을 검증한다.
- UI가 목적을 지정하면 `origin=user_mode`, 없으면 결정적 규칙으로 `request_rules` 계약을 만든다. 명시적인 변경 금지 문구는 수정 모드보다 우선한다. 인용·코드 블록은 자동 판정 입력에서 제외하지만, 이는 완전한 자연어 권한 판독기가 아니다.
- `task_contracts`는 `task_runs`와 같은 트랜잭션으로 생성되는 SQLite 종속 테이블이다. 새 계약은 원문·목적·제약·기본 완료 기준을 저장한다. 계약이 없는 기존 작업은 원문으로 legacy 계약을 읽고, 손상된 계약을 읽기 권한이 넓은 기본값으로 대체하지 않는다.
- 읽기 전용 작업은 전역 workspace-write/자동 리뷰 설정보다 우선한다. 승인·Runner·worker 실행에 Host guard를 적용한다. 해당 작업의 MCP/앱/플러그인은 실행별 비활성화하며, 일반 채팅을 사용한다. 템플릿 모드에서도 변경 승인을 만들지 않는다. CLI가 없으면 작업만 drafting으로 저장된다.
- 외부 검색 금지는 Codex web search와 외부 도구를 끄며, workspace-write의 네트워크 접근도 끈다. Host shell/skill/git/dependency/network 실행과 파이프라인은 개별 네트워크 sandbox가 없어 보수적으로 차단한다. 파일 patch/write는 기존 승인 정책을 유지한다.
- 작업의 권한 범위를 바꾸려면 새 메시지로 TaskRun을 생성한다. 읽기 전용 작업의 변경용 fallback 및 범위를 좁히는 재계획은 `TASK_CONTRACT_ACTION_BLOCKED`로 거부한다. 기존 승인 범위와 `QualityGate → Done` 계약은 유지한다.
- MCP 점검은 모델을 호출하지 않는 `codex mcp list --json`을 사용한다. 점검 실패/잘못된 JSON/CLI override로 표현할 수 없는 서버 ID면 모델 실행 전에 중단한다. 사용자 전역 config는 수정하지 않는다. 점검 이후 외부 프로세스가 config를 바꾸는 경쟁 조건까지 격리하는 기능은 아니다.

## 답변 복사 (2026-09-08)

- `window.harness.app.copyText({ text: string }): Promise<void>` → `app:copyText`.
- 사용자의 복사 버튼 클릭으로만 OS 클립보드에 일반 텍스트를 기록한다. 에이전트 작업 실행 승인이 아니라 직접 UI 동작이며 DB/파일/명령을 변경하지 않는다.
- 빈 문자열/공백만 있는 문자열, NUL, 문자열 이외 입력, 4,194,304 UTF-16 코드 단위를 초과한 입력은 `IPC_INVALID_PAYLOAD`로 거부한다. 원문을 자르거나 Markdown을 제거하지 않는다.
- OS 클립보드 쓰기 실패는 `APP_CLIPBOARD_WRITE_FAILED`로 반환한다. 복사 내용은 로그/DB에 추가 저장하지 않으며 renderer에 클립보드 읽기 또는 raw Electron API를 노출하지 않는다.
- 기존 `registerAppIpc` 등록 경로와 `HarnessDesktopApi`를 공유하므로 새 도메인 등록 함수나 DB 이관은 필요 없다.
- 선택한 TaskRun의 상세 응답이 아직 대기 중이면 그 답변의 복사 버튼은 비활성화한다. 저장 답변 fallback을 invocation 뷰로 교체하는 중에 이전 버튼 소유의 복사를 시작하지 않는다. 다른 작업의 안정된 저장 답변은 계속 복사할 수 있다. 상세 응답이 실패하여 저장 답변을 유지하는 경우에도 복사가 다시 가능하다.
- 테스트와 UI 관측은 해당 TaskRun의 답변에 연결한다. 전체 화면의 첫 saved 답변 같은 위치 선택자는 뷰 교체 후 다른 작업을 가리킬 수 있다. 복사 원문·중복 요청 차단·실패 후 재시도·언어 전환의 기존 계약은 유지한다.

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
  | "file_patch"
  | "file_write"
  | "file_delete"
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

export type TaskIntent = "answer" | "review" | "diagnose" | "change" | "research" | "unspecified";

export interface TaskContract {
  revision: 1;
  origin: "user_mode" | "request_rules" | "legacy";
  intent: TaskIntent;
  deliverable: string;
  constraints: string[];
  assumptions: string[];
  acceptanceCriteria: string[];
  evidenceRequirements: string[];
  authorization: { mode: "read_only" | "approval_required" };
  externalSearch: "allowed" | "forbidden";
  freshness: "not_requested" | "external_sources";
}

export interface TaskRun {
  id: string;
  threadId: string;
  userRequest: string;
  contract?: TaskContract;
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
  retryApprovalId?: string;
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
    | "performance-reviewer"
    | "documenter";
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
파이프라인 선택을 통한 자동 승인도 활성 AgentProfile의 `blockedActions`와
budget cap을 우회하지 않는다. 둘 중 하나라도 위반하면 approval은 pending으로
남고 실행되지 않는다.

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
  capabilities: {
    status: "ok" | "warning" | "error";
    lastRefreshAt?: string;
    lastRefreshFailureAt?: string;
    warning?: string;
  };
}
```

오류:

- `APP_RUNTIME_UNAVAILABLE`

## `window.harness.state`

```ts
state.listThreads(): Promise<Thread[]>;
state.listRecentTaskRuns(input: { limit: number }): Promise<RecentTaskRun[]>;
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
conversation.startTask(input: StartConversationTaskInput): Promise<ConversationTaskDraft>;
conversation.createTask(input: CreateConversationTaskInput): Promise<ConversationTaskDraft>;
conversation.redirectTask(input: { taskRunId: string; instruction: string }): Promise<ConversationTaskDraft>;
conversation.approve(input: { approvalId: string; expectedRevision: number; manualConfirmation?: boolean; message?: string; scope?: ApprovalScope; autoApproveDecision?: AutoApproveDecision | null }): Promise<Approval>;
conversation.rejectApproval(input: { approvalId: string; message: string }): Promise<Approval>;
conversation.setProposedAction(input: { approvalId: string; details: ProposedActionDetails }): Promise<Approval>;
conversation.prepareActionRetry(input: { approvalId: string; expectedRevision: number; expectedExecutionState: "running" | "succeeded" | "failed" | "uncertain" | null; reviewMessage: string }): Promise<Approval>;
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

- `prepareActionRetry`: `blocked`/`quality_failed`에서 실행 전 실패·uncertain·기존 성공/실패 결과를 사용자가 검토한 뒤 새 `pending` 수동 승인을 만든다. `ready_for_review`에서도 남아 있는 `uncertain` 실행은 검토할 수 있다. `expectedRevision`과 표시된 실행 상태가 일치해야 하며 검토 내용은 1~4000자다. 진행 중 승인/Step/모델 호출, paused/terminal, 읽기 전용 계약, 미지원 action은 거부한다. 지원 범위는 유효한 `file_write/file_patch/file_delete/shell` 제안이며 DB snapshot export는 포함하지 않는다. 정책·예산 및 파일 baseline/삭제 snapshot 검증은 기존 승인/실행 경로에서 다시 적용한다.
- 준비는 실행·자동 승인이 아니다. 새 승인/Step/Checkpoint/검토 artifact, 원래 승인에 대한 `retryApprovalId`, TaskRun `waiting_for_approval` 전이는 한 동기 immediate transaction으로 저장한다. 같은 원본의 중복 준비는 기존 새 승인을 반환한다. 원래 revision·실행 결과는 보존하며 대체된 승인의 수정·결정·claim을 차단한다. 후속 Retry 실패는 새 승인을 원본으로 검토하여 체인을 이어간다. 스키마 42의 nullable self-reference이며 기존 행은 변경하지 않는다.
- 이전 uncertain 결과는 새 승인을 생성한 명시적 검토로만 진행 대기에서 제외된다. 새 승인이 pending/실행 중이면 완료할 수 없다. 검토가 검사 성공을 의미하지 않으며 기존 실패 ledger·품질 증거는 유지한다. 새 승인은 전역/프로필/pipeline 자동 동의에 관계없이 개별 수동 승인이 필요하다.
- `failed`는 종료 코드·검사 로그·ValidationRun이 기록되고 checker identity와 입력 revision/generation이 실행 중 유지된 검사의 확정 실패다. 승인은 `executed/failed`로 소비되며 실패 Step/검사 이력은 보존하고 재사용하지 않는다. 최신 품질 게이트가 실패하면 완료할 수 없다. 일반 명령, 변경 중 검사, 취소 및 종료 미확인은 계속 `uncertain`이다. SQLite v44는 기존 승인·감사 이벤트·검사 참조·실행 순서를 보존하며 이 상태를 추가한다.
- 명시적 자동 승인 또는 선택된 pipeline 동의가 있는 작업은 확정 검사 실패에서 기존 제한된 보정 경로로 연결된다. 일반 작업은 RepairLoop 횟수/동일 signature 제한, pipeline은 선택된 backflow 규칙을 따른다. 새 파일 작업도 기존 정책·예산 심사를 거치며 호스트 shell과 수동 검토 승인은 자동 승인되지 않는다.
- Worker 제안의 원래 승인 ID는 replacement 체인을 따라 현재 leaf 승인을 기다린다. 새 승인 checkpoint를 새 worker 완료 표식으로 취급하지 않으며, leaf가 해결된 뒤 원래 성공 worker를 재실행하지 않고 나머지 worker를 이어간다. 끊어진 연결이나 cycle은 미해결로 남긴다.
- Renderer의 thread/task 상세는 선택 ID와 선택 수명 generation을 검사한다. A→B→A와 늦은 성공/실패를 구분하고, 같은 선택의 push burst는 진행 중 조회 뒤 후속 최신 pull로 병합한다. 선택 변경 시 이전 상세와 dialog의 액션을 노출하지 않으며, 이전 선택에서 시작한 생성 응답도 현재 선택을 빼앗지 않는다. polling은 추가하지 않는다.

- `createTask`: 비동기 경로 확인을 끝낸 후 thread 생성 및 TaskRun, steps, artifacts, checkpoint, approvals를 동기 storage transaction 안에서 생성한다. 중간 실패 시 해당 draft row들은 rollback된다. 내부 `withTransaction` callback은 동기 scope만 사용하며 Promise/thenable을 반환할 수 없다. scope는 callback 종료 후 사용할 수 없고, 독립 요청의 쓰기가 다른 요청의 rollback에 포함되지 않는다. 외부 `createTask`와 기존 repository의 Promise API는 유지한다.
- `startTask`: 일반 입력창의 단일 제출 경로. `userRequest`, 선택적인 `threadId/targetDir/followUpTaskRunId/intent`, `orchMode/orchInstruction/orchPipelineId/orchHarness`만 받는다. 파이프라인과 하네스 동시 선택은 거부한다. `mode`와 호출자 제공 authorization은 사용하지 않고 main에서 agent TaskRun과 작업 계약을 생성한다. draft를 반환한 후 main에서 추천 준비 또는 오케스트레이션 초안을 생성한다. 추천 준비가 끝나면 SQLite의 host-owned `harness:planning-ready/{taskRunId}` snapshot으로 기록하고, 추천 승인/거절 후 AI를 한 번 시작한다. renderer 선택/새로고침은 실행 소유권에 영향을 주지 않는다.
- `approve`: 승인은 실행과 별개인 revisioned DB 결정으로 유지하되, main 진행 조정자가 승인된 실행 가능한 file/shell/orchestration 작업을 이어 실행한다. renderer는 별도 실행 요청을 중복 전송하지 않는다. 실행 중·결과 불명확 approval은 재실행하거나 완료 처리하지 않는다. 수동 shell/delete 동의, 변경된 승인 내용 재확인, 차단 정책과 예산 검사는 유지한다.
- main 진행 조정자는 모든 checkpoint의 미해결 승인과 활성 step/invocation이 없어야 QA를 시작한다. passed는 자동 완료, warning은 위험 확인 대기, failed는 실패로 남는다. 처리 오류는 실패 step/log와 blocked 상태로 저장한다. 과거 작업은 앱 시작만으로 자동 재생하지 않는다.
- `pauseTask`: `running` 또는 `waiting_for_approval`에서만 허용 → `paused`. 그 외는 `CONVERSATION_INVALID_STATE`. 파이프라인은 이미 시작한 worker 결과를 정리하되 다음 worker를 시작하지 않는 경계 일시정지다. 진행 중 결과/오류 기록은 `paused`를 덮지 않는다. 마지막 worker가 끝나더라도 사용자가 재개하기 전까지 parent 승인과 continuation을 보존한다.
- `resumeTask`: `paused`에서만 허용. pending approval 존재 시 `waiting_for_approval`, currentStep 존재 시 `running`, 둘 다 없으면 `CONVERSATION_NOTHING_TO_RESUME`.
- `cancelTask`: 비종료 상태에서만 허용. 사유 누락 시 `CONVERSATION_REASON_REQUIRED`. pending approval 자동 거절 + `quality_report` 아티팩트 기록 후 `cancelled`.
- 취소 상태 저장 후 Agent와 Runner 취소를 모두 시도한다. 한쪽 실패가 다른 쪽 취소를 막지 않으며, 종료 처리 실패에도 변경 이벤트를 보낸다. Runner 취소는 실행 정리가 끝날 때까지 기다린다. Windows shell은 소유 PID의 프로세스 트리 종료와 `close`를 확인하며, 제한 시간 내 확인하지 못하면 `RUNNER_TERMINATION_UNCONFIRMED` 오류로 보고하고 승인 결과를 `uncertain`으로 남긴다. `cancelled` 작업 상태 자체는 OS 프로세스 종료 확인을 뜻하지 않는다.
- 모든 내부 상태 쓰기는 중앙 전이표를 검증한다. 일반 호출은 `LocalStateService.setTaskRunStatus`를 사용하고, worker/진행 오류처럼 이전 관측 상태를 보존해야 하는 경로는 같은 전이 검사 후 관측 상태를 명시한 repository CAS를 사용한다. 동일 상태 재기록은 멱등이며, 허용되지 않은 전이는 `TASK_RUN_INVALID_TRANSITION`으로 거부되고 SQLite row를 변경하지 않는다.
- 전이 검증 당시의 상태를 SQLite UPDATE 조건에 포함한다. 다른 요청이 상태를 변경했다면 덮어쓰지 않고 충돌을 반환한다. 이미 동일한 목표 상태에 도달한 요청은 추가 쓰기 없이 성공으로 처리한다.
- 품질 게이트 결과는 비동기로 도착할 수 있으므로 모든 비종료 상태에서 `quality_failed` 또는 `ready_for_review`로 전이할 수 있다. 재작업은 `ready_for_review -> running`, 승인 기반 refinement는 `ready_for_review|done -> waiting_for_approval`을 사용한다.
- `done`은 `ready_for_review`에서만 진입하며 `waiting_for_approval` refinement 외의 역행을 허용하지 않는다. `cancelled`는 terminal 상태다.

```ts
interface CreateConversationTaskInput {
  threadId?: string;
  userRequest: string;
  intent?: TaskIntent;
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
runner.executeCodeChangeAttempt(input: {
  taskRunId: string;
  changeApprovalIds: string[];
  verificationApprovalIds?: string[];
  attemptNumber?: number;
}): Promise<CodeChangeAttemptResult>;
runner.cancelExecution(input: { taskRunId: string }): Promise<{ cancelled: boolean }>;
runner.listArtifacts(input: { taskRunId: string }): Promise<Artifact[]>;
runner.readArtifact(input: { artifactId: string }): Promise<{ artifact: Artifact; content: string }>;
runner.retryApproval(input: { approvalId: string }): Promise<RunnerResult>;
```

> `retryApproval`은 부모 TaskRun이 `blocked`/`quality_failed`이고 승인이 아직 실행에 소비되지 않았을 때만 허용한다. `running`, `succeeded`, `uncertain`, `executed` 승인은 재사용하지 않는다. 실제 실행 결과를 검토한 뒤 새 작업 승인을 생성해야 한다.
> UI의 재시도 검토는 `conversation.prepareActionRetry`를 사용한다. 기존 `runner.retryApproval`은 호환 API로 남지만 대체·소비된 승인을 다시 실행하도록 완화하지 않는다.
> `cancelExecution`은 현재 실행 중인 RunnerService 작업이 있을 때만 `{ cancelled: true }`를 반환하고 해당 TaskRun의 AbortSignal을 중단한다. 존재하지 않거나 실행 중이 아닌 `taskRunId`는 throw하지 않고 `{ cancelled: false }`를 반환한다.
> `executeCodeChangeAttempt`는 이미 approved 상태인 `file_write` approval들을 순서대로 실행하고, 이미 approved 상태인 verification `shell` approval들을 순서대로 실행한다. 이 호출은 raw command나 raw patch를 받지 않으며 기존 approval/runner 정책을 우회하지 않는다. 성공/실패 결과는 attempt manifest artifact와 QualityGateResult로 남긴다.

Runner 실행 가능 approval은 `file_patch`, `file_write`, `file_delete`, `shell`이다. 자동 승인/자동 실행 경로는 approval에 `proposedAction`이 없거나 `proposedAction.type !== approval.actionType`이면 자동 approve하지 않고 pending으로 남긴다. RunnerService도 실행 직전에 같은 `validateProposedActionDetails` 검증을 수행한다. `file_delete`와 `shell`, 변경 후 재승인 대상은 프로필·전역·pipeline 동의로 자동 승인할 수 없다.

### v40 승인 버전 및 실행 소비 계약

- `Approval.actionRevision`은 세부 변경 시 증가한다. IPC `approve.expectedRevision`이 현재 버전과 다르면 거절한다. `approvedRevision`과 승인 JSON 스냅샷을 SQLite에 함께 저장한다.
- 승인된 내용을 변경하면 pending으로 되돌리고 `requiresManualApproval=true`로 표시한다. 실행 중/실행 완료/거절/불확실 결과는 변경 및 재승인이 잠긴다. 취소·완료 TaskRun에서도 승인을 되살리지 않는다.
- 파일·CLI Runner는 SQLite 조건부 UPDATE로 단일 실행을 선점한다. 별도 Runner 인스턴스에서도 같은 승인 ID는 한 번만 수행하고, 다른 승인 ID들의 병렬성은 유지한다. 실행 중단·실패·비정상 종료의 결과는 `executionState=uncertain`으로 유지하며 자동 재시도하지 않는다.
- `approval_events`는 내용 버전, 승인 결정, 실행 상태의 이력을 트리거로 원자적으로 저장한다. 사용자가 해당 작업을 삭제하면 이력도 함께 삭제된다.
- `file_delete` 제안은 `{type:"file_delete",fileDelete:{path}}`이며 `path`는 targetDir 기준 단일 상대 경로다. 세부 저장 시 메인 서비스가 크기·수정 시각·SHA-256을 읽어 반환한다. 사용자가 이 정보를 보고 `manualConfirmation:true`로 승인한다. 승인 및 실행 때 다시 비교하며, 실제 이동은 Electron `shell.trashItem`만 사용한다. 실패 시 영구 삭제로 전환하지 않는다.
- 명령/인수, 파일 경로/본문 등 세부 편집은 기존 `setProposedAction` IPC를 이용한다. 새 서버나 renderer Node 접근은 추가하지 않았다. typed preload/API에서 갱신된 `ApproveInput`과 `ProposedActionDetails`를 공유한다.
- CLI의 targetDir은 cwd이지 OS sandbox가 아니다. 임의 코드의 외부 파일·네트워크 접근을 차단하지 않으며, 별도 경고를 확인한 수동 승인이 필요하다.

`file_write`와 `file_patch`의 경로 검증은 단순 문자열 prefix가 아니라 canonical
real path 기준으로 `targetDir` containment를 재확인한다. Windows junction/symlink가
workspace 밖을 가리키거나 dangling link라 canonical target을 확인할 수 없으면
fail-closed 한다. `file_write.before`가 제안 이후 변경된 경우에도 stale proposal로
간주해 실제 파일을 덮어쓰지 않는다.

같은 main process의 모든 `FileRunner`는 canonical destination별 쓰기 소유권을 공유한다.
`file_patch`도 읽은 preimage와 계산한 결과를 같은 `FileRunner`에 전달하므로, 같은 이전
내용을 승인한 write/patch 경합은 실제 쓰기 직전에 다시 비교한다. 충돌은
`RUNNER_FILE_CONTENT_CHANGED`, 일반 파일이 아니거나 링크 수가 1이 아니면
`RUNNER_FILE_REGULAR_SINGLE_LINK_REQUIRED`로 거부한다. 기존 파일은 검증한 handle에
연결해 읽고 쓰며, 대기 중 취소는 파일 부수효과를 시작하지 않는다. 취소된 중간
waiter 뒤의 요청도 이전 owner를 추월하지 않는다. 다른 파일은 병렬 실행을 유지한다.
이 계약은 외부 프로세스와의 OS 전체 잠금이나 악의적인 연속 경로 교체에 대한
완전한 CAS/이미 시작한 쓰기의 rollback을 보장하지 않는다.

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

```ts
interface CodeChangeAttemptResult {
  attemptNumber: number;
  taskRunId: string;
  status:
    | "verified"
    | "applied_unverified"
    | "verification_failed"
    | "apply_failed"
    | "no_changes";
  nextAction: "ready_for_review" | "repair_required" | "blocked";
  appliedApprovalIds: string[];
  verificationApprovalIds: string[];
  changedFiles: string[];
  artifactIds: string[];
  verificationResults: Array<{
    approvalId: string;
    commandSummary: string;
    exitCode: number | null;
    stdout?: string;
    stderr?: string;
    artifactIds: string[];
  }>;
  failureMessage?: string;
}
```

오류:

- `RUNNER_APPROVAL_REQUIRED`
- `RUNNER_APPROVAL_REJECTED`
- `RUNNER_TARGET_OUTSIDE_WORKSPACE`
- `RUNNER_BLOCKED_HIGH_RISK`
- `RUNNER_POLICY_BLOCKED`
- `RUNNER_EXECUTION_FAILED`
- `RUNNER_RETRY_NOT_BLOCKED`
- `RUNNER_CANCELLED`
- `CODE_CHANGE_TASK_NOT_FOUND`
- `CODE_CHANGE_APPROVAL_NOT_FOUND`
- `CODE_CHANGE_APPROVAL_TASK_MISMATCH`
- `CODE_CHANGE_APPROVAL_TYPE_MISMATCH`
- `CODE_CHANGE_APPROVAL_NOT_APPROVED`
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
quality.registerRegression(input: RegisterRegressionContractInput): Promise<RegressionContractSummary>;
quality.listRegressions(input: { taskRunId: string }): Promise<RegressionContractSummary[]>;
quality.prepareRegression(input: { taskRunId: string; contractId: string }): Promise<Approval>;
quality.evaluate(input: QualityGateInput): Promise<QualityGateResult>;
quality.getLatest(input: { taskRunId: string }): Promise<QualityGateResult | null>;
quality.approveKnownRisks(input: { taskRunId: string; message: string }): Promise<TaskRun>;
quality.createRepairPlan(input: { taskRunId: string; instruction?: string }): Promise<RepairPlanDraft>;
quality.markReadyForReview(input: { taskRunId: string }): Promise<TaskRun>;
quality.markDone(input: { taskRunId: string }): Promise<TaskRun>;
```

평가 근거와 자동 처리:

- `QualityEvaluator`는 같은 TaskRun의 실제 승인 실행 원장(`validation_runs`)을 사용한다. 성공 판정에는 실행 Step·claim·결과 artifact·종료 코드·명령/argv/cwd와 script identity가 연결되어야 한다. 시작 실패는 출력 artifact나 종료 코드 없이도 보수적으로 실패로 판정한다. 제목·모델 출력·로그의 `passed`/`exit=0` 또는 `echo` 성공은 검사 증거가 아니다. 도움말·목록·dry-run·지원하지 않는 wrapper는 미검증이다.
- 동일 checker는 시작 sequence가 가장 큰 실행만 평가한다. 실행 중·취소·artifact 누락인 최신 실행에서 이전 성공으로 돌아가지 않는다. 다른 checker의 현재 실패도 유지한다. timestamp와 Step index는 검사 실행 순서의 기준이 아니다.
- 검사 시작/종료/현재 입력의 전체 파일 fingerprint와 작업공간 mutation generation이 같아야 한다. Git tracked 및 nonignored untracked 파일을 포함하며 tracked build/dist 파일도 제외하지 않는다. 일반 폴더에는 명시적 dependency/output 제외 정책이 적용된다. 입력 읽기 실패·모호한 링크·상한 초과는 미검증이다. 한도는 파일 20,000개, 파일당 64 MiB, 합계 256 MiB, capture당 30초다. 내부 write/direct workspace-write의 active owner 또는 변경 후 복구도 이전 검사를 무효화한다.
- diff는 변경이 존재한다는 근거일 뿐 검토 완료 증거가 아니다. 현재 evaluator는 diff가 있을 때 `changedFilesReviewed=false`를 기록한다.
- 읽기 전용 계약은 최신 성공 invocation의 `parsedPlanArtifactId`와 같은 작업의 성공 step에 연결된, 내용이 있는 plan artifact가 필요하다. 변경 근거가 있으면 failed, 응답 연결이 없으면 not_run이다. 단순 answer는 다른 필수 검사 누락이 없으면 passed, review/diagnose/research 또는 legacy 계약은 내용 확인을 위한 warning이다. 명시적으로 요구한 빌드·테스트 검사를 무시하지 않는다.
- 수정 계약에 실제 diff가 없으면 warning으로 남겨 자동 완료를 막는다. 응답 확인은 사실성·요구사항 전체의 의미 검증이 아니다. 검사·diff·edit가 없고 필수 검사를 요구하지 않은 순수 읽기 전용 응답은 파일 freshness 판정을 요구하지 않는다.
- `ready_for_review` 상태 변경 시 기존 자동 평가 서비스가 위 결정적 검사를 실행한다. 별도 모델을 호출하지 않으며 passed만 자동으로 markDone, warning은 사용자 확인을 기다린다. 화면은 push 이벤트로 받은 최신 gate를 반영한다.
- `createRepairPlan`의 최신 gate 확인·시도 상한·동일 failure signature 검사·attempt 예약은 하나의 동기 SQLite immediate transaction에서 수행한다. 같은 DB의 다른 연결/서비스가 동시에 요청해도 예약을 중복 소비하지 않으며, gate가 바뀌면 모델을 호출하기 전에 `QUALITY_DONE_BLOCKED`로 중단한다.
- 새 `failureSignature`는 `quality-v2:` SHA256이다. gate 상태·build/tests/smoke의 true/false/미검증 구분·정확한 knownRisks 집합과, gate가 선택한 실제 실패 실행 원장의 checkerId·검사 종류 집합·종료 코드를 사용한다. artifact/gate/task/실행 ID·시각·workspace revision/generation/watermark는 동일 실패의 구분자가 아니다. 위험/검사 집합의 순서와 중복은 무시하며 위험 문구의 대소문자·공백·경로·숫자는 임의로 정규화하지 않는다.
- 예약 repository가 DB 원본에서 서명을 계산한다. 과거 attempt는 저장된 hash 형식에 관계없이 연결된 원본 gate와 당시 artifact에 연결된 실행 원장을 다시 비교한다. 과거 hash와 attempt 수는 보존한다. 두 gate 모두 실제 실패 검사 증거가 있으면 전체 서명을 비교하며, 한쪽이라도 증거가 없으면 상태·검사 결과·위험 집합으로 보수적으로 반복을 차단한다. 원본 gate/연결 증거가 손상되어 판정할 수 없으면 `QUALITY_DONE_BLOCKED`이며 모델·새 attempt를 생성하지 않는다.
- 이는 gate/검사 수준의 반복 실패 판정이다. 같은 checker·종료 코드·위험이 유지되는 서로 다른 assertion/root cause를 로그에서 추론해 구분하는 계약은 아니다. 다른 checker·종료 코드·gate 실패 조건은 남은 시도 예산 안에서 별도 실패가 될 수 있다. 증거 artifact ID 자체는 감사·진단용으로 계속 보존한다.

`markDone` 정책 (`TaskRunCompletionService.markDone` 기준):

- TaskRun status가 `ready_for_review`일 때만 허용된다. `running`에서 바로 `done`으로 전환하는 경로는 없다.
- `passed` 게이트 → 최신 gate와 현재 파일 revision/변경 세대/실행 watermark가 유효할 때 허용. 실행 provenance 없는 기존 검사 성공은 재실행 필요
- `warning` 게이트 → `kind="quality_report"`이고 URI가 `/<gate.id>`로 끝나는 known-risk 승인 아티팩트가 있을 때만 허용. (canonical artifact kind는 `quality_report` 하나이며, URI suffix로 일반 quality 보고서와 known-risk 승인을 구분한다 — `quality.approveKnownRisks`가 `harness:quality/<taskRunId>/<gate.id>` URI로 작성한다.)
- `failed`/`not_run` → 거부 (`QUALITY_DONE_BLOCKED`)
- gate 최신성은 SQLite 저장 순서로 판단한다. 파일·검사 결과가 평가 이후 바뀌면 known-risk 승인도 차단한다. 비동기 완료 hook 이후 다시 확인하고 최종 동기 DB CAS에서 gate/작업 상태와 미해결 승인·실행을 재검사한다. 외부 프로세스의 마지막 파일 확인 이후 변경을 완전히 격리하는 파일시스템 snapshot 계약은 아니다.
- `validationState`가 있는 warning도 현재 fingerprint가 필요하며, null fingerprint는 known-risk 승인으로 우회할 수 없다.
- 성공 시 LearningTrace `recordOutcome`이 IPC 계층에서 자동 갱신된다 (renderer는 별도 호출 불필요). outcome에는 최신 QualityGate, `success=true`, TaskRun 총 agent invocation 비용, 완료된 invocation의 대표 latency 집계값이 반영된다.

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
  validationState?: {
    workspaceKey: string;
    fingerprint: string | null;
    generation: number;
    watermark: number;
  };
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
capability.suggest(input: { taskRunId: string; prompt: string; profileId?: string | null }): Promise<CapabilitySuggestion[]>;
capability.proposeCandidates(input: { taskRunId: string; prompt: string; profileId?: string | null }): Promise<{
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

- `refresh`는 DB에 등록된 enabled `skill_sources` 전체를 기준으로 registry를 다시 스캔한다. 고정 project/user 2개 root만 스캔하지 않는다.
- `suggest`는 TaskRun userRequest + 추가 prompt를 기준으로 triggerTerms를 매칭한다. `profileId`가 있으면 해당 profile의 `allowedSkillIds` 필터를 적용하고, `null`이면 profile 필터를 적용하지 않는다.
- `proposeCandidates`는 매칭된 trusted capability를 `capability_use` approval로 자동 큐잉한다. 이 approval은 runner 실행 대상이 아니며, 승인된 후보만 이후 agent prompt의 Skill 컨텍스트로 들어간다. `profileId` 필터 의미는 `suggest`와 같다.
- `readSkill`은 metadata cache miss 시 enabled skill source 전체 refresh를 1회 수행한 뒤 재시도한다.
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
  recommendedContext: ObservationRecallResult[];
  rationale: string;
  costHint?: "low" | "medium" | "high";
  latencyHint?: "low" | "medium" | "high";
  confidence: number;
}

interface ObservationRecallResult {
  observationId: string;
  taskRunId?: string;
  threadId?: string;
  projectKey?: string;
  source: "approval" | "quality" | "learner" | "runner" | "skill" | "agent";
  eventType: string;
  signal: string;
  summary: string;
  score: number;
  createdAt: string;
  outcome?: {
    usedCount: number;
    passedCount: number;
    warningCount: number;
    failedCount: number;
    lastStatus?: "passed" | "warning" | "failed";
    lastOutcomeSource?: "quality" | "agent" | "runner" | "unknown";
    lastSeenAt?: string;
    qualityOutcomeCount: number;
    agentOutcomeCount: number;
    runnerOutcomeCount: number;
    unknownOutcomeCount: number;
    scoreAdjustment: number;
    reuseRisk: "low" | "medium" | "high";
  };
}

type LearnerContextDecisionSurface = "recommended" | "recall";

interface LearnerContextDecisionRecord {
  taskRunId: string;
  observationId: string;
  decision: "pinned" | "unpinned";
  surface?: LearnerContextDecisionSurface;
  score?: number;
  reuseRisk?: "low" | "medium" | "high";
}

interface ContextDecisionRecentEvent {
  decisionObservationId: string;
  taskRunId?: string;
  threadId?: string;
  observationId: string;
  decision: "pinned" | "unpinned";
  surface: LearnerContextDecisionSurface;
  score?: number;
  reuseRisk?: "low" | "medium" | "high";
  createdAt: string;
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
learner.recallContext(input: {
  taskRunId: string;
  query?: string;
  source?: "approval" | "quality" | "learner" | "runner" | "skill" | "agent";
  limit?: number;
}): Promise<ObservationRecallResult[]>;
learner.summarizeContextOutcomes(input: {
  taskRunId: string;
  limit?: number;
}): Promise<ContextOutcomeSummary>;
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
learner.recordContextDecision(input: LearnerContextDecisionRecord): Promise<void>;
learner.recordDecision(input: {
  taskRunId: string;
  recommendationId: string; // LearnerRecommendation.id
  decision: "accepted" | "rejected";
  reason?: string;
}): Promise<void>;
```

`recordSelection`은 user/policy가 모델·capability를 골랐을 때 호출되어 LearningTrace의 `selectedModel`/`selectedCapabilities`를 갱신한다.
`recordOutcome`은 `quality.markDone` 성공 직후 IPC 계층이 자동 호출하므로 renderer가 명시적으로 부르는 일은 드물지만, 외부 통합용으로 노출되어 있다.
agent 계획 실패는 `AgentPlanningService.generatePlan`이 실패 상태와 diagnostic artifact를 저장한 직후 pinned context outcome(`learner/pinned_context_outcome`, signal `failed`)으로 기록한다. runner 실행 실패도 `RunnerService.executeApprovedInternal`이 실패 step, error artifact, blocked 상태를 저장한 직후 같은 outcome(`outcomeSource: "runner.executeApproved"`)으로 기록한다. 취소(`cancelled`)는 실패 학습으로 기록하지 않는다.
`recommend`의 `recommendedContext`는 같은 projectKey에서 현재 TaskRun을 제외한 prior observation을 읽기 전용으로 검색한 최대 3개 후보다. `reuseRisk: "high"` context는 자동 추천에서 제외되며, agent prompt에는 사용자가 명시적으로 pin한 항목만 들어간다.
`recordContextDecision`은 사용자가 추천/검색 context를 pin 또는 unpin할 때 `learner/pinned_context_decision` observation을 남긴다. payload는 observation id, surface, score, reuseRisk 같은 compact metadata만 포함하며 raw observation payload나 summary 원문은 복사하지 않는다. 이 기록은 observability와 감사용이며 approval, runner 권한, agent prompt 주입을 직접 바꾸지 않는다.
`recallContext`는 같은 projectKey의 기존 observation을 읽기 전용으로 검색한다. 현재 TaskRun은 결과에서 제외하고, summary는 redaction 후 반환하며 payload나 prompt 원문은 반환하지 않는다. pinned context outcome 이력은 `outcome.scoreAdjustment`, `outcome.reuseRisk`, `lastOutcomeSource`, 출처별 compact counters(`qualityOutcomeCount`/`agentOutcomeCount`/`runnerOutcomeCount`/`unknownOutcomeCount`)로만 반영되어 실패 이력이 있는 context를 낮춰 보여주며, runner 권한이나 approval 상태를 바꾸지 않는다.
`summarizeContextOutcomes`의 `verifiedContextPackCount`/`pendingContextPackCount`는 pinned context pack 중 이후 outcome으로 검증된 것과 아직 outcome이 없는 것을 구분한다. `contextDecisionCount`/`contextPinnedDecisionCount`/`contextUnpinnedDecisionCount`와 `recentContextDecisions`는 실행 전 context 선택 이력을 read-only로 보여준다. `topObservations`는 사용량/성과 중심, `riskObservations`는 실패/고위험 context 중심의 read-only 집계다. 두 목록 모두 redacted summary와 compact outcome counters만 포함하며 raw `payload_json`은 반환하지 않는다.
`summarizeContextOutcomes`의 `qualityOutcomeCount`/`agentOutcomeCount`/`runnerOutcomeCount`/`unknownOutcomeCount`는 outcome 발생 지점을 정규화한 출처별 집계다. 저장된 payload의 `outcomeSource`는 `quality`, `agent.*`, `runner.*`만 enum으로 축약되어 반환되고, raw payload string은 노출하지 않는다.
`summarizeContextOutcomes`의 `recentOutcomes`는 최신 pinned context outcome을 read-only drill-down으로 반환한다. 각 항목은 outcome observation id, redacted summary, status, normalized outcomeSource, pinned observation ids, timestamp만 포함하고 raw `payload_json`은 반환하지 않는다.
`summarizeContextOutcomes`의 `recentContextPacks`는 context pack observation과 이후 pinned context outcome을 `contextPackObservationId`로 연결해 반환한다. 각 항목은 context pack observation id, optional artifact id, pinned observation ids, timestamp, linked outcome summary/status/source만 포함하고 raw context pack payload는 반환하지 않는다.
`proposeRecommendation`은 현재 TaskRun의 trace 기반 추천을 approval 후보로 올린다. 추천 모델은 `model_use`, 추천 capability는 `capability_use` approval이 되며 둘 다 runner 실행 대상이 아니다. 승인된 `model_use`만 다음 `agent.generatePlan` 호출의 모델 override로 반영된다. 추천 적용/무시 UI는 `recordDecision`으로 감사 로그를 남기되, 감사 로그 실패가 approval 생성 자체를 막지는 않는다.

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
instinct.getCandidateEvidence(input: {
  candidateId: string;
  limit?: number;
}): Promise<EvolutionCandidateEvidence>;
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
  harness?: {
    packageId: string;
    workflowId?: string;
    bindingSetId: string;
  };
}): Promise<{
  plan: OrchestrationPlan;
  artifact: Artifact;
  approval: Approval;
}>;
orchestration.runApproved(input: { approvalId: string }): Promise<OrchestrationRunResult>;
```

> Plan approval은 별도 메서드 없이 `conversation.approve` 흐름을 그대로 사용한다(approval action_type=`orchestration_plan`). 사용자가 approve 처리한 뒤 `runApproved`로 worker step 실행을 트리거한다.

저장된 plan은 마지막 standalone `<!-- orchestration-plan:json -->` marker 뒤의 끝에
고정된 JSON fence만 복구한다. 사용자 instruction의 JSON 예제나 JSON 문자열 안의
marker는 계획 framing이 아니다. artifact의 task/URI와 승인 checkpoint의 artifact ID,
plan ID 및 mode를 대조하고 기본 worker/dependency/backflow 구조를 검증한다.
불일치 시 다른 artifact로 fallback하지 않고 `ORCHESTRATION_PLAN_NOT_FOUND`로 멈춘다.

오류:

- `ORCHESTRATION_DISABLED` — feature flag off 상태에서 draftPlan/runApproved 호출
- `ORCHESTRATION_PLAN_NOT_FOUND` — 복구할 orchestration_plan artifact를 찾지 못함
- `ORCHESTRATION_APPROVAL_REQUIRED` — approval이 존재하지 않거나 approved 상태가 아님
- `ORCHESTRATION_APPROVAL_TYPE_MISMATCH` — approval.actionType이 `orchestration_plan`이 아님
- `ORCHESTRATION_INVALID_PLAN` — `mode`가 허용 enum이 아님
- `ORCHESTRATION_TASK_NOT_FOUND` — taskRunId 미존재
- `ORCHESTRATION_TASK_NOT_RUNNABLE` — 실행 진입 시 TaskRun이 cancelled/done 또는 미존재. parent 승인을 실행 완료로 소비하지 않는다. paused는 재개를 위해 승인과 continuation을 보존한다.
- `ORCHESTRATION_DIRECT_ACTION_BLOCKED` — worker가 approval 게이트를 우회하려 시도
- `HARNESS_PACKAGE_NOT_FOUND` / `HARNESS_BINDING_SET_NOT_FOUND` / `HARNESS_BINDING_SET_MISMATCH` — direct harness source가 저장 snapshot 또는 binding set과 맞지 않음

## `window.harness.agent`

Phase 8 — CLI 기반 agent planner. `conversation.createTask({mode: "agent"})`로 생성된 TaskRun에 대해 `generatePlan`을 호출하면 `codex` CLI가 main process에서 실행되어 plan artifact와 0..N approval row를 만든다. 기본 `read-only` 모드에서는 agent가 파일을 직접 쓰지 않으며 모든 side effect는 기존 approval 흐름을 통과한다. 전역 `agent.codexWorkspaceWrite=true`는 명시적 예외다. 이때 Codex CLI는 targetDir 내부를 직접 수정할 수 있고 해당 변경은 Approval → Runner → Artifact 사전 경로로 자동 변환되지 않는다. 기본값은 `false`이며 UI는 활성화 전에 이 경계를 경고한다. workspace-write 호출은 실행 전후의 bounded 파일 snapshot을 비교해 A/M/D manifest와 가능한 text diff를 secret-redacted `diff` artifact(`Workspace change evidence`)로 남긴다. 이 사후 증거는 사전 approval을 대체하지 않는다.

Exec 결과 신뢰성 (2026-09-07):

- stdout은 상태 유지 UTF-8 decoder와 bounded JSONL reader로 처리한다. 프레임과 최종 답변은 각각 기본 4 MiB 상한이다. 로그 tail 상한과 별도로 최종 메시지·terminal·usage를 보존한다.
- 정상 EOF, 유효한 JSONL, 최종 assistant 메시지, 성공 `turn.completed`, process exit 0이 모두 필요하다. `turn.failed`, fatal `error`, 잘린 EOF, 답변 누락은 `AGENT_INVALID_OUTPUT`이며 성공 result 이벤트를 내보내지 않는다. 이는 작업의 QualityGate 통과를 뜻하지 않는다.
- usage는 Codex 0.153.x JSONL emitter의 누적 thread total을 마지막 값으로 유지한다. 추론 토큰은 output total의 부분집합이며 다시 더하지 않는다. planner와 worker는 캡처한 사용량을 기존 invocation token 컬럼에 저장한다. 누락/잘못된 usage는 정확한 0으로 처리하지 않고 기존 heuristic + usageApproximate 경로를 사용한다. 캐시/추론 세부 단가와 실패 호출의 부분 사용량 정산은 별도 예산 단계 대상이다.
- 취소·timeout·stall의 최초 원인을 유지한다. Windows는 이번 spawn의 PID에 한해 숨김 taskkill /T /F를 실행하고 helper 종료와 child close를 모두 기다린 뒤 adapter를 종료한다. 큐는 이 종료를 기다리므로 같은 lane의 다음 호출이 먼저 시작하지 않는다. 트리 정리 실패는 진단에 명시한다. 이미 발생한 변경은 기존 finally snapshot으로 남긴다.
- 읽기 전용/검색 금지 요청의 MCP inventory를 확인하지 못하면 `TASK_CONTRACT_PREFLIGHT_FAILED`로 모델 spawn 전에 중단한다.
- planner와 local worker의 기본 Codex adapter는 TaskContract에 맞춘 `--output-schema` v1을 사용한다. schemaVersion과 taskIntent가 고정되고 누락/추가 필드와 잘못된 타입을 host에서도 검증한다. 읽기 전용 계약은 변경 제안과 실행형 quality check가 없어야 하며, 검색 금지 계약은 shell 제안도 허용하지 않는다. 검증 실패는 `AGENT_INVALID_OUTPUT`이고 성공 result 이벤트나 실행 제안을 만들지 않는다. QA 통과/완료를 뜻하지는 않는다.
- 호출 전 선택된 CLI의 버전 식별과 `exec --help`의 output-schema 지원을 점검한다. 실패하면 `TASK_CONTRACT_PREFLIGHT_FAILED`로 모델 spawn 전에 중단한다. 호출별 임시 스키마는 병렬 실행 간 공유하지 않으며 생성한 파일/빈 디렉터리만 정리한다. 경로 변경이나 정리 오류는 경고로 남기고 원래 오류를 보존한다.
- 새 IPC 채널/DB migration은 없다. 검증된 JSON은 기존 harness_agent_plan으로 정규화하여 UI/approval과 호환한다. 서비스 파싱은 로그 미리보기 상한과 독립적이며 표시용 메타데이터의 비밀값을 가린다. 승인·실행용 path/preimage/after/patch/command/args와 명령의 원문은 보존한다. 주입형/가짜 adapter와 저장된 legacy plan 호환은 유지하되, worker도 파싱 실패를 성공으로 저장하지 않는다.

최종 출력 스키마 근거: [Codex structured output](https://learn.chatgpt.com/docs/non-interactive-mode), [Structured Outputs 제약](https://developers.openai.com/api/docs/guides/structured-outputs).

사용량 근거: [Codex 0.153.4 JSONL emitter](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/exec/src/event_processor_with_jsonl_output.rs), [OpenAI reasoning usage](https://developers.openai.com/api/docs/guides/reasoning#managing-the-context-window). 취소 범위: [Windows taskkill](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill).

```ts
agent.checkProviders(): Promise<AgentProviderStatusMap>;
agent.generatePlan(input: {
  taskRunId: string; // must be a TaskRun created with mode="agent"
  provider?: AgentProvider;
  model?: string;
  instruction?: string;
  pinnedObservationContexts?: ObservationRecallResult[]; // max 5, explicit user selection only
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

`pinnedObservationContexts`는 `learner.recallContext` 결과 중 사용자가 명시적으로 선택한 항목만 받는다. agent prompt와 context pack artifact에는 redacted summary, provenance id, compact outcome metadata(`usedCount`/`failedCount`/`lastStatus`/`scoreAdjustment`/`reuseRisk`)만 들어간다. 실패 이력은 advisory warning으로만 노출되며 runner 권한이나 approval 상태를 바꾸지 않는다. handler는 배열 크기와 summary 길이, outcome shape를 제한한다.

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
type AgentProvider = "codex";

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
- `file_write.after`는 승인 후 파일 전체를 대체할 완전한 UTF-8 파일 본문이다. diff, TODO, "이 파일에 추가하세요" 같은 자연어 수정 지시문이 아니다.
- 각 `proposedActions[i]`는 기존 `validateProposedActionDetails` 게이트(절대경로/`..`/NUL/자연어 `after` 지시문 차단)를 통과해야 approval row가 만들어진다. 통과 못 한 항목은 drop되고 `quality_report` artifact에 사유가 기록된다 (filter, not all-or-nothing).
- `proposedActions.length === 0` → TaskRun을 `ready_for_review`로 (answer-only 경로).
- `proposedActions.length > 0` → TaskRun을 `waiting_for_approval`로.
- prompt/raw_output artifact는 저장 직전 `redactSecrets`로 마스킹된다.
- 공통 마스킹은 core의 순수 함수이며 기존 learner API는 이를 재노출한다. local/A2A의 tool input·prompt/output/worker 감사 로그·표시 메타데이터와 오류 경계에서 JSON의 중첩/배열/escaped key 및 미완성 quoted 값을 가린다. 실제 원격 요청과 승인·실행·정확한 handoff 복구에 필요한 payload는 감사 복사본과 구분하여 원문을 유지한다.
- invocation별 감사 stream은 분리된 stdout/stderr/assistant 채널의 행/JSON 경계 또는 종료까지 텍스트를 결합해 마스킹하고 이벤트 순서를 유지한다. 보류 텍스트는 최대 64 Ki UTF-16 code units, 보류 이벤트는 256개다. 넘치면 raw를 보내지 않고 생략 표식을 남기며 다음 안전 경계에서 재개한다. 감사 callback 오류가 MCP 자원 정리나 원래 종료 결과를 건너뛰지 않게 한다. 이 정책은 임의의 알 수 없는 비밀 문자열을 모두 탐지한다는 보장은 아니다.
- invocation 취소 수명은 MCP/추천 준비부터 queue 대기, 모델 호출, 결과 정리까지 포함한다. 준비 중 취소 후에는 queue/adapter 진입을 차단하고 준비 자원을 정리한다. 기존 MCP 준비 hook은 AbortSignal을 받지 않으므로 취소 상태는 먼저 저장하되, 이미 시작한 준비가 끝나거나 실패하면 cleanup한다. SQLite의 `cancelled` invocation은 늦은 running/succeeded/failed 갱신으로 덮지 않으며, 이미 성공/실패한 invocation을 뒤늦은 취소가 변경하지 않는다.
- retained CLI tail은 stdout 4 MiB, stderr 1 MiB로 제한한다. normalized/persisted stream은 각각 최대 4,096 events 및 4 MiB이며 누락된 byte/event 수를 transcript의 truncation marker에 기록한다.
- A2A worker는 profile의 timeout을 discovery 시작부터 적용한다(직접 호출 기본값 300초). 이미 취소됐으면 discovery를 시작하지 않는다. Agent Card fetch/body, SDK client 준비, send, iterator 대기는 상위 signal 및 남은 실행 수명에 연결된다. signal을 무시하는 Promise/iterator도 로컬 대기를 끝내며, 늦게 도착한 body/stream은 취소·반환한다. 종료 시 timer와 listener를 해제하고 iterator return이 끝없이 대기해도 원래 취소/실패를 붙잡지 않는다. 이는 원격 서버의 작업 취소 완료나 exactly-once 보장이 아니다.
- A2A 기본 한도는 Agent Card 256 KiB, 전체 HTTP body 합계 4 MiB, 각 decoded event 1 MiB, raw SDK/adapter event 각각 4,096개, artifact 128개·각 1 MiB·합계 4 MiB, 최종 text 4 MiB다. UTF-8 byte를 세며 text join 구분자도 포함한다. 설치된 JSON-RPC/HTTP+JSON SDK transport의 fetch를 감싸 JSON/SSE parsing 전에 body를 제한한다. Content-Length만 신뢰하지 않고 실제 수신 chunk를 센다. JSON 순회는 depth 32/node 100,000으로 제한하며 cycle·accessor·비 JSON 객체는 미검증 성공으로 반환하지 않는다.
- 한도는 독립적이며 먼저 초과한 한도에서 `A2A_RESPONSE_LIMIT`로 실패한다. deadline은 `A2A_REQUEST_TIMEOUT`, 상위 취소는 `AbortError`로 구분하며 성공 result·추가 approval을 만들지 않는다. 완성된 remote state 이후라도 response를 수집하다 초과하면 성공으로 확정하지 않는다. normalized diagnostic tail은 최대 256 events/256 KiB이고 누락 수를 반환한다. text/artifact 실행 결과는 tail로 잘라 성공시키지 않는다. SDK transport 기본 text 변환은 원문 보존이며 감사 마스킹은 기존 main 경계가 담당한다. Markdown의 JSON 문자열 안에 중첩된 JSON도 감사 복사본에서 검사한다.
- repository context의 `maxBytes`는 절단 표시 `\n[...repo context truncated]`를 포함한 UTF-8 hard cap이다(기본 10 KiB). 0~1023도 그대로 적용하며 표시에 필요한 byte조차 부족하면 빈 section을 반환한다. 음수/NaN/Infinity는 거부하고 소수는 내림한다. summary/section 절단은 surrogate pair 및 UTF-8 code point 경계를 보존한다. 파일 ranking/선택 및 prompt 목적은 변경하지 않는다.
- provider/renderer의 미완성 line은 256 KiB, renderer 집계 text는 512 KiB, tool input은 64 KiB로 제한한다. renderer는 raw/tool/assistant burst를 animation frame 단위로 batch하고 result/hydration은 즉시 flush한다.

오류:

- `AGENT_SPAWN_FAILED` — CLI 바이너리 미설치/권한
- `AGENT_CANCELLED` — 사용자 cancel
- `AGENT_BUDGET_UNVERIFIABLE` — 프로필에 USD cap이 있으나 CLI 과금 방식/호출 전 비용 상한을 검증할 수 없어 planner/local worker를 모델·MCP 준비 이전에 차단. 승인이나 호출별 모델 override로 우회할 수 없음.

planner의 이 사전 검사 실패는 TaskRun의 `blocked` 상태와 실패한 plan step의 `outputSummary`에 오류 코드·이유를 저장한다. 같은 TaskRun의 중복 차단 기록은 억제하며, 모델 invocation/approval은 생성하지 않는다. `generatePlan` 오류 반환 시에도 `taskRunChanged`를 전송하므로 renderer는 최신 상태를 다시 읽을 수 있다. 프로필 한도를 자동 해제하거나 자동 재시도하지 않는다. worker의 실패 상태 기록은 기존 orchestration 경로가 담당한다.
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

- `agent`: legacy single-agent fallback 설정. provider는 `codex`로 고정되고 모델은 `gpt-6-astra` / `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` 중 하나다. 이전 provider/model 값은 `codex` / `gpt-5.6-sol`로 정규화한다. reasoning effort는 `none` / `low` / `medium` / `high` / `xhigh` / `max` 중 하나이며 기본값은 `medium`이다. `gpt-6-astra`에서 `none`은 실행 시 `low`로 정규화한다.
- `agent.codexWorkspaceWrite`: 기본값 `false`. `true`이면 Codex CLI direct-write 예외가 활성화되므로 사후 diff 검토가 필요하다.
- `orchestration`: orchestration enable/default mode/default pipeline 설정
- `approval`: auto approval 편의 설정. 실제 실행 가능 여부는 service-layer `PolicyEvaluation`이 최종 결정한다.
  - `approval.autoApprove`: 일반 자동 승인/실행 토글. 기본값은 `false`.
  - `approval.autoExecuteWorkerFileActions`: worker가 생성한 `file_write`/`file_patch` approval만 자동 승인 후 실행한다. 기본값은 `true`이며, approval row는 감사/실행 경계로 계속 생성된다.
  - `approval.workerFileAutoExecutionConfigured`: 사용자가 worker 파일 자동 실행 토글을 명시적으로 변경했는지 나타내는 호환성 플래그다. 과거 설정 row의 `false` 기본값은 이 값이 `true`가 아닌 한 새 기본값 `true`로 승격된다.
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
  provider?: "codex";
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
- `delete`는 해당 profile을 참조하는 AgentPipeline 또는 Harness binding set이 있으면 각각 `PIPELINE_IN_USE_BY_PROFILE_DELETE`, `HARNESS_BINDING_IN_USE_BY_PROFILE_DELETE`로 거부한다.
- profile permissions는 approval UI 자동화보다 우선하는 block/allow context로 사용된다.
- profile permissions의 optional `budget`은 per-invocation / per-TaskRun / per-day USD 자동 승인 및 모델 호출 전 검사의 입력이다. `agent_profiles.budget_json`이 NULL이면 앱의 USD 제한은 적용하지 않는다. 비용이나 필요한 누적 사용량이 미확인이면 cap을 통과시키지 않는다. 현재 CLI의 검증된 과금 방식/호출 전 상한이 없으므로 cap이 설정된 planner/local worker는 `AGENT_BUDGET_UNVERIFIABLE`로 실행 전에 거부한다. 로컬 파일 적용 자체는 새 모델 호출이 아니며 기존 승인·Runner 경계를 유지한다. 병렬 예산의 원자적 예약·정산은 아직 미구현이다.
- 지원되는 저장 프로필의 모델/추론 수준은 기본 제공 seed도 재시작 시 보존한다. 활성/default 프로필은 고정 선택으로 해석해 Learner 추천보다 우선하며, 명시적인 호출별 모델 override는 유지한다. 지원이 끝난 모델만 역할 기본값으로 호환 변환한다.
- transcript result 이벤트의 `usage` 메타데이터에는 `cost_status`(estimated/unknown), `cost_source`(api_token_estimate/unavailable), optional `cost_unknown_reason`, `cached_input_tokens`, `reasoning_output_tokens`를 기록한다. 이 상태는 토큰 기반 추정의 상태다. 정확한 모델 ID의 완전한 가격표와 검증된 API 과금 모드가 없으면 USD를 산출하지 않는다. API 토큰 추정은 청구액이 아니며 구독 크레딧과 혼용하지 않는다. 신규 IPC 채널/DB migration은 없다.

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
- `refresh`는 요청 source 하나를 기준으로 scan count를 반환하지만, capability registry 반영은 DB에 등록된 enabled source 전체를 같은 변환 규칙으로 재계산한다. script는 실행하지 않으며 `scannedCount`, `updatedCount`, `skillCount`를 반환한다.
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

## `window.harness.harnessPackages`

Claude `.claude`, Codex `AGENTS.md` + `skills/*/SKILL.md`, 그리고 Harness-native
`.harness` package를 provider-neutral `HarnessDefinition` snapshot으로 import한다.
이 namespace는 metadata registry만 담당하며, 실행은 항상 별도 orchestration/manual review
흐름에서 처리한다.

```ts
harnessPackages.list(): Promise<HarnessDefinition[]>;
harnessPackages.get(input: { packageId: string }): Promise<HarnessDefinition>;
harnessPackages.create(input: {
  package: CreateHarnessPackageInput;
}): Promise<HarnessDefinition>;
harnessPackages.importDirectory(input: {
  rootDir: string;
}): Promise<HarnessPackageImportDirectoryResult>;
harnessPackages.repair(input: HarnessPackageRepairInput): Promise<HarnessPackageRepairResult>;
harnessPackages.previewExport(input: HarnessPackageExportPreviewInput): Promise<HarnessPackageExportPreview>;
harnessPackages.proposeExport(input: HarnessPackageExportProposalInput): Promise<HarnessPackageExportProposalResult>;
harnessPackages.previewPipelineDraft(input: {
  packageId: string;
  workflowId?: string;
  bindings: readonly HarnessAgentProfileBinding[];
  providers?: AgentProviderStatusMap;
}): Promise<HarnessPipelineDraftPreviewResult>;
harnessPackages.listBindingSets(input?: {
  packageId?: string;
  workflowId?: string;
}): Promise<HarnessBindingSet[]>;
harnessPackages.getBindingSet(input: { bindingSetId: string }): Promise<HarnessBindingSet>;
harnessPackages.saveBindingSet(input: {
  bindingSet: CreateHarnessBindingSetInput | HarnessBindingSet;
}): Promise<HarnessBindingSet>;
harnessPackages.removeBindingSet(input: { bindingSetId: string }): Promise<void>;
harnessPackages.remove(input: { packageId: string }): Promise<void>;
```

```ts
type HarnessPackageImportDirectoryResult =
  | {
      ok: true;
      definition: HarnessDefinition;
      detection: HarnessSourceDetectionResult;
    }
  | {
      ok: false;
      detection: HarnessSourceDetectionResult;
      issues: readonly HarnessValidationIssue[];
    };

interface CreateHarnessPackageInput {
  name: string;
  description?: string;
  workflowName: string;
  agentRef: string;
  agentName?: string;
  agentDescription?: string;
  agentPersona?: string;
  stepTitle: string;
  stepInstruction: string;
  outputContract?: WorkerOutputContract;
  providerHint?: "auto" | "claude" | "codex";
  allowedActions?: readonly ApprovalActionType[];
}

type HarnessPipelineDraftPreviewResult =
  | {
      ok: true;
      workflowId: string;
      pipeline: CreateAgentPipelineInput;
      issues: readonly HarnessPipelineDraftIssue[];
    }
  | {
      ok: false;
      issues: readonly HarnessPipelineDraftIssue[];
    };

interface HarnessPackageRepairInput {
  packageId: string;
  note?: string;
  workflows: readonly HarnessWorkflowRepairInput[];
}

interface HarnessWorkflowRepairInput {
  workflowId: string;
  name?: string;
  description?: string;
  steps?: readonly HarnessWorkflowStepRepairInput[];
}

interface HarnessWorkflowStepRepairInput {
  stepId: string;
  title?: string;
  agentRef?: string | null;
  roleHint?: string;
  instruction?: string;
  dependsOn?: readonly string[];
  artifactContracts?: readonly HarnessArtifactContract[];
  allowedActions?: readonly ApprovalActionType[];
  outputContract?: WorkerOutputContract;
}

interface HarnessPackageRepairResult {
  definition: HarnessDefinition;
  issuesResolved: number;
}

interface HarnessPackageExportPreviewInput {
  packageId: string;
  targetFormat: "claude" | "codex" | "harness-native";
}

interface HarnessPackageExportProposalInput extends HarnessPackageExportPreviewInput {
  targetDir: string;
}

interface HarnessPackageExportPreview {
  packageId: string;
  packageName: string;
  targetFormat: "claude" | "codex" | "harness-native";
  files: readonly HarnessPackageExportFile[];
  warnings: readonly string[];
}

interface HarnessPackageExportFile {
  relativePath: string;
  content: string;
  kind: HarnessSourceFileKind;
}

interface HarnessPackageExportProposalResult {
  preview: HarnessPackageExportPreview;
  thread: Thread;
  taskRun: TaskRun;
  checkpoint: Checkpoint;
  approvals: readonly Approval[];
  targetDir: string;
}

interface CreateHarnessBindingSetInput {
  packageId: string;
  workflowId: string;
  name: string;
  bindings: readonly HarnessAgentProfileBinding[];
}

interface HarnessBindingSet extends CreateHarnessBindingSetInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}
```

동작:

- `importDirectory`는 main process에서만 디렉터리를 읽고, `.md`/`.json` metadata를 중립 snapshot으로 저장한다.
- `create`는 renderer가 보낸 typed starter input을 main/service에서 Harness-native `HarnessDefinition`으로 변환해 저장한다. renderer가 raw `HarnessDefinition` JSON을 직접 저장하지 않는다.
- direct-created package는 `source.format = "harness-native"`와 synthetic `harness://manual` provenance를 사용하며, TaskRun, approval, runner, file write를 만들지 않는다.
- import는 source directory에 파일을 쓰지 않으며 shell, git, network, runner를 호출하지 않는다.
- Claude/Codex/native format detection 결과가 ambiguous/unsupported이면 IPC 자체는 성공하고, 반환값의 `ok=false`와 `issues`로 review 상태를 전달한다.
- 저장된 package는 SQLite WAL canonical state의 `harness_packages` table에만 반영된다.
- `repair`는 기존 import snapshot을 직접 덮어쓰거나 source directory에 쓰지 않고, `repair.sourcePackageId`가 원본을 가리키는 HarnessAgentOS-owned repaired snapshot을 새 package row로 저장한다.
- repaired snapshot은 원본과 같은 `root_dir` provenance를 공유할 수 있다. `root_dir`는 source provenance이며 row uniqueness 기준이 아니다.
- `previewExport`는 저장된 snapshot을 Claude `.claude`, Codex `AGENTS.md` + `skills/*/SKILL.md`, 또는 Harness-native `.harness` declaration files로 projection한다. 이 호출은 preview-only이며 파일을 쓰지 않는다.
- `previewExport` 결과에는 TaskRun state, approvals, runtime artifacts, secrets가 포함되지 않는다. Projection에서 정보 손실 가능성이 있으면 `warnings`에 표시한다.
- `proposeExport`는 `previewExport` 결과를 `targetDir` 기준의 pending `file_write` approvals로 만든다. 호출 시에도 파일은 쓰지 않으며, 실제 디스크 반영은 기존 `runner.executeApproved` 승인 실행을 통과해야 한다.
- `previewPipelineDraft`는 저장된 snapshot과 명시적 AgentProfile binding만 사용해 `CreateAgentPipelineInput` 초안을 반환한다. pipeline row를 생성하지 않고 TaskRun, approval, runner를 만들지 않는다.
- `previewPipelineDraft.providers`는 caller가 이미 조회한 provider readiness snapshot만 전달한다. 이 IPC handler는 provider probe를 새로 실행하지 않으며, 전달된 snapshot은 readiness warning 계산에만 사용한다.
- `previewPipelineDraft`의 `ok=false`는 미바인딩 step, 누락 workflow처럼 사용자가 수정 가능한 변환 issue를 뜻한다. 알 수 없는 package id나 malformed input은 일반 IPC error로 반환한다.
- `saveBindingSet`은 package/workflow별 AgentProfile binding 조합을 SQLite `harness_binding_sets`에 저장한다. 이 row는 질문 입력창에서 direct harness orchestration source로 선택할 수 있다.
- 저장된 binding set을 `orchestration.draftPlan({ harness })`에 넘기면 planner는 `HarnessDefinition` snapshot과 binding set을 읽어 worker steps를 in-memory로 합성한다. `agent_pipelines` row는 생성하지 않는다.
- `harnessPackages.run`, `harnessPackages.apply`, `harnessPackages.writeSource` 같은 직접 실행/source-write IPC는 없다.

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
- Worker 로그만으로 완료를 복구하지 않는다. 연결된 최신 실행 Step이 `succeeded`이고 해당 artifact의 `proposals committed` 완료 표식이 있어야 한다. 성공 확정과 승인 Step/Checkpoint/제안 액션 전체는 같은 동기 SQLite transaction에 저장한다. 최신 실패/중단 로그가 있으면 이전 성공으로 대체하지 않으며, 새 완료 표식이 없는 기존 성공 기록은 `WORKER_COMPLETION_UNVERIFIED`로 중단하여 기존 액션을 자동 재발행하지 않는다.
- 병렬 wave는 비동기 liveness 확인 뒤 남은 index와 실패 여부를 다시 확인한 다음 동기로 예약한다. 저장/발행/liveness 예외가 발생하면 새 배정을 중단하고 이미 시작한 lane과 직렬 결과 발행을 모두 기다린 뒤 최초 예외를 반환한다. 이때 service의 동일 approval in-flight 소유권은 유지된다. 이미 시작한 형제 worker의 성공 완료/proposal 기록은 보존하며, task 전체 취소로 대체하지 않는다. 일반 failed 결과의 backflow 및 Pause/Cancel 정책은 유지한다.
- Worker handoff 복구는 원래 출력과 정책을 통과한 structured payload만 보존한다. 원출력의 거절된 proposal을 재추출해 승인된 제안처럼 되살리지 않는다.
- Backflow의 Pause 또는 child 액션 승인 대기는 attempt를 `running`으로 보존하고 같은 attempt에서 재개한다. `harness:orchestration/{planId}/{workerStepId}/backflow/{attemptId}` artifact와 원자적으로 확정된 Step이 해당 attempt의 완료 위치를 나타낸다. 재개 시 이전 정상 실행의 intermediate/downstream 성공을 새 backflow 결과로 재사용하지 않는다.
- Backflow도 worker 제안 승인·실행이 끝나기 전에 다음 worker를 시작하지 않는다. 품질 실패 backflow는 parent orchestration 승인이 이미 executed여도 기존 main-process progression이 일반 Resume/child 완료 이벤트에서 이어간다. task별 singleflight와 fresh snapshot으로 중복 실행을 막는다.
- Pause/Cancel과 backflow 완료 저장이 경합하면 SQLite 조건부 UPDATE가 작업 상태를 확인해 성공 확정을 차단한다. 실제 provider/replay 실패는 terminal `failed`로 예산을 소비하며, Pause 후 Resume가 이를 정상 worker 실행으로 우회하지 않는다(`PIPELINE_BACKFLOW_FAILED`). 새 품질 실패에 따른 명시적 backflow 요청에는 기존 `maxAttempts` 정책을 적용한다.
- `step_failed` rule은 실행 중 실패한 worker step과 `retryStepId`가 일치할 때만 자동 실행된다. `quality_failed` rule은 `QualityGateResult.status === "failed"`에서만 실행되며 `warning`은 기존 known-risk 승인 흐름을 유지한다.
- 앱 시작 시 role-aware 기본 템플릿을 idempotent하게 seed한다: `Product PRD Discovery`, `Evidence-First Bug Investigation`, `Docs-First Contract Reconciliation`, `Runtime Approval Hardening`, `A2A Federation Safety Review`, `Eval-Driven Release Verification`, `Cross-Harness Agent Baseline`, `Architecture RFC`, `Visual Design Delivery`, `Image Asset Prompt Flow`, `3D New Project Delivery`, `New Project Delivery`, `Frontend Product Delivery`, `Skill and Agent Expansion`, `Supervised Delivery`, `Refactor Safety`, `Parallel Review Hardening`, `Build Recovery`.
- `3D New Project Delivery`는 `PRD -> architecture -> plan -> texture-generation -> modeling -> file-composition -> class-generation -> implementation -> review -> execution-validation -> explanation -> completion` 순서의 12단계 pipeline이다. 텍스처/모델링/파일/클래스/구현 단계는 approval-gated `file_write` 제안만 만들고, 실행 검증 단계는 approval-gated `shell` 제안만 허용한다. Seed된 backflow rule은 step failure 시 앞선 dependency path를 재실행하고, final quality failure 시 `implementation`부터 `completion`까지 재검토하도록 구성된다.
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

- `events:taskRunChanged`: 모든 state-changing IPC 핸들러(`conversation.*`, `runner.executeApproved/executeCodeChangeAttempt/retryApproval/cancelExecution`, `shadow.createPreview`, `quality.*`, `orchestration.draftPlan/runApproved`, `agent.*`)가 성공 직후 발행한다. `runner.executeApproved/executeCodeChangeAttempt/retryApproval`은 runner가 실패/취소/검증 실패 상태를 DB에 기록한 뒤 에러나 실패 결과를 반환하는 경우에도 발행한다.
- 장시간 실행되는 `orchestration.runApproved`는 전체 run 종료 전에도 worker artifact 또는 worker action approval이 저장될 때 `events:taskRunChanged`를 발행할 수 있다. renderer는 이 이벤트를 받으면 fresh TaskRun detail을 pull해서 중간 worker 결과와 approval을 표시해야 한다.
- `events:agentStreamEvent`: `agent.generatePlan`/worker invocation이 진행 중일 때 CLI stdout/stderr 청크 + `started`/`assistant_text`/`result`/`failed` 메시지를 발행한다. 각 이벤트는 가능한 경우 `taskRunId`를 포함해 renderer가 invocation row를 즉시 refetch할 수 있게 한다. renderer는 자기 invocationId가 아닌 이벤트는 무시한다. 장시간 stream의 보존/파싱 상한은 `window.harness.agent` 절의 budget을 따르며, renderer는 invocation별 burst를 frame 단위로 합친다.
- `events:diagnosticsHeartbeat`: main process가 10초 interval로 발행하고, TaskRun status 변경, agent invocation 시작/종료, runner cancel 시점에는 즉시 발행한다. renderer는 `app.getDiagnostics()`로 initial fetch 후 이 이벤트만 구독한다.
- 페이로드는 위 표에 명시된 shape만 — 채널 자체로 임의의 도메인 객체를 전달하지 않는다.
- read-only IPC (예: `quality.getLatest`, `state.listThreads`)는 발행하지 않는다.

규칙:

- 새 push 채널을 추가하기 전에 이 문서를 먼저 갱신한다.
- preload는 `ipcRenderer`를 직접 노출하지 않고 `onXxx(cb): () => void` 형태로만 expose한다.
- listener는 unsubscribe를 컴포넌트 unmount 시 반드시 호출한다.

## Contract 변경 규칙

`RecentTaskRun`은 `{ taskRun: TaskRun, threadId: string, threadTitle: string }`이다.
최근 명령 조회의 limit은 정수 1..100이고 팔레트는 10을 요청한다. canonical SQLite의
TaskRun updatedAt 내림차순, 동률이면 삽입 순서 역순으로 반환한다. 답변 artifact를 읽거나
thread 상세 IPC를 fan-out하지 않는다. 상태·삭제·제목·contract 변경은 다음 요청에 반영한다.
schema 43은 품질 gate의 task-scoped 인덱스와 최근 작업의 updatedAt 인덱스를 추가하며 기존
품질 결과의 rowid 기반 최신 판정과 승인·실행 의미는 변경하지 않는다.
알림은 push를 기반으로 task별 진행 중 1회와 후속 최신 조회 1회로 합친다. 서로 다른 task의
알림 pull은 최대 4회 동시 실행하며 결과를 영구 캐시하지 않는다. detail에 포함된 gate의
삽입 순서를 사용하여 별도 최신 gate IPC를 중복 호출하지 않는다.

- IPC method 추가 시 이 문서를 먼저 갱신한다.
- 기존 method의 input/output을 breaking change로 바꾸면 migration note를 남긴다.
- renderer에 임시 channel string 호출을 추가하지 않는다.



## 실행 기반 C# 회귀 계약 (2026-10-28)

- `quality.registerRegression({taskRunId,title,referenceDir,sourcePaths,sharedPaths,verificationPaths,manualConfirmation:true})`는 사용자가 신뢰한 정상 기준 C# 소스와 공용 계약을 SQLite에 보관한다. 등록은 프로세스를 실행하지 않는다. 등록과 workspace generation 증가가 한 트랜잭션이므로 이전 품질 통과 결과로 완료할 수 없다.
- `quality.listRegressions({taskRunId})`는 등록된 필수 검사와 보호 상태를 반환한다. `quality.prepareRegression({taskRunId,contractId})`는 정확한 입력 fingerprint에 묶인 pending shell 승인을 생성한다. 기존 개별 수동 승인·실행 경로를 사용하며 자동 승인하지 않는다. 입력이 바뀌면 새 승인을 요청해야 한다.
- 승인 실행은 임시 .NET 8 콘솔 프로젝트에서 동일한 검사·공용 계약으로 정상 기준 구현, 현재 구현 순서로 컴파일·실행한다. 외부 패키지를 복원하지 않으며 기존 프로젝트의 build hooks를 가져오지 않는다. 호스트 권한 실행이므로 사용자 제공 코드도 실행 승인 범위에 포함된다.
- 정상 기준 실행이 성공한 검사만 SQLite에 한 번 보호한다. 현재 구현이 실패하더라도 유효한 검사는 유지한다. 보호된 검사·공용 계약의 file_write/file_patch/file_delete/DB export 변경을 거부하며, 정확한 원본 복구는 허용한다. 추가 검사는 별도 파일·계약으로 등록한다. 외부 shell/편집기의 변경까지 OS 수준으로 금지하지는 않으며, 그런 변경은 준비 시 보호 검사와 품질 게이트의 최신 revision 확인에서 차단한다.
- 등록된 각 검사마다 현재 revision·generation에 연결된 최신 실제 통과 결과가 필요하다. 다른 검사 통과로 대신할 수 없다. 실행 취소·시간 초과·결과 미확인은 통과 근거가 아니다. 정상 기준 실패와 현재 구현 실패는 결과 로그에 구분한다.
- 등록된 구현·검사·공용 계약 경로는 Git ignore와 일반 build 폴더 제외 규칙보다 우선한다. Runner의 시작/종료, 품질 평가, Done 직전 확인 모두 같은 명시 경로 집합을 실제로 읽어 확인한다.
- 현재 범위는 명시적으로 등록한 TaskRun의 C# 파일, 외부 패키지 없는 단일 Main 콘솔 검사다. 정상 기준의 정확성은 사용자가 결정한다. 등록되지 않은 검사나 모든 언어의 검사 의미를 자동 증명하는 기능은 아니다. SQLite schema v45를 사용한다.

## 앱 정상 종료 수명 (2026-10-27)

- 정상 창 닫기/Electron quit는 `before-quit`에서 신규 IPC/Agent/Runner 진입과 자동 progression을 먼저 차단한다. 이미 시작한 IPC는 결과/cleanup 정산까지 소유한다. 종료 중 새 요청은 `APPLICATION_SHUTTING_DOWN`으로 거절될 수 있다. IPC 채널·preload 권한·SQLite schema는 추가/변경하지 않는다.
- 현재 drafting/running 작업 및 등록된 실행 owner는 먼저 Pause하여 새 배정을 막는다. 정산 후 중단된 단독 Agent/Runner는 기존 재계획·결과 검토 경로인 blocked로 남기고, pipeline은 paused로 보존하여 명시적 Resume을 기다린다. 기존 사용자 Pause 및 실행 owner가 없는 대기 승인·재검토 필요 상태·done/cancelled는 유지한다. Agent invocation 취소, Runner AbortSignal, A2A router signal은 진행 중 작업의 실제 정리까지 기다린다. 준비/발행 중 작업도 entry부터 추적하여 controller 등록 전 틈으로 새 CLI를 시작하지 않는다.
- callback/직렬 결과 발행, MCP/schema cleanup, parent orchestration/backflow, startup, 진단 heartbeat의 진행 중 read 및 기존 IPC가 정산된 뒤에 DB를 닫는다. 이 과정은 승인 내용을 바꾸거나 파일 부수효과를 되돌리지 않는다. 임의 shell의 claim은 기존 `uncertain`·실행 결과 검토·새 수동 승인 계약을 유지한다. 종료를 이유로 성공/실패를 임의 확정하거나 기존 승인을 재실행하지 않는다.
- 기본 정산 제한은 20초다. timeout 또는 프로세스 정리/결과 저장을 확인하지 못하면 DB를 열어 두고 오류를 알리며 새 실행 차단을 유지한다. 자동 강제 종료하지 않는다. timeout 뒤 정산 완료 시 재시도가 가능하지만, 미확정 종료/저장 오류는 자동으로 안전 판정으로 바꾸지 않는다. OS 강제 종료와 원격 서버의 작업 중단을 보장하는 계약은 아니다.

- `registerRegression`은 `referenceDir`에 더해 선택적인 `additionalReferenceDirs: string[]`(최대 3개)를 받는다. 사용자가 같은 계약의 정상 구현으로 명시적으로 신뢰한 절대 경로만 등록하며, 기준 소스 집합은 SQLite 등록 시 동결한다. 중복 경로/내용과 전체 8 MiB 상한 초과는 거부한다. 반환 summary의 `referenceCount`는 기준 집합 크기이며 구 데이터는 1개로 해석한다. 등록은 코드 실행 승인이 아니며 `prepareRegression`이 만든 pending 승인 후 Runner가 실행한다.
- 같은 검사·공용 계약으로 기준을 모두 실행하고 전부 통과해야 검사 보호 및 후보 실행이 가능하다. 나중 기준의 실패·취소·입력 변경으로 앞선 일부 성공을 보호/완료로 승격하지 않는다. 기준 집합의 reference phase 전체 120초 예산을 공유한다. 호스트 증거의 선택적 `references: {total, exits}`는 순서 있는 실제 종료 코드이며 전체 성공·실패/미실행을 구분한다. 이미 보호한 기존 검사는 추가 기준의 등록만으로 해제하지 않는다.
