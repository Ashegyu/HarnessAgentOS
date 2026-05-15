import type {
  AgentPipeline,
  AgentPipelineStep,
  A2ARegistryEntry,
  ArtifactKind,
  CreateAgentPipelineInput,
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
  })),
});

interface ProfileLite {
  id: string;
  name: string;
}

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
  });
  return errors;
};

export const serializePipelineDraft = (
  draft: PipelineDraft,
): CreateAgentPipelineInput | AgentPipeline => {
  const steps: AgentPipelineStep[] = draft.steps.map((s) => {
    const remoteEndpointId = s.remoteEndpointId?.trim() ?? "";
    return {
      id: s.id,
      agentProfileId: s.agentProfileId,
      ...(remoteEndpointId.length > 0 ? { remoteEndpointId } : {}),
      title: s.title.trim(),
      instruction: s.instruction,
      expectedArtifactKinds: [...s.expectedArtifactKinds] as ArtifactKind[],
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
