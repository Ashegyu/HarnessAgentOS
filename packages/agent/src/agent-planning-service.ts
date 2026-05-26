import {
  AGENT_CANCELLED,
  AGENT_INVALID_OUTPUT,
  AGENT_INVOCATION_BUSY,
  AGENT_INVOCATION_NOT_FOUND,
  AGENT_MODE_MISMATCH,
  AGENT_PROPOSED_ACTION_INVALID,
  AGENT_PROVIDER_UNAVAILABLE,
  AGENT_TASK_RUN_NOT_FOUND,
  DEFAULT_AGENT_STALL_TIMEOUT_MS,
  DEFAULT_AGENT_TIMEOUT_MS,
  formatDiagnosticLog,
  isHarnessError,
  validateProposedActionDetails,
  type AgentInvocation,
  type AgentPlanningStateGateway,
  type AgentPlanOutput,
  type AgentProgressStage,
  type AgentQueueDepths,
  type AgentProfile,
  type AgentProposedAction,
  type AgentProvider,
  type AgentProviderStatusMap,
  type AgentStreamEvent,
  type Approval,
  type Artifact,
  type CapabilityPromptContext,
  type LearnerModelContext,
  type ProposedActionDetails,
  type TaskRun,
} from "@harness/core";
import { redactSecrets } from "@harness/learner";
import {
  buildSplitAgentPrompt,
  type AgentHandoffPromptMessage,
  type ThreadContextPromptTask,
} from "./agent-prompt-builder.ts";
import type { PackedRepoContext } from "./context-packer.ts";
import { resolveAgentProfile } from "./agent-profile-resolver.ts";
import { parseAgentPlan } from "./agent-output-parser.ts";
import { AgentCliError } from "./model-cli-errors.ts";
import { DefaultModelCliAdapter } from "./model-cli-adapter.ts";
import {
  normalizeModelForProvider,
  providerForModel,
} from "./provider-detection.ts";
import {
  estimateModelUsage,
  usageEstimateToRecord,
  type ModelUsageEstimate,
} from "./model-usage-estimator.ts";
import { AgentInvocationQueue } from "./agent-invocation-queue.ts";
import type {
  ModelCliAdapter,
  ModelCliRequest,
} from "./model-cli-types.ts";

export class AgentPlanningError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentPlanningError";
    this.code = code;
  }
}

export interface AgentPlanningServiceDeps {
  state: AgentPlanningStateGateway;
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
  /**
   * Phase 4b — Main process hook that materializes the active MCP config
   * for one CLI invocation. Returns `null` when no enabled MCP servers
   * apply (the request omits `--mcp-config`). The service guarantees
   * `cleanup()` runs whether the invocation succeeded, failed, or threw.
   * Renderer never sees this surface; only the main process implements it.
   */
  prepareMcpInvocation?: (input: {
    profileId: string | null;
    provider: AgentProvider;
  }) => Promise<{
    mcpConfigPath: string | null;
    codexConfigOverrides?: readonly string[];
    cleanup: () => Promise<void>;
  }>;
  /**
   * Main-process hook: returns Skillify capability instructions that
   * already passed the approval ledger for this TaskRun.
   */
  getApprovedCapabilityContexts?: (input: {
    taskRunId: string;
    profileId?: string | null;
  }) => Promise<CapabilityPromptContext[]>;
  /**
   * Main-process hook: returns a Learner model recommendation that
   * already passed approval for this TaskRun.
   */
  getApprovedLearnerModel?: (input: {
    taskRunId: string;
  }) => Promise<LearnerModelContext | null>;
  /**
   * Main-process hook: returns a deterministic repository map packed
   * from the persisted repo index. The agent package owns the packing
   * contract, while storage remains injected behind this interface.
   */
  getRepoContext?: (input: {
    taskRun: TaskRun;
    prompt: string;
  }) => Promise<PackedRepoContext | string | null>;
  /**
   * Main-process hook: records which approved advisory choices were
   * actually used for this invocation.
   */
  recordLearnerSelection?: (input: {
    taskRunId: string;
    selectedModel?: string;
    selectedCapabilities?: string[];
  }) => Promise<unknown>;
}

export interface GeneratePlanInput {
  taskRunId: string;
  provider?: AgentProvider;
  model?: string;
  instruction?: string;
  /** Override service-level default; injected from HarnessSettings at the IPC layer. */
  timeoutMs?: number;
  /** Override service-level default; injected from HarnessSettings at the IPC layer. */
  stallTimeoutMs?: number;
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
 * MVP scope: provider-scoped FIFO queue with one in-flight CLI process per
 * provider. cancel/retry are real service paths and keep the invocation row
 * terminal so the renderer never waits on a stale stream.
 */
export class AgentPlanningService {
  private readonly deps: AgentPlanningServiceDeps;
  private readonly adapter: ModelCliAdapter;
  private readonly queue: AgentInvocationQueue;
  private readonly defaults: { timeoutMs: number; stallTimeoutMs: number };

  constructor(deps: AgentPlanningServiceDeps) {
    this.deps = deps;
    this.adapter = deps.adapter ?? new DefaultModelCliAdapter();
    this.queue = deps.queue ?? new AgentInvocationQueue();
    this.defaults = {
      timeoutMs: deps.defaults?.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
      stallTimeoutMs:
        deps.defaults?.stallTimeoutMs ?? DEFAULT_AGENT_STALL_TIMEOUT_MS,
    };
  }

  /** Exposed so main.ts can wire RuntimeStatusBar to live queue depth. */
  getQueue(): AgentInvocationQueue {
    return this.queue;
  }

