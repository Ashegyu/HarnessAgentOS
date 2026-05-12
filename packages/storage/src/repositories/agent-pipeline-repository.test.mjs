import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import { SqliteAgentProfileRepository } from "./agent-profile-repository.ts";
import { SqliteAgentPipelineRepository } from "./agent-pipeline-repository.ts";

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
  const pipelines = new SqliteAgentPipelineRepository(db, profiles);
  const profile = await profiles.create(validProfileInput());
  return { t, db, profiles, pipelines, profile };
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
