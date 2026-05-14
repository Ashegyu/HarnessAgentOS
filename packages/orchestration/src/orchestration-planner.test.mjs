import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDb,
  closeDb,
  LocalStateService,
} from "../../../packages/storage/src/index.ts";
import { OrchestrationPlanner } from "./orchestration-planner.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-orch-planner-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const seedTaskRun = async (state) => {
  const thread = await state.createThread({
    title: "t",
    targetDir: "/tmp/proj",
  });
  return state.createTaskRun({
    threadId: thread.id,
    userRequest: "ship feature X",
    targetDir: "/tmp/proj",
    status: "running",
  });
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

test("draftPlan with mode falls back to hardcoded synthesizer (regression)", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "single_worker",
    });
    assert.equal(drafted.plan.workerSteps.length, 1);
    assert.equal(drafted.plan.workerSteps[0].role, "coder");
    assert.equal(drafted.plan.sourcePipelineId, undefined);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("draftPlan with pipelineId synthesizes steps from the pipeline", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const profile = await state.agentProfiles.create(validProfileInput());
    const reviewer = await state.agentProfiles.create(
      validProfileInput({ name: "Reviewer", role: "reviewer" }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Code → Review",
      description: "",
      steps: [
        {
          id: "s1",
          agentProfileId: profile.id,
          title: "Implement feature",
          instruction: "Write the change.",
          expectedArtifactKinds: ["plan", "diff"],
        },
        {
          id: "s2",
          agentProfileId: reviewer.id,
          title: "Review",
          instruction: "Check for risks.",
          expectedArtifactKinds: ["quality_report"],
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "single_worker", // mode is ignored when pipelineId is provided
      pipelineId: pipeline.id,
    });
    assert.equal(drafted.plan.workerSteps.length, 2);
    assert.equal(drafted.plan.workerSteps[0].agentProfileId, profile.id);
    assert.equal(drafted.plan.workerSteps[0].role, "coder");
    assert.equal(drafted.plan.workerSteps[0].title, "Implement feature");
    assert.equal(drafted.plan.workerSteps[1].agentProfileId, reviewer.id);
    assert.equal(drafted.plan.workerSteps[1].role, "reviewer");
    assert.equal(drafted.plan.sourcePipelineId, pipeline.id);
    // v12 / Phase 2 — pipeline step.instruction must round-trip into
    // WorkerStep.instruction in full (no truncation). The inputSummary
    // remains the 120-char display slice.
    assert.equal(
      drafted.plan.workerSteps[0].instruction,
      "Write the change.",
    );
    assert.equal(
      drafted.plan.workerSteps[1].instruction,
      "Check for risks.",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("draftPlan throws PIPELINE_NOT_FOUND for unknown pipelineId", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const planner = new OrchestrationPlanner({ state });
    await assert.rejects(
      () =>
        planner.draftPlan({
          taskRunId: taskRun.id,
          mode: "single_worker",
          pipelineId: "pipe_ghost",
        }),
      (e) => e.code === "PIPELINE_NOT_FOUND",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("draftPlan throws PIPELINE_REFERENCED_PROFILE_MISSING when a step's profile was deleted", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const profile = await state.agentProfiles.create(validProfileInput());
    const pipeline = await state.agentPipelines.create({
      name: "P",
      description: "",
      steps: [
        {
          id: "s1",
          agentProfileId: profile.id,
          title: "Plan",
          instruction: "",
          expectedArtifactKinds: ["plan"],
        },
      ],
    });
    // Force-delete the profile from under the pipeline (bypassing the
    // IPC delete-protection) to simulate a stale reference, then ensure
    // the planner fail-fasts at run time.
    await state.agentProfiles.delete(profile.id);
    const planner = new OrchestrationPlanner({ state });
    await assert.rejects(
      () =>
        planner.draftPlan({
          taskRunId: taskRun.id,
          mode: "single_worker",
          pipelineId: pipeline.id,
        }),
      (e) => e.code === "PIPELINE_REFERENCED_PROFILE_MISSING",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
