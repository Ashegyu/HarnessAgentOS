import {
  evaluateBudget,
  isWorkerFileActionApproval,
  shouldAutoApprove,
  taskContractBlocksAction,
  taskContractFor,
  validateProposedActionDetails,
  type AgentInvocation,
  type Approval,
  type ApproveInput,
  type Artifact,
  type AutoApproveActiveProfile,
  type Checkpoint,
  type ShouldAutoApproveInput,
  type Step,
  type TaskRun,
} from "@harness/core";

export interface ProgressionSnapshot {
  taskRun: TaskRun;
  /** Creation order, not the approval panel's most-recent-decision order. */
  approvals: Approval[];
  steps: Step[];
  artifacts: Artifact[];
  checkpoints: Checkpoint[];
  invocations: AgentInvocation[];
  globalAutoApprove: boolean;
  workerFileActionAutoApprove: boolean;
  pipelineConsent: boolean;
  activeProfile: AutoApproveActiveProfile | null;
  budget: Pick<ShouldAutoApproveInput,
    "accumulatedTaskRunCostUsd" | "accumulatedDailyCostUsd" |
    "unknownTaskRunCostInvocationCount" | "unknownDailyCostInvocationCount">;
}

export interface TaskProgressionDeps {
  load: (taskRunId: string) => Promise<ProgressionSnapshot | null>;
  approve: (input: ApproveInput) => Promise<unknown>;
  execute: (approval: Approval) => Promise<unknown>;
  resumePlanning?: (taskRunId: string) => Promise<unknown>;
  resumeBackflow?: (taskRunId: string) => Promise<boolean>;
  evaluateQuality: (taskRunId: string) => Promise<unknown>;
  recordFailure: (taskRunId: string, error: unknown) => Promise<void>;
  changed: (taskRunId: string) => void;
  onError?: (taskRunId: string, error: unknown) => void;
}

const STOPPED = new Set(["blocked", "quality_failed", "paused", "done", "cancelled"]);
const isAdvisory = (a: Approval): boolean =>
  a.actionType === "capability_use" || a.actionType === "model_use";
const isApproved = (a: Approval): boolean =>
  a.status === "approved" || a.status === "always_approved_for_run";
const isUnresolved = (a: Approval): boolean =>
  !a.retryApprovalId && (a.executionState === "running" || a.executionState === "uncertain" ||
  a.status === "pending" || (!isAdvisory(a) && isApproved(a)));

const executable = (a: Approval): boolean => {
  if (a.retryApprovalId || a.executionState || isAdvisory(a)) return false;
  if (a.actionType === "orchestration_plan") return true;
  if (!["file_write", "file_patch", "file_delete", "shell"].includes(a.actionType)) return false;
  return !!a.proposedAction && validateProposedActionDetails(a.proposedAction, a.actionType).ok;
};

const autoDecision = (s: ProgressionSnapshot, a: Approval) => {
  const input: ShouldAutoApproveInput = {
    approval: a, globalAutoApprove: s.globalAutoApprove, activeProfile: s.activeProfile,
    ...s.budget, workerFileActionAutoApprove: s.workerFileActionAutoApprove,
    isWorkerFileAction: isWorkerFileActionApproval({ approval: a, checkpoints: s.checkpoints }),
  };
  if (s.pipelineConsent) {
    // Pipeline selection may cover orchestration/file proposals, never a manual
    // host command, deletion, revised action, blocked profile or exhausted budget.
    input.globalAutoApprove = true;
    input.approval = a.policyEvaluation?.decision === "blocked" ? a : {
      ...a, policyEvaluation: a.policyEvaluation ? { ...a.policyEvaluation, allowAutoApprove: true } : undefined,
    };
  }
  return shouldAutoApprove(input);
};

/**
 * Event-driven main-process owner of approval -> execution -> quality.
 * Per-task singleflight prevents competing event handlers; runners still claim
 * the revisioned SQLite approval before any side effect. No polling or replay.
 */
export class TaskProgressionService {
  private readonly deps: TaskProgressionDeps;
  private readonly running = new Map<string, Promise<void>>();
  private readonly requested = new Set<string>();
  private readonly held = new Set<string>();
  private stopping = false;

  constructor(deps: TaskProgressionDeps) { this.deps = deps; }

  async shutdown(): Promise<void> {
    this.stopping = true;
    this.requested.clear();
    await Promise.allSettled([...this.running.values()]);
  }

  hold(taskRunId: string): () => void {
    this.held.add(taskRunId);
    return () => { this.held.delete(taskRunId); this.schedule(taskRunId); };
  }

  async fail(taskRunId: string, error: unknown): Promise<void> {
    await this.deps.recordFailure(taskRunId, error);
    this.deps.changed(taskRunId);
  }

  schedule(taskRunId: string): void {
    void this.advance(taskRunId).catch(error => this.deps.onError?.(taskRunId, error));
  }

