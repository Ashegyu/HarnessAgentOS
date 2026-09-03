import { resolve } from "node:path";
import {
  AGENT_REASONING_EFFORTS,
  CODEX_MODELS,
} from "@harness/core";
import {
  closeDb,
  LocalStateService,
  openDb,
} from "../../packages/storage/src/index.ts";
import { convertHarnessWorkflowToPipelineDraft } from "../../packages/orchestration/src/harness-pipeline-draft.ts";

const dbArgument = process.argv.find((argument) => argument.startsWith("--db="));
if (!dbArgument) {
  console.error(
    "Usage: node --import tsx scripts/audit/agent-pipeline-harness-audit.mjs --db=<app.db>",
  );
  process.exit(2);
}

const dbPath = resolve(dbArgument.slice("--db=".length));
const db = openDb({ filePath: dbPath, readonly: true });
const state = new LocalStateService(db);
const errors = [];
const warnings = [];
const infos = [];

const finding = (code, message, context = {}) => ({ code, message, context });
const addError = (code, message, context) =>
  errors.push(finding(code, message, context));
const addWarning = (code, message, context) =>
  warnings.push(finding(code, message, context));
const addInfo = (code, message, context) =>
  infos.push(finding(code, message, context));

try {
  const [profiles, pipelines, packages, bindingSets, remoteEndpoints] =
    await Promise.all([
      state.agentProfiles.list(),
      state.agentPipelines.list(),
      state.harnessPackages.list(),
      state.harnessBindingSets.list(),
      state.a2aRemoteAgents.listEndpoints(),
    ]);

  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const packageById = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const endpointById = new Map(
    remoteEndpoints.map((endpoint) => [endpoint.id, endpoint]),
  );
  const modelSet = new Set(CODEX_MODELS);
  const reasoningSet = new Set(AGENT_REASONING_EFFORTS);

  for (const profile of profiles) {
    if (profile.provider !== "codex") {
      addError(
        "PROFILE_PROVIDER_NOT_CODEX",
        `AgentProfile ${profile.id} uses unsupported provider ${profile.provider}.`,
        { profileId: profile.id },
      );
    }
    if (!modelSet.has(profile.tuning.model)) {
      addError(
        "PROFILE_MODEL_UNSUPPORTED",
        `AgentProfile ${profile.id} uses unsupported model ${profile.tuning.model}.`,
        { profileId: profile.id },
      );
    }
    if (
      profile.tuning.reasoningEffort !== undefined &&
      !reasoningSet.has(profile.tuning.reasoningEffort)
    ) {
      addError(
        "PROFILE_REASONING_UNSUPPORTED",
        `AgentProfile ${profile.id} uses unsupported reasoning effort ${profile.tuning.reasoningEffort}.`,
        { profileId: profile.id },
      );
    }
  }

  for (const pipeline of pipelines) {
    for (const step of pipeline.steps) {
      if (!profileById.has(step.agentProfileId)) {
        addError(
          "PIPELINE_PROFILE_MISSING",
          `Pipeline ${pipeline.id} step ${step.id} references missing profile ${step.agentProfileId}.`,
          { pipelineId: pipeline.id, stepId: step.id },
        );
      }
      if (
        step.remoteEndpointId !== undefined &&
        !endpointById.has(step.remoteEndpointId)
      ) {
        addError(
          "PIPELINE_REMOTE_ENDPOINT_MISSING",
          `Pipeline ${pipeline.id} step ${step.id} references missing remote endpoint ${step.remoteEndpointId}.`,
          { pipelineId: pipeline.id, stepId: step.id },
        );
      }
      if (step.source?.kind === "harness_package") {
        const sourcePackage = packageById.get(step.source.packageId);
        if (!sourcePackage) {
          addError(
            "PIPELINE_HARNESS_PACKAGE_MISSING",
            `Pipeline ${pipeline.id} step ${step.id} references missing Harness package ${step.source.packageId}.`,
            { pipelineId: pipeline.id, stepId: step.id },
          );
        } else if (
          !sourcePackage.workflows.some(
            (workflow) => workflow.id === step.source.workflowId,
          )
        ) {
          addError(
            "PIPELINE_HARNESS_WORKFLOW_MISSING",
            `Pipeline ${pipeline.id} step ${step.id} references missing Harness workflow ${step.source.workflowId}.`,
            { pipelineId: pipeline.id, stepId: step.id },
          );
        }
      }
    }
  }

  for (const pkg of packages) {
    const skillIds = new Set(pkg.skills.map((skill) => skill.id));
    for (const workflow of pkg.workflows) {
      if (!skillIds.has(workflow.skillId)) {
        addError(
          "HARNESS_SKILL_MISSING",
          `Harness workflow ${workflow.id} references missing skill ${workflow.skillId}.`,
          { packageId: pkg.id, workflowId: workflow.id },
        );
      }
      auditWorkflow(pkg.id, workflow, addError);
    }
  }

  const boundWorkflowKeys = new Set();
  for (const bindingSet of bindingSets) {
    const pkg = packageById.get(bindingSet.packageId);
    if (!pkg) {
      addError(
        "BINDING_PACKAGE_MISSING",
        `Binding set ${bindingSet.id} references missing package ${bindingSet.packageId}.`,
        { bindingSetId: bindingSet.id },
      );
      continue;
    }
    const workflow = pkg.workflows.find(
      (candidate) => candidate.id === bindingSet.workflowId,
    );
    if (!workflow) {
      addError(
        "BINDING_WORKFLOW_MISSING",
        `Binding set ${bindingSet.id} references missing workflow ${bindingSet.workflowId}.`,
        { bindingSetId: bindingSet.id },
      );
      continue;
    }
    boundWorkflowKeys.add(`${pkg.id}/${workflow.id}`);

    const normalizedRefs = new Set();
    for (const binding of bindingSet.bindings) {
      const normalizedRef = normalizeRef(binding.harnessAgentRef);
      if (normalizedRefs.has(normalizedRef)) {
        addError(
          "BINDING_AGENT_REF_DUPLICATE",
          `Binding set ${bindingSet.id} repeats agent ref ${binding.harnessAgentRef}.`,
          { bindingSetId: bindingSet.id },
        );
      }
      normalizedRefs.add(normalizedRef);
      if (!profileById.has(binding.agentProfileId)) {
        addError(
          "BINDING_PROFILE_MISSING",
          `Binding set ${bindingSet.id} references missing profile ${binding.agentProfileId}.`,
          { bindingSetId: bindingSet.id },
        );
      }
      if (
        binding.remoteEndpointId !== undefined &&
        !endpointById.has(binding.remoteEndpointId)
      ) {
        addError(
          "BINDING_REMOTE_ENDPOINT_MISSING",
          `Binding set ${bindingSet.id} references missing remote endpoint ${binding.remoteEndpointId}.`,
          { bindingSetId: bindingSet.id },
        );
      }
    }

    const draft = convertHarnessWorkflowToPipelineDraft({
      definition: pkg,
      workflowId: workflow.id,
      bindings: bindingSet.bindings,
    });
    if (!draft.ok) {
      for (const issue of draft.issues) {
        addError(issue.code, issue.message, {
          bindingSetId: bindingSet.id,
          workflowId: workflow.id,
          stepId: issue.stepId,
        });
      }
    }
  }

  for (const pkg of packages) {
    const allWorkflowsBound = pkg.workflows.every((workflow) =>
      boundWorkflowKeys.has(`${pkg.id}/${workflow.id}`),
    );
    const blockingIssues = pkg.validation.issues.filter(
      (issue) => issue.blocksExecution,
    );
    const bindingOnlyReview =
      blockingIssues.length > 0 &&
      blockingIssues.every(
        (issue) => issue.code === "HARNESS_PROFILE_BINDING_REQUIRED",
      );
    if (
      pkg.validation.status === "needs_review" &&
      bindingOnlyReview &&
      allWorkflowsBound
    ) {
      addInfo(
        "HARNESS_IMPORT_BINDING_RESOLVED",
        `Harness package ${pkg.id} retains its immutable import finding, but every workflow now has a valid runtime binding.`,
        { packageId: pkg.id },
      );
    } else if (pkg.validation.status === "needs_review") {
      addWarning(
        "HARNESS_PACKAGE_NEEDS_REVIEW",
        `Harness package ${pkg.id} retains unresolved import-time review findings.`,
        { packageId: pkg.id, blockingIssues: blockingIssues.length },
      );
    }
    for (const workflow of pkg.workflows) {
      if (!boundWorkflowKeys.has(`${pkg.id}/${workflow.id}`)) {
        addWarning(
          "HARNESS_WORKFLOW_UNBOUND",
          `Harness workflow ${pkg.id}/${workflow.id} has no saved binding set.`,
          { packageId: pkg.id, workflowId: workflow.id },
        );
      }
    }
  }

  const modelDistribution = Object.fromEntries(
    CODEX_MODELS.map((model) => [
      model,
      profiles.filter((profile) => profile.tuning.model === model).length,
    ]),
  );
  const validationStatusDistribution = Object.fromEntries(
    ["valid", "valid_with_warnings", "needs_review"].map((status) => [
      status,
      packages.filter((pkg) => pkg.validation.status === status).length,
    ]),
  );
  const seededPipelines = pipelines.filter((pipeline) =>
    pipeline.id.startsWith("pipe_template_"),
  ).length;
  const harnessDerivedPipelines = pipelines.filter((pipeline) =>
    pipeline.steps.some((step) => step.source?.kind === "harness_package"),
  ).length;

  const report = {
    auditedAt: new Date().toISOString(),
    dbPath,
    counts: {
      profiles: profiles.length,
      pipelines: pipelines.length,
      seededPipelines,
      harnessDerivedPipelines,
      customPipelines:
        pipelines.length - seededPipelines - harnessDerivedPipelines,
      harnessPackages: packages.length,
      harnessWorkflows: packages.reduce(
        (count, pkg) => count + pkg.workflows.length,
        0,
      ),
      bindingSets: bindingSets.length,
      runtimeReadyHarnessWorkflows: boundWorkflowKeys.size,
      remoteEndpoints: remoteEndpoints.length,
    },
    modelDistribution,
    validationStatusDistribution,
    errors,
    warnings,
    infos,
    ok: errors.length === 0,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally {
  closeDb(db);
}

function auditWorkflow(packageId, workflow, reportError) {
  const stepById = new Map(workflow.steps.map((step) => [step.id, step]));
  const phaseIds = new Set(workflow.phases.map((phase) => phase.id));

  for (const step of workflow.steps) {
    if (step.phaseId !== undefined && !phaseIds.has(step.phaseId)) {
      reportError(
        "HARNESS_PHASE_MISSING",
        `Harness step ${step.id} references missing phase ${step.phaseId}.`,
        { packageId, workflowId: workflow.id, stepId: step.id },
      );
    }
    const dependencies = new Set();
    for (const dependencyId of step.dependsOn) {
      if (dependencies.has(dependencyId)) {
        reportError(
          "HARNESS_DEPENDENCY_DUPLICATE",
          `Harness step ${step.id} repeats dependency ${dependencyId}.`,
          { packageId, workflowId: workflow.id, stepId: step.id },
        );
      }
      dependencies.add(dependencyId);
      if (!stepById.has(dependencyId)) {
        reportError(
          "HARNESS_DEPENDENCY_MISSING",
          `Harness step ${step.id} references missing dependency ${dependencyId}.`,
          { packageId, workflowId: workflow.id, stepId: step.id },
        );
      } else if (dependencyId === step.id) {
        reportError(
          "HARNESS_DEPENDENCY_SELF_REFERENCE",
          `Harness step ${step.id} depends on itself.`,
          { packageId, workflowId: workflow.id, stepId: step.id },
        );
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (step) => {
    if (visited.has(step.id)) return;
    if (visiting.has(step.id)) {
      reportError(
        "HARNESS_DEPENDENCY_CYCLE",
        `Harness workflow ${workflow.id} contains a dependency cycle at ${step.id}.`,
        { packageId, workflowId: workflow.id, stepId: step.id },
      );
      return;
    }
    visiting.add(step.id);
    for (const dependencyId of step.dependsOn) {
      const dependency = stepById.get(dependencyId);
      if (dependency) visit(dependency);
    }
    visiting.delete(step.id);
    visited.add(step.id);
  };
  for (const step of workflow.steps) visit(step);

  const routeKeys = new Set();
  for (const route of workflow.handoffPolicy.routes) {
    const routeKey = `${route.fromStepId}/${route.toStepId}`;
    if (routeKeys.has(routeKey)) {
      reportError(
        "HARNESS_HANDOFF_ROUTE_DUPLICATE",
        `Harness workflow ${workflow.id} repeats handoff route ${routeKey}.`,
        { packageId, workflowId: workflow.id },
      );
    }
    routeKeys.add(routeKey);
    if (!stepById.has(route.fromStepId) || !stepById.has(route.toStepId)) {
      reportError(
        "HARNESS_HANDOFF_ROUTE_MISSING_STEP",
        `Harness workflow ${workflow.id} has a handoff route with a missing step.`,
        { packageId, workflowId: workflow.id, routeKey },
      );
    }
  }

  for (const rule of workflow.failurePolicy.rules) {
    for (const [field, stepId] of [
      ["targetStepId", rule.targetStepId],
      ["retryStepId", rule.retryStepId],
    ]) {
      if (stepId !== undefined && !stepById.has(stepId)) {
        reportError(
          "HARNESS_FAILURE_RULE_MISSING_STEP",
          `Harness workflow ${workflow.id} failure rule ${field} references missing step ${stepId}.`,
          { packageId, workflowId: workflow.id, field, stepId },
        );
      }
    }
  }
}

function normalizeRef(value) {
  return value.trim().toLowerCase();
}
