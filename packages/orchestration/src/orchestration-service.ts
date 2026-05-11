import type { LocalStateService } from "@harness/storage";
import type { Approval } from "@harness/core";
import {
  OrchestrationError,
  type OrchestrationDraftInput,
  type OrchestrationPlan,
  type OrchestrationRunResult,
} from "./orchestration-types.ts";
import {
  OrchestrationPlanner,
  type DraftedOrchestration,
} from "./orchestration-planner.ts";
import { WorkerRunner } from "./worker-runner.ts";

/**
 * Phase 7 service. Wraps the planner + runner with plan recovery so the
 * IPC handler stays small. `enabled=false` (the default per phase-07
 * spec) makes draftPlan and runApproved refuse with a clear error so
 * the basic Harness flow stays unaffected.
 */
export interface OrchestrationServiceDeps {
  state: LocalStateService;
  /**
   * Feature flag. Defaults to false at MVP per phase-07 spec
   * ("Phase 7에서도 feature flag 기본값은 off다").
   */
  enabled: boolean;
}

export class OrchestrationService {
  private readonly planner: OrchestrationPlanner;
  private readonly worker: WorkerRunner;
  private readonly deps: OrchestrationServiceDeps;
  constructor(deps: OrchestrationServiceDeps) {
    this.deps = deps;
    this.planner = new OrchestrationPlanner({ state: deps.state });
    this.worker = new WorkerRunner({ state: deps.state });
  }

  isEnabled(): boolean {
    return this.deps.enabled;
  }

  async draftPlan(input: OrchestrationDraftInput): Promise<DraftedOrchestration> {
    this.assertEnabled();
    return this.planner.draftPlan(input);
  }

  async runApproved(input: {
    approvalId: string;
  }): Promise<OrchestrationRunResult> {
    this.assertEnabled();
    const approval = await this.deps.state.getApproval(input.approvalId);
    if (!approval) {
      throw new OrchestrationError(
        "ORCHESTRATION_APPROVAL_REQUIRED",
        `Approval ${input.approvalId} not found`,
      );
    }
    if (approval.actionType !== "orchestration_plan") {
      throw new OrchestrationError(
        "ORCHESTRATION_APPROVAL_TYPE_MISMATCH",
        `Approval ${input.approvalId} is not for an orchestration plan`,
      );
    }
    if (
      approval.status !== "approved" &&
      approval.status !== "always_approved_for_run"
    ) {
      throw new OrchestrationError(
        "ORCHESTRATION_APPROVAL_REQUIRED",
        `Approval ${input.approvalId} is ${approval.status}`,
      );
    }
    const plan = await this.recoverPlan(approval);
    return this.worker.runApproved({ approval, plan });
  }

  /**
   * Recover the most recent orchestration plan attached to a TaskRun
   * (used by the IPC handler to render OrchestrationPanel state).
   */
  async getLatestPlan(input: {
    taskRunId: string;
  }): Promise<OrchestrationPlan | null> {
    const artifacts = await this.deps.state.listArtifactsByTaskRun(
      input.taskRunId,
    );
    const planArtifacts = artifacts.filter(
      (a) => a.kind === "orchestration_plan",
    );
    if (planArtifacts.length === 0) return null;
    const newest = planArtifacts[planArtifacts.length - 1]!;
    const plan = parseEmbeddedPlanJson(newest.summary ?? "");
    if (!plan) return null;
    return {
      id: plan.id,
      taskRunId: input.taskRunId,
      mode: plan.mode,
      workerSteps: plan.workerSteps,
      requiresApproval: true,
    };
  }

  private async recoverPlan(approval: Approval): Promise<OrchestrationPlan> {
    const checkpoints = await this.deps.state.listCheckpointsByTaskRun(
      approval.taskRunId,
    );
    const checkpoint = checkpoints.find((c) => c.id === approval.checkpointId);
    let artifactIds: string[] = [];
    if (checkpoint) {
      try {
        const parsed = JSON.parse(checkpoint.stateRef) as {
          artifactIds?: string[];
        };
        artifactIds = parsed.artifactIds ?? [];
      } catch {
        artifactIds = [];
      }
    }
    const artifacts = await this.deps.state.listArtifactsByTaskRun(
      approval.taskRunId,
    );
    const planArtifact =
      artifacts.find(
        (a) => a.kind === "orchestration_plan" && artifactIds.includes(a.id),
      ) ?? artifacts.find((a) => a.kind === "orchestration_plan");
    if (!planArtifact) {
      throw new OrchestrationError(
        "ORCHESTRATION_PLAN_NOT_FOUND",
        `Could not locate orchestration_plan artifact for approval ${approval.id}`,
      );
    }
    const parsed = parseEmbeddedPlanJson(planArtifact.summary ?? "");
    if (!parsed) {
      throw new OrchestrationError(
        "ORCHESTRATION_PLAN_NOT_FOUND",
        `Plan artifact ${planArtifact.id} has no embedded JSON`,
      );
    }
    return {
      id: parsed.id,
      taskRunId: approval.taskRunId,
      mode: parsed.mode,
      workerSteps: parsed.workerSteps,
      requiresApproval: true,
    };
  }

  private assertEnabled(): void {
    if (!this.deps.enabled) {
      throw new OrchestrationError(
        "ORCHESTRATION_DISABLED",
        "Agent orchestration is disabled. Enable the feature flag to use it.",
      );
    }
  }
}

const planJsonRe = /```json\s*([\s\S]+?)\s*```/;
const parseEmbeddedPlanJson = (
  summary: string,
): { id: string; mode: OrchestrationPlan["mode"]; workerSteps: OrchestrationPlan["workerSteps"] } | null => {
  const match = planJsonRe.exec(summary);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1] ?? "") as {
      id: string;
      mode: OrchestrationPlan["mode"];
      workerSteps: OrchestrationPlan["workerSteps"];
    };
    if (!parsed || !parsed.id || !parsed.mode || !Array.isArray(parsed.workerSteps))
      return null;
    return parsed;
  } catch {
    return null;
  }
};
