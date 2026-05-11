import {
  AGENT_INVOCATION_BUSY,
  AGENT_INVOCATION_NOT_FOUND,
  AGENT_MODE_MISMATCH,
  AGENT_PROPOSED_ACTION_INVALID,
  AGENT_PROVIDER_UNAVAILABLE,
  AGENT_TASK_RUN_NOT_FOUND,
  validateProposedActionDetails,
  type AgentInvocation,
  type AgentPlanOutput,
  type AgentProposedAction,
  type AgentProvider,
  type AgentProviderStatusMap,
  type AgentStreamEvent,
  type Approval,
  type Artifact,
  type ProposedActionDetails,
} from "@harness/core";
import type { LocalStateService } from "@harness/storage";
import { redactSecrets } from "@harness/learner";
import { buildAgentPrompt } from "./agent-prompt-builder";
import { parseAgentPlan } from "./agent-output-parser";
import { AgentCliError } from "./model-cli-errors";
import { DefaultModelCliAdapter } from "./model-cli-adapter";
import { defaultModelFor, providerForModel } from "./provider-detection";
import { AgentInvocationQueue } from "./agent-invocation-queue";
import type {
  ModelCliAdapter,
  ModelCliRequest,
} from "./model-cli-types";

export class AgentPlanningError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentPlanningError";
  }
}

export interface AgentPlanningServiceDeps {
  state: LocalStateService;
  /** Provider probe results for gating `generatePlan` calls. */
  getProviderStatus: () => AgentProviderStatusMap | null;
  /** Override the CLI adapter for tests / fake runs. */
  adapter?: ModelCliAdapter;
  /** Forwarded to renderer via events:agentStreamEvent (already redacted). */
  emitStreamEvent?: (event: AgentStreamEvent) => void;
  /**
   * Inject a shared queue so `checkProviders()` can report live depth.
   * Service creates its own if omitted, but the main process must pass
   * the same instance to both the IPC layer and the probe wrapper so
   * RuntimeStatusBar reflects real numbers.
   */
  queue?: AgentInvocationQueue;
  /**
   * Default model config knobs. Tests inject lower timeouts so they don't
   * hang waiting on a real CLI.
   */
  defaults?: {
    timeoutMs?: number;
    stallTimeoutMs?: number;
  };
}

export interface GeneratePlanInput {
  taskRunId: string;
  provider?: AgentProvider;
  model?: string;
  instruction?: string;
}

export interface GeneratePlanResult {
  invocation: AgentInvocation;
  planArtifact: Artifact;
  approvals: Approval[];
}

/**
 * Phase 8 — AgentPlanningService. Glue between conversation-mode=agent
 * TaskRun and the CLI adapter. Persists prompt/raw-output artifacts,
 * parses the agent plan, runs the same `validateProposedActionDetails`
 * gate as renderer-supplied actions, and creates 0..N approval rows.
 *
 * MVP scope: single in-flight invocation per TaskRun. cancel/retry
 * stubs are present so the IPC contract resolves but a concurrency
 * queue is deferred to a follow-up.
 */
export class AgentPlanningService {
  private readonly adapter: ModelCliAdapter;
  private readonly queue: AgentInvocationQueue;
  private readonly defaults: { timeoutMs: number; stallTimeoutMs: number };

  constructor(private readonly deps: AgentPlanningServiceDeps) {
    this.adapter = deps.adapter ?? new DefaultModelCliAdapter();
    this.queue = deps.queue ?? new AgentInvocationQueue();
    this.defaults = {
      timeoutMs: deps.defaults?.timeoutMs ?? 120_000,
      stallTimeoutMs: deps.defaults?.stallTimeoutMs ?? 30_000,
    };
  }

  /** Exposed so main.ts can wire RuntimeStatusBar to live queue depth. */
  getQueue(): AgentInvocationQueue {
    return this.queue;
  }

