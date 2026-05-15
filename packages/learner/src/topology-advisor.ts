import { randomUUID } from "node:crypto";
import {
  TOPOLOGY_TASK_NOT_FOUND,
  type AgentPipeline,
  type AgentPipelineStep,
  type AgentProfile,
  type ApprovalActionType,
  type ArtifactKind,
  type Capability,
  type CapabilitySuggestion,
  type Instinct,
  type LearningTrace,
  type RecommendTopologyInput,
  type TopologyRecommendation,
  type TopologyRecommendedStep,
  type WorkerOutputContract,
  type WorkerRole,
} from "@harness/core";
import type { LocalStateService } from "@harness/storage";
import {
  suggestCapabilities,
  type SkillMetadata,
} from "@harness/skillify-adapter";
import { deriveProjectKey } from "./project-key.ts";

export type CapabilityMetadataLookup = (
  capabilityId: string,
) => SkillMetadata | undefined;

export interface TopologyAdvisorDeps {
  state: LocalStateService;
  metadataForCapability?: CapabilityMetadataLookup;
}

export class TopologyAdvisorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TopologyAdvisorError";
    this.code = code;
  }
}

interface RoleSignal {
  role: WorkerRole;
  capabilityIds: Set<string>;
  instinctIds: Set<string>;
  score: number;
  reasons: string[];
}

const ROLE_ORDER: readonly WorkerRole[] = [
  "planner",
  "coder",
  "tester",
  "reviewer",
];

const ROLE_TITLES: Record<WorkerRole, string> = {
  planner: "Plan scope and risks",
  coder: "Implement requested change",
  tester: "Validate with focused tests",
  reviewer: "Review behavior and risks",
};

const ROLE_CONTRACTS: Record<WorkerRole, WorkerOutputContract> = {
  planner: "plan",
  coder: "diff_proposal",
  tester: "test_result",
  reviewer: "review",
};

const ROLE_ARTIFACTS: Record<WorkerRole, readonly ArtifactKind[]> = {
  planner: ["plan", "log"],
  coder: ["diff", "log"],
  tester: ["test_result", "log"],
  reviewer: ["quality_report", "log"],
};

const ROLE_ACTIONS: Record<WorkerRole, readonly ApprovalActionType[]> = {
  planner: [],
  coder: ["file_write"],
  tester: ["shell"],
  reviewer: [],
};

const ROLE_PATTERNS: Record<WorkerRole, RegExp> = {
  planner:
    /plan|design|spec|architecture|docs?|document|roadmap|phase|scope|risk|계획|설계|문서|분석/u,
  coder:
    /code|implement|patch|fix|write|refactor|typescript|react|electron|ipc|sqlite|구현|패치|수정|코드/u,
  tester:
    /test|verify|build|smoke|coverage|regression|quality gate|테스트|검증|빌드/u,
  reviewer:
    /review|audit|security|risk|quality|contract|invariant|검토|리뷰|보안|위험|품질/u,
};

export class TopologyAdvisor {
  private readonly deps: TopologyAdvisorDeps;

  constructor(deps: TopologyAdvisorDeps) {
    this.deps = deps;
  }

  async recommend(
    input: RecommendTopologyInput,
  ): Promise<TopologyRecommendation[]> {
    const taskRun = await this.deps.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new TopologyAdvisorError(
        TOPOLOGY_TASK_NOT_FOUND,
        `TaskRun ${input.taskRunId} not found`,
      );
    }

    const maxCandidates = clampCandidateCount(input.maxCandidates ?? 3);
    if (maxCandidates < 1) return [];

    const projectKey = await deriveProjectKey({ targetDir: taskRun.targetDir });
    const [
      capabilities,
      profiles,
      traces,
      pipelines,
      instincts,
    ] = await Promise.all([
      this.deps.state.listCapabilities(),
      this.deps.state.agentProfiles.list(),
      this.deps.state.listLearningTraces(),
      this.deps.state.agentPipelines.list(),
      this.deps.state.listInstincts({
        projectKey,
      }),
    ]);

