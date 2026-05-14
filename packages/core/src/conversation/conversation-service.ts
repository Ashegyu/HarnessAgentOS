import type {
  Approval,
  Artifact,
  Checkpoint,
  ProposedActionDetails,
  Step,
  TaskRun,
  Thread,
} from "../types/index.ts";
import {
  validateAbsoluteTargetDir,
  type PathExistsFn,
} from "./target-dir.ts";
import { draftPlan } from "./plan-drafter.ts";
import { toProposedAction } from "./approval-policy.ts";
import type { ConversationStateGateway } from "./state-gateway.ts";
import type {
  ApproveInput,
  CancelTaskInput,
  ConversationTaskDraft,
  CreateConversationTaskInput,
  PauseTaskInput,
  RedirectTaskInput,
  RejectApprovalInput,
  ResumeTaskInput,
  TemplateFallbackResult,
  UseTemplateFallbackInput,
} from "./types.ts";

export class ConversationServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ConversationServiceError";
  }
}

export interface ConversationServiceDeps {
  state: ConversationStateGateway;
  pathExists: PathExistsFn;
}

/**
 * Phase 2 conversation orchestration. Turns user requests into
 * (TaskRun, plan Artifact, Checkpoint, Approvals) without performing
 * any side effects. Approval/reject/redirect flows are also handled.
 *
 * Phase 2 does NOT wrap the multi-row creation in a single DB
 * transaction because LocalStateService repository methods return
 * Promise<T> while better-sqlite3 transactions require synchronous
 * bodies. If a mid-flow insert fails, the partial rows remain but are
 * inert (no consumer references them without a TaskRun reaching
 * waiting_for_approval). Phase 3 may refactor to strict atomicity.
 */
export class ConversationService {
  private readonly deps: ConversationServiceDeps;
  constructor(deps: ConversationServiceDeps) {
    this.deps = deps;
  }