  async generatePlan(input: GeneratePlanInput): Promise<GeneratePlanResult> {
    const taskRun = await this.deps.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new AgentPlanningError(
        AGENT_TASK_RUN_NOT_FOUND,
        `TaskRun ${input.taskRunId} not found`,
      );
    }

    // Mode invariant: agent mode TaskRuns sit in `drafting` until
    // generatePlan resolves; anything else means the caller is layering
    // an agent plan on top of a template plan (we reject to keep the
    // approval ledger clean — see phase-08 §6).
    if (taskRun.status !== "drafting" && taskRun.status !== "blocked") {
      throw new AgentPlanningError(
        AGENT_MODE_MISMATCH,
        `agent.generatePlan requires TaskRun status drafting|blocked (got ${taskRun.status})`,
      );
    }

    const providers = this.deps.getProviderStatus();
    const provider =
      input.provider ??
      (providers?.claude.available
        ? "claude"
        : providers?.codex.available
          ? "codex"
          : null);
    if (!provider) {
      throw new AgentPlanningError(
        AGENT_PROVIDER_UNAVAILABLE,
        "No agent CLI provider is available; install claude or codex first",
      );
    }
    if (providers && !providers[provider].available) {
      throw new AgentPlanningError(
        AGENT_PROVIDER_UNAVAILABLE,
        `Provider ${provider} is not available`,
      );
    }
    const model = resolveModel(provider, input.model);

    // 1. plan step
    const stepIndex = (await this.deps.state.listStepsByTaskRun(taskRun.id))
      .length;
    const planStep = await this.deps.state.createStep({
      taskRunId: taskRun.id,
      index: stepIndex,
      kind: "plan",
      title: `Agent plan (${provider}:${model})`,
      status: "running",
      inputSummary: taskRun.userRequest.slice(0, 200),
    });

    // 2. prompt artifact (redacted)
    const recentArtifacts = await this.deps.state.listArtifactsByTaskRun(
      taskRun.id,
    );
    const qualityRisks = await this.deps.state.getLatestQualityGateResult(
      taskRun.id,
    );
    const rawPrompt = buildAgentPrompt({
      taskRun,
      recentArtifacts,
      qualityRisks,
      ...(input.instruction !== undefined
        ? { instruction: input.instruction }
        : {}),
    });
    const redactedPrompt = redactSecrets(rawPrompt, 80_000);
    const promptArtifact = await this.deps.state.createArtifact({
      taskRunId: taskRun.id,
      stepId: planStep.id,
      kind: "log",
      title: "Agent prompt",
      uri: `harness:agent-prompt/${taskRun.id}/${Date.now()}`,
      summary: redactedPrompt,
    });

    // 3. invocation row
    const invocation = await this.deps.state.createAgentInvocation({
      taskRunId: taskRun.id,
      provider,
      model,
      promptArtifactId: promptArtifact.id,
      stepId: planStep.id,
    });

    const startedAt = new Date().toISOString();
    await this.deps.state.updateAgentInvocation(invocation.id, {
      status: "running",
      startedAt,
    });

