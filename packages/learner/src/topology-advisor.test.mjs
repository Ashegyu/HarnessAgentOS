import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDb,
  LocalStateService,
  openDb,
} from "../../../packages/storage/src/index.ts";
import { TopologyAdvisor } from "./topology-advisor.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-topology-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const profileInput = (role, name = role) => ({
  name,
  description: "",
  category: "test",
  tags: [role],
  provider: "codex",
  role,
  persona: "",
  tuning: {
    model: "gpt-5.5",
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
  isDefault: role === "planner",
});

const skillMeta = (id, overrides = {}) => ({
  id,
  name: id,
  description: "",
  sourceDir: "/tmp/skill",
  trusted: true,
  riskLevel: "low",
  allowedActions: [],
  requiredApprovals: [],
  triggerTerms: [],
  tags: [],
  platforms: ["any"],
  inputs: [],
  outputs: [],
  relatedSkills: [],
  projectScopes: [],
  resources: {
    scripts: [],
    templates: [],
    examples: [],
    references: [],
  },
  ...overrides,
});

const seedTaskRun = async (
  state,
  request = "plan implement code and test verification",
) => {
  const thread = await state.createThread({
    title: "t",
    targetDir: "/tmp/proj",
  });
  return state.createTaskRun({
    threadId: thread.id,
    userRequest: request,
    targetDir: "/tmp/proj",
    status: "drafting",
  });
};

const setup = async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  return { t, db, state };
};

