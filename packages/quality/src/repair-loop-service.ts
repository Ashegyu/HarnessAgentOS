import { createHash } from "node:crypto";
import {
  QUALITY_DONE_BLOCKED,
  TaskRunCompletionError,
  TaskRunCompletionService,
  type Approval,
  type Checkpoint,
  type QualityGateResult,
  type RepairPlanDraft,
} from "@harness/core";
import type { LocalStateService } from "@harness/storage";

export interface RepairLoopAgentPlanning {
  generatePlan(input: {
    taskRunId: string;
    instruction?: string;
  }): Promise<{
    invocation: { id: string };
    planArtifact: RepairPlanDraft["planArtifact"];
    approvals: Approval[];
  }>;
}

export interface RepairLoopServiceDeps {
  state: LocalStateService;
  completion: TaskRunCompletionService;
  agentPlanning?: RepairLoopAgentPlanning;
  maxAttempts?: number;
}

export interface CreateRepairLoopInput {
  taskRunId: string;
  instruction?: string;
}

const DEFAULT_MAX_ATTEMPTS = 2;

export class RepairLoopService {
  private readonly deps: RepairLoopServiceDeps;
  private readonly maxAttempts: number;

  constructor(deps: RepairLoopServiceDeps) {
    this.deps = deps;
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  async createRepairPlan(input: CreateRepairLoopInput): Promise<RepairPlanDraft> {
    const gate = await this.requireRepairableGate(input.taskRunId);
    const signature = failureSignature(gate);
    const attempts = await this.deps.state.repairAttempts.listByTaskRun(
      input.taskRunId,
    );
    if (attempts.length >= this.maxAttempts) {
      throw new TaskRunCompletionError(
        QUALITY_DONE_BLOCKED,
        `Repair loop stopped after ${this.maxAttempts} attempts`,
      );
    }
    const repeated = attempts.some(
      (attempt) => attempt.failureSignature === signature,
    );
    if (repeated) {
      throw new TaskRunCompletionError(
        QUALITY_DONE_BLOCKED,
        "Repair loop stopped because the same quality failure signature repeated",
      );
    }

    const attempt = await this.deps.state.repairAttempts.create({
      taskRunId: input.taskRunId,
      qualityGateId: gate.id,
      failureSignature: signature,
      status: "planned",
    });

    if (!this.deps.agentPlanning) {
      await this.deps.state.repairAttempts.update(attempt.id, {
        status: "stopped",
      });
      return {
        ...(await this.deps.completion.createRepairPlan(input)),
        repairAttemptId: attempt.id,
        source: "template",
      };
    }

    try {
      const result = await this.deps.agentPlanning.generatePlan({
        taskRunId: input.taskRunId,
        instruction: buildRepairInstruction(gate, input.instruction),
      });
      const checkpoint = await this.findRepairCheckpoint({
        taskRunId: input.taskRunId,
        invocationId: result.invocation.id,
        approvals: result.approvals,
      });
      const updatedTaskRun = await this.deps.state.getTaskRun(input.taskRunId);
      if (!updatedTaskRun) {
        throw new TaskRunCompletionError(
          "QUALITY_TASK_NOT_FOUND",
          `TaskRun ${input.taskRunId} not found`,
        );
      }
      await this.deps.state.repairAttempts.update(attempt.id, {
        status:
          result.approvals.length > 0 ? "waiting_for_approval" : "stopped",
        invocationId: result.invocation.id,
        generatedApprovalIds: result.approvals.map((approval) => approval.id),
      });
      return {
        taskRun: updatedTaskRun,
        planArtifact: result.planArtifact,
        checkpoint,
        approvals: result.approvals,
        repairAttemptId: attempt.id,
        source: "agent",
      };
    } catch (error) {
      await this.deps.state.repairAttempts.update(attempt.id, {
        status: "stopped",
      });
      const message = error instanceof Error ? error.message : String(error);
      if (/provider|available|CLI/i.test(message)) {
        return {
          ...(await this.deps.completion.createRepairPlan(input)),
          repairAttemptId: attempt.id,
          source: "template",
        };
      }
      throw error;
    }
  }

  private async requireRepairableGate(
    taskRunId: string,
  ): Promise<QualityGateResult> {
    const gate = await this.deps.state.getLatestQualityGateResult(taskRunId);
    if (!gate) {
      throw new TaskRunCompletionError(
        "QUALITY_EVIDENCE_MISSING",
        "Cannot create repair plan before quality.evaluate has run",
      );
    }
    if (gate.status === "passed") {
      throw new TaskRunCompletionError(
        QUALITY_DONE_BLOCKED,
        "Quality gate already passed - no repair needed",
      );
    }
    return gate;
  }

  private async findRepairCheckpoint(input: {
    taskRunId: string;
    invocationId: string;
    approvals: Approval[];
  }): Promise<Checkpoint> {
    const approvalCheckpointId = input.approvals[0]?.checkpointId;
    if (approvalCheckpointId) {
      const checkpoint = await this.deps.state.checkpoints.get(approvalCheckpointId);
      if (checkpoint) return checkpoint;
    }
    const checkpoints = await this.deps.state.listCheckpointsByTaskRun(
      input.taskRunId,
    );
    const matched = [...checkpoints]
      .reverse()
      .find((checkpoint) => checkpoint.stateRef.includes(input.invocationId));
    if (matched) return matched;
    const latest = checkpoints.at(-1);
    if (latest) return latest;
    throw new TaskRunCompletionError(
      QUALITY_DONE_BLOCKED,
      "Agent repair plan did not produce a checkpoint",
    );
  }
}

export const failureSignature = (gate: QualityGateResult): string => {
  const payload = JSON.stringify({
    status: gate.status,
    knownRisks: [...gate.knownRisks].sort(),
    evidenceArtifactIds: [...gate.evidenceArtifactIds].sort(),
    buildPassed: gate.buildPassed ?? null,
    testsPassed: gate.testsPassed ?? null,
    smokePassed: gate.smokePassed ?? null,
  });
  return createHash("sha256").update(payload).digest("hex");
};

const buildRepairInstruction = (
  gate: QualityGateResult,
  userInstruction: string | undefined,
): string =>
  [
    "QUALITY REPAIR LOOP",
    "- Generate a targeted repair plan for the failed quality gate.",
    "- Keep all repair work inside the same TaskRun history.",
    "- No side effect is allowed directly; only propose approval-gated actions.",
    "- Do not propose dependency_install, network, git_commit, or secret access.",
    "- Prefer file_write fixes and explicit follow-up quality checks.",
    "",
    `Quality gate: ${gate.id} (${gate.status})`,
    `Evidence artifact ids: ${gate.evidenceArtifactIds.join(", ") || "(none)"}`,
    "",
    "Known risks:",
    ...(gate.knownRisks.length > 0
      ? gate.knownRisks.map((risk) => `- ${risk}`)
      : ["- (none recorded)"]),
    "",
    userInstruction && userInstruction.trim().length > 0
      ? `User repair instruction:\n${userInstruction.trim()}`
      : "User repair instruction:\n(none)",
  ].join("\n");