  async createTask(
    input: CreateConversationTaskInput,
  ): Promise<ConversationTaskDraft> {
    const userRequest = (input.userRequest ?? "").trim();
    if (userRequest.length === 0) {
      throw new ConversationServiceError(
        "CONVERSATION_EMPTY_REQUEST",
        "userRequest must be a non-empty string",
      );
    }

    // Phase 2 requires an absolute targetDir for any TaskRun.
    const targetDirInput = input.targetDir;
    let targetDir: string;
    if (targetDirInput === undefined) {
      // If no explicit targetDir, fall back to the parent thread's targetDir.
      if (!input.threadId) {
        throw new ConversationServiceError(
          "CONVERSATION_INVALID_TARGET_DIR",
          "targetDir is required when threadId is not provided",
        );
      }
      const parentThread = await this.deps.state.getThread(input.threadId);
      if (!parentThread) {
        throw new ConversationServiceError(
          "CONVERSATION_TASK_NOT_FOUND",
          `Thread ${input.threadId} not found`,
        );
      }
      if (!parentThread.targetDir) {
        throw new ConversationServiceError(
          "CONVERSATION_INVALID_TARGET_DIR",
          "Parent thread has no targetDir; provide one with the request",
        );
      }
      const v = validateAbsoluteTargetDir(parentThread.targetDir);
      if (!v.ok) {
        throw new ConversationServiceError(
          "CONVERSATION_INVALID_TARGET_DIR",
          v.reason,
        );
      }
      targetDir = v.normalized;
    } else {
      const v = validateAbsoluteTargetDir(targetDirInput);
      if (!v.ok) {
        throw new ConversationServiceError(
          "CONVERSATION_INVALID_TARGET_DIR",
          v.reason,
        );
      }
      targetDir = v.normalized;
    }

    const exists = await this.deps.pathExists(targetDir);
    if (!exists) {
      throw new ConversationServiceError(
        "CONVERSATION_INVALID_TARGET_DIR",
        `targetDir does not exist: ${targetDir}`,
      );
    }

    // Resolve or create the thread.
    let thread: Thread;
    if (input.threadId) {
      const existing = await this.deps.state.getThread(input.threadId);
      if (!existing) {
        throw new ConversationServiceError(
          "CONVERSATION_TASK_NOT_FOUND",
          `Thread ${input.threadId} not found`,
        );
      }
      thread = existing;
    } else {
      thread = await this.deps.state.createThread({
        title: deriveThreadTitle(userRequest),
        targetDir,
      });
    }

    // 1. Create TaskRun in drafting state.
    const taskRun = await this.deps.state.createTaskRun({
      threadId: thread.id,
      userRequest,
      targetDir,
      status: "drafting",
    });

    // 2. inspect Step (immediately succeeded with summary).
    const inspectStep = await this.deps.state.createStep({
      taskRunId: taskRun.id,
      index: 0,
      kind: "inspect",
      title: "대상 폴더와 요청 분석",
      status: "running",
      inputSummary: `targetDir=${targetDir}`,
    });
    await this.deps.state.setStepStatus(inspectStep.id, "succeeded", {
      outputSummary: "Inspect placeholder — Phase 3 runner가 실제 분석을 수행합니다.",
    });

    // Phase 8 — agent mode short-circuit: skip deterministic plan-drafter
    // so we don't create a placeholder approval that the agent would have
    // to invalidate. Caller follows up with `agent.generatePlan`.
    if (input.mode === "agent") {
      const placeholderStep = await this.deps.state.createStep({
        taskRunId: taskRun.id,
        index: 1,
        kind: "plan",
        title: "Agent plan 대기",
        status: "pending",
        inputSummary: userRequest.slice(0, 200),
      });
      const planArtifact = await this.deps.state.createArtifact({
        taskRunId: taskRun.id,
        stepId: placeholderStep.id,
        kind: "plan",
        title: "Awaiting agent plan",
        uri: planUri(taskRun.id),
        summary:
          "Agent mode TaskRun — call `agent.generatePlan(taskRunId)` to produce a plan and approvals.",
      });
      const checkpoint = await this.deps.state.createCheckpoint({
        taskRunId: taskRun.id,
        stepId: placeholderStep.id,
        reason: "before_edit",
        stateRef: stateRefJson({
          taskRunStatus: "drafting",
          currentStepId: placeholderStep.id,
          artifactIds: [planArtifact.id],
          targetDir,
          mode: "agent",
        }),
        summary: "agent mode placeholder checkpoint",
      });
      await this.deps.state.setTaskRunCurrentStep(taskRun.id, placeholderStep.id);
      // Status stays `drafting`; `agent.generatePlan` flips it.
      return {
        taskRun,
        planArtifact,
        checkpoint,
        approvals: [],
      };
    }

    // 3. plan Step + plan artifact.
    const planStep = await this.deps.state.createStep({
      taskRunId: taskRun.id,
      index: 1,
      kind: "plan",
      title: "변경 계획 수립",
      status: "running",
      inputSummary: userRequest.slice(0, 200),
    });
    const drafted = draftPlan({ userRequest, targetDir });
    const planArtifact = await this.deps.state.createArtifact({
      taskRunId: taskRun.id,
      stepId: planStep.id,
      kind: "plan",
      title: drafted.title,
      uri: planUri(taskRun.id),
      summary: drafted.content,
    });
    await this.deps.state.setStepStatus(planStep.id, "succeeded", {
      outputSummary: `plan artifact ${planArtifact.id}`,
    });

    // 4. approval Step + before_edit checkpoint + approval rows.
    const approvalStep = await this.deps.state.createStep({
      taskRunId: taskRun.id,
      index: 2,
      kind: "approval",
      title: "사용자 승인 대기",
      status: "pending",
      inputSummary: drafted.proposedActions.map((a) => a.type).join(","),
    });

    const checkpoint = await this.deps.state.createCheckpoint({
      taskRunId: taskRun.id,
      stepId: approvalStep.id,
      reason: "before_edit",
      stateRef: stateRefJson({
        taskRunStatus: "waiting_for_approval",
        currentStepId: approvalStep.id,
        artifactIds: [planArtifact.id],
        targetDir,
      }),
      summary: `before_edit checkpoint for "${drafted.title}"`,
    });

    const approvals: Approval[] = [];
    for (const action of drafted.proposedActions) {
      const approval = await this.deps.state.createApproval({
        taskRunId: taskRun.id,
        checkpointId: checkpoint.id,
        actionType: action.type,
        actionSummary: action.summary,
        status: "pending",
      });
      approvals.push(approval);
    }

    // 5. Promote TaskRun + currentStep state.
    await this.deps.state.setTaskRunCurrentStep(taskRun.id, approvalStep.id);
    const finalTaskRun = await this.deps.state.setTaskRunStatus(
      taskRun.id,
      "waiting_for_approval",
    );

    return {
      taskRun: finalTaskRun,
      planArtifact,
      checkpoint,
      approvals,
    };
  }

