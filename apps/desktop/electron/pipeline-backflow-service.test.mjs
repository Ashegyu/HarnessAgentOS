import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, LocalStateService, openDb } from "@harness/storage";
import { PipelineBackflowService } from "./pipeline-backflow-service.ts";

const now = "2026-05-20T00:00:00.000Z";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-pipeline-backflow-service-"));
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
  persona: "You are an excellent worker.",
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

const seedTaskRun = async (state) => {
  const thread = await state.createThread({ title: "pipeline backflow" });
  return state.createTaskRun({
    threadId: thread.id,
    userRequest: "quality backflow",
    targetDir: process.cwd(),
    status: "quality_failed",
  });
};

const qualityResult = (taskRunId, status) => ({
  id: `qg_${status}`,
  taskRunId,
  status,
  knownRisks: [],
  evidenceArtifactIds: [],
  createdAt: now,
});

test("PipelineBackflowService ignores passed and warning quality gates", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const taskRun = await seedTaskRun(state);
    let getLatestPlanCalls = 0;
    const service = new PipelineBackflowService({
      state,
      orchestration: {
        async getLatestPlan() {
          getLatestPlanCalls += 1;
          return null;
        },
      },
    });

    assert.equal(
      await service.runForQualityFailure(qualityResult(taskRun.id, "passed")),
      false,
    );
    assert.equal(
      await service.runForQualityFailure(qualityResult(taskRun.id, "warning")),
      false,
    );
    assert.equal(getLatestPlanCalls, 0);
    assert.equal((await state.getTaskRun(taskRun.id)).status, "quality_failed");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("PipelineBackflowService runs quality_failed backflow and returns ready_for_review", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const taskRun = await seedTaskRun(state);
    const planner = await state.agentProfiles.create(
      validProfileInput({ name: "Planner", role: "planner" }),
    );
    const coder = await state.agentProfiles.create(
      validProfileInput({ name: "Coder", role: "coder" }),
    );
    const tester = await state.agentProfiles.create(
      validProfileInput({ name: "Tester", role: "tester" }),
    );
    const plan = {
      id: "orch_quality_backflow",
      taskRunId: taskRun.id,
      mode: "multi_worker",
      workerSteps: [
        {
          id: "w_plan",
          title: "Plan",
          role: "planner",
          inputSummary: "Plan the repair.",
          instruction: "Plan the repair.",
          expectedArtifactKinds: ["plan"],
          status: "pending",
          agentProfileId: planner.id,
          dependsOn: [],
        },
        {
          id: "w_code",
          title: "Code",
          role: "coder",
          inputSummary: "Apply the repair.",
          instruction: "Apply the repair.",
          expectedArtifactKinds: ["diff"],
          status: "pending",
          agentProfileId: coder.id,
          dependsOn: ["w_plan"],
        },
        {
          id: "w_test",
          title: "Test",
          role: "tester",
          inputSummary: "Verify the repair.",
          instruction: "Verify the repair.",
          expectedArtifactKinds: ["test_result"],
          status: "pending",
          agentProfileId: tester.id,
          dependsOn: ["w_code"],
        },
      ],
      requiresApproval: true,
      backflowRules: [
        {
          id: "bf_quality",
          trigger: "quality_failed",
          targetStepId: "w_plan",
          retryStepId: "w_code",
          maxAttempts: 2,
        },
      ],
    };
    const calls = [];
    const service = new PipelineBackflowService({
      state,
      orchestration: {
        async getLatestPlan(input) {
          assert.equal(input.taskRunId, taskRun.id);
          return plan;
        },
      },
      agentPlanning: {
        async invokeForWorker(input) {
          calls.push(input.profile.name);
          return { outputText: `${input.profile.name} output` };
        },
      },
    });

    assert.equal(
      await service.runForQualityFailure(qualityResult(taskRun.id, "failed")),
      true,
    );

    assert.deepEqual(calls, ["Planner", "Coder", "Tester"]);
    assert.equal((await state.getTaskRun(taskRun.id)).status, "ready_for_review");
    const attempts = await state.pipelineBackflows.listByTaskRun(taskRun.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].trigger, "quality_failed");
    assert.equal(attempts[0].status, "succeeded");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
