import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import { SqliteAgentProfileRepository } from "./agent-profile-repository.ts";
import { SqliteAgentPipelineRepository } from "./agent-pipeline-repository.ts";
import { SqliteA2ARemoteAgentRepository } from "./a2a-remote-agent-repository.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-pipe-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const validProfileInput = (overrides = {}) => ({
  name: "Coder",
  description: "",
  category: "test",
  tags: ["coder"],
  provider: "claude",
  role: "coder",
  persona: "",
  tuning: {
    model: "claude-sonnet-4-6",
    timeoutMs: 300_000,
    stallTimeoutMs: 60_000,
    contextDepth: 5,
    systemPromptPrefix: "",
    systemPromptSuffix: "",
  },
  cli: { cliPathOverride: "", env: {}, envSecretRefs: {} },
  permissions: {
    autoApproveActions: [],
    blockedActions: [],
    allowedSkillIds: [],
    toolAllowlist: [],
    toolDenylist: [],
  },
  mcpServerIds: [],
  skillSourceIds: [],
  isDefault: false,
  ...overrides,
});

const setupRepos = async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const profiles = new SqliteAgentProfileRepository(db);
  const remoteAgents = new SqliteA2ARemoteAgentRepository(db);
  const pipelines = new SqliteAgentPipelineRepository(db, profiles, remoteAgents);
  const profile = await profiles.create(validProfileInput());
  return { t, db, profiles, pipelines, profile, remoteAgents };
};

const makePipelineInput = (profileId, overrides = {}) => ({
  name: "Backend Feature Flow",
  description: "Plan → Code",
  steps: [
    {
      id: "step_a",
      agentProfileId: profileId,
      title: "Plan",
      instruction: "Outline the change.",
      expectedArtifactKinds: ["plan"],
    },
  ],
  ...overrides,
});

const makeEndpoint = (overrides = {}) => ({
  name: "Remote Reviewer",
  baseUrl: "https://agents.example.com/reviewer",
  agentCardUrl: "https://agents.example.com/reviewer/.well-known/agent-card.json",
  preferredTransport: "json-rpc",
  enabled: true,
  trusted: true,
  ...overrides,
});