  async setProposedAction(
    approvalId: string,
    details: ProposedActionDetails,
  ): Promise<Approval> {
    const approval = await this.deps.state.getApproval(approvalId);
    if (!approval) {
      throw new ConversationServiceError(
        "APPROVAL_NOT_FOUND",
        `Approval ${approvalId} not found`,
      );
    }
    if (details.type !== approval.actionType) {
      throw new ConversationServiceError(
        "CONVERSATION_PROPOSED_ACTION_TYPE_MISMATCH",
        `proposedAction.type (${details.type}) must match approval.actionType (${approval.actionType})`,
      );
    }
    return this.deps.state.setApprovalProposedAction(approvalId, details);
  }

  async approve(input: ApproveInput): Promise<Approval> {
    const approval = await this.deps.state.getApproval(input.approvalId);
    if (!approval) {
      throw new ConversationServiceError(
        "APPROVAL_NOT_FOUND",
        `Approval ${input.approvalId} not found`,
      );
    }
    const decision =
      input.scope === "run_action_class" ? "always_approved_for_run" : "approved";
    if (input.scope !== "run_action_class") {
      return this.deps.state.decideApproval(
        input.approvalId,
        decision,
        input.message,
      );
    }

    const pending = await this.deps.state.listPendingApprovalsForTaskRun(
      approval.taskRunId,
    );
    const sameActionClass = pending.filter(
      (a) => a.actionType === approval.actionType,
    );
    if (!sameActionClass.some((a) => a.id === approval.id)) {
      sameActionClass.push(approval);
    }

    let updatedSelected: Approval | null = null;
    for (const a of sameActionClass) {
      const updated = await this.deps.state.decideApproval(
        a.id,
        decision,
        input.message,
      );
      if (a.id === approval.id) updatedSelected = updated;
    }
    if (updatedSelected) return updatedSelected;
    return this.deps.state.decideApproval(
      input.approvalId,
      decision,
      input.message,
    );
  }

  async rejectApproval(input: RejectApprovalInput): Promise<Approval> {
    const message = (input.message ?? "").trim();
    if (message.length === 0) {
      throw new ConversationServiceError(
        "APPROVAL_MESSAGE_REQUIRED",
        "Reject reason message is required",
      );
    }
    const approval = await this.deps.state.getApproval(input.approvalId);
    if (!approval) {
      throw new ConversationServiceError(
        "APPROVAL_NOT_FOUND",
        `Approval ${input.approvalId} not found`,
      );
    }
    const updated = await this.deps.state.decideApproval(
      input.approvalId,
      "rejected",
      message,
    );
    // Pause the parent TaskRun so the user can decide redirect/cancel.
    await this.deps.state.setTaskRunStatus(approval.taskRunId, "paused");
    return updated;
  }

  async redirectTask(input: RedirectTaskInput): Promise<ConversationTaskDraft> {
    const instruction = (input.instruction ?? "").trim();
    if (instruction.length === 0) {
      throw new ConversationServiceError(
        "CONVERSATION_EMPTY_REQUEST",
        "Redirect instruction must be a non-empty string",
      );
    }
    const taskRun = await this.deps.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new ConversationServiceError(
        "CONVERSATION_TASK_NOT_FOUND",
        `TaskRun ${input.taskRunId} not found`,
      );
    }