  getQueueDepths(): AgentQueueDepths {
    const claude = this.queue.getDepth("claude");
    const codex = this.queue.getDepth("codex");
    return { claude, codex, total: claude + codex };
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
    if (
      taskRun.status !== "drafting" &&
      taskRun.status !== "blocked" &&
      taskRun.status !== "quality_failed"
    ) {
      throw new AgentPlanningError(
        AGENT_MODE_MISMATCH,
        `agent.generatePlan requires TaskRun status drafting|blocked|quality_failed (got ${taskRun.status})`,
      );
    }

    const approvedLearnerModel =
      input.model === undefined
        ? await this.loadApprovedLearnerModel(taskRun.id)
        : null;

    // Phase 4: resolve the active AgentProfile so persona / prefix /
    // suffix flow into the prompt, and so the visible invocation step
    // carries the actual profile name used by the renderer.
    const profiles = await this.deps.state.listAgentProfiles();
    const settings = await this.deps.state.getSettings();
    const resolved = resolveAgentProfile({
      profiles,
      activeAgentProfileId: settings.activeAgentProfileId,
      legacyAgent: settings.agent,
    });

    const modelHint =
      input.model ?? approvedLearnerModel?.model ?? resolved.tuning.model;
    const providers = this.deps.getProviderStatus();
    const providerHint: "claude" | "codex" | undefined =
      input.provider === "claude" || input.provider === "codex"
        ? input.provider
        : modelHint
          ? toConcreteProvider(providerForModel(modelHint))
          : undefined;
    const provider: "claude" | "codex" | null =
      providerHint ??
      (providers?.claude?.available
        ? "claude"
        : providers?.codex?.available
          ? "codex"
          : null);
    if (!provider) {
      throw new AgentPlanningError(
        AGENT_PROVIDER_UNAVAILABLE,
        "No agent CLI provider is available; install claude or codex first",
      );
    }
    if (providers !== null) {
      const probedStatus = providers[provider];
      if (!probedStatus?.available) {
        throw new AgentPlanningError(
          AGENT_PROVIDER_UNAVAILABLE,
          `Provider ${provider} is not available`,
        );
      }
    }
    const model = resolveModel(provider, modelHint);
    const agentStepName = formatStepAgentName(resolved.profile?.name);
    assertProviderSupportsProfileBoundaries(provider, resolved.profile);

    // 1. plan step
    const stepIndex = (await this.deps.state.listStepsByTaskRun(taskRun.id))
      .length;
    const planStep = await this.deps.state.createStep({
      taskRunId: taskRun.id,
      index: stepIndex,
      kind: "plan",
      title: agentStepName
        ? `Agent[${agentStepName}] plan (${provider}:${model})`
        : `Agent plan (${provider}:${model})`,
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
    const capabilityContexts = await this.loadApprovedCapabilityContexts(
      taskRun.id,
      resolved.profile?.id ?? null,
    );
    const repoContext = await this.loadRepoContext(
      taskRun,
      taskRun.userRequest,
    );
    const threadContext = await this.loadThreadContext(taskRun);

    const splitPrompt = buildSplitAgentPrompt({
      taskRun,
      repoContext,
      threadContext,
      recentArtifacts,
      qualityRisks,
      persona: resolved.persona,
      systemPromptPrefix: resolved.systemPromptPrefix,
      systemPromptSuffix: resolved.systemPromptSuffix,
      ...(resolved.profile
        ? {
            profileMetadata: {
              name: resolved.profile.name,
              role: resolved.profile.role,
              category: resolved.profile.category,
              tags: resolved.profile.tags,
            },
          }
        : {}),
      capabilityContexts,
      ...(input.instruction !== undefined
        ? { instruction: input.instruction }
        : {}),
    });
    const redactedSystemPrompt = redactSecrets(splitPrompt.systemPrompt, 80_000);
    const redactedUserPrompt = redactSecrets(splitPrompt.userPrompt, 80_000);
    const promptArtifact = await this.deps.state.createArtifact({
      taskRunId: taskRun.id,
      stepId: planStep.id,
      kind: "log",
      title: "Agent prompt",
      uri: `harness:agent-prompt/${taskRun.id}/${Date.now()}`,
      summary: `[system]\n${redactedSystemPrompt}\n\n[user]\n${redactedUserPrompt}`,
    });

    // 3. invocation row
    const invocation = await this.deps.state.createAgentInvocation({
      taskRunId: taskRun.id,
      provider,
      model,
      promptArtifactId: promptArtifact.id,
      stepId: planStep.id,
      ...(resolved.profile ? { profileId: resolved.profile.id } : {}),
    });

    const startedAt = new Date().toISOString();
    await this.deps.state.updateAgentInvocation(invocation.id, {
      status: "running",
      startedAt,
    });
    const emit = this.deps.emitStreamEvent ?? (() => {});
    const persistedStreamEvents: AgentStreamEvent[] = [];
    const emitCaptured = (event: AgentStreamEvent): void => {
      const redacted = redactStreamEvent(withTaskRunScope(event, taskRun.id));
      persistedStreamEvents.push(redacted);
      emit(redacted);
    };
    const emitProgress = (
      stage: AgentProgressStage,
      message: string,
      detail?: string,
    ): void => {
      emitCaptured({
          type: "progress",
          invocationId: invocation.id,
          taskRunId: taskRun.id,
          stage,
          message,
          ...(detail !== undefined ? { detail } : {}),
          at: new Date().toISOString(),
      });
    };
    emitProgress(
      "context",
      "컨텍스트 수집 완료",
      `${recentArtifacts.length}개 artifact, 이전 task ${threadContext.length}개, 품질 리포트 ${qualityRisks ? "있음" : "없음"}, repo ${describeRepoContext(repoContext)}`,
    );
    emitProgress(
      "profile",
      "에이전트 프로필 선택",
      resolved.profile
        ? `${resolved.profile.name} (${resolved.source})`
        : "전역 agent 설정 사용",
    );
    if (approvedLearnerModel) {
      emitProgress(
        "profile",
        "Learner 모델 추천 반영",
        `${model} — ${approvedLearnerModel.reason}`,
      );
    }
    emitProgress(
      "prompt",
      "프롬프트 구성 완료",
      `system ${redactedSystemPrompt.length}자, user ${redactedUserPrompt.length}자, 승인 Skill ${capabilityContexts.length}개`,
    );

    // 4. invoke CLI through the per-provider queue. The queue serializes
    // claude/codex work and exposes an AbortSignal so cancel/retry can
    // tear down the child process cleanly.
    // Resume the thread's prior claude session if we have one — follow-up
    // questions within a thread share conversation memory that way.
    const thread = await this.deps.state.getThread(taskRun.threadId);
    const existingSessionId =
      provider === "claude" ? thread?.agentSessionId : undefined;
    emitProgress(
      "session",
      existingSessionId ? "이전 CLI 세션 이어가기" : "새 CLI 세션 준비",
      provider,
    );
    // Phase 4b — synthesize a temporary MCP config file when enabled
    // servers exist for the resolved profile. Claude receives a temp file;
    // Codex receives verified `-c mcp_servers.*` overrides.
    let mcpConfigPath: string | null = null;
    let codexConfigOverrides: readonly string[] = [];
    let mcpCleanup: () => Promise<void> = async () => {};
    if (this.deps.prepareMcpInvocation) {
      const prep = await this.deps.prepareMcpInvocation({
        profileId: resolved.profile?.id ?? null,
        provider,
      });
      mcpConfigPath = prep.mcpConfigPath;
      codexConfigOverrides = prep.codexConfigOverrides ?? [];
      mcpCleanup = prep.cleanup;
    }
    emitProgress(
      "mcp",
      mcpConfigPath || codexConfigOverrides.length > 0
        ? "MCP 설정 준비 완료"
        : "활성 MCP 설정 없음",
    );

    try {
      const toolPolicy = toolPolicyForProvider(provider, resolved.profile);
      const request: ModelCliRequest = {
        invocationId: invocation.id,
        taskRunId: taskRun.id,
        cwd: taskRun.targetDir,
        prompt: redactedUserPrompt,
        systemPrompt: redactedSystemPrompt,
        modelConfig: {
          provider,
          model,
          ...(resolved.tuning.reasoningEffort
            ? { reasoningEffort: resolved.tuning.reasoningEffort }
            : {}),
          // Priority: explicit input.timeout > active profile tuning > service defaults.
          // Resolver always provides a tuning block (legacy fallback synthesizes
          // one from HarnessSettings.agent), so `resolved.tuning.timeoutMs` is
          // safe to read directly.
          timeoutMs:
            input.timeoutMs ?? resolved.tuning.timeoutMs ?? this.defaults.timeoutMs,
          stallTimeoutMs:
            input.stallTimeoutMs ??
            resolved.tuning.stallTimeoutMs ??
            this.defaults.stallTimeoutMs,
        },
        sandbox: {
          primaryDir: taskRun.targetDir,
          enforceInPrompt: true,
        },
        ...(resolved.profile?.cli.cliPathOverride
          ? { cliPathOverride: resolved.profile.cli.cliPathOverride }
          : {}),
        ...(existingSessionId ? { sessionId: existingSessionId } : {}),
        ...(mcpConfigPath ? { mcpConfigPath } : {}),
        ...(codexConfigOverrides.length > 0 ? { codexConfigOverrides } : {}),
        ...(toolPolicy ? { toolPolicy } : {}),
      };
      await this.recordLearnerSelection({
        taskRunId: taskRun.id,
        ...(approvedLearnerModel ? { selectedModel: model } : {}),
        ...(capabilityContexts.length > 0
          ? {
              selectedCapabilities: capabilityContexts.map(
                (ctx) => ctx.capability.id,
              ),
            }
          : {}),
      });
      let assistantOutput = "";
      let rawProviderOutput = "";
      let latencyMs = 0;
      let costEstimate: number | undefined;
      let resultSessionId: string | undefined;
      try {
        const cliProgressDetail = `${provider}:${model} · cwd ${taskRun.targetDir}`;
        emitProgress("queued", "CLI 실행 대기열 등록", cliProgressDetail);
        const result = await this.queue.enqueue({
          provider,
          invocationId: invocation.id,
          work: (signal) => {
            emitProgress("cli", "CLI 프로세스 시작", cliProgressDetail);
            return this.adapter.invoke(
              request,
              emitCaptured,
              signal,
            );
          },
        });
        assistantOutput = result.stdout;
        rawProviderOutput = result.rawStdout ?? result.stdout;
        latencyMs = result.latencyMs;
        costEstimate = result.costEstimate;
        resultSessionId = result.sessionId;
      } catch (e) {
      const isCancelled = isHarnessError(e) && e.code === AGENT_CANCELLED;
      const code = isCancelled
        ? AGENT_CANCELLED
        : e instanceof AgentCliError
          ? e.code
          : AGENT_PROVIDER_UNAVAILABLE;
      const message = isHarnessError(e)
        ? e.message
        : e instanceof Error
          ? e.message
          : String(e);
      const finishedAt = new Date().toISOString();
      const diagnosticArtifact = await this.writeDiagnosticLog({
        title: "Agent diagnostic log",
        taskRunId: taskRun.id,
        stepId: planStep.id,
        invocationId: invocation.id,
        phase: "agent.generatePlan.cli",
        severity: isCancelled ? "warn" : "error",
        errorCode: code,
        message,
        provider,
        model,
        ...(e instanceof Error && e.stack ? { detail: e.stack } : {}),
      });
      if (isCancelled) {
        emitCaptured({
          type: "cancelled",
          invocationId: invocation.id,
          taskRunId: taskRun.id,
        });
        await this.deps.state.updateAgentInvocation(invocation.id, {
          status: "cancelled",
          errorCode: AGENT_CANCELLED,
          errorMessage: redactSecrets(message, 2_000),
          finishedAt,
          ...(diagnosticArtifact
            ? { rawOutputArtifactId: diagnosticArtifact.id }
            : {}),
        });
        await this.deps.state.setStepStatus(planStep.id, "failed", {
          outputSummary: `cancelled: ${message.slice(0, 200)}`,
        });
        throw new AgentPlanningError(AGENT_CANCELLED, message);
      }
      emitCaptured({
        type: "failed",
        invocationId: invocation.id,
        taskRunId: taskRun.id,
        errorCode: code,
        message,
      });
      await this.deps.state.updateAgentInvocation(invocation.id, {
        status: "failed",
        errorCode: code,
        errorMessage: redactSecrets(message, 2_000),
        finishedAt,
        ...(diagnosticArtifact
          ? { rawOutputArtifactId: diagnosticArtifact.id }
          : {}),
      });
      await this.deps.state.setStepStatus(planStep.id, "failed", {
        outputSummary: `${code}: ${message.slice(0, 200)}`,
      });
      await this.deps.state.setTaskRunStatus(taskRun.id, "blocked");
      throw new AgentPlanningError(code, message);
    }

    // 5. raw output artifact (redacted). Persist the original provider
    // stream when available so completed TaskRuns can hydrate back into
    // the same thinking/tool/intermediate/final sections as the live UI.
    const redactedOutput = redactSecrets(assistantOutput, 200_000);
    const redactedRawOutput = redactSecrets(rawProviderOutput, 200_000);
    const usageEstimate = estimateModelUsage({
      provider,
      model,
      systemPrompt: redactedSystemPrompt,
      prompt: redactedUserPrompt,
      output: redactedOutput,
      rawOutput: redactedRawOutput,
    });
    const providerCostEstimate = costEstimate;
    costEstimate = costEstimate ?? usageEstimate.costUsd;
    const persistedStreamTranscript = buildPersistedStreamTranscript({
      events: persistedStreamEvents,
      invocationId: invocation.id,
      taskRunId: taskRun.id,
      rawOutput: redactedRawOutput,
      assistantText: redactedOutput,
      latencyMs,
      ...(costEstimate !== undefined ? { costEstimate } : {}),
      usageEstimate,
      costEstimateApproximate:
        providerCostEstimate === undefined && usageEstimate.costUsd !== undefined,
    });
    const rawOutputArtifact = await this.deps.state.createArtifact({
      taskRunId: taskRun.id,
      stepId: planStep.id,
      kind: "log",
      title: "Agent raw output",
      uri: `harness:agent-output/${taskRun.id}/${Date.now()}`,
      summary: persistedStreamTranscript,
    });
    await this.deps.state.updateAgentInvocation(invocation.id, {
      rawOutputArtifactId: rawOutputArtifact.id,
      latencyMs,
      inputTokens: usageEstimate.inputTokens,
      outputTokens: usageEstimate.outputTokens,
      totalTokens: usageEstimate.totalTokens,
      usageApproximate: usageEstimate.approximate,
      ...(costEstimate !== undefined ? { costEstimate } : {}),
    });

    // Persist the claude session id on the thread so subsequent
    // TaskRuns within this conversation can `--resume` it.
    if (
      provider === "claude" &&
      resultSessionId &&
      resultSessionId !== existingSessionId
    ) {
      try {
        await this.deps.state.setThreadAgentSession(
          taskRun.threadId,
          resultSessionId,
        );
      } catch {
        // best effort — failing to record the session id should not
        // tear down a successful invocation.
      }
    }

    // 6. parse
    emitProgress("parse", "응답 파싱 중", `${redactedOutput.length}자 출력`);
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
      const snippet = redactedOutput.slice(0, 300).replace(/\n/g, " ");
      const errorMessage = snippet.length > 0
        ? `${parsed.reason} | Output preview: ${snippet}…`
        : parsed.reason;
      await this.deps.state.updateAgentInvocation(invocation.id, {
        status: "failed",
        errorCode: AGENT_INVALID_OUTPUT,
        errorMessage,
        finishedAt,
        parsedPlanArtifactId: errorArtifact.id,
      });
      await this.deps.state.setStepStatus(planStep.id, "failed", {
        outputSummary: `parse error: ${parsed.reason.slice(0, 200)}`,
      });
      await this.deps.state.setTaskRunStatus(taskRun.id, "blocked");
      throw new AgentPlanningError(AGENT_INVALID_OUTPUT, errorMessage);
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
    emitProgress(
      "approval",
      acceptedActions.length > 0
        ? "승인 항목 생성 중"
        : "승인 없이 답변 완료 처리 중",
      `${acceptedActions.length}/${plan.proposedActions.length}개 action accepted`,
    );
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
    emitProgress("complete", "에이전트 응답 처리 완료");
    return {
      invocation: finalInvocation,
      planArtifact,
      approvals,
    };
    } finally {
      // Best-effort cleanup of the per-invocation MCP config file.
      // Errors here never override the main outcome (success or failure).
      try {
        await mcpCleanup();
      } catch {
        // ignore
      }
    }
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
    if (inv.status === "succeeded" || inv.status === "failed" || inv.status === "cancelled") return inv;
    this.queue.cancel(input.invocationId);
    return this.deps.state.updateAgentInvocation(input.invocationId, {
      status: "cancelled",
      finishedAt: new Date().toISOString(),
      errorCode: AGENT_CANCELLED,
      errorMessage: "Cancelled by user",
    });
  }

  async retryInvocation(input: {
    invocationId: string;
    timeoutMs?: number;
    stallTimeoutMs?: number;
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
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.stallTimeoutMs !== undefined ? { stallTimeoutMs: input.stallTimeoutMs } : {}),
    });
  }

