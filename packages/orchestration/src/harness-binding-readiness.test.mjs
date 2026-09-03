import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessHarnessBindingReadiness,
  harnessAgentBindingCandidates,
} from "./harness-binding-readiness.ts";

const importedAt = "2026-05-27T00:00:00.000Z";

const pkg = (overrides = {}) => ({
  id: "harness_demo",
  name: "Demo Harness",
  source: {
    format: "codex",
    rootDir: "C:/tmp/demo",
    importedAt,
    files: [],
  },
  overview: { title: "Demo Harness", summary: "Demo" },
  agents: [],
  skills: [],
  workflows: [],
  capabilities: [],
  validation: {
    status: "valid",
    issues: [],
    importedAt,
    adapterVersion: "test",
  },
  ...overrides,
});

test("assessHarnessBindingReadiness reports unbound workflow candidates", () => {
  const summary = assessHarnessBindingReadiness({
    definition: pkg({ workflows: [workflow()] }),
    workflowId: "wf",
    bindings: {},
    profiles: [],
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.errorCount, 2);
  assert.deepEqual(
    summary.issues.map((issue) => issue.code),
    ["HARNESS_PROFILE_UNBOUND", "HARNESS_PROFILE_UNBOUND"],
  );
});

test("binding readiness normalizes agent refs consistently with pipeline conversion", () => {
  const normalizedWorkflow = workflow();
  normalizedWorkflow.steps = normalizedWorkflow.steps.map((step, index) => ({
    ...step,
    agentRef: index === 0 ? " Planner " : "planner",
    roleHint: "planner",
    dependsOn: index === 0 ? [] : ["step-1"],
  }));
  const definition = pkg({
    agents: [
      {
        id: "planner",
        name: "Planner",
        description: "Plan",
        roleHint: "planner",
        sourceFile: ".claude/agents/planner.md",
        persona: "",
        responsibilities: [],
        requiredCapabilities: [],
      },
    ],
    workflows: [normalizedWorkflow],
  });

  assert.deepEqual(
    harnessAgentBindingCandidates(definition, "wf").map((candidate) => ({
      harnessAgentRef: candidate.harnessAgentRef,
      stepCount: candidate.stepCount,
    })),
    [{ harnessAgentRef: "Planner", stepCount: 2 }],
  );

  const summary = assessHarnessBindingReadiness({
    definition,
    workflowId: "wf",
    bindings: { " PLANNER ": "profile-planner" },
    profiles: [profile()],
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.errorCount, 0);
});

test("assessHarnessBindingReadiness surfaces provider, MCP, Skill, and capability risks", () => {
  const definition = pkg({
    agents: [
      {
        id: "planner",
        name: "Planner",
        description: "Plan",
        roleHint: "planner",
        sourceFile: ".claude/agents/planner.md",
        persona: "",
        responsibilities: [],
        providerHint: "claude",
        requiredCapabilities: ["cap-review"],
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
    workflows: [workflow()],
    capabilities: [
      {
        id: "cap-review",
        kind: "skill_source",
        required: true,
        description: "Review capability",
        providerHint: "claude",
        risk: "high",
      },
    ],
  });

  const summary = assessHarnessBindingReadiness({
    definition,
    workflowId: "wf",
    bindings: {
      planner: "profile-planner",
      reviewer: "profile-reviewer",
    },
    profiles: [
      profile({
        id: "profile-planner",
        name: "Planner Profile",
        provider: "codex",
        mcpServerIds: ["mcp-http", "missing-mcp"],
        skillSourceIds: ["skill-disabled"],
        permissions: {
          allowedSkillIds: ["cap-other"],
        },
      }),
      profile({
        id: "profile-reviewer",
        name: "Reviewer Profile",
        provider: "codex",
        role: "reviewer",
      }),
    ],
    providers: {
      claude: { available: true, queueDepth: 0 },
      codex: { available: false, queueDepth: 0, error: "not found" },
    },
    mcpServers: [
      {
        id: "mcp-http",
        name: "HTTP MCP",
        description: "",
        transport: "http",
        url: "http://localhost:9999",
        env: {},
        envSecretRefs: {},
        scope: "per-agent",
        enabled: true,
        createdAt: importedAt,
        updatedAt: importedAt,
      },
    ],
    skillSources: [
      {
        id: "skill-disabled",
        name: "Disabled Skills",
        origin: "custom",
        rootDir: "C:/skills",
        trusted: false,
        enabled: false,
        registeredInPathPolicy: false,
        createdAt: importedAt,
        updatedAt: importedAt,
      },
    ],
    capabilities: [
      {
        id: "cap-review",
        source: "skillify:project",
        name: "Review capability",
        description: "",
        triggerTerms: [],
        riskLevel: "high",
        requiresApproval: true,
      },
    ],
  });

  const codes = new Set(summary.issues.map((issue) => issue.code));
  assert.equal(summary.ok, true);
  assert.equal(summary.errorCount, 0);
  assert.equal(codes.has("HARNESS_CAPABILITY_HIGH_RISK"), true);
  assert.equal(codes.has("HARNESS_PROVIDER_HINT_MISMATCH"), true);
  assert.equal(codes.has("HARNESS_PROVIDER_UNAVAILABLE"), true);
  assert.equal(codes.has("HARNESS_MCP_CODEX_LIMITED"), true);
  assert.equal(codes.has("HARNESS_MCP_UNKNOWN"), true);
  assert.equal(codes.has("HARNESS_SKILL_SOURCE_DISABLED"), true);
  assert.equal(codes.has("HARNESS_SKILL_SOURCE_UNTRUSTED"), true);
  assert.equal(codes.has("HARNESS_AGENT_CAPABILITY_NOT_ALLOWED"), true);
});

const workflow = () => ({
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
      artifactContracts: [],
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

const profile = (overrides = {}) => {
  const permissions = {
    autoApproveActions: [],
    blockedActions: [],
    allowedSkillIds: [],
    toolAllowlist: [],
    toolDenylist: [],
    ...(overrides.permissions ?? {}),
  };
  return {
    id: "profile-planner",
    name: "Planner Profile",
    description: "",
    category: "development",
    tags: [],
    provider: "codex",
    role: "planner",
    persona: "",
    tuning: {
      model: "gpt-5.5",
      timeoutMs: 300000,
      stallTimeoutMs: 60000,
      contextDepth: 4,
      systemPromptPrefix: "",
      systemPromptSuffix: "",
    },
    cli: {
      cliPathOverride: "",
      env: {},
      envSecretRefs: {},
    },
    permissions,
    mcpServerIds: [],
    skillSourceIds: [],
    isDefault: false,
    createdAt: importedAt,
    updatedAt: importedAt,
    ...overrides,
    permissions,
  };
};
