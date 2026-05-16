import { APPROVAL_ACTION_TYPES, WORKER_OUTPUT_CONTRACTS } from "@harness/core";
import type {
  AgentPipeline,
  AgentPipelineStep,
  A2ARegistryEntry,
  ArtifactKind,
  CreateAgentPipelineInput,
  ApprovalActionType,
  HarnessSettings,
  ThreadDetail,
  WorkerRole,
  WorkerOutputContract,
} from "@harness/core";

/**
 * Renderer-side form state for editing AgentPipeline templates. Steps
 * carry an `agentProfileId` (chosen from the registered profiles list);
 * everything else is a plain text input. Validation runs against the
 * caller-supplied profile list so the form catches dangling references
 * before the IPC roundtrip.
 */

export interface PipelineStepDraft {
  id: string;
  agentProfileId: string;
  remoteEndpointId: string;
  title: string;
  instruction: string;
  expectedArtifactKinds: string[];
  dependsOn: string[] | null;
  allowedActions: ApprovalActionType[] | null;
  outputContract: WorkerOutputContract | "";
}

export interface PipelineDraft {
  id: string | null;
  name: string;
  description: string;
  steps: PipelineStepDraft[];
}

export interface PipelineDraftError {
  field: "name" | "description" | "steps";
  message: string;
}

export interface PipelineFanOutStepPreview {
  stepId: string;
  title: string;
  index: number;
  dependencyIds: string[];
  role: WorkerRole | "documenter" | "unknown";
  remoteEndpointId: string | null;
  remoteEndpointLabel: string;
  remoteEndpointEnabled: boolean;
  remoteEndpointTrusted: boolean;
  allowedActions: ApprovalActionType[] | null;
  canRunReadOnlyParallel: boolean;
  blockers: string[];
  warnings: string[];
}

export interface PipelineFanOutWave {
  index: number;
  stepIds: string[];
  parallelizable: boolean;
  hasSideEffects: boolean;
  warnings: string[];
  steps: PipelineFanOutStepPreview[];
}

export interface PipelineFanOutPreview {
  waves: PipelineFanOutWave[];
  deterministicOrder: string[];
  warnings: string[];
}

export interface TopologyTaskRunOption {
  id: string;
  label: string;
  threadTitle: string;
  userRequest: string;
  status: string;
  createdAt: string;
}

export const PIPELINE_WORKER_ACTION_CHOICES: readonly ApprovalActionType[] = [
  "file_write",
  "shell",
];

export const PIPELINE_OUTPUT_CONTRACT_CHOICES = WORKER_OUTPUT_CONTRACTS;

const ACTION_SET: ReadonlySet<string> = new Set(APPROVAL_ACTION_TYPES);
const OUTPUT_CONTRACT_SET: ReadonlySet<string> = new Set(
  WORKER_OUTPUT_CONTRACTS,
);

export const emptyPipelineDraft = (): PipelineDraft => ({
  id: null,
  name: "",
  description: "",
  steps: [],
});

export const pipelineToDraft = (p: AgentPipeline): PipelineDraft => ({
  id: p.id,
  name: p.name,
  description: p.description,
  steps: p.steps.map((s) => ({
    id: s.id,
    agentProfileId: s.agentProfileId,
    remoteEndpointId: s.remoteEndpointId ?? "",
    title: s.title,
    instruction: s.instruction,
    expectedArtifactKinds: [...s.expectedArtifactKinds],
    dependsOn: s.dependsOn !== undefined ? [...s.dependsOn] : null,
    allowedActions:
      s.allowedActions !== undefined ? [...s.allowedActions] : null,
    outputContract: s.outputContract ?? "",
  })),
});

export const pipelineInputToDraft = (
  input: CreateAgentPipelineInput,
): PipelineDraft => ({
  id: null,
  name: input.name,
  description: input.description,
  steps: input.steps.map((s) => ({
    id: s.id,
    agentProfileId: s.agentProfileId,
    remoteEndpointId: s.remoteEndpointId ?? "",
    title: s.title,
    instruction: s.instruction,
    expectedArtifactKinds: [...s.expectedArtifactKinds],
    dependsOn: s.dependsOn !== undefined ? [...s.dependsOn] : null,
    allowedActions:
      s.allowedActions !== undefined ? [...s.allowedActions] : null,
    outputContract: s.outputContract ?? "",
  })),
});

