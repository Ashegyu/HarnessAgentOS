import {
  CAPABILITY_NOT_FOUND,
  CAPABILITY_SCRIPT_NOT_FOUND,
  CAPABILITY_SCRIPT_TRAVERSAL,
  CAPABILITY_UNTRUSTED_SKILL,
  type Approval,
  type AgentProfile,
  type Capability,
  type CapabilityCandidateApprovalResult,
  type CapabilityPromptContext,
  type CapabilitySuggestion,
  type SkillResources,
} from "@harness/core";
import type { LocalStateService } from "@harness/storage";
import { join, normalize, resolve, sep } from "node:path";
import { promises as fs } from "node:fs";
import { CapabilityRegistry } from "./capability-registry.ts";
import { suggestCapabilities } from "./capability-suggester.ts";
import { listSkillResources, readSkillInstructions } from "./skill-loader.ts";
import type { SkillMetadata } from "./skill-metadata.ts";
import { isScriptExecutionAllowed } from "./skill-risk-policy.ts";

export class CapabilityServiceError extends Error {
  readonly code: string;
  constructor(
    code: string,
    message: string,
  ) {
    super(message);
    this.name = "CapabilityServiceError";
    this.code = code;
  }
}

export interface CapabilityServiceDeps {
  state: LocalStateService;
  registry: CapabilityRegistry;
}

/**
 * Phase 5 capability service. Pulls capability suggestions and routes
 * skill script execution requests through the approval flow. Never runs
 * a skill script itself.
 *
 * Source: docs/implementation/phase-05-skillify-capability-adapter.md
 */
export class CapabilityService {
  private readonly deps: CapabilityServiceDeps;
  constructor(deps: CapabilityServiceDeps) {
    this.deps = deps;
  }

  async list(): Promise<Capability[]> {
    return this.deps.state.listCapabilities();
  }

