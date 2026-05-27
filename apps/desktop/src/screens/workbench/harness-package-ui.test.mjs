import { test } from "node:test";
import assert from "node:assert/strict";
import {
  harnessAgentBindingCandidates,
  harnessWorkflowStepRows,
  primaryHarnessPackageIssue,
  repairDraftFromWorkflow,
  repairInputFromDraft,
  suggestHarnessProfileBinding,
  summarizeHarnessPackage,
  validateHarnessWorkflowRepairDraft,
} from "./harness-package-ui.ts";

const pkg = (overrides = {}) => ({
  id: "harness_demo",
  name: "Demo Harness",
  source: {
    format: "codex",
    rootDir: "C:/tmp/demo",
    importedAt: "2026-05-27T00:00:00.000Z",
    files: [
      {
        relativePath: "skills/demo/SKILL.md",
        kind: "skill",
        sha256: "abc",
        parserVersion: "test",
      },
    ],
  },
  overview: { title: "Demo Harness", summary: "Demo" },
  agents: [],
  skills: [
    {
      id: "demo",
      name: "demo",
      description: "Demo skill",
      triggerTerms: [],
      negativeTriggerTerms: [],
      sourceFile: "skills/demo/SKILL.md",
      workflowRefs: [],
      relatedSkillRefs: [],
      rawFrontmatter: {},
    },
  ],
  workflows: [],
  capabilities: [],
  validation: {
    status: "needs_review",
    issues: [
      {
        severity: "warning",
        code: "HARNESS_WORKFLOW_PARSE_PENDING",
        message: "Workflow parse pending",
        blocksExecution: true,
      },
      {
        severity: "info",
        code: "HARNESS_NOTE",
        message: "Metadata imported",
        blocksExecution: false,
      },
    ],
    importedAt: "2026-05-27T00:00:00.000Z",
    adapterVersion: "test",
  },
  ...overrides,
});

test("summarizeHarnessPackage counts package structure and blocking issues", () => {
  const summary = summarizeHarnessPackage(pkg());

  assert.equal(summary.formatLabel, "Codex");
  assert.equal(summary.statusLabel, "Needs review");
  assert.equal(summary.files, 1);
  assert.equal(summary.skills, 1);
  assert.equal(summary.workflows, 0);
  assert.deepEqual(summary.issueCounts, {
    info: 1,
    warning: 1,
    error: 0,
  });
  assert.equal(summary.blocksExecution, true);
});

test("primaryHarnessPackageIssue prefers execution blockers", () => {
  const issue = primaryHarnessPackageIssue(
    pkg({
      validation: {
        ...pkg().validation,
        issues: [
          {
            severity: "info",
            code: "INFO",
            message: "First",
            blocksExecution: false,
          },
          {
            severity: "error",
            code: "BLOCKED",
            message: "Second",
            blocksExecution: true,
          },
        ],
      },
    }),
  );

  assert.equal(issue.code, "BLOCKED");
});

test("primaryHarnessPackageIssue returns null with no issues", () => {
  const issue = primaryHarnessPackageIssue(
    pkg({
      validation: { ...pkg().validation, issues: [], status: "valid" },
    }),
  );

  assert.equal(issue, null);
});