export const topologyTaskRunOptionsFromThreadDetails = (
  details: ReadonlyArray<ThreadDetail | null>,
  limit = 50,
): TopologyTaskRunOption[] =>
  details
    .flatMap((detail) =>
      detail
        ? detail.taskRuns.map((taskRun) => ({
            id: taskRun.id,
            label: `${detail.thread.title} · ${taskRun.userRequest}`,
            threadTitle: detail.thread.title,
            userRequest: taskRun.userRequest,
            status: taskRun.status,
            createdAt: taskRun.createdAt,
          }))
        : [],
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);

export const settingsWithDefaultPipeline = (
  settings: HarnessSettings,
  pipelineId: string,
): HarnessSettings => ({
  ...settings,
  orchestration: {
    ...settings.orchestration,
    enabled: true,
    defaultPipelineId: pipelineId,
  },
});

interface ProfileLite {
  id: string;
  name: string;
  role?: WorkerRole | "documenter";
}

const READ_ONLY_PARALLEL_ROLES = new Set<string>([
  "planner",
  "reviewer",
  "documenter",
]);

export const validatePipelineDraft = (
  draft: PipelineDraft,
  profiles: readonly ProfileLite[],
  remoteEntries: readonly A2ARegistryEntry[] = [],
): PipelineDraftError[] => {
  const errors: PipelineDraftError[] = [];
  if (draft.name.trim().length === 0) {
    errors.push({ field: "name", message: "이름은 필수입니다" });
  }
  if (draft.steps.length < 1) {
    errors.push({ field: "steps", message: "최소 1개의 step이 필요합니다" });
  }
  const validProfileIds = new Set(profiles.map((p) => p.id));
  const validRemoteEndpointIds = new Set(
    remoteEntries
      .filter((entry) => entry.endpoint.enabled && entry.endpoint.trusted)
      .map((entry) => entry.endpoint.id),
  );
  const stepIds = new Set<string>();
  for (const [i, step] of draft.steps.entries()) {
    if (stepIds.has(step.id)) {
      errors.push({
        field: "steps",
        message: `step ${i + 1}: 중복된 step id (${step.id})`,
      });
    }
    stepIds.add(step.id);
  }
  draft.steps.forEach((step, i) => {
    const remoteEndpointId = step.remoteEndpointId ?? "";
    if (step.title.trim().length === 0) {
      errors.push({
        field: "steps",
        message: `step ${i + 1}: title이 비어있습니다`,
      });
    }
    if (!validProfileIds.has(step.agentProfileId)) {
      errors.push({
        field: "steps",
        message: `step ${i + 1}: 알 수 없는 profile (${step.agentProfileId})`,
      });
    }
    if (
      remoteEndpointId.length > 0 &&
      !validRemoteEndpointIds.has(remoteEndpointId)
    ) {
      errors.push({
        field: "steps",
        message: `step ${i + 1}: unknown remote endpoint (${remoteEndpointId})`,
      });
    }
    const dependsOn = effectiveDependsOn(draft.steps, i);
    for (const depId of dependsOn) {
      if (depId === step.id) {
        errors.push({
          field: "steps",
          message: `step ${i + 1}: 자기 자신을 dependency로 지정할 수 없습니다`,
        });
      } else if (!stepIds.has(depId)) {
        errors.push({
          field: "steps",
          message: `step ${i + 1}: unknown dependency (${depId})`,
        });
      }
    }
    if (
      step.allowedActions !== null &&
      step.allowedActions !== undefined &&
      !step.allowedActions.every((action) => ACTION_SET.has(action))
    ) {
      errors.push({
        field: "steps",
        message: `step ${i + 1}: unknown allowed action`,
      });
    }
    if (
      step.outputContract !== "" &&
      step.outputContract !== undefined &&
      !OUTPUT_CONTRACT_SET.has(step.outputContract)
    ) {
      errors.push({
        field: "steps",
        message: `step ${i + 1}: unknown output contract`,
      });
    }
  });
  const cycleAt = firstCycleStepId(draft.steps);
  if (cycleAt !== null) {
    errors.push({
      field: "steps",
      message: `dependency cycle detected at ${cycleAt}`,
    });
  }
  return errors;
};

