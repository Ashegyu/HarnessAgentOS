import {
  isHarnessDefinition,
  type HarnessDefinition,
  type HarnessPackageRepairInput,
  type HarnessPackageRepairResult,
  type HarnessValidationIssue,
  type HarnessValidationStatus,
  type HarnessWorkflowDefinition,
  type HarnessWorkflowStep,
} from "@harness/core";

export interface ApplyHarnessPackageRepairInput
  extends HarnessPackageRepairInput {
  definition: HarnessDefinition;
  repairedAt: string;
  repairedId?: string;
}

const REPAIR_APPLIED_CODE = "HARNESS_MANUAL_REPAIR_APPLIED";

export const applyHarnessPackageRepair = (
  input: ApplyHarnessPackageRepairInput,
): HarnessPackageRepairResult => {
  if (input.packageId !== input.definition.id) {
    throw new Error(
      `repair packageId ${input.packageId} does not match definition ${input.definition.id}`,
    );
  }
  if (input.workflows.length === 0) {
    throw new Error("at least one workflow repair is required");
  }

  const repairByWorkflowId = new Map(
    input.workflows.map((repair) => [repair.workflowId, repair] as const),
  );
  const workflows = input.definition.workflows.map((workflow) => {
    const repair = repairByWorkflowId.get(workflow.id);
    if (!repair) return workflow;
    return repairWorkflow(workflow, repair);
  });

  for (const workflowId of repairByWorkflowId.keys()) {
    if (!input.definition.workflows.some((workflow) => workflow.id === workflowId)) {
      throw new Error(`workflow ${workflowId} was not found`);
    }
  }

  const issues = reconcileIssues(input.definition.validation.issues, workflows);
  const sourcePackageId =
    input.definition.repair?.sourcePackageId ?? input.definition.id;
  const repaired: HarnessDefinition = {
    ...input.definition,
    id: input.repairedId ?? defaultRepairedId(input.definition.id, input.repairedAt),
    name: input.definition.name.endsWith(" (repaired)")
      ? input.definition.name
      : `${input.definition.name} (repaired)`,
    workflows,
    validation: {
      ...input.definition.validation,
      status: statusFromIssues(issues),
      issues,
      importedAt: input.repairedAt,
      adapterVersion: `${input.definition.validation.adapterVersion}+repair`,
    },
    repair: {
      sourcePackageId,
      repairedAt: input.repairedAt,
      ...(input.note !== undefined ? { note: input.note } : {}),
    },
  };

  if (!isHarnessDefinition(repaired)) {
    throw new Error("repair produced an invalid HarnessDefinition");
  }

  const issuesResolved =
    input.definition.validation.issues.length - issues.length;
  return {
    definition: repaired,
    issuesResolved: Math.max(0, issuesResolved),
  };
};

const repairWorkflow = (
  workflow: HarnessWorkflowDefinition,
  repair: NonNullable<ApplyHarnessPackageRepairInput["workflows"][number]>,
): HarnessWorkflowDefinition => {
  const stepRepairById = new Map(
    (repair.steps ?? []).map((step) => [step.stepId, step] as const),
  );
  const steps = workflow.steps.map((step) => {
    const stepRepair = stepRepairById.get(step.id);
    if (!stepRepair) return step;
    const repaired: HarnessWorkflowStep = {
      ...step,
      ...(repairString(stepRepair.title) !== undefined
        ? { title: repairString(stepRepair.title)! }
        : {}),
      ...(stepRepair.agentRef !== undefined
        ? stepRepair.agentRef === null
          ? { agentRef: undefined }
          : { agentRef: requireNonEmpty(stepRepair.agentRef, "agentRef") }
        : {}),
      ...(repairString(stepRepair.roleHint) !== undefined
        ? { roleHint: repairString(stepRepair.roleHint)! }
        : {}),
      ...(stepRepair.instruction !== undefined
        ? { instruction: stepRepair.instruction }
        : {}),
      ...(stepRepair.dependsOn !== undefined
        ? { dependsOn: [...stepRepair.dependsOn] }
        : {}),
      ...(stepRepair.artifactContracts !== undefined
        ? { artifactContracts: [...stepRepair.artifactContracts] }
        : {}),
      ...(stepRepair.allowedActions !== undefined
        ? { allowedActions: [...stepRepair.allowedActions] }
        : {}),
      ...(stepRepair.outputContract !== undefined
        ? { outputContract: stepRepair.outputContract }
        : {}),
    };
    return repaired;
  });

  for (const stepId of stepRepairById.keys()) {
    if (!workflow.steps.some((step) => step.id === stepId)) {
      throw new Error(`workflow ${workflow.id} step ${stepId} was not found`);
    }
  }
  validateWorkflowDependencies(workflow.id, steps);

  return {
    ...workflow,
    ...(repairString(repair.name) !== undefined
      ? { name: repairString(repair.name)! }
      : {}),
    ...(repair.description !== undefined
      ? { description: repair.description }
      : {}),
    steps,
  };
};