test("harnessAgentBindingCandidates reads workflow agent refs in step order", () => {
  const definition = pkg({
    agents: [
      {
        id: "content-strategist",
        name: "Content Strategist",
        description: "Strategy",
        roleHint: "strategist",
        sourceFile: ".claude/agents/content-strategist.md",
        persona: "",
        responsibilities: [],
        requiredCapabilities: [],
      },
      {
        id: "reviewer",
        name: "Reviewer",
        description: "Review",
        roleHint: "reviewer",
        sourceFile: ".claude/agents/reviewer.md",
        persona: "",
        responsibilities: [],
        requiredCapabilities: [],
      },
    ],
    workflows: [
      {
        id: "wf",
        skillId: "demo",
        name: "Demo workflow",
        mode: "agent-team",
        description: "Demo",
        sourceFile: "skills/demo/SKILL.md",
        phases: [],
        steps: [
          {
            id: "step-1",
            title: "Strategy",
            agentRef: "content-strategist",
            roleHint: "strategist",
            instruction: "Plan",
            dependsOn: [],
            artifactContracts: [],
            allowedActions: [],
            outputContract: "plan",
            sourceRef: { relativePath: "skills/demo/SKILL.md" },
          },
          {
            id: "step-2",
            title: "Review",
            agentRef: "reviewer",
            roleHint: "reviewer",
            instruction: "Review",
            dependsOn: ["step-1"],
            artifactContracts: [],
            allowedActions: [],
            outputContract: "review",
            sourceRef: { relativePath: "skills/demo/SKILL.md" },
          },
          {
            id: "step-3",
            title: "Review again",
            agentRef: "reviewer",
            roleHint: "reviewer",
            instruction: "Review",
            dependsOn: ["step-2"],
            artifactContracts: [],
            allowedActions: [],
            outputContract: "review",
            sourceRef: { relativePath: "skills/demo/SKILL.md" },
          },
        ],
        handoffPolicy: {
          mode: "source_message_semantics",
          routes: [],
          requiredPayload: "harness_worker_handoff_v1",
          fallback: "synthesize_from_artifact",
        },
        failurePolicy: {
          defaultMode: "pause_for_review",
          maxAttempts: 2,
          rules: [],
        },
        testScenarios: [],
        parseConfidence: "medium",
      },
    ],
  });

  const candidates = harnessAgentBindingCandidates(definition, "wf");

  assert.deepEqual(
    candidates.map((candidate) => [
      candidate.harnessAgentRef,
      candidate.label,
      candidate.stepCount,
    ]),
    [
      ["content-strategist", "Content Strategist", 1],
      ["reviewer", "Reviewer", 2],
    ],
  );
});

test("suggestHarnessProfileBinding only fills strong profile matches", () => {
  const profiles = [
    {
      id: "profile-strategist",
      name: "Content Strategist",
      tags: [],
    },
    {
      id: "profile-reviewer",
      name: "Quality",
      tags: ["reviewer"],
    },
    {
      id: "profile-default",
      name: "Default Agent",
      tags: [],
    },
  ];

  assert.equal(
    suggestHarnessProfileBinding(
      {
        harnessAgentRef: "content-strategist",
        label: "Content Strategist",
        stepCount: 1,
      },
      profiles,
    ),
    "profile-strategist",
  );
  assert.equal(
    suggestHarnessProfileBinding(
      { harnessAgentRef: "reviewer", label: "Reviewer", stepCount: 1 },
      profiles,
    ),
    "profile-reviewer",
  );
  assert.equal(
    suggestHarnessProfileBinding(
      { harnessAgentRef: "writer", label: "Writer", stepCount: 1 },
      profiles,
    ),
    "",
  );
});

test("harnessWorkflowStepRows formats dependencies and artifact contracts for review", () => {
  const workflow = {
    id: "wf",
    skillId: "demo",
    name: "Demo workflow",
    mode: "agent-team",
    description: "Demo",
    sourceFile: "skills/demo/SKILL.md",
    phases: [],
    steps: [
      {
        id: "step-1",
        title: "Plan",
        agentRef: "planner",
        roleHint: "planner",
        instruction: "Plan",
        dependsOn: [],
        artifactContracts: [
          {
            id: "artifact-1",
            pathHint: "_workspace/plan.md",
            title: "plan",
            kind: "workspace_file",
            required: true,
            description: "Plan",
          },
        ],
        allowedActions: ["file_write"],
        outputContract: "plan",
        sourceRef: { relativePath: "skills/demo/SKILL.md" },
      },
      {
        id: "step-2",
        title: "Review",
        roleHint: "reviewer",
        instruction: "Review",
        dependsOn: ["step-1"],
        artifactContracts: [],
        allowedActions: [],
        outputContract: "review",
        sourceRef: { relativePath: "skills/demo/SKILL.md" },
      },
    ],
    handoffPolicy: {
      mode: "source_message_semantics",
      routes: [],
      requiredPayload: "harness_worker_handoff_v1",
      fallback: "synthesize_from_artifact",
    },
    failurePolicy: {
      defaultMode: "pause_for_review",
      maxAttempts: 2,
      rules: [],
    },
    testScenarios: [],
    parseConfidence: "medium",
  };

  assert.deepEqual(harnessWorkflowStepRows(workflow), [
    {
      id: "step-1",
      title: "Plan",
      owner: "planner",
      dependsOn: "None",
      artifacts: "_workspace/plan.md",
      outputContract: "plan",
    },
    {
      id: "step-2",
      title: "Review",
      owner: "reviewer",
      dependsOn: "step-1",
      artifacts: "None",
      outputContract: "review",
    },
  ]);
});