  /**
   * Phase 2 — orchestration worker invocation.
   *
   * Slim CLI call that drives a single AgentPipeline step. Uses the
   * step's bound `AgentProfile` for persona/tuning/MCP and the
   * pipeline-author-written `instruction` as the user request. Returns
   * the raw stdout text so the worker-runner can persist it as a log
   * artifact, plus parsed proposed actions when the model follows the
   * `harness_agent_plan` contract.
   *
   * Side-effect-free per Phase 2 policy (a): this method does NOT
   * create approvals, run shell commands, or write files. The model
   * may *suggest* such actions inside its output text; the worker-runner
   * turns those suggestions into pending approvals before any side effect.
   *
   * Differences vs `generatePlan`:
   *  - no TaskRun status mutation (worker-runner owns step rows)
   *  - parses proposed actions but does not create approvals itself
   *  - errors bubble up so the worker-runner marks the step failed
   *
   * Persists an `agent_invocations` row keyed by the synthesized
   * invocation id so the renderer's `InlineAgentStream` / right-panel
   * `AgentStreamView` pick the worker call up and render its live
   * stream in the central chat window — same surface as a normal
   * agent-mode TaskRun. Without this row, the stream events would
   * be emitted but the UI wouldn't know which TaskRun they belong
   * to, so the user sees a silent run.
   */
  async invokeForWorker(input: {
    taskRunId: string;
    stepId?: string;
    profile: AgentProfile;
    userRequest: string;
    handoffMessages?: readonly AgentHandoffPromptMessage[];
  }): Promise<{ outputText: string; proposedActions?: AgentProposedAction[] }> {
    const taskRun = await this.deps.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new AgentPlanningError(
        AGENT_TASK_RUN_NOT_FOUND,
        `TaskRun ${input.taskRunId} not found`,
      );
    }

