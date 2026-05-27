import { test } from "node:test";
import assert from "node:assert/strict";
import { applyHarnessPackageRepair } from "./harness-package-repair.ts";

const ISO = "2026-05-27T00:00:00.000Z";

const step = (overrides = {}) => ({
  id: "step-1",
  title: "Draft plan",
  roleHint: "writer",
  instruction: "Draft the plan.",
  dependsOn: [],
  artifactContracts: [
    {
      id: "artifact_plan",
      title: "Plan",
      kind: "workspace_file",
      required: true,
      description: "Plan file.",
    },
  ],
  allowedActions: ["file_write"],
  outputContract: "plan",
  sourceRef: { relativePath: "skills/demo/SKILL.md", heading: "Workflow" },
  ...overrides,
});

const workflow = (overrides = {}) => ({
  id: "demo-workflow",
  skillId: "demo",
  name: "Demo workflow",
  mode: "agent-team",
  description: "Demo.",
  sourceFile: "skills/demo/SKILL.md",
  phases: [
    {
      id: "workflow",
      title: "Workflow",
      owner: "orchestrator",
      summary: "Parsed table.",
    },
  ],
  steps: [step()],
  handoffPolicy: {
    mode: "source_message_semantics",
    routes: [],
    requiredPayload: "harness_worker_handoff_v1",
    fallback: "synthesize_from_artifact",
  },
  failurePolicy: {
    defaultMode: "pause_for_review",
    maxAttempts: 1,
    rules: [],
  },
  testScenarios: [],
  parseConfidence: "medium",
  ...overrides,
});

const definition = (overrides = {}) => ({
  id: "harness_demo",
  name: "Demo Harness",
  source: {
    format: "codex",
    rootDir: "C:/tmp/demo",
    importedAt: ISO,
    files: [
      {
        relativePath: "skills/demo/SKILL.md",
        kind: "skill",
        sha256: "abc",
        parserVersion: "test",
      },
    ],
  },
  overview: {
    title: "Demo Harness",
    summary: "Demo harness.",
  },
  agents: [],
  skills: [
    {
      id: "demo",
      name: "demo",
      description: "Demo skill.",
      triggerTerms: [],
      negativeTriggerTerms: [],
      sourceFile: "skills/demo/SKILL.md",
      workflowRefs: ["demo-workflow"],
      relatedSkillRefs: [],
      rawFrontmatter: {},
    },
  ],
  workflows: [workflow()],
  capabilities: [],
  validation: {
    status: "needs_review",
    issues: [
      {
        severity: "warning",
        code: "HARNESS_AGENT_REFERENCE_UNRESOLVED",
        message: "Owner could not be mapped.",
        sourceRef: { relativePath: "skills/demo/SKILL.md" },
        blocksExecution: true,
      },
      {
        severity: "warning",
        code: "HARNESS_PROFILE_BINDING_REQUIRED",
        message: "Bind profiles before execution.",
        blocksExecution: true,
      },
    ],
    importedAt: ISO,
    adapterVersion: "test",
  },
  ...overrides,
});

test("applyHarnessPackageRepair creates a separate repaired snapshot", () => {
  const input = definition();
  const result = applyHarnessPackageRepair({
    packageId: input.id,
    definition: input,
    repairedAt: "2026-05-27T01:02:03.004Z",
    repairedId: "harness_demo_repaired",
    note: "Resolved owner mapping.",
    workflows: [
      {
        workflowId: "demo-workflow",
        steps: [
          {
            stepId: "step-1",
            agentRef: "writer",
            dependsOn: [],
          },
        ],
      },
    ],
  });

  assert.equal(result.definition.id, "harness_demo_repaired");
  assert.equal(result.definition.repair.sourcePackageId, "harness_demo");
  assert.equal(result.definition.repair.note, "Resolved owner mapping.");
  assert.equal(result.definition.source.rootDir, input.source.rootDir);
  assert.equal(result.definition.workflows[0].steps[0].agentRef, "writer");
  assert.equal(input.workflows[0].steps[0].agentRef, undefined);
  assert.equal(
    result.definition.validation.issues.some(
      (issue) => issue.code === "HARNESS_MANUAL_REPAIR_APPLIED",
    ),
    true,
  );
  assert.equal(
    result.definition.validation.issues.some(
      (issue) => issue.code === "HARNESS_PROFILE_BINDING_REQUIRED",
    ),
    true,
  );
});

test("applyHarnessPackageRepair rejects unknown and cyclic dependencies", () => {
  assert.throws(
    () =>
      applyHarnessPackageRepair({
        packageId: "harness_demo",
        definition: definition(),
        repairedAt: ISO,
        workflows: [
          {
            workflowId: "demo-workflow",
            steps: [{ stepId: "step-1", dependsOn: ["missing"] }],
          },
        ],
      }),
    /depends on unknown step missing/,
  );

  assert.throws(
    () =>
      applyHarnessPackageRepair({
        packageId: "harness_demo",
        definition: definition(),
        repairedAt: ISO,
        workflows: [
          {
            workflowId: "demo-workflow",
            steps: [{ stepId: "step-1", dependsOn: ["step-1"] }],
          },
        ],
      }),
    /cannot depend on itself/,
  );
});