export const buildPipelineFanOutPreview = (
  draft: PipelineDraft,
  profiles: readonly ProfileLite[],
  remoteEntries: readonly A2ARegistryEntry[] = [],
): PipelineFanOutPreview => {
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const remoteById = new Map(
    remoteEntries.map((entry) => [entry.endpoint.id, entry] as const),
  );
  const stepIdSet = new Set(draft.steps.map((step) => step.id));
  const dependencyById = new Map(
    draft.steps.map(
      (step, index) => [step.id, effectiveDependsOn(draft.steps, index)] as const,
    ),
  );
  const steps = draft.steps.map((step, index): PipelineFanOutStepPreview => {
    const profile = profileById.get(step.agentProfileId);
    const role = profile?.role ?? "unknown";
    const dependencyIds = dependencyById.get(step.id) ?? [];
    const blockers: string[] = [];
    const warnings: string[] = [];
    const allowedActions =
      step.allowedActions !== null && step.allowedActions !== undefined
        ? [...step.allowedActions]
        : null;

    if (allowedActions === null) {
      blockers.push("Allowed Actions가 Default라 읽기 전용 병렬 대상이 아닙니다");
      warnings.push("side-effect proposal 범위가 명시되지 않았습니다");
    } else if (allowedActions.length > 0) {
      blockers.push(
        `side-effect proposal(${allowedActions.join(", ")})이 허용되어 병렬 대상이 아닙니다`,
      );
    }
    if (!READ_ONLY_PARALLEL_ROLES.has(role)) {
      blockers.push(`${role} role은 읽기 전용 병렬 대상이 아닙니다`);
    }
    for (const depId of dependencyIds) {
      if (!stepIdSet.has(depId)) {
        blockers.push(`unknown dependency (${depId})`);
      }
    }

    const remoteEndpointId = step.remoteEndpointId?.trim() || null;
    const remoteEntry =
      remoteEndpointId !== null ? remoteById.get(remoteEndpointId) : undefined;
    let remoteEndpointLabel = "Local CLI";
    let remoteEndpointEnabled = true;
    let remoteEndpointTrusted = true;
    if (remoteEndpointId !== null) {
      remoteEndpointLabel =
        remoteEntry?.endpoint.name ?? `(missing remote: ${remoteEndpointId})`;
      remoteEndpointEnabled = remoteEntry?.endpoint.enabled ?? false;
      remoteEndpointTrusted = remoteEntry?.endpoint.trusted ?? false;
      if (remoteEntry === undefined) {
        blockers.push(`remote endpoint를 찾을 수 없습니다 (${remoteEndpointId})`);
      } else {
        if (!remoteEntry.endpoint.enabled) {
          blockers.push("remote endpoint가 disabled 상태입니다");
        }
        if (!remoteEntry.endpoint.trusted) {
          blockers.push("remote endpoint가 trusted 상태가 아닙니다");
        }
      }
    }

    return {
      stepId: step.id,
      title: step.title.trim() || step.id,
      index,
      dependencyIds,
      role,
      remoteEndpointId,
      remoteEndpointLabel,
      remoteEndpointEnabled,
      remoteEndpointTrusted,
      allowedActions,
      canRunReadOnlyParallel: blockers.length === 0,
      blockers,
      warnings,
    };
  });
  const stepPreviewById = new Map(
    steps.map((step) => [step.stepId, step] as const),
  );
  const scheduled = new Set<string>();
  const remaining = new Set(steps.map((step) => step.stepId));
  const waves: PipelineFanOutWave[] = [];
  const previewWarnings: string[] = [];

  while (remaining.size > 0) {
    const ready = steps
      .filter(
        (step) =>
          remaining.has(step.stepId) &&
          step.dependencyIds.every((depId) => {
            if (!stepPreviewById.has(depId)) return true;
            return scheduled.has(depId);
          }),
      )
      .sort((a, b) => a.index - b.index);

    if (ready.length === 0) {
      const blocked = steps
        .filter((step) => remaining.has(step.stepId))
        .sort((a, b) => a.index - b.index)
        .map((step) => ({
          ...step,
          blockers: [
            ...step.blockers,
            "dependency cycle 또는 미해결 dependency 때문에 wave를 확정할 수 없습니다",
          ],
          canRunReadOnlyParallel: false,
        }));
      previewWarnings.push("dependency cycle 또는 미해결 dependency가 있습니다");
      waves.push(buildFanOutWave(waves.length, blocked));
      break;
    }

    for (const step of ready) {
      scheduled.add(step.stepId);
      remaining.delete(step.stepId);
    }
    waves.push(buildFanOutWave(waves.length, ready));
  }

  return {
    waves,
    deterministicOrder: steps.map((step) => step.stepId),
    warnings: previewWarnings,
  };
};