    // 4. invoke CLI through the per-provider queue. The queue serializes
    // claude/codex work and exposes an AbortSignal so cancel/retry can
    // tear down the child process cleanly.
    const request: ModelCliRequest = {
      invocationId: invocation.id,
      taskRunId: taskRun.id,
      cwd: taskRun.targetDir,
      prompt: redactedPrompt,
      modelConfig: {
        provider,
        model,
        timeoutMs: this.defaults.timeoutMs,
        stallTimeoutMs: this.defaults.stallTimeoutMs,
      },
      sandbox: {
        primaryDir: taskRun.targetDir,
        enforceInPrompt: true,
      },
    };
    const emit = this.deps.emitStreamEvent ?? (() => {});
    let rawStdout = "";
    let latencyMs = 0;
    try {
      const result = await this.queue.enqueue({
        provider,
        invocationId: invocation.id,
        work: (signal) =>
          this.adapter.invoke(
            request,
            (e) => {
              emit(redactStreamEvent(e));
            },
            signal,
          ),
      });
      rawStdout = result.stdout;
      latencyMs = result.latencyMs;
    } catch (e) {
      const code =
        e instanceof AgentCliError ? e.code : AGENT_PROVIDER_UNAVAILABLE;
      const message = e instanceof Error ? e.message : String(e);
      const finishedAt = new Date().toISOString();
      await this.deps.state.updateAgentInvocation(invocation.id, {
        status: "failed",
        errorCode: code,
        errorMessage: redactSecrets(message, 2_000),
        finishedAt,
      });
      await this.deps.state.setStepStatus(planStep.id, "failed", {
        outputSummary: `${code}: ${message.slice(0, 200)}`,
      });
      await this.deps.state.setTaskRunStatus(taskRun.id, "blocked");
      throw new AgentPlanningError(code, message);
    }

    // 5. raw output artifact (redacted)
    const redactedOutput = redactSecrets(rawStdout, 200_000);
    const rawOutputArtifact = await this.deps.state.createArtifact({
      taskRunId: taskRun.id,
      stepId: planStep.id,
      kind: "log",
      title: "Agent raw output",
      uri: `harness:agent-output/${taskRun.id}/${Date.now()}`,
      summary: redactedOutput,
    });
    await this.deps.state.updateAgentInvocation(invocation.id, {
      rawOutputArtifactId: rawOutputArtifact.id,
      latencyMs,
    });

    // 6. parse
    const parsed = parseAgentPlan(redactedOutput);
    if (!parsed.ok) {
      const finishedAt = new Date().toISOString();
      const errorArtifact = await this.deps.state.createArtifact({
        taskRunId: taskRun.id,
        stepId: planStep.id,
        kind: "quality_report",
        title: "Agent output parse error",
        uri: `harness:agent-parse-error/${taskRun.id}/${Date.now()}`,
        summary: `# Parse error\n\n${parsed.reason}\n\nSee raw output artifact ${rawOutputArtifact.id}.`,
      });
      await this.deps.state.updateAgentInvocation(invocation.id, {
        status: "failed",
        errorCode: "AGENT_INVALID_OUTPUT",
        errorMessage: parsed.reason,
        finishedAt,
        parsedPlanArtifactId: errorArtifact.id,
      });
      await this.deps.state.setStepStatus(planStep.id, "failed", {
        outputSummary: `parse error: ${parsed.reason.slice(0, 200)}`,
      });
      await this.deps.state.setTaskRunStatus(taskRun.id, "blocked");
      throw new AgentPlanningError("AGENT_INVALID_OUTPUT", parsed.reason);
    }

    // 7. Validate proposed actions through the same gate renderer-supplied
    // details traverse. Invalid actions are dropped with a logged report
    // (phase-08 §11 — filter, not all-or-nothing).
    const plan = parsed.plan;
    const policyReport: string[] = [];
    const acceptedActions: Array<{
      action: AgentProposedAction;
      details: ProposedActionDetails;
    }> = [];
    for (const [i, raw] of plan.proposedActions.entries()) {
      const details = toProposedActionDetails(raw);
      const expected = raw.type;
      const validation = validateProposedActionDetails(details, expected);
      if (!validation.ok || !validation.details) {
        policyReport.push(
          `- [${i}] ${raw.type} rejected: ${validation.reason ?? "invalid"}`,
        );
        continue;
      }
      acceptedActions.push({ action: raw, details: validation.details });
    }

    // 8. plan artifact (markdown rendering of accepted plan).
    const planArtifact = await this.deps.state.createArtifact({
      taskRunId: taskRun.id,
      stepId: planStep.id,
      kind: "plan",
      title: "Agent plan",
      uri: `harness:agent-plan/${taskRun.id}/${Date.now()}`,
      summary: renderPlanMarkdown(plan, acceptedActions.length, policyReport),
    });
    await this.deps.state.setStepStatus(planStep.id, "succeeded", {
      outputSummary: `accepted ${acceptedActions.length}/${plan.proposedActions.length} actions`,
    });

