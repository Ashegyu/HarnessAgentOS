import type {
  Approval,
  QualityGateResult,
  RepairPlanDraft,
  TaskRun,
} from "../types";
import { toProposedAction } from "../conversation/approval-policy";
import type { TaskRunCompletionGateway } from "./completion-gateway";

export class TaskRunCompletionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TaskRunCompletionError";
  }
}

export interface TaskRunCompletionDeps {
  state: TaskRunCompletionGateway;
  /**
   * Called immediately before a TaskRun flips to `done`. Production wiring
   * delegates to the learner package so a LearningTrace is always written
   * for every completed run (acceptance-checklist Phase 6 requirement).
   * Failures here propagate so the markDone IPC fails atomically — a
   * TaskRun row never reaches `done` without a trace stamp.
   */
  onTaskRunDone?: (taskRunId: string) => Promise<void>;
}

export interface CreateRepairPlanInput {
  taskRunId: string;
  instruction?: string;
}

export interface ApproveKnownRisksInput {
  taskRunId: string;
  message: string;
}

/**
 * Phase 4 service. Centralizes the TaskRun status transitions that depend
 * on a QualityGateResult so the renderer cannot move a TaskRun to
 * `done` without a passing (or warning + explicit risk approval) gate.
 *
 * Source: docs/implementation/phase-04-quality-gates.md
 *   "done 전환은 QualityService를 통해서만 가능하다.
 *    renderer는 TaskRun status를 직접 done으로 바꿀 수 없다."
 */
export class TaskRunCompletionService {
  constructor(private readonly deps: TaskRunCompletionDeps) {}

  /** Reflects a freshly-evaluated QualityGateResult into TaskRun status. */
  async applyQualityGateResult(
    result: QualityGateResult,
  ): Promise<TaskRun> {
    const taskRun = await this.requireTaskRun(result.taskRunId);
    if (taskRun.status === "done" || taskRun.status === "cancelled") {
      // Once a task is finalized further gate evaluations are read-only.
      return taskRun;
    }
    if (result.status === "failed") {
      return this.deps.state.setTaskRunStatus(taskRun.id, "quality_failed");
    }
    if (result.status === "passed" || result.status === "warning") {
      return this.deps.state.setTaskRunStatus(taskRun.id, "ready_for_review");
    }
    // not_run leaves the TaskRun in its current state.
    return taskRun;
  }

  /**
   * Promote ready_for_review (passed gate, OR warning gate + explicit
   * known-risk approval) → done. Per Flow 11 in mvp-user-flows.md.
   */
  async markDone(input: { taskRunId: string }): Promise<TaskRun> {
    const taskRun = await this.requireTaskRun(input.taskRunId);
    const gate = await this.deps.state.getLatestQualityGateResult(
      taskRun.id,
    );
    if (!gate) {
      throw new TaskRunCompletionError(
        "QUALITY_DONE_BLOCKED",
        "Cannot mark done without a quality gate result",
      );
    }
    if (gate.status === "failed" || gate.status === "not_run") {
      throw new TaskRunCompletionError(
        "QUALITY_DONE_BLOCKED",
        `Cannot mark done while quality gate is ${gate.status}`,
      );
    }
    if (gate.status === "warning") {
      const approved = await this.hasKnownRiskApproval(taskRun.id, gate.id);
      if (!approved) {
        throw new TaskRunCompletionError(
          "QUALITY_DONE_BLOCKED",
          "Warning-status gate requires an explicit known-risk approval before done",
        );
      }
    }
    if (
      taskRun.status !== "ready_for_review" &&
      taskRun.status !== "running"
    ) {
      throw new TaskRunCompletionError(
        "QUALITY_DONE_BLOCKED",
        `TaskRun must be ready_for_review to mark done (current: ${taskRun.status})`,
      );
    }
    // Stamp the LearningTrace BEFORE flipping to done so a `done` row
    // never exists without a corresponding trace entry. Failures bubble
    // up — the renderer surfaces them like any other completion error.
    if (this.deps.onTaskRunDone) {
      await this.deps.onTaskRunDone(taskRun.id);
    }
    return this.deps.state.setTaskRunStatus(taskRun.id, "done");
  }