test("AgentPipelineRepository.list returns [] on an empty DB", async () => {
  const { t, db, pipelines } = await setupRepos();
  try {
    assert.deepEqual(await pipelines.list(), []);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentPipelineRepository.create assigns id, timestamps, round-trips steps", async () => {
  const { t, db, pipelines, profile } = await setupRepos();
  try {
    const input = makePipelineInput(profile.id);
    const created = await pipelines.create(input);
    assert.ok(created.id.startsWith("pipe_"));
    assert.equal(typeof created.createdAt, "string");
    assert.equal(created.createdAt, created.updatedAt);
    assert.equal(created.name, input.name);
    assert.deepEqual(created.steps, input.steps);

    const fetched = await pipelines.get(created.id);
    assert.deepEqual(fetched, created);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentPipelineRepository.ensureSeed inserts role-aware default templates", async () => {
  const { t, db, pipelines, profiles } = await setupRepos();
  try {
    await profiles.ensureSeed();
    await pipelines.ensureSeed();

    const all = await pipelines.list();
    const names = all.map((p) => p.name).sort();
    assert.deepEqual(names, [
      "3D New Project Delivery",
      "A2A Federation Safety Review",
      "Architecture RFC",
      "Build Recovery",
      "Cross-Harness Agent Baseline",
      "Docs-First Contract Reconciliation",
      "Eval-Driven Release Verification",
      "Evidence-First Bug Investigation",
      "Frontend Product Delivery",
      "Image Asset Prompt Flow",
      "New Project Delivery",
      "Parallel Review Hardening",
      "Product PRD Discovery",
      "Refactor Safety",
      "Runtime Approval Hardening",
      "Skill and Agent Expansion",
      "Supervised Delivery",
      "Visual Design Delivery",
    ]);

    const profileRoles = new Map(
      (await profiles.list()).map((p) => [p.id, p.role]),
    );
    const delivery = all.find((p) => p.id === "pipe_template_supervised_delivery");
    assert.ok(delivery, "Supervised Delivery template should exist");
    assert.deepEqual(
      delivery.steps.map((step) => profileRoles.get(step.agentProfileId)),
      [
        "orchestrator",
        "planner",
        "coder",
        "build-error-resolver",
        "tester",
        "security-reviewer",
        "reviewer",
      ],
    );
    assert.deepEqual(
      delivery.steps.find((step) => step.id === "security")?.allowedActions,
      [],
    );
    assert.deepEqual(
      delivery.steps.find((step) => step.id === "build")?.allowedActions,
      ["shell", "file_write"],
    );
    assert.match(
      delivery.steps.find((step) => step.id === "plan")?.instruction ?? "",
      /한국어/,
      "seed step instructions should be Korean-facing",
    );
    assert.ok(
      delivery.backflowRules?.some(
        (rule) =>
          rule.trigger === "step_failed" &&
          rule.targetStepId === "plan" &&
          rule.retryStepId === "implement",
      ),
      "seeded delivery pipelines should include retry-to-upstream backflow",
    );
    assert.ok(
      delivery.backflowRules?.some(
        (rule) =>
          rule.trigger === "quality_failed" &&
          rule.targetStepId === "implement" &&
          rule.retryStepId === "final-review",
      ),
      "seeded delivery pipelines should include a bounded quality backflow",
    );

    const prd = all.find((p) => p.id === "pipe_template_product_prd");
    assert.ok(prd, "Product PRD Discovery template should exist");
    assert.deepEqual(
      prd.steps.map((step) => profileRoles.get(step.agentProfileId)),
      ["planner", "planner", "orchestrator", "reviewer"],
    );

    const visual = all.find((p) => p.id === "pipe_template_image_asset_prompt");
    assert.ok(visual, "Image Asset Prompt Flow template should exist");
    assert.deepEqual(
      visual.steps.map((step) => step.id),
      ["brief", "image-prompts", "design-review", "handoff"],
    );
    assert.deepEqual(
      visual.steps.find((step) => step.id === "image-prompts")?.allowedActions,
      [],
      "image prompt generation is read-only until a concrete image runner exists",
    );

    const newProject = all.find((p) => p.id === "pipe_template_new_project_delivery");
    assert.ok(newProject, "New Project Delivery template should exist");
    assert.deepEqual(
      newProject.steps.map((step) => step.id),
      [
        "prd",
        "project-plan",
        "architecture",
        "ux-flow",
        "image-assets",
        "implementation",
        "build-recovery",
        "verification",
        "design-review",
        "security-review",
        "final-review",
      ],
    );
    assert.deepEqual(
      newProject.steps.map((step) => profileRoles.get(step.agentProfileId)),
      [
        "planner",
        "planner",
        "orchestrator",
        "planner",
        "planner",
        "coder",
        "build-error-resolver",
        "tester",
        "reviewer",
        "security-reviewer",
        "reviewer",
      ],
    );
    assert.deepEqual(
      newProject.steps.find((step) => step.id === "implementation")?.allowedActions,
      ["file_write"],
      "project creation files must be proposed through Harness approvals",
    );
    assert.deepEqual(
      newProject.steps.find((step) => step.id === "build-recovery")?.allowedActions,
      ["shell", "file_write"],
    );
    assert.deepEqual(
      newProject.steps.find((step) => step.id === "image-assets")?.allowedActions,
      [],
      "image generation planning remains read-only until a concrete image runner exists",
    );
    assert.ok(
      newProject.backflowRules?.some(
        (rule) =>
          rule.trigger === "step_failed" &&
          rule.targetStepId === "image-assets" &&
          rule.retryStepId === "implementation",
      ),
      "new project implementation should be able to backflow to asset planning",
    );

    const investigation = all.find((p) => p.id === "pipe_template_evidence_bug_investigation");
    assert.ok(investigation, "Evidence-First Bug Investigation template should exist");
    assert.deepEqual(
      investigation.steps.map((step) => step.id),
      ["trace", "hypothesis", "patch", "verify", "review"],
    );
    assert.deepEqual(
      investigation.steps.map((step) => profileRoles.get(step.agentProfileId)),
      ["planner", "planner", "coder", "tester", "reviewer"],
    );

    const contract = all.find((p) => p.id === "pipe_template_docs_contract_reconciliation");
    assert.ok(contract, "Docs-First Contract Reconciliation template should exist");
    assert.deepEqual(
      contract.steps.map((step) => step.id),
      ["source-check", "contract-audit", "runtime-design", "implement", "verify", "review"],
    );
    assert.deepEqual(
      contract.steps.find((step) => step.id === "contract-audit")?.allowedActions,
      [],
    );

    const baseline = all.find((p) => p.id === "pipe_template_cross_harness_agent_baseline");
    assert.ok(baseline, "Cross-Harness Agent Baseline template should exist");
    assert.deepEqual(
      baseline.steps.map((step) => step.id),
      ["sources", "skill-memory", "topology", "implement", "verify", "security", "review"],
    );

    const project3d = all.find((p) => p.id === "pipe_template_3d_new_project_delivery");
    assert.ok(project3d, "3D New Project Delivery template should exist");
    assert.deepEqual(
      project3d.steps.map((step) => step.id),
      [
        "prd",
        "architecture",
        "plan",
        "texture-generation",
        "modeling",
        "file-composition",
        "class-generation",
        "implementation",
        "review",
        "execution-validation",
        "explanation",
        "completion",
      ],
    );
    assert.deepEqual(
      project3d.steps.map((step) => profileRoles.get(step.agentProfileId)),
      [
        "planner",
        "orchestrator",
        "planner",
        "coder",
        "coder",
        "coder",
        "coder",
        "coder",
        "reviewer",
        "tester",
        "planner",
        "reviewer",
      ],
    );
    assert.deepEqual(
      project3d.steps.find((step) => step.id === "texture-generation")?.allowedActions,
      ["file_write"],
      "texture artifacts must be proposed as approval-gated files",
    );
    assert.deepEqual(
      project3d.steps.find((step) => step.id === "execution-validation")?.allowedActions,
      ["shell"],
      "execution verification may run approved smoke commands",
    );
    assert.match(
      project3d.steps.find((step) => step.id === "implementation")?.instruction ?? "",
      /3D 모델|텍스처/,
      "implementation step must explicitly consume the generated 3D model and texture outputs",
    );
    assert.ok(
      project3d.backflowRules?.some(
        (rule) =>
          rule.id === "bf_completion_quality_from_implementation" &&
          rule.trigger === "quality_failed" &&
          rule.targetStepId === "implementation" &&
          rule.retryStepId === "completion",
      ),
      "3D template keeps its explicit final quality backflow",
    );
    assert.ok(
      project3d.backflowRules?.some(
        (rule) =>
          rule.trigger === "step_failed" &&
          rule.targetStepId === "file-composition" &&
          rule.retryStepId === "class-generation",
      ),
      "3D template should add missing step-level backflow where topology allows it",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentPipelineRepository.ensureSeed backfills missing seed backflow rules", async () => {
  const { t, db, pipelines, profiles } = await setupRepos();
  try {
    await profiles.ensureSeed();
    await pipelines.ensureSeed();
    const seeded = await pipelines.get("pipe_template_supervised_delivery");
    assert.ok(seeded, "Supervised Delivery template should exist");
    await pipelines.update({ ...seeded, backflowRules: [] });

    await pipelines.ensureSeed();

    const refreshed = await pipelines.get("pipe_template_supervised_delivery");
    assert.ok(refreshed?.backflowRules?.length > 0);
    assert.ok(
      refreshed.backflowRules.some(
        (rule) =>
          rule.id === "bf_implement_from_plan_step_failed" &&
          rule.trigger === "step_failed",
      ),
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentPipelineRepository.ensureSeed is idempotent", async () => {
  const { t, db, pipelines, profiles } = await setupRepos();
  try {
    await profiles.ensureSeed();
    await pipelines.ensureSeed();
    await pipelines.ensureSeed();

    const all = await pipelines.list();
    assert.equal(all.length, 18);
    assert.equal(
      all.filter((p) => p.id === "pipe_template_refactor_safety").length,
      1,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentPipelineRepository.ensureSeed localizes unmodified English templates", async () => {
  const { t, db, pipelines, profiles } = await setupRepos();
  try {
    await profiles.ensureSeed();
    const profileByRole = new Map(
      (await profiles.list()).map((p) => [p.role, p.id]),
    );
    const now = "2026-05-17T00:00:00.000Z";
    const steps = [
      {
        id: "diagnose",
        agentProfileId: profileByRole.get("build-error-resolver"),
        title: "Diagnose first real failure",
        instruction:
          "Read the first real build, typecheck, lint, or test failure. Trace the owning module and propose the smallest corrective change.",
        expectedArtifactKinds: ["test_result", "diff", "log"],
        dependsOn: [],
        allowedActions: ["shell", "file_write"],
        outputContract: "test_result",
      },
    ];
    db.prepare(
      `INSERT INTO agent_pipelines
        (id, name, description, steps_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(
      "pipe_template_build_recovery",
      "Build Recovery",
      "Focused failure-recovery flow for build, typecheck, lint, or test failures with verification and final review.",
      JSON.stringify(steps),
      now,
      now,
    );

    await pipelines.ensureSeed();
    const refreshed = await pipelines.get("pipe_template_build_recovery");

    assert.match(refreshed.description, /집중 복구/);
    assert.match(refreshed.steps[0].title, /첫 실제 실패/);
    assert.match(refreshed.steps[0].instruction, /한국어/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentPipelineRepository.create preserves a remoteEndpointId override", async () => {
  const { t, db, pipelines, profile, remoteAgents } = await setupRepos();
  try {
    const endpoint = await remoteAgents.upsertEndpoint(makeEndpoint());
    const created = await pipelines.create(
      makePipelineInput(profile.id, {
        steps: [
          {
            id: "step_remote",
            agentProfileId: profile.id,
            remoteEndpointId: endpoint.id,
            title: "Remote review",
            instruction: "Review via A2A.",
            expectedArtifactKinds: ["log"],
          },
        ],
      }),
    );
    assert.equal(created.steps[0].remoteEndpointId, endpoint.id);
    assert.equal((await pipelines.get(created.id)).steps[0].remoteEndpointId, endpoint.id);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentPipelineRepository.create preserves topology metadata", async () => {
  const { t, db, pipelines, profiles, profile } = await setupRepos();
  try {
    const reviewer = await profiles.create(
      validProfileInput({ name: "Reviewer", role: "reviewer" }),
    );
    const created = await pipelines.create(
      makePipelineInput(profile.id, {
        steps: [
          {
            id: "plan",
            agentProfileId: profile.id,
            title: "Plan",
            instruction: "Outline.",
            expectedArtifactKinds: ["plan"],
            allowedActions: ["file_write"],
            outputContract: "diff_proposal",
          },
          {
            id: "review",
            agentProfileId: reviewer.id,
            title: "Review",
            instruction: "Review.",
            expectedArtifactKinds: ["quality_report"],
            dependsOn: ["plan"],
            allowedActions: [],
            outputContract: "review",
          },
        ],
      }),
    );

    assert.deepEqual(created.steps[1].dependsOn, ["plan"]);
    assert.deepEqual((await pipelines.get(created.id)).steps, created.steps);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentPipelineRepository.create round-trips backflow rules", async () => {
  const { t, db, pipelines, profiles, profile } = await setupRepos();
  try {
    const reviewer = await profiles.create(
      validProfileInput({ name: "Reviewer", role: "reviewer" }),
    );
    const created = await pipelines.create(
      makePipelineInput(profile.id, {
        steps: [
          {
            id: "plan",
            agentProfileId: profile.id,
            title: "Plan",
            instruction: "Plan.",
            expectedArtifactKinds: ["plan"],
            dependsOn: [],
          },
          {
            id: "review",
            agentProfileId: reviewer.id,
            title: "Review",
            instruction: "Review.",
            expectedArtifactKinds: ["quality_report"],
            dependsOn: ["plan"],
          },
        ],
        backflowRules: [
          {
            id: "bf_review",
            trigger: "step_failed",
            targetStepId: "plan",
            retryStepId: "review",
            maxAttempts: 2,
            instruction: "Refresh the plan before retrying review.",
          },
        ],
      }),
    );

    assert.deepEqual(created.backflowRules, [
      {
        id: "bf_review",
        trigger: "step_failed",
        targetStepId: "plan",
        retryStepId: "review",
        maxAttempts: 2,
        instruction: "Refresh the plan before retrying review.",
      },
    ]);
    assert.deepEqual((await pipelines.get(created.id)).backflowRules, created.backflowRules);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentPipelineRepository.create rejects invalid backflow topology", async () => {
  const { t, db, pipelines, profiles, profile } = await setupRepos();
  try {
    const reviewer = await profiles.create(
      validProfileInput({ name: "Reviewer", role: "reviewer" }),
    );
    const base = {
      steps: [
        {
          id: "plan",
          agentProfileId: profile.id,
          title: "Plan",
          instruction: "Plan.",
          expectedArtifactKinds: ["plan"],
          dependsOn: [],
        },
        {
          id: "review",
          agentProfileId: reviewer.id,
          title: "Review",
          instruction: "Review.",
          expectedArtifactKinds: ["quality_report"],
          dependsOn: ["plan"],
        },
      ],
    };

    await assert.rejects(
      () =>
        pipelines.create(
          makePipelineInput(profile.id, {
            ...base,
            backflowRules: [
              {
                id: "bf_missing",
                trigger: "step_failed",
                targetStepId: "missing",
                retryStepId: "review",
                maxAttempts: 2,
              },
            ],
          }),
        ),
      /backflow.*unknown/i,
    );
    await assert.rejects(
      () =>
        pipelines.create(
          makePipelineInput(profile.id, {
            ...base,
            backflowRules: [
              {
                id: "bf_forward",
                trigger: "step_failed",
                targetStepId: "review",
                retryStepId: "plan",
                maxAttempts: 2,
              },
            ],
          }),
        ),
      /backflow.*earlier/i,
    );
    await assert.rejects(
      () =>
        pipelines.create(
          makePipelineInput(profile.id, {
            ...base,
            steps: [
              base.steps[0],
              {
                id: "research",
                agentProfileId: reviewer.id,
                title: "Research",
                instruction: "Research independently.",
                expectedArtifactKinds: ["log"],
                dependsOn: [],
              },
              base.steps[1],
            ],
            backflowRules: [
              {
                id: "bf_unconnected",
                trigger: "step_failed",
                targetStepId: "research",
                retryStepId: "review",
                maxAttempts: 2,
              },
            ],
          }),
        ),
      /backflow.*dependency path/i,
    );
    await assert.rejects(
      () =>
        pipelines.create(
          makePipelineInput(profile.id, {
            ...base,
            backflowRules: [
              {
                id: "bf_invalid_attempts",
                trigger: "quality_failed",
                targetStepId: "plan",
                retryStepId: "review",
                maxAttempts: 6,
              },
            ],
          }),
        ),
      /maxAttempts/i,
    );
    await assert.rejects(
      () =>
        pipelines.create(
          makePipelineInput(profile.id, {
            ...base,
            backflowRules: [
              {
                id: "bf_dup",
                trigger: "quality_failed",
                targetStepId: "plan",
                retryStepId: "review",
                maxAttempts: 1,
              },
              {
                id: "bf_dup",
                trigger: "step_failed",
                targetStepId: "plan",
                retryStepId: "review",
                maxAttempts: 1,
              },
            ],
          }),
        ),
      /duplicates/i,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentPipelineRepository.create rejects empty steps", async () => {
  const { t, db, pipelines, profile } = await setupRepos();
  try {
    await assert.rejects(
      () =>
        pipelines.create(makePipelineInput(profile.id, { steps: [] })),
      /steps/i,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentPipelineRepository.create rejects unknown dependsOn step ids", async () => {
  const { t, db, pipelines, profile } = await setupRepos();
  try {
    await assert.rejects(
      () =>
        pipelines.create(
          makePipelineInput(profile.id, {
            steps: [
              {
                id: "step_a",
                agentProfileId: profile.id,
                title: "Plan",
                instruction: "",
                expectedArtifactKinds: ["plan"],
                dependsOn: ["missing"],
              },
            ],
          }),
        ),
      /dependsOn/i,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentPipelineRepository.create rejects dependsOn cycles", async () => {
  const { t, db, pipelines, profile } = await setupRepos();
  try {
    await assert.rejects(
      () =>
        pipelines.create(
          makePipelineInput(profile.id, {
            steps: [
              {
                id: "a",
                agentProfileId: profile.id,
                title: "A",
                instruction: "",
                expectedArtifactKinds: ["plan"],
                dependsOn: ["b"],
              },
              {
                id: "b",
                agentProfileId: profile.id,
                title: "B",
                instruction: "",
                expectedArtifactKinds: ["log"],
                dependsOn: ["a"],
              },
            ],
          }),
        ),
      /cycle/i,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentPipelineRepository.create rejects unknown agentProfileId", async () => {
  const { t, db, pipelines, profile } = await setupRepos();
  try {
    await assert.rejects(
      () =>
        pipelines.create(
          makePipelineInput(profile.id, {
            steps: [
              {
                id: "step_a",
                agentProfileId: "agentProfile_does_not_exist",
                title: "Plan",
                instruction: "",
                expectedArtifactKinds: ["plan"],
              },
            ],
          }),
        ),
      /agentProfile/i,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentPipelineRepository.create rejects unknown remoteEndpointId", async () => {
  const { t, db, pipelines, profile } = await setupRepos();
  try {
    await assert.rejects(
      () =>
        pipelines.create(
          makePipelineInput(profile.id, {
            steps: [
              {
                id: "step_remote",
                agentProfileId: profile.id,
                remoteEndpointId: "a2a_missing",
                title: "Remote review",
                instruction: "",
                expectedArtifactKinds: ["log"],
              },
            ],
          }),
        ),
      /remoteEndpointId/i,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentPipelineRepository.update preserves id, bumps updatedAt", async () => {
  const { t, db, pipelines, profile } = await setupRepos();
  try {
    const created = await pipelines.create(makePipelineInput(profile.id));
    // ensure timestamp can differ
    await new Promise((r) => setTimeout(r, 5));
    const updated = await pipelines.update({
      ...created,
      name: "Renamed Flow",
    });
    assert.equal(updated.id, created.id);
    assert.equal(updated.name, "Renamed Flow");
    assert.notEqual(updated.updatedAt, created.updatedAt);
    assert.equal(updated.createdAt, created.createdAt);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentPipelineRepository.delete removes the row", async () => {
  const { t, db, pipelines, profile } = await setupRepos();
  try {
    const created = await pipelines.create(makePipelineInput(profile.id));
    await pipelines.delete(created.id);
    assert.equal(await pipelines.get(created.id), null);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("findByReferencedAgentProfileId returns pipelines referencing the profile", async () => {
  const { t, db, pipelines, profiles, profile } = await setupRepos();
  try {
    // 2nd profile to ensure the filter actually filters
    const other = await profiles.create(validProfileInput({ name: "Other" }));

    const pA = await pipelines.create(makePipelineInput(profile.id));
    await pipelines.create(makePipelineInput(other.id, { name: "Other Flow" }));

    const refs = await pipelines.findByReferencedAgentProfileId(profile.id);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].id, pA.id);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("findByReferencedAgentProfileId returns [] when no references", async () => {
  const { t, db, pipelines } = await setupRepos();
  try {
    assert.deepEqual(
      await pipelines.findByReferencedAgentProfileId("agentProfile_nope"),
      [],
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("update also enforces unknown agentProfileId check", async () => {
  const { t, db, pipelines, profile } = await setupRepos();
  try {
    const created = await pipelines.create(makePipelineInput(profile.id));
    await assert.rejects(
      () =>
        pipelines.update({
          ...created,
          steps: [
            {
              ...created.steps[0],
              agentProfileId: "agentProfile_ghost",
            },
          ],
        }),
      /agentProfile/i,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
