import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDb,
  closeDb,
  SqliteAgentProfileRepository,
  SqliteAgentPipelineRepository,
} from "@harness/storage";
import { buildPipelineHandlers } from "./pipeline-ipc.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-pipe-ipc-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const validProfileInput = (overrides = {}) => ({
  name: "Worker",
  description: "",
  category: "test",
  tags: ["coder"],
  provider: "codex",
  role: "coder",
  persona: "",
  tuning: {
    model: "gpt-5.6-sol",
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

const setup = async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const profiles = new SqliteAgentProfileRepository(db);
  const pipelines = new SqliteAgentPipelineRepository(db, profiles);
  const profile = await profiles.create(validProfileInput());
  const handlers = buildPipelineHandlers({ pipelines });
  return { t, db, profiles, pipelines, profile, handlers };
};

const validPipelineInput = (profileId, overrides = {}) => ({
  name: "Build → Review",
  description: "",
  steps: [
    {
      id: "s1",
      agentProfileId: profileId,
      title: "Plan",
      instruction: "Outline the change.",
      expectedArtifactKinds: ["plan"],
    },
  ],
  ...overrides,
});

test("pipeline.list returns ok-wrapped empty array on empty DB", async () => {
  const { t, db, handlers } = await setup();
  try {
    const result = await handlers.list();
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, []);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("pipeline.create persists and returns the new pipeline", async () => {
  const { t, db, handlers, profile } = await setup();
  try {
    const r = await handlers.create({
      pipeline: validPipelineInput(profile.id),
    });
    assert.equal(r.ok, true);
    assert.ok(r.value.id.startsWith("pipe_"));
    const listed = (await handlers.list()).value;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, r.value.id);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("pipeline.create rejects empty steps", async () => {
  const { t, db, handlers, profile } = await setup();
  try {
    const r = await handlers.create({
      pipeline: validPipelineInput(profile.id, { steps: [] }),
    });
    assert.equal(r.ok, false);
    assert.match(r.error.message, /steps/i);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("pipeline.create rejects unknown agentProfileId", async () => {
  const { t, db, handlers } = await setup();
  try {
    const r = await handlers.create({
      pipeline: {
        name: "Bad",
        description: "",
        steps: [
          {
            id: "s1",
            agentProfileId: "ap_does_not_exist",
            title: "Plan",
            instruction: "",
            expectedArtifactKinds: ["plan"],
          },
        ],
      },
    });
    assert.equal(r.ok, false);
    assert.match(r.error.message, /agentProfile/i);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("pipeline.get returns PIPELINE_NOT_FOUND for unknown id", async () => {
  const { t, db, handlers } = await setup();
  try {
    const r = await handlers.get({ pipelineId: "pipe_nope" });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "PIPELINE_NOT_FOUND");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("pipeline.update edits an existing pipeline", async () => {
  const { t, db, handlers, profile } = await setup();
  try {
    const created = (
      await handlers.create({ pipeline: validPipelineInput(profile.id) })
    ).value;
    const r = await handlers.update({
      pipeline: { ...created, name: "Renamed" },
    });
    assert.equal(r.ok, true);
    assert.equal(r.value.name, "Renamed");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("pipeline.update rejects unknown id", async () => {
  const { t, db, handlers, profile } = await setup();
  try {
    const created = (
      await handlers.create({ pipeline: validPipelineInput(profile.id) })
    ).value;
    const r = await handlers.update({
      pipeline: { ...created, id: "pipe_ghost" },
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "PIPELINE_NOT_FOUND");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("pipeline.delete removes the row", async () => {
  const { t, db, handlers, profile } = await setup();
  try {
    const created = (
      await handlers.create({ pipeline: validPipelineInput(profile.id) })
    ).value;
    const r = await handlers.delete({ pipelineId: created.id });
    assert.equal(r.ok, true);
    const g = await handlers.get({ pipelineId: created.id });
    assert.equal(g.ok, false);
    assert.equal(g.error.code, "PIPELINE_NOT_FOUND");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