  /**
   * Returns true if the user has explicitly approved known risks for the
   * given quality gate. The approval flow stores a quality_report
   * artifact whose URI carries the gate id (harness:quality/<task>/<gate>).
   */
  async hasKnownRiskApproval(
    taskRunId: string,
    gateId: string,
  ): Promise<boolean> {
    const artifacts = await this.deps.state.listArtifactsByTaskRun(taskRunId);
    return artifacts.some(
      (a) =>
        a.kind === "quality_report" &&
        typeof a.uri === "string" &&
        a.uri.endsWith(`/${gateId}`),
    );
  }

  /**
   * Promote a TaskRun to ready_for_review when the user opts in despite
   * pending checks, but only if the gate is at least `warning`.
   */
  async markReadyForReview(input: { taskRunId: string }): Promise<TaskRun> {
    const taskRun = await this.requireTaskRun(input.taskRunId);
    const gate = await this.deps.state.getLatestQualityGateResult(
      taskRun.id,
    );
    if (!gate) {
      throw new TaskRunCompletionError(
        "QUALITY_EVIDENCE_MISSING",
        "Run quality.evaluate before marking ready for review",
      );
    }
    if (gate.status === "failed") {
      throw new TaskRunCompletionError(
        "QUALITY_DONE_BLOCKED",
        "Cannot mark ready for review while quality gate is failed",
      );
    }
    if (gate.status === "not_run") {
      throw new TaskRunCompletionError(
        "QUALITY_EVIDENCE_MISSING",
        "Quality gate has no evidence (not_run)",
      );
    }
    return this.deps.state.setTaskRunStatus(taskRun.id, "ready_for_review");
  }

  /**
   * Record an explicit known-risk approval. Required before warning-status
   * runs can be marked done. Persists a quality_report artifact carrying
   * the user's message and promotes status to ready_for_review.
   */
  async approveKnownRisks(input: ApproveKnownRisksInput): Promise<TaskRun> {
    const message = (input.message ?? "").trim();
    if (message.length === 0) {
      throw new TaskRunCompletionError(
        "QUALITY_RISK_MESSAGE_REQUIRED",
        "Known-risk approval requires a non-empty message",
      );
    }
    const taskRun = await this.requireTaskRun(input.taskRunId);
    const gate = await this.deps.state.getLatestQualityGateResult(
      taskRun.id,
    );
    if (!gate) {
      throw new TaskRunCompletionError(
        "QUALITY_EVIDENCE_MISSING",
        "Cannot approve known risks before quality.evaluate has run",
      );
    }
    if (gate.status === "failed") {
      throw new TaskRunCompletionError(
        "QUALITY_DONE_BLOCKED",
        "Cannot approve known risks while quality gate is failed",
      );
    }
    if (gate.status === "not_run") {
      throw new TaskRunCompletionError(
        "QUALITY_EVIDENCE_MISSING",
        "Cannot approve known risks while quality gate is not_run",
      );
    }
    // Append a quality_report artifact recording the approval rationale.
    const stepIndex = await this.nextStepIndex(taskRun.id);
    const reviewStep = await this.deps.state.createStep({
      taskRunId: taskRun.id,
      index: stepIndex,
      kind: "quality_gate",
      title: "Known risk 승인",
      status: "running",
      inputSummary: message.slice(0, 200),
    });
    await this.deps.state.createArtifact({
      taskRunId: taskRun.id,
      stepId: reviewStep.id,
      kind: "quality_report",
      title: "Known risk approval",
      uri: `harness:quality/${taskRun.id}/${gate.id}`,
      summary: buildRiskApprovalSummary(gate, message),
    });
    await this.deps.state.setStepStatus(reviewStep.id, "succeeded", {
      outputSummary: "user-approved known risks",
    });
    return this.deps.state.setTaskRunStatus(taskRun.id, "ready_for_review");
  }