    // 1. Mark any pending approvals as rejected with system reason.
    const pending = await this.deps.state.listPendingApprovalsForTaskRun(
      taskRun.id,
    );
    for (const a of pending) {
      await this.deps.state.decideApproval(
        a.id,
        "rejected",
        `Replaced by redirect: ${instruction.slice(0, 200)}`,
      );
    }

    // 2. New plan step + artifact + checkpoint + approvals.
    const stepIndex = await this.nextStepIndex(taskRun.id);
    const newPlanStep = await this.deps.state.createStep({
      taskRunId: taskRun.id,
      index: stepIndex,
      kind: "plan",
      title: "재계획",
      status: "running",
      inputSummary: instruction.slice(0, 200),
    });
    const drafted = draftPlan({
      userRequest: taskRun.userRequest,
      targetDir: taskRun.targetDir,
      redirectFrom: { previousPlanContent: "", instruction },
    });
    const planArtifact = await this.deps.state.createArtifact({
      taskRunId: taskRun.id,
      stepId: newPlanStep.id,
      kind: "plan",
      title: drafted.title,
      uri: planUri(taskRun.id),
      summary: drafted.content,
    });
    await this.deps.state.setStepStatus(newPlanStep.id, "succeeded", {
      outputSummary: `redirect plan artifact ${planArtifact.id}`,
    });

    const newApprovalStep = await this.deps.state.createStep({
      taskRunId: taskRun.id,
      index: stepIndex + 1,
      kind: "approval",
      title: "재승인 대기",
      status: "pending",
      inputSummary: drafted.proposedActions.map((a) => a.type).join(","),
    });
    const checkpoint = await this.deps.state.createCheckpoint({
      taskRunId: taskRun.id,
      stepId: newApprovalStep.id,
      reason: "before_edit",
      stateRef: stateRefJson({
        taskRunStatus: "waiting_for_approval",
        currentStepId: newApprovalStep.id,
        artifactIds: [planArtifact.id],
        targetDir: taskRun.targetDir,
        redirectInstruction: instruction,
      }),
      summary: `redirect before_edit checkpoint`,
    });
    const approvals: Approval[] = [];
    for (const action of drafted.proposedActions) {
      approvals.push(
        await this.deps.state.createApproval({
          taskRunId: taskRun.id,
          checkpointId: checkpoint.id,
          actionType: action.type,
          actionSummary: action.summary,
          status: "pending",
        }),
      );
    }
    await this.deps.state.setTaskRunCurrentStep(taskRun.id, newApprovalStep.id);
    const finalTaskRun = await this.deps.state.setTaskRunStatus(
      taskRun.id,
      "waiting_for_approval",
    );

