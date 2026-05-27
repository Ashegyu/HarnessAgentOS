import {
  ARTIFACT_KINDS,
  MAX_PIPELINE_STEPS,
  type AgentPipelineStep,
  type ArtifactKind,
  type CreateAgentPipelineInput,
  type HarnessAgentProfileBinding,
  type HarnessArtifactKind,
  type HarnessDefinition,
  type HarnessPipelineDraftIssue,
  type HarnessWorkflowDefinition,
  type HarnessWorkflowStep,
} from "@harness/core";

export interface ConvertHarnessWorkflowToPipelineDraftInput {
  definition: HarnessDefinition;
  workflowId?: string;
  bindings: readonly HarnessAgentProfileBinding[];
}

export type ConvertHarnessWorkflowToPipelineDraftResult =
  | {
      ok: true;
      workflow: HarnessWorkflowDefinition;
      pipeline: CreateAgentPipelineInput;
      issues: readonly HarnessPipelineDraftIssue[];
    }
  | {
      ok: false;
      issues: readonly HarnessPipelineDraftIssue[];
    };

const ARTIFACT_KIND_SET: ReadonlySet<string> = new Set(ARTIFACT_KINDS);

export const convertHarnessWorkflowToPipelineDraft = (
  input: ConvertHarnessWorkflowToPipelineDraftInput,
): ConvertHarnessWorkflowToPipelineDraftResult => {
  const workflow = selectWorkflow(input.definition, input.workflowId);
  if (!workflow) {
    return {
      ok: false,
      issues: [
        {
          severity: "error",
          code: "HARNESS_WORKFLOW_NOT_FOUND",
          message:
            input.workflowId === undefined
              ? "Harness definition does not contain a workflow to convert."
              : `Harness workflow ${input.workflowId} was not found.`,
          workflowId: input.workflowId,
        },
      ],
    };
  }

  const issues: HarnessPipelineDraftIssue[] = [];
  if (workflow.steps.length > MAX_PIPELINE_STEPS) {
    return {
      ok: false,
      issues: [
        {
          severity: "error",
          code: "HARNESS_WORKFLOW_TOO_LARGE",
          message: `Harness workflow has ${workflow.steps.length} steps; AgentPipeline supports at most ${MAX_PIPELINE_STEPS}.`,
          workflowId: workflow.id,
        },
      ],
    };
  }

  const bindings = buildBindingIndex(input.bindings);
  const steps: AgentPipelineStep[] = [];
  for (const step of workflow.steps) {
    const binding = resolveBinding(step, bindings);
    if (!binding) {
      issues.push({
        severity: "error",
        code: "HARNESS_STEP_PROFILE_UNBOUND",
        message: `Harness workflow step ${step.id} is not bound to an AgentProfile.`,
        workflowId: workflow.id,
        stepId: step.id,
        sourceRef: step.sourceRef,
      });
      continue;
    }

    const expectedArtifactKinds = mapArtifactKinds(step, issues, workflow.id);
    steps.push({
      id: step.id,
      agentProfileId: binding.agentProfileId,
      ...(binding.remoteEndpointId
        ? { remoteEndpointId: binding.remoteEndpointId }
        : {}),
      title: step.title,
      instruction: buildPipelineInstruction(input.definition, workflow, step),
      expectedArtifactKinds,
      dependsOn: [...step.dependsOn],
      ...(step.allowedActions.length > 0
        ? { allowedActions: [...step.allowedActions] }
        : {}),
      outputContract: step.outputContract,
      source: buildStepSourceMetadata(input.definition, workflow, step),
    });
  }

  if (issues.some((issue) => issue.severity === "error")) {
    return { ok: false, issues };
  }

  if (workflow.failurePolicy.rules.length > 0) {
    issues.push({
      severity: "warning",
      code: "HARNESS_FAILURE_POLICY_REVIEW_REQUIRED",
      message:
        "Harness failure-policy rules were not converted automatically; review pipeline backflow rules before execution.",
      workflowId: workflow.id,
    });
  }

  return {
    ok: true,
    workflow,
    pipeline: {
      name: `${input.definition.name}: ${workflow.name}`,
      description: buildPipelineDescription(input.definition, workflow),
      steps,
      backflowRules: [],
    },
    issues,
  };
};

const selectWorkflow = (
  definition: HarnessDefinition,
  workflowId: string | undefined,
): HarnessWorkflowDefinition | null => {
  if (workflowId !== undefined) {
    return definition.workflows.find((workflow) => workflow.id === workflowId) ?? null;
  }
  return definition.workflows[0] ?? null;
};