const buildFanOutWave = (
  index: number,
  steps: PipelineFanOutStepPreview[],
): PipelineFanOutWave => {
  const hasSideEffects = steps.some(
    (step) => step.allowedActions !== null && step.allowedActions.length > 0,
  );
  const hasDefaultActions = steps.some((step) => step.allowedActions === null);
  const parallelizable =
    steps.length > 1 && steps.every((step) => step.canRunReadOnlyParallel);
  const warnings: string[] = [];
  if (hasSideEffects) {
    warnings.push("side-effect proposal이 포함되어 실행 시 approval이 필요합니다");
  }
  if (hasDefaultActions) {
    warnings.push("Default action scope가 있어 읽기 전용 병렬 대상에서 제외됩니다");
  }
  if (steps.length > 1 && !parallelizable) {
    warnings.push("동일 wave이지만 보수 정책상 순차 preview입니다");
  }
  return {
    index,
    stepIds: steps.map((step) => step.stepId),
    parallelizable,
    hasSideEffects,
    warnings,
    steps,
  };
};

export const serializePipelineDraft = (
  draft: PipelineDraft,
): CreateAgentPipelineInput | AgentPipeline => {
  const steps: AgentPipelineStep[] = draft.steps.map((s) => {
    const remoteEndpointId = s.remoteEndpointId?.trim() ?? "";
    const dependsOn = s.dependsOn ?? null;
    const allowedActions = s.allowedActions ?? null;
    const outputContract = s.outputContract ?? "";
    return {
      id: s.id,
      agentProfileId: s.agentProfileId,
      ...(remoteEndpointId.length > 0 ? { remoteEndpointId } : {}),
      title: s.title.trim(),
      instruction: s.instruction,
      expectedArtifactKinds: [...s.expectedArtifactKinds] as ArtifactKind[],
      ...(dependsOn !== null ? { dependsOn: [...dependsOn] } : {}),
      ...(allowedActions !== null
        ? { allowedActions: [...allowedActions] }
        : {}),
      ...(outputContract !== "" ? { outputContract } : {}),
    };
  });
  const base = {
    name: draft.name.trim(),
    description: draft.description,
    steps,
  };
  if (draft.id !== null) {
    // Update — caller layers `createdAt/updatedAt` on top before sending.
    return { ...base, id: draft.id } as unknown as AgentPipeline;
  }
  return base as CreateAgentPipelineInput;
};

/**
 * Move the step at `index` by `delta` positions (-1 = up, +1 = down).
 * Returns a new array; the original is left untouched. No-op if the
 * resulting index would fall outside the array.
 */
export const moveStep = <T>(
  steps: readonly T[],
  index: number,
  delta: number,
): T[] => {
  const target = index + delta;
  if (target < 0 || target >= steps.length) return [...steps];
  const next = [...steps];
  const tmp = next[index] as T;
  next[index] = next[target] as T;
  next[target] = tmp;
  return next;
};

const effectiveDependsOn = (
  steps: readonly PipelineStepDraft[],
  index: number,
): string[] => {
  const step = steps[index];
  if (!step) return [];
  if (step.dependsOn !== null && step.dependsOn !== undefined) {
    return [...step.dependsOn];
  }
  return index > 0 ? [steps[index - 1]!.id] : [];
};

const firstCycleStepId = (steps: readonly PipelineStepDraft[]): string | null => {
  const byId = new Map(steps.map((step, i) => [step.id, { step, i }] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): string | null => {
    if (visited.has(id)) return null;
    if (visiting.has(id)) return id;
    const entry = byId.get(id);
    if (!entry) return null;
    visiting.add(id);
    for (const depId of effectiveDependsOn(steps, entry.i)) {
      const cycleAt = visit(depId);
      if (cycleAt !== null) return cycleAt;
    }
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const step of steps) {
    const cycleAt = visit(step.id);
    if (cycleAt !== null) return cycleAt;
  }
  return null;
};
