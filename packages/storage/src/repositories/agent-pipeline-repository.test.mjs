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
      "Architecture RFC",
      "Build Recovery",
      "Frontend Product Delivery",
      "Image Asset Prompt Flow",
      "New Project Delivery",
      "Parallel Review Hardening",
      "Product PRD Discovery",
      "Refactor Safety",
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
    assert.equal(all.length, 11);
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