    return {
      taskRun: finalTaskRun,
      planArtifact,
      checkpoint,
      approvals,
    };
  }

  /**
   * Move a running/waiting_for_approval TaskRun to paused. Pending
   * approvals stay pending so resume can pick up where it left off.
   */
  async pauseTask(input: PauseTaskInput): Promise<TaskRun> {
    const taskRun = await this.deps.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new ConversationServiceError(
        "CONVERSATION_TASK_NOT_FOUND",
        `TaskRun ${input.taskRunId} not found`,
      );
    }
    if (
      taskRun.status !== "running" &&
      taskRun.status !== "waiting_for_approval"
    ) {
      throw new ConversationServiceError(
        "CONVERSATION_INVALID_STATE",
        `Cannot pause TaskRun in status ${taskRun.status}`,
      );
    }
    return this.deps.state.setTaskRunStatus(taskRun.id, "paused");
  }

  /**
   * Restore a paused TaskRun. If pending approvals remain, return to
   * waiting_for_approval so the user can decide on them; otherwise if
   * a currentStep is recorded, return to running. Per design.md
   * §2.3 ("resume은 이전 성공 단계부터 재실행하지 않아야 한다"),
   * resume never re-creates already-succeeded work.
   */
  async resumeTask(input: ResumeTaskInput): Promise<TaskRun> {
    const taskRun = await this.deps.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new ConversationServiceError(
        "CONVERSATION_TASK_NOT_FOUND",
        `TaskRun ${input.taskRunId} not found`,
      );
    }
    if (taskRun.status !== "paused") {
      throw new ConversationServiceError(
        "CONVERSATION_INVALID_STATE",
        `Cannot resume TaskRun in status ${taskRun.status}`,
      );
    }
    const pending = await this.deps.state.listPendingApprovalsForTaskRun(
      taskRun.id,
    );
    if (pending.length > 0) {
      return this.deps.state.setTaskRunStatus(
        taskRun.id,
        "waiting_for_approval",
      );
    }
    if (taskRun.currentStepId) {
      return this.deps.state.setTaskRunStatus(taskRun.id, "running");
    }
    throw new ConversationServiceError(
      "CONVERSATION_NOTHING_TO_RESUME",
      "TaskRun has no pending approvals or in-flight step; use redirectTask instead",
    );
  }

  /**
   * Terminate a TaskRun. Marks all pending approvals as rejected with
   * the cancellation reason and persists a quality_report artifact
   * recording why. Refuses to operate on already-terminal states.
   */
  async cancelTask(input: CancelTaskInput): Promise<TaskRun> {
    const reason = (input.reason ?? "").trim();
    if (reason.length === 0) {
      throw new ConversationServiceError(
        "CONVERSATION_REASON_REQUIRED",
        "Cancel requires a non-empty reason",
      );
    }
    const taskRun = await this.deps.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new ConversationServiceError(
        "CONVERSATION_TASK_NOT_FOUND",
        `TaskRun ${input.taskRunId} not found`,
      );
    }
    if (taskRun.status === "done" || taskRun.status === "cancelled") {
      throw new ConversationServiceError(
        "CONVERSATION_INVALID_STATE",
        `TaskRun is already ${taskRun.status}; cannot cancel`,
      );
    }
    const pending = await this.deps.state.listPendingApprovalsForTaskRun(
      taskRun.id,
    );
    for (const a of pending) {
      await this.deps.state.decideApproval(
        a.id,
        "rejected",
        `Cancelled: ${reason.slice(0, 200)}`,
      );
    }
    const stepIndex = await this.nextStepIndex(taskRun.id);
    const cancelStep = await this.deps.state.createStep({
      taskRunId: taskRun.id,
      index: stepIndex,
      kind: "summarize",
      title: "TaskRun 취소",
      status: "running",
      inputSummary: reason.slice(0, 200),
    });
    await this.deps.state.createArtifact({
      taskRunId: taskRun.id,
      stepId: cancelStep.id,
      kind: "quality_report",
      title: "Cancellation note",
      uri: `harness:cancel/${taskRun.id}/${Date.now()}`,
      summary: [
        `# TaskRun cancelled`,
        "",
        `**Previous status**: ${taskRun.status}`,
        "",
        `**Reason**:`,
        "",
        `> ${reason.replace(/\n+/g, "\n> ")}`,
      ].join("\n"),
    });
    await this.deps.state.setStepStatus(cancelStep.id, "succeeded", {
      outputSummary: "cancelled by user",
    });
    return this.deps.state.setTaskRunStatus(taskRun.id, "cancelled");
  }

  /**
   * Phase 8 — convert an agent-mode TaskRun back to a deterministic
   * template plan when the agent CLI is unavailable or its output is
   * unusable. Reuses the same plan-drafter as `createTask({mode:"template"})`
   * so the renderer doesn't have to special-case fallback approvals.
   *
   * Allowed source states: `drafting` (mode-agent placeholder still in
   * place) or `blocked` (agent invocation failed). Anything else means
   * we'd be racing an already-progressing flow.
   *
   * The caller (agent-ipc) is responsible for refusing the call when an
   * agent invocation is still queued or running for this TaskRun.
   */
  async useTemplateFallback(
    input: UseTemplateFallbackInput,
  ): Promise<TemplateFallbackResult> {
    const taskRun = await this.deps.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new ConversationServiceError(
        "CONVERSATION_TASK_NOT_FOUND",
        `TaskRun ${input.taskRunId} not found`,
      );
    }
    if (taskRun.status !== "drafting" && taskRun.status !== "blocked") {
      throw new ConversationServiceError(
        "CONVERSATION_INVALID_STATE",
        `Template fallback requires drafting|blocked status (got ${taskRun.status})`,
      );
    }

    // Reject any pending approvals from the agent-mode placeholder so the
    // ledger has a single fresh plan + approval set.
    const pending = await this.deps.state.listPendingApprovalsForTaskRun(
      taskRun.id,
    );
    for (const a of pending) {
      await this.deps.state.decideApproval(
        a.id,
        "rejected",
        "Replaced by template fallback",
      );
    }

    const stepIndex = await this.nextStepIndex(taskRun.id);
    const planStep = await this.deps.state.createStep({
      taskRunId: taskRun.id,
      index: stepIndex,
      kind: "plan",
      title: "Template fallback plan",
      status: "running",
      inputSummary: taskRun.userRequest.slice(0, 200),
    });
    const drafted = draftPlan({
      userRequest: taskRun.userRequest,
      targetDir: taskRun.targetDir,
    });
    const planArtifact = await this.deps.state.createArtifact({
      taskRunId: taskRun.id,
      stepId: planStep.id,
      kind: "plan",
      title: drafted.title,
      uri: planUri(taskRun.id),
      summary: drafted.content,
    });
    await this.deps.state.setStepStatus(planStep.id, "succeeded", {
      outputSummary: `template fallback plan artifact ${planArtifact.id}`,
    });

    const approvalStep = await this.deps.state.createStep({
      taskRunId: taskRun.id,
      index: stepIndex + 1,
      kind: "approval",
      title: "Template fallback 승인 대기",
      status: "pending",
      inputSummary: drafted.proposedActions.map((a) => a.type).join(","),
    });
    const checkpoint = await this.deps.state.createCheckpoint({
      taskRunId: taskRun.id,
      stepId: approvalStep.id,
      reason: "before_edit",
      stateRef: stateRefJson({
        taskRunStatus: "waiting_for_approval",
        currentStepId: approvalStep.id,
        artifactIds: [planArtifact.id],
        targetDir: taskRun.targetDir,
        fallbackFrom: "agent",
      }),
      summary: "template fallback before_edit checkpoint",
    });
    const approvals: Approval[] = [];
    for (const action of drafted.proposedActions) {
      approvals.push(
        await this.deps.state.createApproval({
          taskRunId: taskRun.id,
          checkpointId: checkpoint.id,
          actionType: action.type,
          actionSummary: action.summary,
          status: "pending",
        }),
      );
    }
    await this.deps.state.setTaskRunCurrentStep(taskRun.id, approvalStep.id);
    await this.deps.state.setTaskRunStatus(
      taskRun.id,
      "waiting_for_approval",
    );

    return { planArtifact, approvals };
  }

  private async nextStepIndex(taskRunId: string): Promise<number> {
    const existing = await this.deps.state.listStepsByTaskRun(taskRunId);
    return existing.length;
  }
}

const planUri = (taskRunId: string): string =>
  // Phase 2 placeholder URI scheme. Phase 3 introduces real artifact files
  // under app.getPath("userData")/artifacts/{taskRunId}/{artifactId}.{ext}
  // and replaces this scheme.
  `harness:plan/${taskRunId}/${Date.now()}`;

const stateRefJson = (state: Record<string, unknown>): string =>
  JSON.stringify(state);

const deriveThreadTitle = (userRequest: string): string => {
  const firstLine = userRequest.split(/\r?\n/, 1)[0] ?? "";
  const trimmed = firstLine.slice(0, 80).trim();
  return trimmed || "새 작업";
};