test("repairDraftFromWorkflow creates editable fields from workflow steps", () => {
  const draft = repairDraftFromWorkflow(repairWorkflow());

  assert.equal(draft.workflowId, "wf");
  assert.equal(draft.note, "");
  assert.deepEqual(
    draft.steps.map((step) => [
      step.stepId,
      step.title,
      step.agentRef,
      step.roleHint,
      step.dependsOnText,
      step.artifactsText,
      step.outputContract,
    ]),
    [
      ["step-1", "Plan", "planner", "planner", "", "_workspace/plan.md", "plan"],
      ["step-2", "Review", "", "reviewer", "step-1", "", "review"],
    ],
  );
});

test("repairInputFromDraft normalizes dependencies artifacts and blank owners", () => {
  const draft = repairDraftFromWorkflow(repairWorkflow());
  const patched = {
    ...draft,
    note: " reviewed ",
    steps: draft.steps.map((step) =>
      step.stepId === "step-2"
        ? {
            ...step,
            agentRef: "",
            dependsOnText: " step-1, step-1 ",
            artifactsText: "_workspace/review.md",
          }
        : step,
    ),
  };

  const input = repairInputFromDraft("pkg-1", patched);

  assert.equal(input.packageId, "pkg-1");
  assert.equal(input.note, "reviewed");
  assert.deepEqual(input.workflows[0].steps[1], {
    stepId: "step-2",
    title: "Review",
    agentRef: null,
    roleHint: "reviewer",
    instruction: "Review",
    dependsOn: ["step-1"],
    artifactContracts: [
      {
        id: "step-2-artifact-1",
        pathHint: "_workspace/review.md",
        title: "_workspace/review.md",
        kind: "workspace_file",
        required: true,
        description: "_workspace/review.md",
      },
    ],
    outputContract: "review",
  });
});

test("validateHarnessWorkflowRepairDraft reports invalid dependency edits", () => {
  const draft = repairDraftFromWorkflow(repairWorkflow());
  const invalid = {
    ...draft,
    steps: draft.steps.map((step) =>
      step.stepId === "step-1"
        ? { ...step, roleHint: " ", dependsOnText: "step-2" }
        : { ...step, dependsOnText: "step-1" },
    ),
  };

  assert.deepEqual(validateHarnessWorkflowRepairDraft(invalid), [
    "step-1: role hint is required.",
    "Workflow dependencies contain a cycle.",
  ]);
});

const repairWorkflow = () => ({
  id: "wf",
  skillId: "demo",
  name: "Demo workflow",
  mode: "agent-team",
  description: "Demo",
  sourceFile: "skills/demo/SKILL.md",
  phases: [],
  steps: [
    {
      id: "step-1",
      title: "Plan",
      agentRef: "planner",
      roleHint: "planner",
      instruction: "Plan",
      dependsOn: [],
      artifactContracts: [
        {
          id: "artifact-1",
          pathHint: "_workspace/plan.md",
          title: "plan",
          kind: "workspace_file",
          required: true,
          description: "Plan",
        },
      ],
      allowedActions: ["file_write"],
      outputContract: "plan",
      sourceRef: { relativePath: "skills/demo/SKILL.md" },
    },
    {
      id: "step-2",
      title: "Review",
      roleHint: "reviewer",
      instruction: "Review",
      dependsOn: ["step-1"],
      artifactContracts: [],
      allowedActions: [],
      outputContract: "review",
      sourceRef: { relativePath: "skills/demo/SKILL.md" },
    },
  ],
  handoffPolicy: {
    mode: "source_message_semantics",
    routes: [],
    requiredPayload: "harness_worker_handoff_v1",
    fallback: "synthesize_from_artifact",
  },
  failurePolicy: {
    defaultMode: "pause_for_review",
    maxAttempts: 2,
    rules: [],
  },
  testScenarios: [],
  parseConfidence: "medium",
});
