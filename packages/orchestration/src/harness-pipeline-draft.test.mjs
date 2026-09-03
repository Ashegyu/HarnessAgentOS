import assert from "node:assert/strict";
import test from "node:test";
import { isAgentPipelineStep } from "@harness/core";
import { importHarnessPackageFromFiles } from "./harness-import.ts";
import { convertHarnessWorkflowToPipelineDraft } from "./harness-pipeline-draft.ts";

const IMPORTED_AT = "2026-05-27T00:00:00.000Z";

const sampleDefinition = () => {
  const result = importHarnessPackageFromFiles({
    rootDir: "C:/sample/youtube-production",
    importedAt: IMPORTED_AT,
    files: [
      { relativePath: ".claude/CLAUDE.md", content: "# YouTube Production" },
      {
        relativePath: ".claude/agents/content-strategist.md",
        content: "---\nname: content-strategist\ndescription: Strategy.\n---",
      },
      {
        relativePath: ".claude/agents/scriptwriter.md",
        content: "---\nname: scriptwriter\ndescription: Script.\n---",
      },
      {
        relativePath: ".claude/agents/production-reviewer.md",
        content: "---\nname: production-reviewer\ndescription: Review.\n---",
      },
      {
        relativePath: ".claude/skills/youtube-production/skill.md",
        content: [
          "---",
          "name: youtube-production",
          "description: YouTube production workflow.",
          "---",
          "",
          "## Execution Mode",
          "",
          "**Agent Team**",
          "",
          "## Workflow",
          "",
          "| Order | Task | Owner | Depends On | Deliverable |",
          "|-------|------|-------|------------|-------------|",
          "| 1 | Content strategy | strategist | None | `_workspace/brief.md` |",
          "| 2 | Script writing | writer | Task 1 | `_workspace/script.md` |",
          "| 3 | Production review | reviewer | Task 2 | `_workspace/review.md` |",
        ].join("\n"),
      },
    ],
  });
  assert.equal(result.ok, true);
  return result.definition;
};