    const warningSet = new Set<string>();
    const suggestions = filterTrustedSuggestions(
      suggestCapabilities({
        prompt: taskRun.userRequest,
        capabilities,
        limit: 10,
      }),
      this.deps.metadataForCapability,
      warningSet,
    );

    const signals = buildRoleSignals({
      prompt: taskRun.userRequest,
      suggestions,
      traces,
      instincts,
      metadataForCapability: this.deps.metadataForCapability,
    });
    const selectedRoles = chooseRoles(signals);
    const profileByRole = buildProfileByRole(profiles);
    const selectedSteps = buildRecommendedSteps({
      roles: selectedRoles,
      signals,
      profileByRole,
      warnings: warningSet,
    });

    if (selectedSteps.length === 0) return [];

    const sourceCapabilityIds = uniqueStrings(
      selectedSteps.flatMap((s) => s.sourceCapabilityIds),
    );
    const sourceInstinctIds = uniqueStrings(
      selectedSteps.flatMap((s) => s.sourceInstinctIds),
    );
    const sourceTraceIds = findSupportingTraceIds(traces, sourceCapabilityIds);
    const templatePipelineIds = findTemplatePipelineIds(
      pipelines,
      selectedSteps.map((s) => s.step.agentProfileId),
    );
    const pipelineDraft = {
      name: `Recommended: ${shorten(taskRun.userRequest, 54)}`,
      description:
        "Advisory topology draft generated from capability metadata, learning traces, and active instincts.",
      steps: selectedSteps.map((s) => s.step),
    };

    const recommendation: TopologyRecommendation = {
      id: `toprec_${randomUUID()}`,
      taskRunId: taskRun.id,
      title: "Balanced supervised topology",
      description:
        "Applies explicit dependencies and per-worker allowed actions while leaving save/run approval to the user.",
      confidence: computeConfidence({
        suggestions,
        instincts,
        sourceTraceIds,
        warningCount: warningSet.size,
      }),
      rationale: formatRecommendationRationale(selectedSteps),
      warnings: Array.from(warningSet),
      source: {
        capabilityIds: sourceCapabilityIds,
        instinctIds: sourceInstinctIds,
        traceIds: sourceTraceIds,
        templatePipelineIds,
      },
      steps: selectedSteps,
      pipelineDraft,
    };

    return [recommendation].slice(0, maxCandidates);
  }
}

const clampCandidateCount = (n: number): number => {
  if (!Number.isFinite(n)) return 3;
  return Math.max(0, Math.min(3, Math.floor(n)));
};

const filterTrustedSuggestions = (
  suggestions: CapabilitySuggestion[],
  lookup: CapabilityMetadataLookup | undefined,
  warnings: Set<string>,
): CapabilitySuggestion[] =>
  suggestions.filter((suggestion) => {
    const meta = lookup?.(suggestion.capability.id);
    if (meta?.trusted === false) {
      warnings.add(
        `Skipped untrusted capability metadata: ${suggestion.capability.name}`,
      );
      return false;
    }
    return true;
  });

