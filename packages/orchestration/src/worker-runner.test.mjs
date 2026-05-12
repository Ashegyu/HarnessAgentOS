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
import { WorkerRunner } from "./worker-runner.ts";
import { OrchestrationPlanner } from "./orchestration-planner.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-wr-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const seedTaskRun = async (state) => {
  const thread = await state.createThread({ title: "t", targetDir: "/tmp/proj" });
  return state.createTaskRun({
    threadId: thread.id,
    userRequest: "do",
    targetDir: "/tmp/proj",
    status: "running",
  });
};

const validProfileInput = (overrides = {}) => ({
  name: "Coder",
  description: "",
  provider: "claude",
  role: "coder",
  persona: "You are an excellent coder.",
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

const approvePlanApproval = async (state, approval) =>
  state.decideApproval(approval.id, "approved", "ok");

test("runApproved still works for legacy mode-based plans (regression)", async () => {
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
    const approved = await approvePlanApproval(state, drafted.approval);
    const runner = new WorkerRunner({ state });
    const result = await runner.runApproved({
      approval: approved,
      plan: drafted.plan,
    });
    assert.equal(result.workerSteps.length, 1);
    assert.equal(result.workerSteps[0].status, "succeeded");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved annotates worker artifact with agentProfileId when present", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const profile = await state.agentProfiles.create(
      validProfileInput({ name: "SpecialCoder", persona: "Be terse." }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Solo",
      description: "",
      steps: [
        {
          id: "s1",
          agentProfileId: profile.id,
          title: "Implement",
          instruction: "Do the thing.",
          expectedArtifactKinds: ["plan", "log"],
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "single_worker",
      pipelineId: pipeline.id,
    });
    const approved = await approvePlanApproval(state, drafted.approval);
    const runner = new WorkerRunner({ state });
    const result = await runner.runApproved({
      approval: approved,
      plan: drafted.plan,
    });
    assert.equal(result.workerSteps.length, 1);
    assert.equal(result.workerSteps[0].agentProfileId, profile.id);
    // Artifact summary should reference the profile name so the user
    // can see which profile produced the output in the Artifacts tab.
    const artifacts = await state.listArtifactsByTaskRun(taskRun.id);
    const workerArtifact = artifacts.find(
      (a) => a.kind === "log" && a.title.startsWith("Worker output"),
    );
    assert.ok(workerArtifact, "worker artifact must exist");
    assert.match(workerArtifact.summary, /SpecialCoder/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved fails-fast when a step's profile was deleted between draft and run", async () => {
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
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "single_worker",
      pipelineId: pipeline.id,
    });
    const approved = await approvePlanApproval(state, drafted.approval);
    // Race: profile removed between approval and run
    await state.agentProfiles.delete(profile.id);
    const runner = new WorkerRunner({ state });
    await assert.rejects(
      () => runner.runApproved({ approval: approved, plan: drafted.plan }),
      (e) => e.code === "PIPELINE_REFERENCED_PROFILE_MISSING",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