  advance(taskRunId: string): Promise<void> {
    if (this.stopping || !taskRunId) return Promise.resolve();
    this.requested.add(taskRunId);
    const existing = this.running.get(taskRunId);
    if (existing) return existing;
    const work = Promise.resolve().then(async () => {
      try {
        const attempted = new Set<string>();
        do {
          this.requested.delete(taskRunId);
          await this.progress(taskRunId, attempted);
        } while (!this.stopping && this.requested.has(taskRunId));
      } catch (error) {
        await this.fail(taskRunId, error);
      }
    }).finally(() => {
      this.running.delete(taskRunId);
      this.requested.delete(taskRunId);
    });
    this.running.set(taskRunId, work);
    return work;
  }

  private async progress(taskRunId: string, attempted: Set<string>): Promise<void> {
    for (;;) {
      if (this.stopping || this.held.has(taskRunId)) return;
      const s = await this.deps.load(taskRunId);
      if (this.stopping || !s || this.held.has(taskRunId) || STOPPED.has(s.taskRun.status)) return;
      if (s.steps.some(step => step.status === "running") ||
          s.invocations.some(invocation => invocation.status === "running" || invocation.status === "queued")) return;

      // A parent orchestration approval stays approved across worker checkpoints.
      // Resolve its child actions first; never restart it while a child waits.
      const children = s.approvals.filter(a => a.actionType !== "orchestration_plan");
      const ordered = children.some(isUnresolved)
        ? children : [...children, ...s.approvals.filter(a => a.actionType === "orchestration_plan")];
      const first = ordered.find(isUnresolved);
      const canHandle = (a: Approval): boolean => {
        if (taskContractBlocksAction(taskContractFor(s.taskRun), a.actionType)) return false;
        if (a.status === "pending") return (isAdvisory(a) || executable(a)) && autoDecision(s, a).approved;
        return isApproved(a) && executable(a);
      };
      const candidate = first && canHandle(first) ? first : undefined;
      if (!candidate) {
        if (!s.approvals.some(isUnresolved) && this.deps.resumeBackflow &&
            ["running", "waiting_for_approval", "ready_for_review"].includes(s.taskRun.status)) {
          const key = `backflow:${s.taskRun.status}:` +
            s.steps.map(step => `${step.id}:${step.status}`).join("|") + ":" +
            s.approvals.map(a => `${a.id}:${a.actionRevision}:${a.status}:${a.executionState ?? ""}`).join("|");
          if (attempted.has(key)) return;
          if (await this.deps.resumeBackflow(taskRunId)) {
            attempted.add(key);
            this.deps.changed(taskRunId);
            continue;
          }
        }
        if (!s.approvals.some(isUnresolved) && s.taskRun.status === "drafting" &&
            s.invocations.length === 0 && this.deps.resumePlanning &&
            s.artifacts.some(a => a.taskRunId === taskRunId && a.kind === "snapshot" &&
              a.uri === `harness:planning-ready/${taskRunId}`)) {
          if (attempted.has("planning")) return;
          attempted.add("planning");
          await this.deps.resumePlanning(taskRunId);
          this.deps.changed(taskRunId);
          continue;
        }
        if (!s.approvals.some(isUnresolved) && s.taskRun.status === "ready_for_review") {
          await this.deps.evaluateQuality(taskRunId);
        }
        return;
      }

      // A continuation that produces no new persisted progress must not spin.
      const key = `${candidate.id}:${candidate.actionRevision}:${candidate.status}:` +
        s.approvals.map(a => `${a.id}:${a.status}:${a.executionState ?? ""}`).join("|");
      if (attempted.has(key)) return;
      attempted.add(key);
      if (candidate.status === "pending") {
        await this.deps.approve({
          approvalId: candidate.id, expectedRevision: candidate.actionRevision ?? 1,
          autoApproveDecision: autoDecision(s, candidate),
          message: s.pipelineConsent ? "auto-approved (pipeline task)" : "auto-approved (main-process policy)",
        });
      } else {
        if (candidate.approvedRevision !== (candidate.actionRevision ?? 1)) {
          throw new Error("승인 내용이 변경되었습니다. 최신 내용을 확인해 다시 승인하세요.");
        }
        if (candidate.policyEvaluation?.decision === "blocked" ||
            s.activeProfile?.permissions.blockedActions.includes(candidate.actionType) ||
            evaluateBudget({ approval: candidate, profile: s.activeProfile, ...s.budget }).kind === "blocked") {
          throw new Error("현재 정책 또는 예산 제한으로 승인된 작업을 실행할 수 없습니다.");
        }
        await this.deps.execute(candidate);
      }
      this.deps.changed(taskRunId);
      // Reload after every decision/action: cancellation, new revisions and worker
      // proposals can arrive during an await. Never continue from a stale array.
    }
  }
}