    const providers = this.deps.getProviderStatus();
    let provider: AgentProvider;
    if (input.profile.provider === "auto") {
      const picked: "claude" | "codex" | null = providers?.claude?.available
        ? "claude"
        : providers?.codex?.available
          ? "codex"
          : null;
      if (!picked) {
        throw new AgentPlanningError(
          AGENT_PROVIDER_UNAVAILABLE,
          "No agent CLI provider is available for worker invocation",
        );
      }
      provider = picked;
    } else {
      provider = input.profile.provider;
    }
    if (providers !== null) {
      const probed = providers[provider];
      if (!probed?.available) {
        throw new AgentPlanningError(
          AGENT_PROVIDER_UNAVAILABLE,
          `Provider ${provider} is not available for worker invocation`,
        );
      }
    }
    const tuning = input.profile.tuning;
    const model = resolveModel(provider, tuning.model);
    assertProviderSupportsProfileBoundaries(provider, input.profile);

    // Worker invocations are independent pipeline steps. They receive
    // repo context and explicit handoffs in the prompt, so they do not
    // resume the thread-level Claude session; sharing one session would
    // make same-provider parallel workers contend on the provider CLI.
    const existingSessionId = undefined;

    // Per-invocation MCP config (Phase 4b). Cleaned up via try/finally.
    let mcpConfigPath: string | null = null;
    let codexConfigOverrides: readonly string[] = [];
    let mcpCleanup: () => Promise<void> = async () => {};
    if (this.deps.prepareMcpInvocation) {
      const prep = await this.deps.prepareMcpInvocation({
        profileId: input.profile.id,
        provider,
      });
      mcpConfigPath = prep.mcpConfigPath;
      codexConfigOverrides = prep.codexConfigOverrides ?? [];
      mcpCleanup = prep.cleanup;
    }

