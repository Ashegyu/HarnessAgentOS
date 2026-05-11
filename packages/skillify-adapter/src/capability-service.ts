import {
  CAPABILITY_NOT_FOUND,
  CAPABILITY_SCRIPT_NOT_FOUND,
  CAPABILITY_SCRIPT_TRAVERSAL,
  CAPABILITY_UNTRUSTED_SKILL,
  type Approval,
  type Capability,
  type CapabilitySuggestion,
  type SkillResources,
} from "@harness/core";
import type { LocalStateService } from "@harness/storage";
import { join, normalize, resolve, sep } from "node:path";
import { promises as fs } from "node:fs";
import { CapabilityRegistry } from "./capability-registry.ts";
import { suggestCapabilities } from "./capability-suggester.ts";
import { listSkillResources, readSkillInstructions } from "./skill-loader.ts";
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
  }): Promise<CapabilitySuggestion[]> {
    const taskRun = await this.deps.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new CapabilityServiceError(
        "STATE_TASK_RUN_NOT_FOUND",
        `TaskRun ${input.taskRunId} not found`,
      );
    }
    const capabilities = await this.deps.state.listCapabilities();
    return suggestCapabilities({
      prompt: `${taskRun.userRequest}\n${input.prompt}`,
      capabilities,
    });
  }

  async readSkill(input: {
    capabilityId: string;
  }): Promise<{
    capability: Capability;
    instructions: string;
    resources: SkillResources;
  }> {
    const capability = await this.requireCapability(input.capabilityId);
    const metadata = this.deps.registry.getMetadata(capability.id);
    if (!metadata) {
      throw new CapabilityServiceError(
        CAPABILITY_NOT_FOUND,
        `Skill metadata for capability ${capability.id} is not loaded; refresh the registry first`,
      );
    }
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
    const metadata = this.deps.registry.getMetadata(capability.id);
    if (!metadata) {
      throw new CapabilityServiceError(
        CAPABILITY_NOT_FOUND,
        `Skill metadata for capability ${capability.id} is not loaded`,
      );
    }
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
}

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