const reconcileIssues = (
  issues: readonly HarnessValidationIssue[],
  workflows: readonly HarnessWorkflowDefinition[],
): HarnessValidationIssue[] => {
  const workflowIds = new Set(workflows.map((workflow) => workflow.id));
  const resolvedStepIds = new Set(
    workflows.flatMap((workflow) =>
      workflow.steps
        .filter((step) => step.agentRef !== undefined || step.roleHint === "orchestrator")
        .map((step) => step.id),
    ),
  );
  const out = issues.filter((issue) => {
    if (
      issue.code === REPAIR_APPLIED_CODE ||
      issue.code === "HARNESS_WORKFLOW_PARSE_PENDING"
    ) {
      return false;
    }
    if (issue.code === "HARNESS_AGENT_REFERENCE_UNRESOLVED") {
      return issue.sourceRef === undefined || resolvedStepIds.size === 0;
    }
    if (issue.code === "HARNESS_AMBIGUOUS_DEPENDENCIES") {
      return issue.sourceRef === undefined || workflowIds.size === 0;
    }
    return true;
  });
  out.push({
    severity: "info",
    code: REPAIR_APPLIED_CODE,
    message:
      "Manual repair snapshot was created inside HarnessAgentOS; source package files were not modified.",
    blocksExecution: false,
  });
  return out;
};

const validateWorkflowDependencies = (
  workflowId: string,
  steps: readonly HarnessWorkflowStep[],
): void => {
  const ids = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    for (const depId of step.dependsOn) {
      if (!ids.has(depId)) {
        throw new Error(
          `workflow ${workflowId} step ${step.id} depends on unknown step ${depId}`,
        );
      }
      if (depId === step.id) {
        throw new Error(`workflow ${workflowId} step ${step.id} cannot depend on itself`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(steps.map((step) => [step.id, step] as const));
  const visit = (stepId: string): void => {
    if (visited.has(stepId)) return;
    if (visiting.has(stepId)) {
      throw new Error(`workflow ${workflowId} dependencies contain a cycle`);
    }
    visiting.add(stepId);
    const step = byId.get(stepId);
    if (step) {
      for (const depId of step.dependsOn) visit(depId);
    }
    visiting.delete(stepId);
    visited.add(stepId);
  };
  for (const step of steps) visit(step.id);
};

const statusFromIssues = (
  issues: readonly HarnessValidationIssue[],
): HarnessValidationStatus => {
  if (issues.some((issue) => issue.blocksExecution)) return "needs_review";
  if (issues.length > 0) return "valid_with_warnings";
  return "valid";
};

const repairString = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  return requireNonEmpty(value, "repair string");
};

const requireNonEmpty = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${field} must not be blank`);
  return trimmed;
};

const defaultRepairedId = (packageId: string, repairedAt: string): string =>
  `${packageId}__repair_${repairedAt.replace(/[^0-9A-Za-z]+/g, "").slice(0, 20)}`;