    const capabilityContexts = await this.loadApprovedCapabilityContexts(
      taskRun.id,
      input.profile.id,
    );
    const repoContext = await this.loadRepoContext(taskRun, input.userRequest);
    const threadContext = await this.loadThreadContext(taskRun);
    const prompt = buildSplitAgentPrompt({
      taskRun: { ...taskRun, userRequest: input.userRequest },
      repoContext,
      threadContext,
      persona: input.profile.persona,
      systemPromptPrefix: tuning.systemPromptPrefix,
      systemPromptSuffix: tuning.systemPromptSuffix,
      profileMetadata: {
        name: input.profile.name,
        role: input.profile.role,
        category: input.profile.category,
        tags: input.profile.tags,
      },
      capabilityContexts,
      ...(input.handoffMessages && input.handoffMessages.length > 0
        ? { handoffMessages: input.handoffMessages }
        : {}),
    });
    const systemPrompt = redactSecrets(prompt.systemPrompt, 80_000);
    const userPrompt = redactSecrets(prompt.userPrompt, 80_000);

    // Persist prompt + invocation row so the renderer's
    // `InlineAgentStream` can subscribe to stream events keyed by
    // invocation.id, and so the worker call shows up in the
    // right-panel Agent tab's invocation history alongside any
    // generatePlan calls.
    const promptArtifact = await this.deps.state.createArtifact({
      taskRunId: taskRun.id,
      ...(input.stepId ? { stepId: input.stepId } : {}),
      kind: "log",
      title: `Worker prompt — ${input.profile.name}`,
      uri: `harness:worker-prompt/${taskRun.id}/${Date.now()}`,
      summary: `[system]\n${systemPrompt}\n\n[user]\n${userPrompt}`,
    });
    const invocation = await this.deps.state.createAgentInvocation({
      taskRunId: taskRun.id,
      provider,
      model,
      promptArtifactId: promptArtifact.id,
      profileId: input.profile.id,
      ...(input.stepId ? { stepId: input.stepId } : {}),
    });
    const startedAt = new Date().toISOString();
    await this.deps.state.updateAgentInvocation(invocation.id, {
      status: "running",
      startedAt,
    });