const buildRoleSignals = (input: {
  prompt: string;
  suggestions: CapabilitySuggestion[];
  traces: LearningTrace[];
  instincts: Instinct[];
  metadataForCapability?: CapabilityMetadataLookup;
}): Map<WorkerRole, RoleSignal> => {
  const signals = new Map<WorkerRole, RoleSignal>();
  for (const role of ROLE_ORDER) {
    signals.set(role, {
      role,
      capabilityIds: new Set<string>(),
      instinctIds: new Set<string>(),
      score: ROLE_PATTERNS[role].test(input.prompt.toLowerCase()) ? 0.35 : 0,
      reasons: [],
    });
  }

  for (const suggestion of input.suggestions) {
    const meta = input.metadataForCapability?.(suggestion.capability.id);
    for (const role of rolesForCapability(suggestion.capability, meta)) {
      const signal = signals.get(role);
      if (!signal) continue;
      signal.capabilityIds.add(suggestion.capability.id);
      signal.score += Math.max(0.2, suggestion.score);
      signal.reasons.push(suggestion.reason);
    }
  }

  const selectedCapabilityIds = new Set(
    input.suggestions.map((s) => s.capability.id),
  );
  for (const trace of input.traces) {
    const reward = trace.reward ?? 0;
    if (reward <= 0) continue;
    for (const capabilityId of trace.selectedCapabilities) {
      if (!selectedCapabilityIds.has(capabilityId)) continue;
      const suggestion = input.suggestions.find(
        (s) => s.capability.id === capabilityId,
      );
      if (!suggestion) continue;
      const meta = input.metadataForCapability?.(capabilityId);
      for (const role of rolesForCapability(suggestion.capability, meta)) {
        const signal = signals.get(role);
        if (!signal) continue;
        signal.score += Math.min(0.5, reward);
        signal.reasons.push(`Positive trace ${trace.id}`);
      }
    }
  }

  for (const instinct of input.instincts) {
    if (instinct.status !== "active") continue;
    const text = instinctText(instinct);
    for (const role of ROLE_ORDER) {
      if (!ROLE_PATTERNS[role].test(text)) continue;
      const signal = signals.get(role);
      if (!signal) continue;
      signal.instinctIds.add(instinct.id);
      signal.score += Math.max(0.2, instinct.confidence);
      signal.reasons.push(`Active instinct: ${instinct.title}`);
    }
  }

  return signals;
};

const rolesForCapability = (
  capability: Capability,
  meta: SkillMetadata | undefined,
): WorkerRole[] => {
  const text = [
    capability.name,
    capability.description,
    capability.triggerTerms.join(" "),
    meta?.tags.join(" ") ?? "",
    meta?.inputs.join(" ") ?? "",
    meta?.outputs.join(" ") ?? "",
    meta?.allowedActions.join(" ") ?? "",
  ]
    .join(" ")
    .toLowerCase();
  const roles = ROLE_ORDER.filter((role) => ROLE_PATTERNS[role].test(text));
  if (meta?.allowedActions.includes("file_write")) roles.push("coder");
  if (meta?.allowedActions.includes("shell")) roles.push("tester");
  return uniqueRoles(roles.length > 0 ? roles : ["coder"]);
};

const chooseRoles = (signals: Map<WorkerRole, RoleSignal>): WorkerRole[] => {
  const roles = ROLE_ORDER.filter((role) => {
    const signal = signals.get(role);
    return signal !== undefined && signal.score > 0;
  });
  if (roles.length === 0) return ["planner", "coder"];
  if (!roles.includes("planner") && roles.length > 1) {
    roles.unshift("planner");
  }
  if (!roles.includes("coder")) {
    roles.splice(roles.includes("planner") ? 1 : 0, 0, "coder");
  }
  return uniqueRoles(roles);
};

const buildProfileByRole = (
  profiles: AgentProfile[],
): Map<WorkerRole, AgentProfile> => {
  const byRole = new Map<WorkerRole, AgentProfile>();
  for (const role of ROLE_ORDER) {
    const first = profiles.find((p) => p.role === role);
    if (first) byRole.set(role, first);
  }
  return byRole;
};

const buildRecommendedSteps = (input: {
  roles: WorkerRole[];
  signals: Map<WorkerRole, RoleSignal>;
  profileByRole: Map<WorkerRole, AgentProfile>;
  warnings: Set<string>;
}): TopologyRecommendedStep[] => {
  const steps: TopologyRecommendedStep[] = [];
  const stepIdByRole = new Map<WorkerRole, string>();
  for (const role of input.roles) {
    const profile = input.profileByRole.get(role);
    if (!profile) {
      input.warnings.add(`No AgentProfile is configured for role: ${role}`);
      continue;
    }
    const previousId = dependencyForRole(role, stepIdByRole);
    const stepId = `rec_${role}_${steps.length + 1}`;
    const signal = input.signals.get(role);
    const step: AgentPipelineStep = {
      id: stepId,
      agentProfileId: profile.id,
      title: ROLE_TITLES[role],
      instruction: instructionForRole(role),
      expectedArtifactKinds: ROLE_ARTIFACTS[role],
      dependsOn: previousId ? [previousId] : [],
      allowedActions: ROLE_ACTIONS[role],
      outputContract: ROLE_CONTRACTS[role],
    };
    stepIdByRole.set(role, stepId);
    steps.push({
      step,
      rationale: rationaleForRole(role, signal),
      sourceCapabilityIds: Array.from(signal?.capabilityIds ?? []),
      sourceInstinctIds: Array.from(signal?.instinctIds ?? []),
    });
  }
  return steps;
};

