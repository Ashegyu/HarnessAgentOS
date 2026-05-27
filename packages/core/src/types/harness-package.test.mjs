import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HARNESS_SOURCE_FORMATS,
  HARNESS_VALIDATION_STATUSES,
  isHarnessDefinition,
  isHarnessSourceFormat,
  isHarnessValidationStatus,
  isHarnessWorkflowDefinition,
  isHarnessWorkflowStep,
} from "./harness-package.ts";

const ISO = "2026-05-27T00:00:00.000Z";

const VALID_SOURCE_REF = {
  relativePath: ".claude/skills/performance-optimizer/skill.md",
  heading: "Workflow",
  line: 42,
};

const VALID_STEP = {
  id: "step_profile",
  title: "Profile the target path",
  agentRef: "profiler",
  roleHint: "profiler",
  phaseId: "phase_execute",
  instruction: "Collect CPU and allocation evidence.",
  dependsOn: [],
  artifactContracts: [
    {
      id: "artifact_profile",
      pathHint: "_workspace/01_profiling_report.md",
      title: "Profiling report",
      kind: "workspace_file",
      required: true,
      description: "Profiling report produced by the profiler.",
      validationHint: "Must include baseline metrics.",
    },
  ],
  allowedActions: ["shell"],
  outputContract: "test_result",
  sourceRef: VALID_SOURCE_REF,
};

const VALID_WORKFLOW = {
  id: "workflow_full",
  skillId: "performance-optimizer",
  name: "Full performance optimization",
  mode: "full",
  description: "Profile, analyze, optimize, benchmark, and review.",
  sourceFile: ".claude/skills/performance-optimizer/skill.md",
  phases: [
    {
      id: "phase_execute",
      title: "Team execution",
      owner: "agent",
      summary: "Specialist workers execute the workflow.",
    },
  ],
  steps: [VALID_STEP],
  handoffPolicy: {
    mode: "structured_handoff",
    routes: [
      {
        fromStepId: "step_profile",
        toStepId: "step_profile",
        summary: "Self-contained single-step workflow.",
      },
    ],
    requiredPayload: "harness_worker_handoff_v1",
    fallback: "synthesize_from_artifact",
  },
  failurePolicy: {
    defaultMode: "pause_for_review",
    maxAttempts: 1,
    rules: [
      {
        trigger: "step_failed",
        action: "pause_for_review",
      },
    ],
  },
  testScenarios: [
    {
      id: "scenario_normal",
      title: "Normal import",
      prompt: "Optimize this API.",
      expected: ["profiling report", "benchmark plan"],
    },
  ],
  parseConfidence: "high",
};

const VALID_DEFINITION = {
  id: "harness_performance_optimizer",
  name: "Performance Optimizer",
  version: "1.0.0",
  source: {
    format: "claude",
    rootDir:
      "C:/Users/GC/Desktop/Works/Personal/Study/harness-100/ko/29-performance-optimizer",
    importedAt: ISO,
    files: [
      {
        relativePath: ".claude/CLAUDE.md",
        kind: "overview",
        sha256: "abc123",
        parserVersion: "harness-adapter-v1",
      },
      {
        relativePath: ".claude/skills/performance-optimizer/skill.md",
        kind: "skill",
        sha256: "def456",
        parserVersion: "harness-adapter-v1",
      },
    ],
  },
  overview: {
    title: "Performance Optimizer",
    summary: "Agent-team harness for performance optimization.",
    usage: "Trigger with a performance optimization request.",
    outputPolicy: "Artifacts are declarations until runtime execution.",
  },
  agents: [
    {
      id: "profiler",
      name: "Profiler",
      description: "Collects CPU, memory, I/O, and network evidence.",
      roleHint: "profiler",
      sourceFile: ".claude/agents/profiler.md",
      persona: "You are a performance profiler.",
      responsibilities: ["Collect evidence", "Report baseline metrics"],
      providerHint: "auto",
      requiredCapabilities: ["shell-profiler"],
    },
  ],
  skills: [
    {
      id: "performance-optimizer",
      name: "performance-optimizer",
      description: "Performance optimization workflow.",
      triggerTerms: ["performance", "profiling"],
      negativeTriggerTerms: ["infra provisioning"],
      sourceFile: ".claude/skills/performance-optimizer/skill.md",
      workflowRefs: ["workflow_full"],
      relatedSkillRefs: [],
      rawFrontmatter: {
        name: "performance-optimizer",
        description: "Performance optimization workflow.",
      },
    },
  ],
  workflows: [VALID_WORKFLOW],
  capabilities: [
    {
      id: "shell-profiler",
      kind: "shell",
      required: false,
      description: "Optional shell profiler execution.",
      providerHint: "either",
      risk: "medium",
    },
  ],
  validation: {
    status: "valid",
    issues: [],
    importedAt: ISO,
    adapterVersion: "harness-adapter-v1",
  },
};

test("source format and validation status constants are explicit", () => {
  assert.deepEqual([...HARNESS_SOURCE_FORMATS], [
    "claude",
    "codex",
    "harness-native",
  ]);
  assert.deepEqual([...HARNESS_VALIDATION_STATUSES], [
    "valid",
    "valid_with_warnings",
    "needs_review",
    "unsupported",
  ]);
});