    const emit = this.deps.emitStreamEvent ?? (() => {});
    const persistedStreamEvents: AgentStreamEvent[] = [];
    const emitCaptured = (event: AgentStreamEvent): void => {
      const redacted = redactStreamEvent(withTaskRunScope(event, taskRun.id));
      persistedStreamEvents.push(redacted);
      emit(redacted);
    };
    const emitProgress = (
      stage: AgentProgressStage,
      message: string,
      detail?: string,
    ): void => {
      emitCaptured({
          type: "progress",
          invocationId: invocation.id,
          taskRunId: taskRun.id,
          stage,
          message,
          ...(detail !== undefined ? { detail } : {}),
          at: new Date().toISOString(),
      });
    };
    emitProgress(
      "profile",
      "Worker 프로필 준비",
      `${input.profile.name} (${input.profile.role})`,
    );
    emitProgress(
      "prompt",
      "Worker 프롬프트 구성 완료",
      `system ${systemPrompt.length}자, user ${userPrompt.length}자, 이전 task ${threadContext.length}개, handoff ${input.handoffMessages?.length ?? 0}개, repo ${describeRepoContext(repoContext)}`,
    );
    emitProgress(
      "session",
      existingSessionId ? "이전 CLI 세션 이어가기" : "새 CLI 세션 준비",
      provider,
    );
    emitProgress(
      "mcp",
      mcpConfigPath || codexConfigOverrides.length > 0
        ? "MCP 설정 준비 완료"
        : "활성 MCP 설정 없음",
    );
    try {
      const toolPolicy = toolPolicyForProvider(provider, input.profile);
      const request: ModelCliRequest = {
        invocationId: invocation.id,
        taskRunId: taskRun.id,
        cwd: taskRun.targetDir,
        prompt: userPrompt,
        systemPrompt,
        modelConfig: {
          provider,
          model,
          ...(tuning.reasoningEffort
            ? { reasoningEffort: tuning.reasoningEffort }
            : {}),
          timeoutMs: tuning.timeoutMs ?? this.defaults.timeoutMs,
          stallTimeoutMs:
            tuning.stallTimeoutMs ?? this.defaults.stallTimeoutMs,
        },
        sandbox: {
          primaryDir: taskRun.targetDir,
          enforceInPrompt: true,
        },
        ...(input.profile.cli.cliPathOverride
          ? { cliPathOverride: input.profile.cli.cliPathOverride }
          : {}),
        ...(existingSessionId ? { sessionId: existingSessionId } : {}),
        ...(mcpConfigPath ? { mcpConfigPath } : {}),
        ...(codexConfigOverrides.length > 0 ? { codexConfigOverrides } : {}),
        ...(toolPolicy ? { toolPolicy } : {}),
      };
      const cliProgressDetail = `${provider}:${model} · cwd ${taskRun.targetDir}`;
      emitProgress("queued", "Worker CLI 실행 대기열 등록", cliProgressDetail);
      const result = await this.queue.enqueue({
        provider,
        invocationId: invocation.id,
        laneKey: `worker:${invocation.id}`,
        work: (signal) => {
          emitProgress("cli", "Worker CLI 프로세스 시작", cliProgressDetail);
          return this.adapter.invoke(
            request,
            emitCaptured,
            signal,
          );
        },
      });
      emitProgress("parse", "Worker 응답 정리 중", `${result.stdout.length}자 출력`);
      const redactedOutput = redactSecrets(result.stdout, 200_000);
      const redactedRawOutput = redactSecrets(
        result.rawStdout ?? result.stdout,
        200_000,
      );
      const usageEstimate = estimateModelUsage({
        provider,
        model,
        systemPrompt,
        prompt: userPrompt,
        output: redactedOutput,
        rawOutput: redactedRawOutput,
      });
      const costEstimate = result.costEstimate ?? usageEstimate.costUsd;
      const persistedStreamTranscript = buildPersistedStreamTranscript({
        events: persistedStreamEvents,
        invocationId: invocation.id,
        taskRunId: taskRun.id,
        rawOutput: redactedRawOutput,
        assistantText: redactedOutput,
        latencyMs: result.latencyMs,
        ...(costEstimate !== undefined ? { costEstimate } : {}),
        usageEstimate,
        costEstimateApproximate:
          result.costEstimate === undefined && usageEstimate.costUsd !== undefined,
      });
      const parsedPlan = parseAgentPlan(redactedOutput);
      const proposedActions = parsedPlan.ok
        ? parsedPlan.plan.proposedActions
        : [];
      const rawOutputArtifact = await this.deps.state.createArtifact({
        taskRunId: taskRun.id,
        ...(input.stepId ? { stepId: input.stepId } : {}),
        kind: "log",
        title: `Worker raw output — ${input.profile.name}`,
        uri: `harness:worker-output/${taskRun.id}/${Date.now()}`,
        summary: persistedStreamTranscript,
      });
      const finishedAt = new Date().toISOString();
      await this.deps.state.updateAgentInvocation(invocation.id, {
        status: "succeeded",
        rawOutputArtifactId: rawOutputArtifact.id,
        latencyMs: result.latencyMs,
        inputTokens: usageEstimate.inputTokens,
        outputTokens: usageEstimate.outputTokens,
        totalTokens: usageEstimate.totalTokens,
        usageApproximate: usageEstimate.approximate,
        ...(costEstimate !== undefined ? { costEstimate } : {}),
        finishedAt,
      });
      emitProgress(
        "complete",
        proposedActions.length > 0
          ? "Worker 제안 action 확인"
          : "Worker 응답 처리 완료",
        proposedActions.length > 0 ? `${proposedActions.length}개 action` : undefined,
      );
      return {
        outputText: redactedOutput,
        ...(proposedActions.length > 0 ? { proposedActions } : {}),
      };
    } catch (e) {
      const isCancelled = isHarnessError(e) && e.code === AGENT_CANCELLED;
      const code = isCancelled
        ? AGENT_CANCELLED
        : e instanceof AgentCliError
          ? e.code
          : AGENT_PROVIDER_UNAVAILABLE;
      const message = isHarnessError(e)
        ? e.message
        : e instanceof Error
          ? e.message
          : String(e);
      const finishedAt = new Date().toISOString();
      const diagnosticArtifact = await this.writeDiagnosticLog({
        title: `Worker diagnostic log — ${input.profile.name}`,
        taskRunId: taskRun.id,
        ...(input.stepId ? { stepId: input.stepId } : {}),
        invocationId: invocation.id,
        phase: "agent.invokeForWorker.cli",
        severity: isCancelled ? "warn" : "error",
        errorCode: code,
        message,
        provider,
        model,
        ...(e instanceof Error && e.stack ? { detail: e.stack } : {}),
      });
      // Emit the failure as a stream event too — without this the
      // InlineAgentStream sits at "응답 작성 중…" forever for a
      // failed worker call.
      if (isCancelled) {
        emitCaptured({
          type: "cancelled",
          invocationId: invocation.id,
          taskRunId: taskRun.id,
        });
      } else {
        emitCaptured({
          type: "failed",
          invocationId: invocation.id,
          taskRunId: taskRun.id,
          errorCode: code,
          message,
        });
      }
      await this.deps.state.updateAgentInvocation(invocation.id, {
        status: isCancelled ? "cancelled" : "failed",
        errorCode: code,
        errorMessage: redactSecrets(message, 2_000),
        finishedAt,
        ...(diagnosticArtifact
          ? { rawOutputArtifactId: diagnosticArtifact.id }
          : {}),
      });
      throw e;
    } finally {
      await mcpCleanup();
    }
  }