test("recommend creates an explicit pipeline draft from capability metadata", async () => {
  const { t, db, state } = await setup();
  try {
    const profiles = {};
    for (const role of ["planner", "coder", "tester", "reviewer"]) {
      profiles[role] = await state.agentProfiles.create(profileInput(role));
    }
    const taskRun = await seedTaskRun(state);
    await state.upsertCapability({
      id: "cap_code",
      source: "skillify:test",
      name: "Code patch",
      description: "Implement code changes",
      triggerTerms: ["implement", "code"],
      riskLevel: "low",
      requiresApproval: true,
    });
    await state.upsertCapability({
      id: "cap_test",
      source: "skillify:test",
      name: "Test runner",
      description: "Run verification tests",
      triggerTerms: ["test", "verification"],
      riskLevel: "low",
      requiresApproval: true,
    });
    const traceTask = await seedTaskRun(state, "implement previous code");
    const trace = await state.createLearningTrace({ taskRunId: traceTask.id });
    await state.updateLearningTrace(trace.id, {
      selectedCapabilities: ["cap_code"],
      reward: 0.8,
      success: true,
    });
    const metadata = new Map([
      [
        "cap_code",
        skillMeta("cap_code", {
          allowedActions: ["file_write"],
          tags: ["code"],
        }),
      ],
      [
        "cap_test",
        skillMeta("cap_test", {
          allowedActions: ["shell"],
          tags: ["test"],
        }),
      ],
    ]);

    const advisor = new TopologyAdvisor({
      state,
      metadataForCapability: (id) => metadata.get(id),
    });
    const recommendations = await advisor.recommend({
      taskRunId: taskRun.id,
      maxCandidates: 3,
    });

    assert.equal(recommendations.length, 1);
    const rec = recommendations[0];
    assert.equal(rec.taskRunId, taskRun.id);
    assert.ok(rec.pipelineDraft.name.startsWith("Recommended:"));
    assert.ok(rec.source.capabilityIds.includes("cap_code"));
    assert.ok(rec.source.capabilityIds.includes("cap_test"));
    assert.ok(rec.source.traceIds.includes(trace.id));
    assert.ok(rec.confidence > 0.45);

    const steps = rec.pipelineDraft.steps;
    assert.ok(steps.length >= 3);
    assert.deepEqual(steps[0].dependsOn, []);
    assert.ok(steps.every((step) => Array.isArray(step.allowedActions)));
    assert.ok(steps.some((step) => step.allowedActions.includes("file_write")));
    assert.ok(steps.some((step) => step.allowedActions.includes("shell")));
    assert.ok(steps.every((step) => typeof step.outputContract === "string"));
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("recommend skips untrusted capability metadata and warns", async () => {
  const { t, db, state } = await setup();
  try {
    await state.agentProfiles.create(profileInput("planner"));
    await state.agentProfiles.create(profileInput("coder"));
    const taskRun = await seedTaskRun(state, "implement code");
    await state.upsertCapability({
      id: "cap_untrusted",
      source: "skillify:test",
      name: "Untrusted patcher",
      description: "Implement code",
      triggerTerms: ["implement", "code"],
      riskLevel: "high",
      requiresApproval: true,
    });
    const advisor = new TopologyAdvisor({
      state,
      metadataForCapability: (id) =>
        id === "cap_untrusted"
          ? skillMeta(id, { trusted: false })
          : undefined,
    });

    const [rec] = await advisor.recommend({ taskRunId: taskRun.id });
    assert.ok(rec);
    assert.ok(!rec.source.capabilityIds.includes("cap_untrusted"));
    assert.match(rec.warnings.join("\n"), /untrusted/i);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("recommend reports missing role profiles without fabricating steps", async () => {
  const { t, db, state } = await setup();
  try {
    const planner = await state.agentProfiles.create(profileInput("planner"));
    const taskRun = await seedTaskRun(state, "plan implement code");
    await state.upsertCapability({
      id: "cap_code",
      source: "skillify:test",
      name: "Code patch",
      description: "Implement code",
      triggerTerms: ["implement", "code"],
      riskLevel: "low",
      requiresApproval: true,
    });
    const advisor = new TopologyAdvisor({
      state,
      metadataForCapability: (id) =>
        id === "cap_code"
          ? skillMeta(id, { allowedActions: ["file_write"], tags: ["code"] })
          : undefined,
    });

    const [rec] = await advisor.recommend({ taskRunId: taskRun.id });
    assert.ok(rec);
    assert.equal(rec.pipelineDraft.steps.length, 1);
    assert.equal(rec.pipelineDraft.steps[0].agentProfileId, planner.id);
    assert.match(rec.warnings.join("\n"), /coder/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("recommend uses active global instincts as topology signals", async () => {
  const { t, db, state } = await setup();
  try {
    await state.agentProfiles.create(profileInput("planner"));
    await state.agentProfiles.create(profileInput("coder"));
    await state.agentProfiles.create(profileInput("tester"));
    const taskRun = await seedTaskRun(state, "implement code");
    const instinct = await state.createInstinct({
      scope: "global",
      title: "Run focused tests",
      rule: "Add a tester step when implementation work is requested.",
      rationale: "Past implementation changes failed without verification.",
      confidence: 0.8,
      sourceObservationIds: [],
      tags: ["test"],
    });
    const advisor = new TopologyAdvisor({ state });

    const [rec] = await advisor.recommend({ taskRunId: taskRun.id });
    assert.ok(rec);
    assert.ok(rec.source.instinctIds.includes(instinct.id));
    assert.ok(
      rec.pipelineDraft.steps.some(
        (step) => step.outputContract === "test_result",
      ),
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("recommend maps specialized review prompts to expanded roles", async () => {
  const { t, db, state } = await setup();
  try {
    for (const role of [
      "planner",
      "coder",
      "security-reviewer",
      "performance-reviewer",
      "reviewer",
    ]) {
      await state.agentProfiles.create(profileInput(role));
    }
    const taskRun = await seedTaskRun(
      state,
      "security and performance review for approval bypass and latency risk",
    );
    const advisor = new TopologyAdvisor({ state });

    const [rec] = await advisor.recommend({ taskRunId: taskRun.id });
    assert.ok(rec);
    const stepIds = rec.pipelineDraft.steps.map((step) => step.id);
    assert.ok(
      rec.pipelineDraft.steps.some(
        (step) => step.outputContract === "review" && step.allowedActions.length === 0,
      ),
    );
    assert.ok(
      rec.pipelineDraft.steps.some((step) =>
        step.id.includes("security-reviewer"),
      ),
      `expected security-reviewer step in ${stepIds.join(", ")}`,
    );
    assert.ok(
      rec.pipelineDraft.steps.some((step) =>
        step.id.includes("performance-reviewer"),
      ),
      `expected performance-reviewer step in ${stepIds.join(", ")}`,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("recordFeedback stores topology feedback as learner observation", async () => {
  const { t, db, state } = await setup();
  try {
    const taskRun = await seedTaskRun(state, "implement code");
    const advisor = new TopologyAdvisor({ state });

    await advisor.recordFeedback({
      taskRunId: taskRun.id,
      recommendationId: "toprec_1",
      decision: "applied",
      reason: "accepted api_key=secret-value",
    });

    const observations = await state.listObservations({
      taskRunId: taskRun.id,
    });
    assert.equal(observations.length, 1);
    assert.equal(observations[0].source, "learner");
    assert.equal(observations[0].eventType, "topology_applied");
    assert.equal(observations[0].signal, "applied");
    assert.equal(observations[0].payload.recommendationId, "toprec_1");
    assert.match(observations[0].payload.reason, /\[REDACTED\]/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
