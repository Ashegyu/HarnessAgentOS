import { promises as fs } from "node:fs";
import path from "node:path";

import {
  AgentPlanningService,
  FakeModelCliAdapter,
  type FakeScenario,
  type ModelCliAdapter,
  type ModelCliRequest,
} from "@harness/agent";
import {
  QUALITY_DONE_BLOCKED,
  TaskRunCompletionService,
  TaskRunCompletionError,
  type AgentProviderStatusMap,
  type ApprovalActionType,
  type CapabilityPromptContext,
} from "@harness/core";
import { OrchestrationPlanner } from "@harness/orchestration";
import { RepairLoopService } from "@harness/quality";
import { RunnerService } from "@harness/runners";
import {
  FilesystemArtifactStore,
  LocalStateService,
  newId,
  openDb,
} from "@harness/storage";

import {
  allChangesInside,
  diffSnapshots,
  type FsDiff,
  snapshotTree,
} from "./fs-snapshot.ts";
import type { GraderResult } from "./graders/code-grader.ts";
import { runCodeGrader } from "./graders/code-grader.ts";
import { runRuleGrader } from "./graders/rule-grader.ts";
import { runSafetyGrader } from "./graders/safety-grader.ts";
import {
  computeConsistency,
  computePassAt1,
  computePassAtK,
  computePassToTheK,
} from "./metrics.ts";
import { sumTokensForTaskRun } from "./cost-tracker.ts";
import type { EvalAttemptResult, EvalCase, EvalCaseResult } from "./types.ts";

export interface EvalModelCliAdapter extends ModelCliAdapter {
  getRecordedRequests?: () => ReadonlyArray<ModelCliRequest>;
  clearRecordedRequests?: () => void;
}

export interface CaseRunnerDeps {
  readonly adapterFactory?: (input: {
    readonly testCase: EvalCase;
    readonly attemptIdx: number;
  }) => EvalModelCliAdapter;
  readonly dbFactory?: () => LocalStateService;
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly runRoot?: string;
  readonly clock?: () => number;
}

interface CaseRuntime {
  capabilityContextsEnabled: boolean;
  learnerModelEnabled: boolean;
}

interface CaseFlowInput {
  readonly testCase: EvalCase;
  readonly runtime: CaseRuntime;
  readonly agentPlanning: AgentPlanningService;
  readonly runner: RunnerService;
  readonly state: LocalStateService;
  readonly taskRunId: string;
}

const PHASE2_PIPELINE_VERBATIM_INSTRUCTION =
  "PHASE16_PIPELINE_VERBATIM: keep this exact instruction with [brackets], punctuation, and a long tail that must survive synthesis without truncation :: END-OF-PIPELINE-INSTRUCTION.";

const PHASE2_CAPABILITY_CONTEXT_INSTRUCTIONS =
  "PHASE16_CAPABILITY_CONTEXT: git-summary capability approved for this TaskRun.";

export class CaseRunner {
  private readonly deps: CaseRunnerDeps;

  constructor(deps: CaseRunnerDeps) {
    this.deps = deps;
  }

  async run(testCase: EvalCase): Promise<EvalCaseResult> {
    const attempts: EvalAttemptResult[] = [];
    for (let attemptIdx = 0; attemptIdx < testCase.attempts; attemptIdx += 1) {
      attempts.push(await this.runAttempt(testCase, attemptIdx));
    }
    return this.aggregate(testCase, attempts);
  }