  private async writeDiagnosticLog(input: {
    title: string;
    taskRunId: string;
    stepId?: string;
    invocationId?: string;
    phase: string;
    severity: "warn" | "error";
    errorCode: string;
    message: string;
    provider: AgentProvider;
    model: string;
    detail?: string;
  }): Promise<Artifact | null> {
    try {
      const message = redactSecrets(input.message, 4_000);
      const detail = input.detail
        ? redactSecrets(input.detail, 20_000)
        : undefined;
      return await this.deps.state.createArtifact({
        taskRunId: input.taskRunId,
        ...(input.stepId ? { stepId: input.stepId } : {}),
        kind: "log",
        title: input.title,
        uri: `harness:diagnostic/${input.taskRunId}/${Date.now()}`,
        summary: formatDiagnosticLog({
          severity: input.severity,
          subsystem: "agent",
          phase: input.phase,
          taskRunId: input.taskRunId,
          ...(input.stepId ? { stepId: input.stepId } : {}),
          ...(input.invocationId ? { invocationId: input.invocationId } : {}),
          errorCode: input.errorCode,
          message,
          detail: [
            `provider=${input.provider}`,
            `model=${input.model}`,
            detail ?? "",
          ]
            .filter((line) => line.length > 0)
            .join("\n"),
        }),
      });
    } catch {
      return null;
    }
  }

  private async loadApprovedCapabilityContexts(
    taskRunId: string,
    profileId?: string | null,
  ): Promise<CapabilityPromptContext[]> {
    if (!this.deps.getApprovedCapabilityContexts) return [];
    try {
      return await this.deps.getApprovedCapabilityContexts({
        taskRunId,
        profileId,
      });
    } catch {
      return [];
    }
  }

  private async loadApprovedLearnerModel(
    taskRunId: string,
  ): Promise<LearnerModelContext | null> {
    if (!this.deps.getApprovedLearnerModel) return null;
    try {
      return await this.deps.getApprovedLearnerModel({ taskRunId });
    } catch {
      return null;
    }
  }

  private async loadRepoContext(
    taskRun: TaskRun,
    prompt: string,
  ): Promise<PackedRepoContext | string | null> {
    if (!this.deps.getRepoContext) return null;
    try {
      return await this.deps.getRepoContext({ taskRun, prompt });
    } catch {
      return null;
    }
  }

  private async loadThreadContext(
    taskRun: TaskRun,
  ): Promise<ThreadContextPromptTask[]> {
    if (!this.deps.state.getThreadDetail) return [];
    try {
      const detail = await this.deps.state.getThreadDetail(taskRun.threadId);
      if (!detail) return [];
      const currentCreatedAt = Date.parse(taskRun.createdAt);
      const ordered = [...detail.taskRuns].sort(
        (a, b) =>
          Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
          a.id.localeCompare(b.id),
      );
      const priorTasks = ordered
        .filter((candidate) => {
          if (candidate.id === taskRun.id) return false;
          const candidateCreatedAt = Date.parse(candidate.createdAt);
          if (
            Number.isFinite(currentCreatedAt) &&
            Number.isFinite(candidateCreatedAt)
          ) {
            return candidateCreatedAt <= currentCreatedAt;
          }
          return candidate.createdAt <= taskRun.createdAt;
        })
        .map((candidate, index) => ({
          ordinal:
            ordered.findIndex((task) => task.id === candidate.id) + 1 ||
            index + 1,
          taskRunId: candidate.id,
          userRequest: candidate.userRequest,
          status: candidate.status,
          ...(taskRun.followUpTaskRunId === candidate.id
            ? { isFollowUpAnchor: true }
            : {}),
          ...(detail.agentAnswers?.[candidate.id]
            ? { answerSummary: detail.agentAnswers[candidate.id] }
            : {}),
        }));
      const visible = priorTasks.slice(-6);
      const anchor = priorTasks.find((candidate) => candidate.isFollowUpAnchor);
      if (!anchor || visible.some((candidate) => candidate.taskRunId === anchor.taskRunId)) {
        return visible;
      }
      return [anchor, ...visible.slice(-5)].sort(
        (a, b) => a.ordinal - b.ordinal,
      );
    } catch {
      return [];
    }
  }