    if (policyReport.length > 0) {
      await this.deps.state.createArtifact({
        taskRunId: taskRun.id,
        stepId: planStep.id,
        kind: "quality_report",
        title: "Agent action policy report",
        uri: `harness:agent-policy/${taskRun.id}/${Date.now()}`,
        summary: [
          `# Agent proposed-action policy rejections`,
          "",
          `Total proposed: ${plan.proposedActions.length}`,
          `Accepted: ${acceptedActions.length}`,
          "",
          `## Rejected`,
          "",
          ...policyReport,
        ].join("\n"),
      });
    }

    // 9. checkpoint + approvals
    const approvalStep = await this.deps.state.createStep({
      taskRunId: taskRun.id,
      index: stepIndex + 1,
      kind: "approval",
      title: "Agent plan 승인 대기",
      status: acceptedActions.length > 0 ? "pending" : "succeeded",
      inputSummary: acceptedActions.map((a) => a.action.type).join(","),
    });
    const checkpoint = await this.deps.state.createCheckpoint({
      taskRunId: taskRun.id,
      stepId: approvalStep.id,
      reason: "before_edit",
      stateRef: JSON.stringify({
        taskRunStatus:
          acceptedActions.length > 0 ? "waiting_for_approval" : "ready_for_review",
        currentStepId: approvalStep.id,
        artifactIds: [planArtifact.id],
        targetDir: taskRun.targetDir,
        invocationId: invocation.id,
      }),
      summary: `agent plan checkpoint (${acceptedActions.length} actions)`,
    });

    const approvals: Approval[] = [];
    for (const { action, details } of acceptedActions) {
      const approval = await this.deps.state.createApproval({
        taskRunId: taskRun.id,
        checkpointId: checkpoint.id,
        actionType: details.type,
        actionSummary: shortRationale(action),
        status: "pending",
      });
      const withDetails = await this.deps.state.setApprovalProposedAction(
        approval.id,
        details,
      );
      approvals.push(withDetails);
    }

    // 10. status transition
    const finishedAt = new Date().toISOString();
    if (acceptedActions.length === 0) {
      // phase-08 §8 answer-only response — skip waiting_for_approval.
      await this.deps.state.setTaskRunStatus(taskRun.id, "ready_for_review");
    } else {
      await this.deps.state.setTaskRunCurrentStep(taskRun.id, approvalStep.id);
      await this.deps.state.setTaskRunStatus(taskRun.id, "waiting_for_approval");
    }
    const finalInvocation = await this.deps.state.updateAgentInvocation(
      invocation.id,
      {
        status: "succeeded",
        finishedAt,
        parsedPlanArtifactId: planArtifact.id,
      },
    );
    if (acceptedActions.length === 0 && policyReport.length === 0) {
      // pure answer-only path — keep the step in succeeded state already.
    }