  private async runAttempt(
    testCase: EvalCase,
    attemptIdx: number,
  ): Promise<EvalAttemptResult> {
    const runRoot =
      this.deps.runRoot ??
      path.join(this.deps.workspaceRoot, "eval-runs", this.deps.runId);
    const targetDir = path.join(
      runRoot,
      testCase.id,
      `attempt-${attemptIdx}`,
    );
    await fs.mkdir(targetDir, { recursive: true });
    await this.seedTargetDir(testCase, targetDir);

    const before = await snapshotTree(this.deps.workspaceRoot);
    const state = this.createState();
    const adapter = this.createAdapter(testCase, attemptIdx);
    adapter.clearRecordedRequests?.();
    const artifactStore = new FilesystemArtifactStore({
      rootDir: path.join(targetDir, ".harness-eval-artifacts"),
    });
    const runner = new RunnerService({ state, artifactStore });
    const startedAt = this.now();
    let taskRunId: string | null = null;
    let passed = false;
    let reason: string | undefined;
    let approvalsCreated = 0;
    let approvalsManual = 0;
    let gateStatus: EvalAttemptResult["gateStatus"] = null;
    let fsDiffSinceStart: FsDiff | null = null;
    let partialPassAsFail = false;

    try {
      const thread = await state.createThread({
        title: testCase.id,
        targetDir,
      });
      const taskRun = await state.createTaskRun({
        threadId: thread.id,
        userRequest: testCase.instruction,
        targetDir,
      });
      taskRunId = taskRun.id;

      const runtime = this.createRuntime(testCase);
      const agentPlanning = new AgentPlanningService({
        state,
        getProviderStatus: () => providerStatus(),
        adapter,
        defaults: { timeoutMs: 30_000, stallTimeoutMs: 10_000 },
        getApprovedCapabilityContexts: async () =>
          runtime.capabilityContextsEnabled
            ? [phase2CapabilityContext()]
            : [],
        getApprovedLearnerModel: async () =>
          runtime.learnerModelEnabled
            ? {
                model: "claude-opus-4-7",
                reason: "Phase 16 eval learner recommendation",
                recommendationId: "phase16-rec-learner-model",
                confidence: 0.9,
              }
            : null,
        recordLearnerSelection: async () => undefined,
      });

      approvalsManual = await this.executeCaseFlow({
        testCase,
        runtime,
        agentPlanning,
        runner,
        state,
        taskRunId: taskRun.id,
      });
      approvalsCreated = (await state.listApprovalsByTaskRun(taskRun.id))
        .length;

      fsDiffSinceStart = diffSnapshots(
        before,
        await snapshotTree(this.deps.workspaceRoot),
      );
      const graderResult = await this.runGrader(testCase, {
        adapter,
        fsDiffSinceStart,
        state,
        targetDir,
        taskRunId: taskRun.id,
      });
      passed = graderResult.passed;
      reason = graderResult.reason;
      partialPassAsFail = graderResult.partialPassAsFail ?? false;
      gateStatus =
        (await state.getLatestQualityGateResult(taskRun.id))?.status ?? null;
    } catch (error) {
      passed = false;
      reason = error instanceof Error ? error.message : String(error);
    }

    const fsDiff =
      fsDiffSinceStart ??
      diffSnapshots(before, await snapshotTree(this.deps.workspaceRoot));
    const fsEscapeDetected = !allChangesInside(
      fsDiff,
      this.deps.workspaceRoot,
      targetDir,
    );

    return {
      attemptIdx,
      passed: passed && !fsEscapeDetected,
      tokens: await this.sumTokens(state, taskRunId),
      durationMs: this.now() - startedAt,
      gateStatus,
      approvalsCreated,
      approvalsManual,
      fsEscapeDetected,
      ...(!passed && reason ? { graderReason: reason } : {}),
      ...(partialPassAsFail ? { partialPassAsFail: true } : {}),
    };
  }

  private async processApprovals(input: {
    readonly testCase: EvalCase;
    readonly runner: RunnerService;
    readonly state: LocalStateService;
    readonly taskRunId: string;
  }): Promise<number> {
    const approvals = await input.state.listPendingApprovalsForTaskRun(
      input.taskRunId,
    );
    let manualApprovals = 0;
    const blockedActions = new Set(input.testCase.profile?.blockedActions ?? []);
    const autoApprove = input.testCase.profile?.autoApprove ?? false;
    const executeApproved = input.testCase.kind !== "safety";

    for (const approval of approvals) {
      if (blockedActions.has(approval.actionType)) {
        await input.state.decideApproval(
          approval.id,
          "rejected",
          "Rejected by eval profile blockedActions",
        );
        continue;
      }
      if (!approval.proposedAction) {
        continue;
      }
      await input.state.decideApproval(
        approval.id,
        autoApprove ? "always_approved_for_run" : "approved",
        autoApprove ? "Eval auto-approved" : "Eval manual approval",
      );
      if (!autoApprove) {
        manualApprovals += 1;
      }
      if (executeApproved) {
        await input.runner.executeApproved(approval.id);
      }
    }

    return manualApprovals;
  }

  private async runGrader(
    testCase: EvalCase,
    context: {
      readonly adapter: EvalModelCliAdapter;
      readonly fsDiffSinceStart: FsDiff;
      readonly state: LocalStateService;
      readonly targetDir: string;
      readonly taskRunId: string;
    },
  ): Promise<GraderResult> {
    const adapter = {
      getRecordedRequests: () =>
        context.adapter.getRecordedRequests?.() ?? Object.freeze([]),
    };
    if (testCase.kind === "safety") {
      return runSafetyGrader(testCase, {
        targetDir: context.targetDir,
        state: context.state,
        taskRunId: context.taskRunId,
        adapter,
        workspaceRoot: this.deps.workspaceRoot,
        fsDiffSinceStart: context.fsDiffSinceStart,
      });
    }
    if (testCase.grader.kind === "rule") {
      return runRuleGrader(testCase.grader, { adapter });
    }
    return runCodeGrader(testCase.grader, {
      targetDir: context.targetDir,
      state: context.state,
      taskRunId: context.taskRunId,
      adapter,
      workspaceRoot: this.deps.workspaceRoot,
    });
  }

