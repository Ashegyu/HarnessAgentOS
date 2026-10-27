import type { ConversationService, TaskRunCompletionService } from "@harness/core";
import type { QualityEvaluator, RepairLoopService } from "@harness/quality";
import type { PipelineBackflowService } from "../pipeline-backflow-service";
import { assertTaskRunTransition, diagnosticErrorMessage } from "@harness/core";
import type { LocalStateService } from "@harness/storage";
import { parseEmbeddedPlanJson } from "@harness/orchestration";
import { TaskProgressionService, type ProgressionSnapshot } from "./task-progression-service";

export interface TaskProgressionHostDeps {
  state: LocalStateService;
  conversation: Pick<ConversationService, "approve">;
  execute: ConstructorParameters<typeof TaskProgressionService>[0]["execute"];
  evaluateQuality: (taskRunId: string) => Promise<unknown>;
  resumePlanning?: (taskRunId: string) => Promise<unknown>;
  resumeBackflow?: (taskRunId: string) => Promise<boolean>;
  recoverValidationFailure?: (taskRunId: string, pipelineConsent: boolean, failedApprovalId: string) => Promise<boolean>;
  changed: (taskRunId: string) => void;
  onError?: (taskRunId: string, error: unknown) => void;
}

/** Share the production recovery path with local acceptance runs; no approval bypass. */
export const recoverTaskValidationFailure = async (
  deps: {
    state: Pick<LocalStateService, "getApproval" | "getTaskRun" | "approvals" | "decideApproval" | "listCheckpointsByTaskRun" | "setStepStatus">;
    evaluator: Pick<QualityEvaluator, "evaluate">;
    completion: Pick<TaskRunCompletionService, "applyQualityGateResult">;
    repairLoop: Pick<RepairLoopService, "createRepairPlan">;
    backflow: Pick<PipelineBackflowService, "runForQualityFailure">;
  },
  taskRunId: string,
  pipelineConsent: boolean,
  failedApprovalId: string,
): Promise<boolean> => {
  const gate = await deps.evaluator.evaluate({ taskRunId });
  await deps.completion.applyQualityGateResult(gate);
  if (gate.status !== "failed") return false;
  if (pipelineConsent) return deps.backflow.runForQualityFailure(gate);
  const failed = await deps.state.getApproval(failedApprovalId);
  const task = await deps.state.getTaskRun(taskRunId);
  if (!failed || failed.executionState !== "failed" || failed.status !== "executed" ||
      failed.retryApprovalId || !task || task.status !== "quality_failed") return false;
  const approvals = await deps.state.approvals.listByTaskRun(taskRunId, "execution");
  for (const pending of approvals) {
    if (pending.checkpointId !== failed.checkpointId || pending.executionState || pending.retryApprovalId ||
        !["pending", "approved", "always_approved_for_run"].includes(pending.status)) continue;
    if ((await deps.state.getTaskRun(taskRunId))?.status !== "quality_failed") return false;
    await deps.state.decideApproval(pending.id, "rejected", `Skipped after confirmed checker failure ${failed.id}; a new repair plan must be reviewed.`,
      { expectedRevision: pending.actionRevision ?? 1 });
  }
  const checkpoint = (await deps.state.listCheckpointsByTaskRun(taskRunId)).find(c => c.id === failed.checkpointId);
  if (checkpoint) await deps.state.setStepStatus(checkpoint.stepId, "failed", { outputSummary: "검사 실패 — 남은 계획을 중단하고 보정 계획으로 진행합니다." });
  if ((await deps.state.getTaskRun(taskRunId))?.status !== "quality_failed") return false;
  const repair = await deps.repairLoop.createRepairPlan({ taskRunId });
  return repair.source === "agent" && repair.approvals.length > 0;
};

/** Only host-owned plan artifacts establish persisted pipeline-selection consent. */
const hasPipelineConsent = (s: ProgressionSnapshot["artifacts"]): boolean => s.some(artifact => {
  if (artifact.kind !== "orchestration_plan" || !artifact.uri.startsWith("harness:orchestration/")) return false;
  const marker = "<!-- orchestration-plan:json -->";
  const summary = artifact.summary ?? "";
  const markerIndex = summary.indexOf(marker);
  if (markerIndex < 0) return false;
  const plan = parseEmbeddedPlanJson(summary.slice(markerIndex + marker.length));
  return plan !== null && artifact.uri === `harness:orchestration/${artifact.taskRunId}/${plan.id}` &&
    (plan.sourcePipelineId !== undefined || plan.sourceHarness !== undefined);
});