const buildBindingIndex = (
  bindings: readonly HarnessAgentProfileBinding[],
): ReadonlyMap<string, HarnessAgentProfileBinding> => {
  const map = new Map<string, HarnessAgentProfileBinding>();
  for (const binding of bindings) {
    const key = normalizeBindingRef(binding.harnessAgentRef);
    if (key.length === 0 || map.has(key)) continue;
    map.set(key, binding);
  }
  return map;
};

const resolveBinding = (
  step: HarnessWorkflowStep,
  bindings: ReadonlyMap<string, HarnessAgentProfileBinding>,
): HarnessAgentProfileBinding | null => {
  const refs = [step.agentRef, step.roleHint]
    .filter(isString)
    .map(normalizeBindingRef);
  for (const ref of refs) {
    const binding = bindings.get(ref);
    if (binding) return binding;
  }
  return null;
};

const mapArtifactKinds = (
  step: HarnessWorkflowStep,
  issues: HarnessPipelineDraftIssue[],
  workflowId: string,
): ArtifactKind[] => {
  const out: ArtifactKind[] = [];
  for (const artifact of step.artifactContracts) {
    const mapped = mapArtifactKind(artifact.kind);
    if (!out.includes(mapped.kind)) out.push(mapped.kind);
    if (mapped.kind !== artifact.kind) {
      issues.push({
        severity: "warning",
        code: "HARNESS_ARTIFACT_KIND_MAPPED",
        message: `Harness artifact kind ${artifact.kind} was mapped to AgentPipeline artifact kind ${mapped.kind}.`,
        workflowId,
        stepId: step.id,
        sourceRef: step.sourceRef,
      });
    }
  }
  if (out.length > 0) return out;
  return [artifactKindForOutputContract(step.outputContract)];
};

const mapArtifactKind = (
  kind: HarnessArtifactKind,
): { kind: ArtifactKind } => {
  if (ARTIFACT_KIND_SET.has(kind)) return { kind: kind as ArtifactKind };
  switch (kind) {
    case "workspace_file":
      return { kind: "file" };
    case "external_url":
      return { kind: "snapshot" };
    case "provider_artifact":
      return { kind: "log" };
  }
  return { kind: "log" };
};

const artifactKindForOutputContract = (
  outputContract: HarnessWorkflowStep["outputContract"],
): ArtifactKind => {
  switch (outputContract) {
    case "plan":
      return "plan";
    case "diff_proposal":
      return "diff";
    case "review":
      return "quality_report";
    case "test_result":
      return "test_result";
  }
};

const buildPipelineInstruction = (
  definition: HarnessDefinition,
  workflow: HarnessWorkflowDefinition,
  step: HarnessWorkflowStep,
): string => {
  const lines = [
    step.instruction,
    "",
    `Source harness: ${definition.name}`,
    `Source workflow: ${workflow.name}`,
    `Source file: ${step.sourceRef.relativePath}`,
  ];
  if (step.artifactContracts.length > 0) {
    lines.push(
      `Artifact contracts: ${step.artifactContracts
        .map((artifact) => artifact.pathHint ?? artifact.title)
        .join(", ")}`,
    );
  }
  return lines.join("\n");
};

const buildStepSourceMetadata = (
  definition: HarnessDefinition,
  workflow: HarnessWorkflowDefinition,
  step: HarnessWorkflowStep,
): AgentPipelineStep["source"] => ({
  kind: "harness_package",
  packageId: definition.id,
  ...(definition.repair?.sourcePackageId !== undefined
    ? { sourcePackageId: definition.repair.sourcePackageId }
    : {}),
  packageName: definition.name,
  sourceFormat: definition.source.format,
  workflowId: workflow.id,
  workflowName: workflow.name,
  stepId: step.id,
  sourceRef: { ...step.sourceRef },
});

const buildPipelineDescription = (
  definition: HarnessDefinition,
  workflow: HarnessWorkflowDefinition,
): string => {
  const parts = [
    workflow.description,
    `Imported from ${definition.source.format} harness package ${definition.name}.`,
    "Review AgentProfile bindings, artifact expectations, and backflow rules before execution.",
  ];
  return parts.filter((part) => part.trim().length > 0).join("\n\n");
};

const normalizeBindingRef = (value: string): string =>
  value.trim().toLowerCase();

const isString = (value: string | undefined): value is string =>
  value !== undefined;