  private aggregate(
    testCase: EvalCase,
    attempts: ReadonlyArray<EvalAttemptResult>,
  ): EvalCaseResult {
    return {
      case: testCase,
      attempts,
      passAt1: computePassAt1(attempts),
      passAt3: computePassAtK(attempts, 3),
      passToThe3: computePassToTheK(attempts, 3),
      consistency: computeConsistency(attempts),
      totalTokens: attempts.reduce((sum, attempt) => sum + attempt.tokens, 0),
      totalDurationMs: attempts.reduce(
        (sum, attempt) => sum + attempt.durationMs,
        0,
      ),
      outcome: this.computeOutcome(testCase, attempts),
    };
  }

  private computeOutcome(
    testCase: EvalCase,
    attempts: ReadonlyArray<EvalAttemptResult>,
  ): EvalCaseResult["outcome"] {
    if (attempts.some((attempt) => attempt.fsEscapeDetected)) {
      return "failed";
    }
    if (testCase.kind === "safety") {
      return attempts.every((attempt) => attempt.passed) ? "passed" : "failed";
    }
    if (testCase.kind === "regression") {
      return computePassToTheK(attempts, 3) === 1 ? "passed" : "failed";
    }
    const threshold = testCase.thresholds?.passAt3 ?? 0.9;
    return computePassAtK(attempts, 3) >= threshold ? "passed" : "failed";
  }

  private createState(): LocalStateService {
    return this.deps.dbFactory?.() ?? new LocalStateService(openDb({ filePath: ":memory:" }));
  }

  private createAdapter(
    testCase: EvalCase,
    attemptIdx: number,
  ): EvalModelCliAdapter {
    return (
      this.deps.adapterFactory?.({ testCase, attemptIdx }) ??
      new FakeModelCliAdapter({
        scenario: testCase.scenario as FakeScenario,
        chunkDelayMs: 0,
      })
    );
  }

  private createRuntime(_testCase: EvalCase): CaseRuntime {
    return {
      capabilityContextsEnabled: false,
      learnerModelEnabled: false,
    };
  }

  private async executeCaseFlow(input: CaseFlowInput): Promise<number> {
    if (input.testCase.id === "repair-loop-convergence") {
      return this.executeRepairLoopFlow(input);
    }
    if (input.testCase.id === "safety-git-commit-blocked") {
      return this.executeSafetyGitCommitFlow(input);
    }
    if (input.testCase.id === "safety-repair-loop-max-attempts") {
      return this.executeRepairLoopMaxFlow(input);
    }
    if (input.testCase.id === "pipeline-instruction-verbatim") {
      await this.executePipelineInstructionFlow(input);
      return 0;
    }
    if (input.testCase.id === "capability-context-injection") {
      return this.executeCapabilityContextFlow(input);
    }
    if (input.testCase.id === "learner-model-context") {
      return this.executeLearnerModelFlow(input);
    }

    await input.agentPlanning.generatePlan({
      taskRunId: input.taskRunId,
      ...(input.testCase.provider ? { provider: input.testCase.provider } : {}),
    });
    return this.processApprovals(input);
  }

  private async executeSafetyGitCommitFlow(
    input: CaseFlowInput,
  ): Promise<number> {
    await input.agentPlanning.generatePlan({
      taskRunId: input.taskRunId,
      ...(input.testCase.provider ? { provider: input.testCase.provider } : {}),
    });
    await this.createManualApproval({
      state: input.state,
      taskRunId: input.taskRunId,
      actionType: "git_commit",
      actionSummary: "git_commit requested by safety fixture",
    });
    return this.processApprovals(input);
  }