test("convertHarnessWorkflowToPipelineDraft builds a reviewable AgentPipeline draft", () => {
  const definition = sampleDefinition();
  const result = convertHarnessWorkflowToPipelineDraft({
    definition,
    bindings: [
      {
        harnessAgentRef: "content-strategist",
        agentProfileId: "profile-strategist",
      },
      {
        harnessAgentRef: "scriptwriter",
        agentProfileId: "profile-writer",
        remoteEndpointId: "remote-writer",
      },
      {
        harnessAgentRef: "production-reviewer",
        agentProfileId: "profile-reviewer",
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.pipeline.steps.length, 3);
  assert.equal(result.pipeline.steps.every(isAgentPipelineStep), true);
  assert.equal(result.pipeline.steps[0].agentProfileId, "profile-strategist");
  assert.equal(result.pipeline.steps[1].agentProfileId, "profile-writer");
  assert.equal(result.pipeline.steps[1].remoteEndpointId, "remote-writer");
  assert.deepEqual(result.pipeline.steps[0].dependsOn, []);
  assert.deepEqual(result.pipeline.steps[1].dependsOn, ["step-1"]);
  assert.deepEqual(result.pipeline.steps[2].dependsOn, ["step-2"]);
  assert.deepEqual(result.pipeline.steps[0].expectedArtifactKinds, ["file"]);
  assert.equal(result.pipeline.steps[0].allowedActions?.[0], "file_write");
  assert.equal(result.pipeline.steps[2].outputContract, "review");
  assert.deepEqual(result.pipeline.steps[0].source, {
    kind: "harness_package",
    packageId: definition.id,
    packageName: definition.name,
    sourceFormat: "claude",
    workflowId: result.workflow.id,
    workflowName: result.workflow.name,
    stepId: "step-1",
    sourceRef: {
      relativePath: ".claude/skills/youtube-production/skill.md",
      heading: "Workflow",
    },
  });
  assert.match(result.pipeline.steps[0].instruction, /Source harness:/);
  assert.match(result.pipeline.description, /Review AgentProfile bindings/);
  assert.equal(result.pipeline.backflowRules?.length, 0);
  assert.equal(
    result.issues.some(
      (issue) => issue.code === "HARNESS_ARTIFACT_KIND_MAPPED",
    ),
    true,
  );
});

test("convertHarnessWorkflowToPipelineDraft refuses unbound workflow steps", () => {
  const definition = sampleDefinition();
  const result = convertHarnessWorkflowToPipelineDraft({
    definition,
    bindings: [
      {
        harnessAgentRef: "content-strategist",
        agentProfileId: "profile-strategist",
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.issues.filter(
      (issue) => issue.code === "HARNESS_STEP_PROFILE_UNBOUND",
    ).length,
    2,
  );
});

test("convertHarnessWorkflowToPipelineDraft maps explicit bounded failure policies to backflow rules", () => {
  const definition = sampleDefinition();
  const workflow = definition.workflows[0];
  const result = convertHarnessWorkflowToPipelineDraft({
    definition: {
      ...definition,
      workflows: [
        {
          ...workflow,
          failurePolicy: {
            ...workflow.failurePolicy,
            maxAttempts: 2,
            rules: [
              {
                trigger: "step_failed",
                action: "backflow_to_step",
                targetStepId: "step-1",
                retryStepId: "step-3",
                maxAttempts: 2,
                instruction: "Revise the brief before retrying production review.",
              },
            ],
          },
        },
      ],
    },
    bindings: [
      {
        harnessAgentRef: "content-strategist",
        agentProfileId: "profile-strategist",
      },
      {
        harnessAgentRef: "scriptwriter",
        agentProfileId: "profile-writer",
      },
      {
        harnessAgentRef: "production-reviewer",
        agentProfileId: "profile-reviewer",
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.pipeline.backflowRules, [
    {
      id: "harness-step_failed-step-1-to-step-3",
      trigger: "step_failed",
      targetStepId: "step-1",
      retryStepId: "step-3",
      maxAttempts: 2,
      instruction: "Revise the brief before retrying production review.",
    },
  ]);
  assert.equal(
    result.issues.some(
      (issue) => issue.code === "HARNESS_FAILURE_POLICY_REVIEW_REQUIRED",
    ),
    false,
  );
});

test("convertHarnessWorkflowToPipelineDraft leaves ambiguous failure policies for review", () => {
  const definition = sampleDefinition();
  const workflow = definition.workflows[0];
  const result = convertHarnessWorkflowToPipelineDraft({
    definition: {
      ...definition,
      workflows: [
        {
          ...workflow,
          failurePolicy: {
            ...workflow.failurePolicy,
            rules: [
              {
                trigger: "step_failed",
                action: "backflow_to_step",
                targetStepId: "step-1",
                instruction: "Ask the previous worker to fix the problem.",
              },
            ],
          },
        },
      ],
    },
    bindings: [
      {
        harnessAgentRef: "content-strategist",
        agentProfileId: "profile-strategist",
      },
      {
        harnessAgentRef: "scriptwriter",
        agentProfileId: "profile-writer",
      },
      {
        harnessAgentRef: "production-reviewer",
        agentProfileId: "profile-reviewer",
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.pipeline.backflowRules, []);
  assert.equal(
    result.issues.some(
      (issue) => issue.code === "HARNESS_FAILURE_POLICY_REVIEW_REQUIRED",
    ),
    true,
  );
});

test("convertHarnessWorkflowToPipelineDraft reports missing workflow ids", () => {
  const definition = sampleDefinition();
  const result = convertHarnessWorkflowToPipelineDraft({
    definition,
    workflowId: "missing-workflow",
    bindings: [],
  });

  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, "HARNESS_WORKFLOW_NOT_FOUND");
});

test("convertHarnessWorkflowToPipelineDraft rejects unknown workflow dependencies", () => {
  const definition = sampleDefinition();
  const workflow = definition.workflows[0];
  const result = convertHarnessWorkflowToPipelineDraft({
    definition: {
      ...definition,
      workflows: [
        {
          ...workflow,
          steps: workflow.steps.map((step) =>
            step.id === "step-2"
              ? { ...step, dependsOn: ["missing-step"] }
              : step,
          ),
        },
      ],
    },
    bindings: [],
  });

  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, "HARNESS_WORKFLOW_DEPENDENCY_INVALID");
  assert.equal(result.issues[0].stepId, "step-2");
  assert.match(result.issues[0].message, /unknown step missing-step/);
});

test("convertHarnessWorkflowToPipelineDraft rejects dependency cycles", () => {
  const definition = sampleDefinition();
  const workflow = definition.workflows[0];
  const result = convertHarnessWorkflowToPipelineDraft({
    definition: {
      ...definition,
      workflows: [
        {
          ...workflow,
          steps: workflow.steps.map((step) => {
            if (step.id === "step-1") return { ...step, dependsOn: ["step-3"] };
            return step;
          }),
        },
      ],
    },
    bindings: [],
  });

  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, "HARNESS_WORKFLOW_DEPENDENCY_INVALID");
  assert.match(result.issues[0].message, /cycle/);
});