test("isHarnessSourceFormat and isHarnessValidationStatus reject unknown values", () => {
  assert.equal(isHarnessSourceFormat("claude"), true);
  assert.equal(isHarnessSourceFormat("openai"), false);
  assert.equal(isHarnessValidationStatus("needs_review"), true);
  assert.equal(isHarnessValidationStatus("maybe"), false);
});

test("isHarnessDefinition accepts a complete vendor-neutral harness definition", () => {
  assert.equal(isHarnessDefinition(VALID_DEFINITION), true);
});

test("isHarnessDefinition accepts Codex and Harness-native source formats", () => {
  assert.equal(
    isHarnessDefinition({
      ...VALID_DEFINITION,
      source: { ...VALID_DEFINITION.source, format: "codex" },
    }),
    true,
  );
  assert.equal(
    isHarnessDefinition({
      ...VALID_DEFINITION,
      source: { ...VALID_DEFINITION.source, format: "harness-native" },
    }),
    true,
  );
});

test("isHarnessDefinition accepts repaired snapshot metadata", () => {
  assert.equal(
    isHarnessDefinition({
      ...VALID_DEFINITION,
      id: "harness_performance_optimizer_repaired",
      name: "Performance Optimizer (repaired)",
      repair: {
        sourcePackageId: VALID_DEFINITION.id,
        repairedAt: ISO,
        note: "Resolved dependency table.",
      },
    }),
    true,
  );
  assert.equal(
    isHarnessDefinition({
      ...VALID_DEFINITION,
      repair: {
        sourcePackageId: "",
        repairedAt: ISO,
      },
    }),
    false,
  );
});

test("isHarnessDefinition rejects duplicate top-level ids", () => {
  assert.equal(
    isHarnessDefinition({
      ...VALID_DEFINITION,
      agents: [VALID_DEFINITION.agents[0], VALID_DEFINITION.agents[0]],
    }),
    false,
  );
  assert.equal(
    isHarnessDefinition({
      ...VALID_DEFINITION,
      skills: [VALID_DEFINITION.skills[0], VALID_DEFINITION.skills[0]],
    }),
    false,
  );
});

test("isHarnessDefinition rejects malformed provider and capability hints", () => {
  assert.equal(
    isHarnessDefinition({
      ...VALID_DEFINITION,
      agents: [{ ...VALID_DEFINITION.agents[0], providerHint: "gemini" }],
    }),
    false,
  );
  assert.equal(
    isHarnessDefinition({
      ...VALID_DEFINITION,
      capabilities: [
        { ...VALID_DEFINITION.capabilities[0], providerHint: "auto" },
      ],
    }),
    false,
  );
});

test("isHarnessWorkflowDefinition rejects duplicate step ids", () => {
  assert.equal(
    isHarnessWorkflowDefinition({
      ...VALID_WORKFLOW,
      steps: [VALID_STEP, VALID_STEP],
    }),
    false,
  );
});

test("isHarnessWorkflowStep accepts existing and harness-specific artifact kinds", () => {
  assert.equal(isHarnessWorkflowStep(VALID_STEP), true);
  assert.equal(
    isHarnessWorkflowStep({
      ...VALID_STEP,
      artifactContracts: [
        { ...VALID_STEP.artifactContracts[0], kind: "log" },
        { ...VALID_STEP.artifactContracts[0], id: "external", kind: "external_url" },
      ],
    }),
    true,
  );
});

test("isHarnessWorkflowStep rejects invalid action and output contracts", () => {
  assert.equal(
    isHarnessWorkflowStep({
      ...VALID_STEP,
      allowedActions: ["git_push"],
    }),
    false,
  );
  assert.equal(
    isHarnessWorkflowStep({
      ...VALID_STEP,
      outputContract: "memo",
    }),
    false,
  );
});

test("isHarnessDefinition rejects malformed validation issues", () => {
  assert.equal(
    isHarnessDefinition({
      ...VALID_DEFINITION,
      validation: {
        ...VALID_DEFINITION.validation,
        status: "needs_review",
        issues: [
          {
            severity: "warning",
            code: "HARNESS_AMBIGUOUS_DEPENDENCIES",
            message: "Workflow dependency table is ambiguous.",
            sourceRef: VALID_SOURCE_REF,
            blocksExecution: true,
          },
        ],
      },
    }),
    true,
  );
  assert.equal(
    isHarnessDefinition({
      ...VALID_DEFINITION,
      validation: {
        ...VALID_DEFINITION.validation,
        issues: [
          {
            severity: "fatal",
            code: "BAD",
            message: "Bad issue severity.",
            blocksExecution: true,
          },
        ],
      },
    }),
    false,
  );
});

test("isHarnessDefinition rejects missing runtime-safety policy fields", () => {
  const { validation: _ignored, ...withoutValidation } = VALID_DEFINITION;
  void _ignored;
  assert.equal(isHarnessDefinition(withoutValidation), false);

  assert.equal(
    isHarnessDefinition({
      ...VALID_DEFINITION,
      workflows: [
        {
          ...VALID_WORKFLOW,
          failurePolicy: {
            ...VALID_WORKFLOW.failurePolicy,
            maxAttempts: 0,
          },
        },
      ],
    }),
    false,
  );
});