  private async recordLearnerSelection(input: {
    taskRunId: string;
    selectedModel?: string;
    selectedCapabilities?: string[];
  }): Promise<void> {
    if (!this.deps.recordLearnerSelection) return;
    if (
      input.selectedModel === undefined &&
      input.selectedCapabilities === undefined
    ) {
      return;
    }
    try {
      await this.deps.recordLearnerSelection(input);
    } catch {
      // Advisory trace writes must not block a valid agent invocation.
    }
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
  return normalizeModelForProvider(provider, preferred);
};

const formatStepAgentName = (name: string | undefined): string | null => {
  const normalized = name
    ?.replace(/[\[\]\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized && normalized.length > 0 ? normalized : null;
};

const toConcreteProvider = (
  provider: AgentProvider | null,
): "claude" | "codex" | undefined =>
  provider === "claude" || provider === "codex" ? provider : undefined;

const describeRepoContext = (
  context: PackedRepoContext | string | null,
): string => {
  if (!context) return "없음";
  if (typeof context === "string") return `${context.length}자`;
  return `${context.selectedFiles.length}/${context.indexedFileCount} files`;
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
  return lines.join("\n");
};

// Claude Code can invoke provider-managed tools before Harness has a
// chance to create approvals. Keep side-effect tools denied by default;
// the model should propose file/shell actions for Approval + Runner.
const CLAUDE_DEFAULT_DENIED_SIDE_EFFECT_TOOLS = [
  "Bash",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "Task",
] as const;

const toolPolicyForProvider = (
  provider: AgentProvider,
  profile: AgentProfile | null | undefined,
): ModelCliRequest["toolPolicy"] | undefined => {
  if (provider !== "claude") return undefined;
  const permissions = profile?.permissions;
  const toolAllowlist = normalizeToolPolicyList(
    permissions?.toolAllowlist ?? [],
  );
  const toolDenylist = normalizeToolPolicyList([
    ...CLAUDE_DEFAULT_DENIED_SIDE_EFFECT_TOOLS,
    ...(permissions?.toolDenylist ?? []),
  ]);
  if (toolAllowlist.length === 0 && toolDenylist.length === 0) {
    return undefined;
  }
  return { toolAllowlist, toolDenylist };
};

const assertProviderSupportsProfileBoundaries = (
  provider: AgentProvider,
  profile: AgentProfile | null | undefined,
): void => {
  if (provider !== "codex" || !profile) return;
  const unsupported: string[] = [];
  if (
    normalizeToolPolicyList(profile.permissions.toolAllowlist).length > 0 ||
    normalizeToolPolicyList(profile.permissions.toolDenylist).length > 0
  ) {
    unsupported.push("tool policy");
  }
  if (unsupported.length === 0) return;
  throw new AgentPlanningError(
    AGENT_PROVIDER_UNAVAILABLE,
    `Codex provider cannot enforce AgentProfile ${unsupported.join(" and ")} yet; use Claude or remove unsupported profile boundaries.`,
  );
};

const normalizeToolPolicyList = (patterns: readonly string[]): string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const pattern of patterns) {
    const value = pattern.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
};

const redactStreamEvent = (e: AgentStreamEvent): AgentStreamEvent => {
  if (e.type === "progress") {
    return {
      ...e,
      message: redactSecrets(e.message, 1_000),
      ...(e.detail !== undefined
        ? { detail: redactSecrets(e.detail, 1_000) }
        : {}),
    };
  }
  if (e.type === "assistant_text") {
    return { ...e, text: redactSecrets(e.text, 8_000) };
  }
  if (e.type === "raw") {
    return { ...e, text: redactSecrets(e.text, 8_000) };
  }
  if (e.type === "tool_call") {
    return {
      ...e,
      toolName: redactSecrets(e.toolName, 1_000),
      ...(e.toolCallId !== undefined
        ? { toolCallId: redactSecrets(e.toolCallId, 1_000) }
        : {}),
      ...(e.input !== undefined
        ? { input: redactUnknownStreamValue(e.input, 8_000) }
        : {}),
    };
  }
  if (e.type === "failed") {
    return { ...e, message: redactSecrets(e.message, 2_000) };
  }
  return e;
};

const withTaskRunScope = (
  event: AgentStreamEvent,
  taskRunId: string,
): AgentStreamEvent =>
  "taskRunId" in event && event.taskRunId
    ? event
    : { ...event, taskRunId };

const redactUnknownStreamValue = (value: unknown, limit: number): unknown => {
  if (typeof value === "string") return redactSecrets(value, limit);
  try {
    const redacted = redactSecrets(JSON.stringify(value), limit);
    return JSON.parse(redacted) as unknown;
  } catch {
    return redactSecrets(String(value), limit);
  }
};

const buildPersistedStreamTranscript = (input: {
  events: readonly AgentStreamEvent[];
  invocationId: string;
  taskRunId: string;
  rawOutput: string;
  assistantText: string;
  latencyMs: number;
  costEstimate?: number;
  usageEstimate?: ModelUsageEstimate;
  costEstimateApproximate?: boolean;
}): string => {
  const events = enrichResultEvents([...input.events], input);
  if (!events.some((event) => event.type === "raw") && input.rawOutput.length > 0) {
    events.push({
      type: "raw",
      invocationId: input.invocationId,
      taskRunId: input.taskRunId,
      source: "stdout",
      text: input.rawOutput,
    });
  }
  if (
    !events.some((event) => event.type === "assistant_text") &&
    input.assistantText.length > 0
  ) {
    events.push({
      type: "assistant_text",
      invocationId: input.invocationId,
      taskRunId: input.taskRunId,
      text: input.assistantText,
    });
  }
  if (!events.some((event) => event.type === "result")) {
    events.push({
      type: "result",
      invocationId: input.invocationId,
      taskRunId: input.taskRunId,
      latencyMs: input.latencyMs,
      ...(input.costEstimate !== undefined
        ? { costEstimate: input.costEstimate }
        : {}),
      ...(input.usageEstimate
        ? {
            usage: usageEstimateToRecord(input.usageEstimate),
            usageApproximate: input.usageEstimate.approximate,
          }
        : {}),
      ...(input.costEstimateApproximate !== undefined
        ? { costEstimateApproximate: input.costEstimateApproximate }
        : {}),
    });
  }
  return serializePersistedStreamEvents(events) || input.rawOutput;
};

const enrichResultEvents = (
  events: AgentStreamEvent[],
  input: {
    latencyMs: number;
    costEstimate?: number;
    usageEstimate?: ModelUsageEstimate;
    costEstimateApproximate?: boolean;
  },
): AgentStreamEvent[] =>
  events.map((event) => {
    if (event.type !== "result") return event;
    return {
      ...event,
      latencyMs: event.latencyMs ?? input.latencyMs,
      ...(event.costEstimate !== undefined
        ? { costEstimate: event.costEstimate }
        : input.costEstimate !== undefined
          ? { costEstimate: input.costEstimate }
          : {}),
      ...(input.usageEstimate
        ? {
            usage: usageEstimateToRecord(input.usageEstimate),
            usageApproximate: input.usageEstimate.approximate,
          }
        : {}),
      ...(input.costEstimateApproximate !== undefined
        ? { costEstimateApproximate: input.costEstimateApproximate }
        : {}),
    };
  });


const serializePersistedStreamEvents = (
  events: readonly AgentStreamEvent[],
): string => {
  if (events.length === 0) return "";
  return events.map((event) => JSON.stringify(event)).join("\n");
};