const dependencyForRole = (
  role: WorkerRole,
  stepIdByRole: Map<WorkerRole, string>,
): string | null => {
  if (role === "planner") return null;
  if (role === "coder") return stepIdByRole.get("planner") ?? null;
  return stepIdByRole.get("coder") ?? stepIdByRole.get("planner") ?? null;
};

const instructionForRole = (role: WorkerRole): string => {
  switch (role) {
    case "planner":
      return "Decompose the request, identify risks, and hand off a concrete implementation plan.";
    case "coder":
      return "Implement the approved plan using the repository conventions. Propose side effects only through approvals.";
    case "tester":
      return "Run or design focused verification for the implemented change and report concrete evidence.";
    case "reviewer":
      return "Review the result for correctness, regressions, and policy violations before completion.";
  }
};

const rationaleForRole = (
  role: WorkerRole,
  signal: RoleSignal | undefined,
): string => {
  if (!signal || signal.reasons.length === 0) {
    return `${role} is included as a baseline supervised workflow role.`;
  }
  return uniqueStrings(signal.reasons).slice(0, 3).join("; ");
};

const findSupportingTraceIds = (
  traces: LearningTrace[],
  capabilityIds: readonly string[],
): string[] => {
  const ids = new Set(capabilityIds);
  return traces
    .filter((trace) => {
      if ((trace.reward ?? 0) <= 0) return false;
      return trace.selectedCapabilities.some((id) => ids.has(id));
    })
    .slice(0, 5)
    .map((trace) => trace.id);
};

const findTemplatePipelineIds = (
  pipelines: AgentPipeline[],
  profileIds: readonly string[],
): string[] => {
  const ids = new Set(profileIds);
  return pipelines
    .filter((pipeline) =>
      pipeline.steps.some((step) => ids.has(step.agentProfileId)),
    )
    .slice(0, 3)
    .map((pipeline) => pipeline.id);
};

const computeConfidence = (input: {
  suggestions: CapabilitySuggestion[];
  instincts: Instinct[];
  sourceTraceIds: readonly string[];
  warningCount: number;
}): number => {
  const suggestionBoost = Math.min(
    0.25,
    input.suggestions.reduce((sum, s) => sum + Math.max(0, s.score), 0) *
      0.03,
  );
  const instinctBoost = Math.min(
    0.15,
    input.instincts.filter((i) => i.status === "active").length * 0.03,
  );
  const traceBoost = Math.min(0.15, input.sourceTraceIds.length * 0.04);
  const warningPenalty = Math.min(0.25, input.warningCount * 0.05);
  return round2(
    Math.max(
      0.25,
      Math.min(
        0.92,
        0.45 + suggestionBoost + instinctBoost + traceBoost - warningPenalty,
      ),
    ),
  );
};

const formatRecommendationRationale = (
  steps: readonly TopologyRecommendedStep[],
): string =>
  steps
    .map((entry) => `${entry.step.title}: ${entry.rationale}`)
    .join(" | ");

const instinctText = (instinct: Instinct): string =>
  [
    instinct.title,
    instinct.rule,
    instinct.rationale,
    instinct.tags.join(" "),
  ]
    .join(" ")
    .toLowerCase();

const uniqueStrings = (values: Iterable<string>): string[] =>
  Array.from(new Set(Array.from(values).filter((v) => v.length > 0)));

const uniqueRoles = (values: Iterable<WorkerRole>): WorkerRole[] => {
  const seen = new Set<WorkerRole>();
  const out: WorkerRole[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
};

const shorten = (text: string, max: number): string => {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}...`;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;