    return {
      invocation: finalInvocation,
      planArtifact,
      approvals,
    };
  }

  /**
   * Cancel an invocation. If still queued or in-flight, fires the
   * AbortController so the CLI child receives SIGTERM. The invocation
   * row is marked `cancelled` immediately so the renderer reflects the
   * decision even before the spawn cleanup completes.
   */
  async cancelInvocation(input: {
    invocationId: string;
  }): Promise<AgentInvocation> {
    const inv = await this.deps.state.getAgentInvocation(input.invocationId);
    if (!inv) {
      throw new AgentPlanningError(
        AGENT_INVOCATION_NOT_FOUND,
        `AgentInvocation ${input.invocationId} not found`,
      );
    }
    if (inv.status === "succeeded" || inv.status === "failed") return inv;
    this.queue.cancel(input.invocationId);
    return this.deps.state.updateAgentInvocation(input.invocationId, {
      status: "cancelled",
      finishedAt: new Date().toISOString(),
      errorCode: "AGENT_CANCELLED",
      errorMessage: "Cancelled by user",
    });
  }

  async retryInvocation(input: {
    invocationId: string;
  }): Promise<GeneratePlanResult> {
    const previous = await this.deps.state.getAgentInvocation(
      input.invocationId,
    );
    if (!previous) {
      throw new AgentPlanningError(
        AGENT_INVOCATION_NOT_FOUND,
        `AgentInvocation ${input.invocationId} not found`,
      );
    }
    if (this.queue.isBusy(input.invocationId)) {
      throw new AgentPlanningError(
        AGENT_INVOCATION_BUSY,
        "Previous invocation is still queued or running; cancel it first",
      );
    }
    return this.generatePlan({
      taskRunId: previous.taskRunId,
      provider: previous.provider,
      model: previous.model,
    });
  }
}

const toProposedActionDetails = (
  raw: AgentProposedAction,
): ProposedActionDetails => {
  if (raw.type === "file_write") {
    if (raw.before !== undefined) {
      return {
        type: "file_write",
        filePatch: { path: raw.path, after: raw.after, before: raw.before },
      };
    }
    return {
      type: "file_write",
      filePatch: { path: raw.path, after: raw.after },
    };
  }
  if (raw.args !== undefined) {
    return { type: "shell", command: raw.command, args: raw.args };
  }
  return { type: "shell", command: raw.command };
};

const resolveModel = (
  provider: AgentProvider,
  preferred: string | undefined,
): string => {
  if (preferred && providerForModel(preferred) === provider) return preferred;
  return defaultModelFor(provider);
};

const shortRationale = (a: AgentProposedAction): string => {
  const head =
    a.type === "file_write"
      ? `file_write ${a.path}`
      : `shell ${a.command.slice(0, 80)}`;
  return `${head} — ${a.rationale.slice(0, 160)}`;
};

const renderPlanMarkdown = (
  plan: AgentPlanOutput,
  accepted: number,
  rejected: string[],
): string => {
  const lines: string[] = [];
  lines.push(`# ${plan.summary}`);
  if (plan.assumptions.length > 0) {
    lines.push("", "## Assumptions");
    for (const a of plan.assumptions) lines.push(`- ${a}`);
  }
  if (plan.steps.length > 0) {
    lines.push("", "## Steps");
    for (const s of plan.steps) {
      lines.push(`- (${s.risk}) **${s.title}** — ${s.rationale}`);
    }
  }
  lines.push(
    "",
    `## Proposed actions (${accepted}/${plan.proposedActions.length} accepted)`,
  );
  for (const a of plan.proposedActions) {
    if (a.type === "file_write") {
      lines.push(`- \`file_write\` \`${a.path}\` — ${a.rationale}`);
    } else {
      lines.push(`- \`shell\` \`${a.command}\` — ${a.rationale}`);
    }
  }
  if (rejected.length > 0) {
    lines.push("", "## Policy rejections");
    lines.push(...rejected);
  }
  if (plan.suggestedQualityChecks.length > 0) {
    lines.push("", "## Suggested quality checks");
    for (const q of plan.suggestedQualityChecks) {
      lines.push(`- \`${q.command}\` — ${q.reason}`);
    }
  }
  if (plan.questions.length > 0) {
    lines.push("", "## Questions");
    for (const q of plan.questions) lines.push(`- ${q}`);
  }
  return lines.join("\n");
};

const redactStreamEvent = (e: AgentStreamEvent): AgentStreamEvent => {
  if (e.type === "assistant_text") {
    return { ...e, text: redactSecrets(e.text, 8_000) };
  }
  if (e.type === "raw") {
    return { ...e, text: redactSecrets(e.text, 8_000) };
  }
  return e;
};