  async suggest(input: {
    taskRunId: string;
    prompt: string;
    profileId?: string | null;
  }): Promise<CapabilitySuggestion[]> {
    const taskRun = await this.deps.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new CapabilityServiceError(
        "STATE_TASK_RUN_NOT_FOUND",
        `TaskRun ${input.taskRunId} not found`,
      );
    }
    const capabilities = await this.deps.state.listCapabilities();
    const suggestions = suggestCapabilities({
      prompt: `${taskRun.userRequest}\n${input.prompt}`,
      capabilities,
    });
    const profile = await this.resolvePolicyProfile(input.profileId);
    return filterSuggestionsForProfile(suggestions, profile);
  }

  /**
   * Turn ranked Skillify suggestions into visible approval candidates.
   * This does not execute scripts and does not inject instructions into
   * a prompt yet. The agent prompt path later reads only approved
   * `capability_use` approvals via `approvedPromptContexts`.
   */
  async proposeCandidateApprovals(input: {
    taskRunId: string;
    prompt: string;
    profileId?: string | null;
  }): Promise<CapabilityCandidateApprovalResult> {
    const taskRun = await this.deps.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new CapabilityServiceError(
        "STATE_TASK_RUN_NOT_FOUND",
        `TaskRun ${input.taskRunId} not found`,
      );
    }
    const suggestions = await this.suggest(input);
    if (suggestions.length === 0) {
      return { suggestions, approvals: [], skipped: [] };
    }

    const existingApprovals = await this.deps.state.listApprovalsByTaskRun(
      taskRun.id,
    );
    const alreadyProposed = new Set(
      existingApprovals
        .filter((a) => a.actionType === "capability_use")
        .map((a) => a.proposedAction?.capabilityUse?.capabilityId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );

    const approvals: Approval[] = [];
    const skipped: CapabilitySuggestion[] = [];
    let checkpointId: string | null = null;

    for (const suggestion of suggestions) {
      const capability = suggestion.capability;
      const metadata = await this.metadataAfterCacheRecovery(capability.id);
      if (!metadata?.trusted || alreadyProposed.has(capability.id)) {
        skipped.push(suggestion);
        continue;
      }
      if (checkpointId === null) {
        const stepIndex = (
          await this.deps.state.listStepsByTaskRun(taskRun.id)
        ).length;
        const candidateStep = await this.deps.state.createStep({
          taskRunId: taskRun.id,
          index: stepIndex,
          kind: "approval",
          title: "Skill 후보 승인 대기",
          status: "pending",
          inputSummary: suggestions
            .map((s) => s.capability.name)
            .slice(0, 5)
            .join(", "),
        });
        const checkpoint = await this.deps.state.createCheckpoint({
          taskRunId: taskRun.id,
          stepId: candidateStep.id,
          reason: "before_edit",
          stateRef: JSON.stringify({
            taskRunStatus: taskRun.status,
            currentStepId: candidateStep.id,
            capabilityCandidateIds: suggestions.map((s) => s.capability.id),
          }),
          summary: "skill candidate checkpoint",
        });
        await this.deps.state.setTaskRunCurrentStep(
          taskRun.id,
          candidateStep.id,
        );
        checkpointId = checkpoint.id;
      }

      if (checkpointId === null) {
        throw new CapabilityServiceError(
          "STATE_INVALID_INPUT",
          "No checkpoint available for capability candidate approval",
        );
      }
      const approval = await this.deps.state.createApproval({
        taskRunId: taskRun.id,
        checkpointId,
        actionType: "capability_use",
        actionSummary: `Skill 후보 사용: ${capability.name} — ${suggestion.reason}`,
        status: "pending",
        proposedAction: {
          type: "capability_use",
          capabilityUse: {
            capabilityId: capability.id,
            capabilityName: capability.name,
            reason: suggestion.reason,
            matchedTerms: suggestion.matchedTerms,
          },
        },
      });
      approvals.push(approval);
      alreadyProposed.add(capability.id);
    }

    return { suggestions, approvals, skipped };
  }

  async approvedPromptContexts(input: {
    taskRunId: string;
    profileId?: string | null;
  }): Promise<CapabilityPromptContext[]> {
    const taskRun = await this.deps.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new CapabilityServiceError(
        "STATE_TASK_RUN_NOT_FOUND",
        `TaskRun ${input.taskRunId} not found`,
      );
    }
    const approvals = await this.deps.state.listApprovalsByTaskRun(taskRun.id);
    const profile = await this.resolvePolicyProfile(input.profileId);
    const seen = new Set<string>();
    const contexts: CapabilityPromptContext[] = [];
    for (const approval of approvals) {
      if (approval.actionType !== "capability_use") continue;
      if (
        approval.status !== "approved" &&
        approval.status !== "always_approved_for_run" &&
        approval.status !== "executed"
      ) {
        continue;
      }
      const capabilityId = approval.proposedAction?.capabilityUse?.capabilityId;
      if (!capabilityId || seen.has(capabilityId)) continue;
      if (!isCapabilityAllowedByProfile(capabilityId, profile)) continue;
      const metadata = await this.metadataAfterCacheRecovery(capabilityId);
      if (!metadata?.trusted) continue;
      const capability = await this.requireCapability(capabilityId);
      const instructions = await readSkillInstructions(metadata);
      contexts.push({
        capability,
        reason:
          approval.proposedAction?.capabilityUse?.reason ??
          approval.actionSummary,
        instructions,
      });
      seen.add(capabilityId);
    }
    return contexts;
  }

  async readSkill(input: {
    capabilityId: string;
  }): Promise<{
    capability: Capability;
    instructions: string;
    resources: SkillResources;
  }> {
    const capability = await this.requireCapability(input.capabilityId);
    const metadata = await this.requireMetadata(capability.id);
    const [instructions, resources] = await Promise.all([
      readSkillInstructions(metadata),
      listSkillResources(metadata),
    ]);
    return { capability, instructions, resources };
  }

  /**
   * Create an Approval row for a skill script execution. Never executes
   * the script. Untrusted skills are refused outright, per Phase 5
   * security policy.
   */
  async proposeScriptRun(input: {
    capabilityId: string;
    taskRunId: string;
    scriptName: string;
  }): Promise<Approval> {
    const capability = await this.requireCapability(input.capabilityId);
    const metadata = await this.requireMetadata(capability.id);
    if (
      !isScriptExecutionAllowed({
        trusted: metadata.trusted,
        riskLevel: metadata.riskLevel,
      })
    ) {
      throw new CapabilityServiceError(
        CAPABILITY_UNTRUSTED_SKILL,
        `Skill ${metadata.id} is untrusted; script execution is blocked`,
      );
    }
    const scriptName = (input.scriptName ?? "").trim();
    if (scriptName.length === 0) {
      throw new CapabilityServiceError(
        "STATE_INVALID_INPUT",
        "scriptName must be a non-empty string",
      );
    }
    const scriptPath = resolveSkillScript(metadata.sourceDir, scriptName);
    try {
      await fs.access(scriptPath);
    } catch {
      throw new CapabilityServiceError(
        CAPABILITY_SCRIPT_NOT_FOUND,
        `Skill script ${scriptName} not found in ${metadata.sourceDir}`,
      );
    }

    const taskRun = await this.deps.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new CapabilityServiceError(
        "STATE_TASK_RUN_NOT_FOUND",
        `TaskRun ${input.taskRunId} not found`,
      );
    }

    const stepIndex = (
      await this.deps.state.listStepsByTaskRun(taskRun.id)
    ).length;
    const proposalStep = await this.deps.state.createStep({
      taskRunId: taskRun.id,
      index: stepIndex,
      kind: "approval",
      title: `Skill script 제안: ${capability.name}`,
      status: "pending",
      inputSummary: `${capability.id}/${scriptName}`,
    });
    const checkpoint = await this.deps.state.createCheckpoint({
      taskRunId: taskRun.id,
      stepId: proposalStep.id,
      reason: "before_edit",
      stateRef: JSON.stringify({
        taskRunStatus: taskRun.status,
        currentStepId: proposalStep.id,
        capabilityId: capability.id,
        scriptName,
        scriptPath,
      }),
      summary: `before_edit checkpoint for skill script ${capability.name}/${scriptName}`,
    });
    const approval = await this.deps.state.createApproval({
      taskRunId: taskRun.id,
      checkpointId: checkpoint.id,
      actionType: "skill_script",
      actionSummary: `Run skill script ${capability.name}/${scriptName}`,
      status: "pending",
    });
    return approval;
  }

  private async requireCapability(id: string): Promise<Capability> {
    const cap = await this.deps.state.getCapability(id);
    if (!cap) {
      throw new CapabilityServiceError(
        CAPABILITY_NOT_FOUND,
        `Capability ${id} not found`,
      );
    }
    return cap;
  }

  private async requireMetadata(capabilityId: string): Promise<SkillMetadata> {
    const metadata = await this.metadataAfterCacheRecovery(capabilityId);
    if (!metadata) {
      throw new CapabilityServiceError(
        CAPABILITY_NOT_FOUND,
        `Skill metadata for capability ${capabilityId} is not loaded after refreshing enabled skill sources`,
      );
    }
    return metadata;
  }

  private async metadataAfterCacheRecovery(
    capabilityId: string,
  ): Promise<SkillMetadata | undefined> {
    const cached = this.deps.registry.getMetadata(capabilityId);
    if (cached) return cached;
    try {
      await this.deps.registry.refreshPersistedSources();
    } catch (error) {
      throw new CapabilityServiceError(
        CAPABILITY_NOT_FOUND,
        `Skill metadata for capability ${capabilityId} is not loaded and refresh failed: ${errorMessage(error)}`,
      );
    }
    return this.deps.registry.getMetadata(capabilityId);
  }

  private async resolvePolicyProfile(
    profileId: string | null | undefined,
  ): Promise<AgentProfile | null> {
    if (profileId === null) return null;
    if (profileId !== undefined) {
      return this.deps.state.agentProfiles.get(profileId);
    }

    const settings = await this.deps.state.getSettings();
    const profiles = await this.deps.state.listAgentProfiles();
    if (settings.activeAgentProfileId) {
      const active = profiles.find(
        (p) => p.id === settings.activeAgentProfileId,
      );
      if (active) return active;
    }
    return profiles.find((p) => p.isDefault) ?? null;
  }
}

const isCapabilityAllowedByProfile = (
  capabilityId: string,
  profile: AgentProfile | null,
): boolean => {
  const allowed = profile?.permissions.allowedSkillIds ?? [];
  return allowed.length === 0 || allowed.includes(capabilityId);
};

const filterSuggestionsForProfile = (
  suggestions: readonly CapabilitySuggestion[],
  profile: AgentProfile | null,
): CapabilitySuggestion[] =>
  suggestions.filter((s) =>
    isCapabilityAllowedByProfile(s.capability.id, profile),
  );

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const resolveSkillScript = (sourceDir: string, scriptName: string): string => {
  const candidate = resolve(normalize(join(sourceDir, "scripts", scriptName)));
  const dir = resolve(normalize(sourceDir));
  const withSep = dir.endsWith(sep) ? dir : dir + sep;
  if (!candidate.startsWith(withSep)) {
    throw new CapabilityServiceError(
      CAPABILITY_SCRIPT_TRAVERSAL,
      `Script path escapes skill directory`,
    );
  }
  return candidate;
};