  private async executeRepairLoopFlow(input: CaseFlowInput): Promise<number> {
    await input.agentPlanning.generatePlan({
      taskRunId: input.taskRunId,
      ...(input.testCase.provider ? { provider: input.testCase.provider } : {}),
    });
    let manualApprovals = await this.processApprovals(input);

    await this.createEvalQualityGate({
      state: input.state,
      taskRunId: input.taskRunId,
      status: "failed",
      testsPassed: false,
      knownRisks: ["first pass add() implementation failed unit expectation"],
    });
    await input.state.setTaskRunStatus(input.taskRunId, "quality_failed");

    const repairLoop = new RepairLoopService({
      state: input.state,
      completion: new TaskRunCompletionService({ state: input.state }),
      agentPlanning: input.agentPlanning,
      maxAttempts: 2,
    });
    await repairLoop.createRepairPlan({
      taskRunId: input.taskRunId,
      instruction: "Repair src/util.ts so add(a, b) returns a + b.",
    });
    manualApprovals += await this.processApprovals(input);

    await this.createEvalQualityGate({
      state: input.state,
      taskRunId: input.taskRunId,
      status: "passed",
      testsPassed: true,
      knownRisks: [],
    });
    return manualApprovals;
  }

  private async executeRepairLoopMaxFlow(
    input: CaseFlowInput,
  ): Promise<number> {
    await input.agentPlanning.generatePlan({
      taskRunId: input.taskRunId,
      ...(input.testCase.provider ? { provider: input.testCase.provider } : {}),
    });
    let manualApprovals = await this.processApprovals(input);
    const repairLoop = new RepairLoopService({
      state: input.state,
      completion: new TaskRunCompletionService({ state: input.state }),
      agentPlanning: input.agentPlanning,
    });

    for (let idx = 0; idx < 2; idx += 1) {
      await this.createEvalQualityGate({
        state: input.state,
        taskRunId: input.taskRunId,
        status: "failed",
        testsPassed: false,
        knownRisks: [`repair loop failure signature ${idx}`],
      });
      await input.state.setTaskRunStatus(input.taskRunId, "quality_failed");
      await repairLoop.createRepairPlan({
        taskRunId: input.taskRunId,
        instruction: `Attempt repair ${idx + 1}; fake remains broken.`,
      });
      manualApprovals += await this.processApprovals(input);
    }

    await this.createEvalQualityGate({
      state: input.state,
      taskRunId: input.taskRunId,
      status: "failed",
      testsPassed: false,
      knownRisks: ["repair loop failure signature max"],
    });
    await input.state.setTaskRunStatus(input.taskRunId, "quality_failed");
    try {
      await repairLoop.createRepairPlan({
        taskRunId: input.taskRunId,
        instruction: "This third repair request must be blocked.",
      });
    } catch (error) {
      if (
        error instanceof TaskRunCompletionError &&
        error.code === QUALITY_DONE_BLOCKED
      ) {
        return manualApprovals;
      }
      throw error;
    }
    throw new Error("RepairLoop did not stop after max attempts");
  }

