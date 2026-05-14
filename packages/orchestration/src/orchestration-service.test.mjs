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
import { OrchestrationService } from "./orchestration-service.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-orch-"));
  return {
    dir,
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
    userRequest: "do something orchestrated",
    targetDir: "/tmp/proj",
    status: "running",
  });
};

test("draftPlan refuses when feature flag is off", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const service = new OrchestrationService({ state, enabled: () => false });
    await assert.rejects(
      () =>
        service.draftPlan({ taskRunId: taskRun.id, mode: "single_worker" }),
      (e) => e.code === "ORCHESTRATION_DISABLED",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("draftPlan creates artifact + checkpoint + approval (orchestration_plan)", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const service = new OrchestrationService({ state, enabled: () => true });
    const drafted = await service.draftPlan({
      taskRunId: taskRun.id,
      mode: "planner_worker",
    });
    assert.equal(drafted.plan.mode, "planner_worker");
    assert.ok(drafted.plan.workerSteps.length >= 2);
    assert.equal(drafted.artifact.kind, "orchestration_plan");
    assert.equal(drafted.approval.actionType, "orchestration_plan");
    assert.equal(drafted.approval.status, "pending");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved refuses when approval is not approved", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const service = new OrchestrationService({ state, enabled: () => true });
    const drafted = await service.draftPlan({
      taskRunId: taskRun.id,
      mode: "single_worker",
    });
    await assert.rejects(
      () => service.runApproved({ approvalId: drafted.approval.id }),
      (e) => e.code === "ORCHESTRATION_APPROVAL_REQUIRED",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved produces worker artifacts after approval", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const service = new OrchestrationService({ state, enabled: () => true });
    const drafted = await service.draftPlan({
      taskRunId: taskRun.id,
      mode: "single_worker",
    });
    await state.decideApproval(drafted.approval.id, "approved");
    const result = await service.runApproved({
      approvalId: drafted.approval.id,
    });
    assert.equal(result.taskRunId, taskRun.id);
    assert.equal(result.workerSteps.length, 1);
    assert.equal(result.workerSteps[0].status, "succeeded");
    assert.equal(result.workerStepArtifactIds.length, 1);

    const artifacts = await state.listArtifactsByTaskRun(taskRun.id);
    const workerLogs = artifacts.filter((a) => a.kind === "log");
    assert.equal(workerLogs.length, 1);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("enabled getter is evaluated per call (live flag changes)", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    let flagValue = false;
    const service = new OrchestrationService({ state, enabled: () => flagValue });
    const taskRun = await seedTaskRun(state);
    await assert.rejects(
      () => service.draftPlan({ taskRunId: taskRun.id, mode: "single_worker" }),
      (e) => e.code === "ORCHESTRATION_DISABLED",
    );
    flagValue = true;
    const drafted = await service.draftPlan({ taskRunId: taskRun.id, mode: "single_worker" });
    assert.ok(drafted.plan.id);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("getLatestPlan recovers plan JSON from artifact summary", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const service = new OrchestrationService({ state, enabled: () => true });
    const drafted = await service.draftPlan({
      taskRunId: taskRun.id,
      mode: "multi_worker",
    });
    const recovered = await service.getLatestPlan({ taskRunId: taskRun.id });
    assert.ok(recovered);
    assert.equal(recovered.id, drafted.plan.id);
    assert.equal(recovered.mode, "multi_worker");
    assert.equal(
      recovered.workerSteps.length,
      drafted.plan.workerSteps.length,
    );
    // Legacy mode plans have no pipeline source — the recovered field
    // must remain absent so the renderer's `isPipelineDriven` stays
    // false for them.
    assert.equal(recovered.sourcePipelineId, undefined);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

// Regression: prior to this commit `parseEmbeddedPlanJson` dropped
// `sourcePipelineId` when reading the artifact summary back, so
// `getLatestPlan` and `recoverPlan` both returned plans without the
// marker. The renderer's OrchestrationPanel then re-showed the manual
// draft form / "Worker 실행" button for pipeline-driven runs because
// `isPipelineDriven` was always false.
test(
  "getLatestPlan preserves sourcePipelineId for pipeline-driven plans",
  async () => {
    const t = tmp();
    const db = openDb({ filePath: t.file });
    const state = new LocalStateService(db);
    try {
      const taskRun = await seedTaskRun(state);
      const profile = await state.agentProfiles.create({
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
      });
      const pipeline = await state.agentPipelines.create({
        name: "Code only",
        description: "",
        steps: [
          {
            id: "s1",
            agentProfileId: profile.id,
            title: "Implement",
            instruction: "Do the thing.",
            expectedArtifactKinds: ["plan"],
          },
        ],
      });
      const service = new OrchestrationService({ state, enabled: () => true });
      await service.draftPlan({
        taskRunId: taskRun.id,
        mode: "single_worker",
        pipelineId: pipeline.id,
      });
      const recovered = await service.getLatestPlan({ taskRunId: taskRun.id });
      assert.ok(recovered);
      assert.equal(recovered.sourcePipelineId, pipeline.id);
    } finally {
      closeDb(db);
      t.cleanup();
    }
  },
);