  /**
   * Generate a repair plan from a failed quality gate. Returns the same
   * shape as a Phase 2 ConversationTaskDraft so the renderer can reuse
   * the approval flow components.
   */
  async createRepairPlan(
    input: CreateRepairPlanInput,
  ): Promise<RepairPlanDraft> {
    const taskRun = await this.requireTaskRun(input.taskRunId);
    const gate = await this.deps.state.getLatestQualityGateResult(
      taskRun.id,
    );
    if (!gate) {
      throw new TaskRunCompletionError(
        "QUALITY_EVIDENCE_MISSING",
        "Cannot create repair plan before quality.evaluate has run",
      );
    }
    if (gate.status === "passed") {
      throw new TaskRunCompletionError(
        "QUALITY_DONE_BLOCKED",
        "Quality gate already passed — no repair needed",
      );
    }

    const instruction = (input.instruction ?? "").trim();
    const stepIndex = await this.nextStepIndex(taskRun.id);
    const planStep = await this.deps.state.createStep({
      taskRunId: taskRun.id,
      index: stepIndex,
      kind: "plan",
      title: "Quality repair plan",
      status: "running",
      inputSummary:
        instruction.length > 0 ? instruction.slice(0, 200) : gate.knownRisks.join("; "),
    });

    const planContent = buildRepairPlanContent(taskRun, gate, instruction);
    const planArtifact = await this.deps.state.createArtifact({
      taskRunId: taskRun.id,
      stepId: planStep.id,
      kind: "plan",
      title: "Repair plan",
      uri: `harness:plan/${taskRun.id}/${Date.now()}`,
      summary: planContent,
    });
    await this.deps.state.setStepStatus(planStep.id, "succeeded", {
      outputSummary: `repair plan artifact ${planArtifact.id}`,
    });

    const approvalStep = await this.deps.state.createStep({
      taskRunId: taskRun.id,
      index: stepIndex + 1,
      kind: "approval",
      title: "Repair plan 승인 대기",
      status: "pending",
      inputSummary: "file_write",
    });
    const checkpoint = await this.deps.state.createCheckpoint({
      taskRunId: taskRun.id,
      stepId: approvalStep.id,
      reason: "before_edit",
      stateRef: JSON.stringify({
        taskRunStatus: "waiting_for_approval",
        currentStepId: approvalStep.id,
        artifactIds: [planArtifact.id],
        targetDir: taskRun.targetDir,
        repairFromQualityGateId: gate.id,
      }),
      summary: `repair before_edit checkpoint (gate ${gate.id})`,
    });
    const proposed = toProposedAction(
      "file_write",
      `Repair changes within ${taskRun.targetDir} (gate ${gate.status})`,
    );
    const approvals: Approval[] = [
      await this.deps.state.createApproval({
        taskRunId: taskRun.id,
        checkpointId: checkpoint.id,
        actionType: proposed.type,
        actionSummary: proposed.summary,
        status: "pending",
      }),
    ];

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

  private async requireTaskRun(id: string): Promise<TaskRun> {
    const taskRun = await this.deps.state.getTaskRun(id);
    if (!taskRun) {
      throw new TaskRunCompletionError(
        "QUALITY_TASK_NOT_FOUND",
        `TaskRun ${id} not found`,
      );
    }
    return taskRun;
  }

  private async nextStepIndex(taskRunId: string): Promise<number> {
    const existing = await this.deps.state.listStepsByTaskRun(taskRunId);
    return existing.length;
  }
}

const buildRiskApprovalSummary = (
  gate: QualityGateResult,
  message: string,
): string =>
  [
    `# Known risk approval`,
    "",
    `**Quality gate**: ${gate.id} (${gate.status})`,
    "",
    `**Approval message**:`,
    "",
    `> ${message.replace(/\n+/g, "\n> ")}`,
    "",
    `## Acknowledged risks`,
    "",
    ...(gate.knownRisks.length > 0
      ? gate.knownRisks.map((r) => `- ${r}`)
      : ["- (none recorded)"]),
  ].join("\n");

const buildRepairPlanContent = (
  taskRun: TaskRun,
  gate: QualityGateResult,
  instruction: string,
): string =>
  [
    `# Repair plan`,
    "",
    `**Target**: \`${taskRun.targetDir}\``,
    "",
    `**Triggering quality gate**: ${gate.id} (${gate.status})`,
    "",
    `## Risks to address`,
    "",
    ...(gate.knownRisks.length > 0
      ? gate.knownRisks.map((r) => `- ${r}`)
      : ["- (no specific risks recorded)"]),
    "",
    instruction.length > 0
      ? `## User instruction\n\n> ${instruction.replace(/\n+/g, "\n> ")}`
      : `## User instruction\n\n> (none — repair using known risks above)`,
    "",
    `## Proposed actions`,
    "",
    `- \`file_write\` — apply targeted fixes within \`${taskRun.targetDir}\` and re-run the quality gate.`,
  ].join("\n");