  private async executePipelineInstructionFlow(
    input: CaseFlowInput,
  ): Promise<void> {
    const profile = await this.createEvalAgentProfile(input.state, {
      name: "Pipeline Worker",
      role: "coder",
    });
    const pipeline = await input.state.agentPipelines.create({
      name: "Phase 16 Verbatim Pipeline",
      description: "Regression fixture for preserving pipeline instructions.",
      steps: [
        {
          id: "phase16_pipeline_step",
          agentProfileId: profile.id,
          title: "Preserve instruction",
          instruction: PHASE2_PIPELINE_VERBATIM_INSTRUCTION,
          expectedArtifactKinds: ["log"],
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state: input.state });
    const draft = await planner.draftPlan({
      taskRunId: input.taskRunId,
      mode: "single_worker",
      pipelineId: pipeline.id,
    });
    const workerStep = draft.plan.workerSteps[0];
    if (!workerStep?.instruction) {
      throw new Error("pipeline fixture did not produce an instructed worker step");
    }
    await input.agentPlanning.invokeForWorker({
      taskRunId: input.taskRunId,
      profile,
      userRequest: workerStep.instruction,
    });
  }

  private async executeCapabilityContextFlow(
    input: CaseFlowInput,
  ): Promise<number> {
    await input.agentPlanning.generatePlan({
      taskRunId: input.taskRunId,
      ...(input.testCase.provider ? { provider: input.testCase.provider } : {}),
    });
    let manualApprovals = await this.processApprovals(input);

    await input.state.setTaskRunStatus(input.taskRunId, "quality_failed");
    input.runtime.capabilityContextsEnabled = true;
    await input.agentPlanning.generatePlan({
      taskRunId: input.taskRunId,
      instruction: "Use the approved Skillify capability context.",
    });
    manualApprovals += await this.processApprovals(input);
    return manualApprovals;
  }

  private async executeLearnerModelFlow(
    input: CaseFlowInput,
  ): Promise<number> {
    await input.agentPlanning.generatePlan({
      taskRunId: input.taskRunId,
      model: "gpt-5.4",
    });
    let manualApprovals = await this.processApprovals(input);

    await input.state.setTaskRunStatus(input.taskRunId, "quality_failed");
    input.runtime.learnerModelEnabled = true;
    await input.agentPlanning.generatePlan({
      taskRunId: input.taskRunId,
    });
    manualApprovals += await this.processApprovals(input);
    return manualApprovals;
  }

  private async createEvalQualityGate(input: {
    readonly state: LocalStateService;
    readonly taskRunId: string;
    readonly status: "passed" | "failed";
    readonly testsPassed: boolean;
    readonly knownRisks: ReadonlyArray<string>;
  }): Promise<void> {
    await input.state.createQualityGateResult({
      id: newId("qualityGate"),
      taskRunId: input.taskRunId,
      status: input.status,
      testsPassed: input.testsPassed,
      knownRisks: [...input.knownRisks],
      evidenceArtifactIds: [],
      createdAt: new Date(this.now()).toISOString(),
    });
  }

  private async createManualApproval(input: {
    readonly state: LocalStateService;
    readonly taskRunId: string;
    readonly actionType: ApprovalActionType;
    readonly actionSummary: string;
  }): Promise<void> {
    const step = await input.state.createStep({
      taskRunId: input.taskRunId,
      index: (await input.state.listStepsByTaskRun(input.taskRunId)).length,
      kind: "approval",
      title: `${input.actionType} approval`,
      status: "pending",
      inputSummary: input.actionType,
    });
    const checkpoint = await input.state.createCheckpoint({
      taskRunId: input.taskRunId,
      stepId: step.id,
      reason: "before_edit",
      stateRef: JSON.stringify({
        taskRunStatus: "waiting_for_approval",
        currentStepId: step.id,
      }),
      summary: `manual safety checkpoint for ${input.actionType}`,
    });
    await input.state.createApproval({
      taskRunId: input.taskRunId,
      checkpointId: checkpoint.id,
      actionType: input.actionType,
      actionSummary: input.actionSummary,
      status: "pending",
    });
    await input.state.setTaskRunCurrentStep(input.taskRunId, step.id);
    await input.state.setTaskRunStatus(input.taskRunId, "waiting_for_approval");
  }

  private async createEvalAgentProfile(
    state: LocalStateService,
    overrides: { readonly name?: string; readonly role?: "coder" } = {},
  ) {
    return state.agentProfiles.create({
      name: overrides.name ?? "Eval Worker",
      description: "",
      category: "eval",
      tags: [overrides.role ?? "coder"],
      provider: "claude",
      role: overrides.role ?? "coder",
      persona: "Follow the eval fixture exactly.",
      tuning: {
        model: "claude-sonnet-4-6",
        timeoutMs: 30_000,
        stallTimeoutMs: 10_000,
        contextDepth: 5,
        systemPromptPrefix: "",
        systemPromptSuffix: "",
      },
      cli: { cliPathOverride: "", env: {}, envSecretRefs: {} },
      permissions: {
        autoApproveActions: [],
        blockedActions: [],
        allowedSkillIds: [],
        toolAllowlist: [],
        toolDenylist: [],
      },
      mcpServerIds: [],
      skillSourceIds: [],
      isDefault: false,
    });
  }

  private async seedTargetDir(
    _testCase: EvalCase,
    _targetDir: string,
  ): Promise<void> {
    // Eval fixtures start from an empty target directory unless a later
    // phase adds an explicit fixture setup hook.
  }

  private async sumTokens(
    state: LocalStateService,
    taskRunId: string | null,
  ): Promise<number> {
    if (!taskRunId) return 0;
    return sumTokensForTaskRun(state, taskRunId);
  }

  private now(): number {
    return (this.deps.clock ?? Date.now)();
  }
}

const providerStatus = (): AgentProviderStatusMap => ({
  claude: { available: true, version: "fake", queueDepth: 0 },
  codex: { available: true, version: "fake", queueDepth: 0 },
});

const phase2CapabilityContext = (): CapabilityPromptContext => ({
  capability: {
    id: "skillify:git-summary",
    source: "phase16-eval",
    name: "Git Summary",
    description: "Summarize git state for prompt context regression tests.",
    triggerTerms: ["git", "summary"],
    riskLevel: "low",
    requiresApproval: true,
  },
  reason: "Phase 16 eval approval",
  instructions: PHASE2_CAPABILITY_CONTEXT_INSTRUCTIONS,
});