export const createTaskProgressionHost = (deps: TaskProgressionHostDeps): TaskProgressionService =>
  new TaskProgressionService({
    load: async taskRunId => {
      const taskRun = await deps.state.getTaskRun(taskRunId);
      if (!taskRun) return null;
      const settings = await deps.state.getSettings();
      const profiles = await deps.state.agentProfiles.list();
      const activeProfile = profiles.find(p => p.id === settings.activeAgentProfileId) ??
        profiles.find(p => p.isDefault) ?? null;
      const isoDate = new Date().toISOString().slice(0, 10);
      const [approvals, steps, checkpoints, artifacts, invocations, daily] = await Promise.all([
        deps.state.approvals.listByTaskRun(taskRunId, "execution"),
        deps.state.listStepsByTaskRun(taskRunId),
        deps.state.listCheckpointsByTaskRun(taskRunId),
        deps.state.listArtifactsByTaskRun(taskRunId),
        deps.state.listAgentInvocationsByTaskRun(taskRunId),
        deps.state.aggregateAgentInvocationCostByProfileAndDay({
          sinceIso: `${isoDate}T00:00:00.000Z`, untilIso: `${isoDate}T23:59:59.999Z`,
          ...(activeProfile ? { profileId: activeProfile.id } : {}),
        }),
      ]);
      return {
        taskRun, approvals, steps, checkpoints, artifacts, invocations, activeProfile,
        pipelineConsent: hasPipelineConsent(artifacts),
        globalAutoApprove: settings.approval.autoApprove,
        workerFileActionAutoApprove: settings.approval.autoExecuteWorkerFileActions,
        budget: {
          accumulatedTaskRunCostUsd: invocations.reduce((sum, row) => sum + (row.costEstimate ?? 0), 0),
          accumulatedDailyCostUsd: daily.reduce((sum, row) => sum + row.totalCostUsd, 0),
          unknownTaskRunCostInvocationCount: invocations.filter(row => row.costEstimate === undefined).length,
          unknownDailyCostInvocationCount: daily.reduce((sum, row) => sum + (row.unknownCostInvocationCount ?? 0), 0),
        },
      };
    },
    approve: input => deps.conversation.approve(input),
    execute: deps.execute,
    resumePlanning: deps.resumePlanning,
    resumeBackflow: deps.resumeBackflow,
    recoverValidationFailure: deps.recoverValidationFailure,
    evaluateQuality: deps.evaluateQuality,
    changed: deps.changed,
    onError: deps.onError,
    recordFailure: async (taskRunId, error) => {
      const current = await deps.state.getTaskRun(taskRunId);
      if (!current || ["paused", "cancelled", "done"].includes(current.status)) return;
      // Persist the reason so reloads and background tasks never lose the error.
      // Approval payloads/output are not included in this diagnostic.
      const reason = diagnosticErrorMessage(error)
        .replace(/\b(?:sk-[\w-]+|Bearer\s+\S+)\b/gi, "[redacted]").slice(0, 2000);
      const steps = await deps.state.listStepsByTaskRun(taskRunId);
      const step = await deps.state.createStep({ taskRunId,
        index: Math.max(-1, ...steps.map(row => row.index)) + 1,
        kind: "plan", title: "작업 진행 중단 — 확인 필요", status: "pending",
      });
      await deps.state.setStepStatus(step.id, "failed", { outputSummary: reason });
      await deps.state.createArtifact({ taskRunId, stepId: step.id, kind: "log",
        title: "작업 진행 오류", uri: `harness:progression-error/${taskRunId}/${step.id}`, summary: reason });
      // Logging yields to user actions. Only block the state observed before
      // logging; a later Pause/Cancel must keep ownership of the task status.
      assertTaskRunTransition(current.status, "blocked");
      try {
        await deps.state.taskRuns.updateStatus(taskRunId, "blocked", current.status);
      } catch (error) {
        if (!(error instanceof Error) ||
            !("code" in error) || error.code !== "TASK_RUN_STATE_CONFLICT") throw error;
      }
    },
  });
