import {
  ARTIFACT_KINDS,
  MAX_PIPELINE_STEPS,
  type AgentPipelineBackflowRule,
  type AgentPipelineStep,
  type ArtifactKind,
  type CreateAgentPipelineInput,
  type HarnessAgentProfileBinding,
  type HarnessArtifactKind,
  type HarnessDefinition,
  type HarnessFailureRule,
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

  issues.push(...validateWorkflowDependencies(workflow));
  if (issues.length > 0) {
    return { ok: false, issues };
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

  const backflow = mapFailurePolicyBackflowRules(workflow, steps);
  if (backflow.unmappedCount > 0) {
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
      backflowRules: backflow.rules,
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

const validateWorkflowDependencies = (
  workflow: HarnessWorkflowDefinition,
): HarnessPipelineDraftIssue[] => {
  const issues: HarnessPipelineDraftIssue[] = [];
  const stepById = new Map(workflow.steps.map((step) => [step.id, step] as const));

  for (const step of workflow.steps) {
    const seen = new Set<string>();
    for (const dependencyId of step.dependsOn) {
      if (dependencyId.trim().length === 0) {
        issues.push(dependencyIssue(workflow, step, "contains a blank dependency id"));
      } else if (seen.has(dependencyId)) {
        issues.push(
          dependencyIssue(
            workflow,
            step,
            `contains duplicate dependency ${dependencyId}`,
          ),
        );
      } else if (dependencyId === step.id) {
        issues.push(dependencyIssue(workflow, step, "cannot depend on itself"));
      } else if (!stepById.has(dependencyId)) {
        issues.push(
          dependencyIssue(
            workflow,
            step,
            `depends on unknown step ${dependencyId}`,
          ),
        );
      }
      seen.add(dependencyId);
    }
  }
  if (issues.length > 0) return issues;

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (step: HarnessWorkflowStep): HarnessPipelineDraftIssue | null => {
    if (visited.has(step.id)) return null;
    visiting.add(step.id);
    for (const dependencyId of step.dependsOn) {
      if (visiting.has(dependencyId)) {
        return dependencyIssue(
          workflow,
          step,
          `contains a dependency cycle through ${dependencyId}`,
        );
      }
      const dependency = stepById.get(dependencyId)!;
      const issue = visit(dependency);
      if (issue) return issue;
    }
    visiting.delete(step.id);
    visited.add(step.id);
    return null;
  };

  for (const step of workflow.steps) {
    const issue = visit(step);
    if (issue) return [issue];
  }
  return issues;
};

const dependencyIssue = (
  workflow: HarnessWorkflowDefinition,
  step: HarnessWorkflowStep,
  detail: string,
): HarnessPipelineDraftIssue => ({
  severity: "error",
  code: "HARNESS_WORKFLOW_DEPENDENCY_INVALID",
  message: `Harness workflow step ${step.id} ${detail}.`,
  workflowId: workflow.id,
  stepId: step.id,
  sourceRef: step.sourceRef,
});

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

const mapFailurePolicyBackflowRules = (
  workflow: HarnessWorkflowDefinition,
  steps: readonly AgentPipelineStep[],
): { rules: AgentPipelineBackflowRule[]; unmappedCount: number } => {
  const rules: AgentPipelineBackflowRule[] = [];
  const ruleIds = new Set<string>();
  let unmappedCount = 0;
  for (const rule of workflow.failurePolicy.rules) {
    const mapped = mapFailureRule(
      rule,
      workflow.failurePolicy.maxAttempts,
      steps,
    );
    if (!mapped) {
      unmappedCount += 1;
      continue;
    }
    const id = uniqueBackflowRuleId(
      `harness-${mapped.trigger}-${mapped.targetStepId}-to-${mapped.retryStepId}`,
      ruleIds,
    );
    rules.push({ ...mapped, id });
  }
  return { rules, unmappedCount };
};

const mapFailureRule = (
  rule: HarnessFailureRule,
  policyMaxAttempts: number,
  steps: readonly AgentPipelineStep[],
): Omit<AgentPipelineBackflowRule, "id"> | null => {
  if (rule.action !== "backflow_to_step") return null;
  if (!isPipelineBackflowTrigger(rule.trigger)) return null;
  if (rule.targetStepId === undefined || rule.retryStepId === undefined) {
    return null;
  }
  const maxAttempts = rule.maxAttempts ?? policyMaxAttempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    return null;
  }
  if (!isValidBackflowPath(steps, rule.targetStepId, rule.retryStepId)) {
    return null;
  }
  return {
    trigger: rule.trigger,
    targetStepId: rule.targetStepId,
    retryStepId: rule.retryStepId,
    maxAttempts,
    ...(rule.instruction !== undefined ? { instruction: rule.instruction } : {}),
  };
};

const isPipelineBackflowTrigger = (
  trigger: HarnessFailureRule["trigger"],
): trigger is AgentPipelineBackflowRule["trigger"] =>
  trigger === "step_failed" || trigger === "quality_failed";

const isValidBackflowPath = (
  steps: readonly AgentPipelineStep[],
  targetStepId: string,
  retryStepId: string,
): boolean => {
  if (targetStepId === retryStepId) return false;
  const stepIndexById = new Map(
    steps.map((step, index) => [step.id, index] as const),
  );
  const targetIndex = stepIndexById.get(targetStepId);
  const retryIndex = stepIndexById.get(retryStepId);
  if (targetIndex === undefined || retryIndex === undefined) return false;
  if (targetIndex >= retryIndex) return false;
  return hasBackflowDependencyPath(steps, targetStepId, retryStepId);
};

const hasBackflowDependencyPath = (
  steps: readonly AgentPipelineStep[],
  targetStepId: string,
  retryStepId: string,
): boolean => {
  const stepIndexById = new Map(
    steps.map((step, index) => [step.id, index] as const),
  );
  const visited = new Set<string>();
  const visit = (stepId: string): boolean => {
    if (stepId === targetStepId) return true;
    if (visited.has(stepId)) return false;
    visited.add(stepId);
    const index = stepIndexById.get(stepId);
    if (index === undefined) return false;
    const step = steps[index]!;
    const dependencyIds =
      step.dependsOn !== undefined
        ? step.dependsOn
        : index > 0
          ? [steps[index - 1]!.id]
          : [];
    return dependencyIds.some((depId) => visit(depId));
  };
  return visit(retryStepId);
};

const uniqueBackflowRuleId = (
  base: string,
  used: Set<string>,
): string => {
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
};

const normalizeBindingRef = (value: string): string =>
  value.trim().toLowerCase();

const isString = (value: string | undefined): value is string =>
  value !== undefined;
