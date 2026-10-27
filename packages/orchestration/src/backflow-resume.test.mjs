import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb, LocalStateService } from "../../storage/src/index.ts";
import { ConversationService } from "../../core/src/conversation/conversation-service.ts";
import { OrchestrationPlanner } from "./orchestration-planner.ts";
import { WorkerRunner } from "./worker-runner.ts";

const fixture = async (trigger = "step_failed") => {
  const db = openDb({ filePath: ":memory:" });
  const state = new LocalStateService(db);
  const thread = await state.createThread({ title: "backflow resume", targetDir: "/tmp/project" });
  const task = await state.createTaskRun({ threadId: thread.id, userRequest: "프로젝트를 분석하고 필요한 코드를 수정해줘", targetDir: "/tmp/project", status: "running" });
  const profiles = [];
  for (let i = 0; i < 4; i++) profiles.push(await state.agentProfiles.create({
    name: `Stage${i}`, description: "", category: "test", tags: [], role: "reviewer", provider: "claude",
    persona: "Review the supplied evidence.",
    tuning: { model: "fake", timeoutMs: 1000, stallTimeoutMs: 1000, contextDepth: 5, systemPromptPrefix: "", systemPromptSuffix: "" },
    cli: { cliPathOverride: "", env: {}, envSecretRefs: {} },
    permissions: { autoApproveActions: [], blockedActions: [], allowedSkillIds: [], toolAllowlist: [], toolDenylist: [] },
    mcpServerIds: [], skillSourceIds: [], isDefault: false,
  }));
  const pipeline = await state.agentPipelines.create({ name: "Resume repair", description: "",
    steps: profiles.map((profile, i) => ({ id: `stage-${i}`, agentProfileId: profile.id, title: profile.name,
      instruction: "Review current upstream output.", expectedArtifactKinds: ["log"],
      dependsOn: i ? [`stage-${i - 1}`] : [], allowedActions: ["file_write"] })),
    backflowRules: [{ id: "repair", trigger, targetStepId: "stage-0", retryStepId: "stage-2", maxAttempts: 1 }],
  });
  const drafted = await new OrchestrationPlanner({ state }).draftPlan({ taskRunId: task.id, mode: "multi_worker", pipelineId: pipeline.id });
  const approval = await state.decideApproval(drafted.approval.id, "approved", "test consent");
  const conversation = new ConversationService({ state, pathExists: async () => true });
  return { db, state, task, profiles, plan: drafted.plan, approval, conversation };
};

for (const trigger of ["step_failed", "quality_failed"]) {
  for (const pauseAt of trigger === "step_failed" ? [0, 1, 2] : [0, 1, 2, 3]) {
    test(`${trigger} backflow resumes after stage ${pauseAt} without stale outputs or another attempt`, async () => {
      const f = await fixture(trigger);
      const calls = [];
      let backflow = false;
      let didPause = false;
      const invoker = { async invokeForWorker({ profile }) {
        const stage = f.profiles.findIndex(p => p.id === profile.id);
        calls.push({ stage, backflow });
        if (trigger === "step_failed" && !backflow && stage === 2) { backflow = true; throw new Error("first retry stage failed"); }
        if (backflow && stage === pauseAt && !didPause) {
          didPause = true;
          await f.conversation.pauseTask({ taskRunId: f.task.id });
        }
        return { outputText: `${backflow ? "fresh" : "old"} stage ${stage}` };
      } };
      const run = () => {
        const runner = new WorkerRunner({ state: f.state, agentPlanning: invoker });
        return trigger === "quality_failed" && backflow
          ? runner.runQualityBackflow({ plan: f.plan, reason: "quality failed" })
          : runner.runApproved({ plan: f.plan, approval: f.approval });
      };
      try {
        if (trigger === "quality_failed") { await run(); backflow = true; }
        const paused = await run();
        assert.equal((await f.state.getTaskRun(f.task.id)).status, "paused");
        assert.equal(paused.needsContinuation, true);
        const before = await f.state.pipelineBackflows.listByTaskRun(f.task.id);
        assert.equal(before.length, 1);
        assert.equal(before[0].status, "running", "Pause preserves the current repair attempt");
        assert.equal(before[0].completedAt, undefined);
        await f.conversation.resumeTask({ taskRunId: f.task.id });
        const resumed = await run();
        assert.deepEqual(calls.filter(c => c.backflow).map(c => c.stage), [0, 1, 2, 3], "each fresh stage must run exactly once across a new Runner");
        const attempts = await f.state.pipelineBackflows.listByTaskRun(f.task.id);
        assert.equal(attempts.length, 1, "Resume must not spend a second retry budget");
        assert.equal(attempts[0].id, before[0].id);
        assert.equal(attempts[0].status, "succeeded");
        assert.equal(resumed.needsContinuation, undefined);
        assert.equal((await f.state.getTaskRun(f.task.id)).status, "ready_for_review");
      } finally { closeDb(f.db); }
    });
  }
}

test("backflow waits for its proposed file action before starting the retry path", async () => {
  const f = await fixture();
  const calls = [];
  let repair = false;
  const invoker = { async invokeForWorker({ profile }) {
    const stage = f.profiles.findIndex(p => p.id === profile.id);
    calls.push(stage);
    if (!repair && stage === 2) { repair = true; throw new Error("repair required"); }
    return { outputText: `stage ${stage}`, ...(repair && stage === 0 ? {
      proposedActions: [{ type: "file_write", path: "fixed.txt", after: "fixed content", rationale: "repair" }],
    } : {}) };
  } };
  const run = () => new WorkerRunner({ state: f.state, agentPlanning: invoker }).runApproved({ plan: f.plan, approval: f.approval });
  try {
    const waiting = await run();
    assert.deepEqual(calls, [0, 1, 2, 0], "review/test must wait until the repair action executes");
    assert.equal(waiting.needsContinuation, true);
    assert.equal((await f.state.getTaskRun(f.task.id)).status, "waiting_for_approval");
    const child = (await f.state.listApprovalsByTaskRun(f.task.id)).find(a => a.actionType === "file_write");
    assert.ok(child?.proposedAction);
    await run();
    assert.deepEqual(calls, [0, 1, 2, 0], "a pending child cannot be bypassed by another continuation");
    await f.state.decideApproval(child.id, "approved", "approve repair");
    await f.state.decideApproval(child.id, "executed", "simulated runner completion");
    await run();
    assert.deepEqual(calls, [0, 1, 2, 0, 1, 2, 3]);
    const attempts = await f.state.pipelineBackflows.listByTaskRun(f.task.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, "succeeded");
  } finally { closeDb(f.db); }
});

test("backflow resumes durable worker publication when its following event write failed", async () => {
  const f = await fixture();
  const calls = [];
  let repair = false;
  let crash = true;
  const createEvent = f.state.pipelineBackflows.createEvent.bind(f.state.pipelineBackflows);
  f.state.pipelineBackflows.createEvent = async input => {
    if (input.eventType === "target_succeeded" && crash) { crash = false; throw new Error("event persistence interrupted"); }
    return createEvent(input);
  };
  const run = () => new WorkerRunner({ state: f.state, agentPlanning: { async invokeForWorker({ profile }) {
    const stage = f.profiles.findIndex(p => p.id === profile.id);
    calls.push(stage);
    if (!repair && stage === 2) { repair = true; throw new Error("repair required"); }
    return { outputText: `stage ${stage}` };
  } } }).runApproved({ plan: f.plan, approval: f.approval });
  try {
    await assert.rejects(run(), /event persistence interrupted/);
    const attempt = (await f.state.pipelineBackflows.listByTaskRun(f.task.id))[0];
    assert.equal(attempt.status, "running");
    await run();
    assert.deepEqual(calls, [0, 1, 2, 0, 1, 2, 3], "published target must not be invoked again");
    assert.equal((await f.state.pipelineBackflows.getAttempt(attempt.id)).status, "succeeded");
  } finally { closeDb(f.db); }
});

for (const stop of ["pause", "cancel"]) {
  test(`quality backflow preserves ${stop} that wins immediately before completion storage`, async () => {
    const f = await fixture("quality_failed");
    const calls = [];
    const runner = () => new WorkerRunner({ state: f.state, agentPlanning: { async invokeForWorker({ profile }) {
      calls.push(profile.name);
      return { outputText: "finished" };
    } } });
    let stopBeforeCompletion = true;
    const update = f.state.pipelineBackflows.updateAttempt.bind(f.state.pipelineBackflows);
    f.state.pipelineBackflows.updateAttempt = async (id, patch) => {
      if (patch.status === "succeeded" && stopBeforeCompletion) {
        stopBeforeCompletion = false;
        if (stop === "pause") await f.conversation.pauseTask({ taskRunId: f.task.id });
        else await f.conversation.cancelTask({ taskRunId: f.task.id, reason: "cancel completion" });
      }
      return update(id, patch);
    };
    try {
      const result = await runner().runQualityBackflow({ plan: f.plan, reason: "quality failed" });
      const attempt = (await f.state.pipelineBackflows.listByTaskRun(f.task.id))[0];
      assert.equal((await f.state.getTaskRun(f.task.id)).status, stop === "pause" ? "paused" : "cancelled");
      assert.equal(attempt.status, stop === "pause" ? "running" : "failed");
      assert.equal(calls.length, 4);
      if (stop === "pause") {
        assert.equal(result.needsContinuation, true);
        await f.conversation.resumeTask({ taskRunId: f.task.id });
        await runner().runQualityBackflow({ plan: f.plan, reason: "quality failed" });
        assert.equal(calls.length, 4, "all published outputs survive the completion race");
        assert.equal((await f.state.pipelineBackflows.getAttempt(attempt.id)).status, "succeeded");
        assert.equal((await f.state.getTaskRun(f.task.id)).status, "ready_for_review");
      }
    } finally { closeDb(f.db); }
  });
}

test("Resume cannot bypass a failed backflow budget through normal worker waves", async () => {
  const f = await fixture();
  const calls = [];
  let repair = false;
  let failedRepair = false;
  const run = () => new WorkerRunner({ state: f.state, agentPlanning: { async invokeForWorker({ profile }) {
    const stage = f.profiles.findIndex(p => p.id === profile.id);
    calls.push(stage);
    if (!repair && stage === 2) { repair = true; throw new Error("initial failure"); }
    if (repair && !failedRepair) {
      failedRepair = true;
      await f.conversation.pauseTask({ taskRunId: f.task.id });
      throw new Error("repair failed while paused");
    }
    return { outputText: "must not silently retry a failed repair" };
  } } }).runApproved({ plan: f.plan, approval: f.approval });
  try {
    await run();
    assert.deepEqual(calls, [0, 1, 2, 0]);
    const attempts = await f.state.pipelineBackflows.listByTaskRun(f.task.id);
    assert.equal(attempts[0].status, "failed");
    assert.ok(attempts[0].completedAt);
    await f.conversation.resumeTask({ taskRunId: f.task.id });
    await assert.rejects(run(), error => error.code === "PIPELINE_BACKFLOW_FAILED");
    assert.deepEqual(calls, [0, 1, 2, 0]);
    assert.equal((await f.state.getTaskRun(f.task.id)).status, "blocked");
    assert.equal((await f.state.pipelineBackflows.listByTaskRun(f.task.id)).length, 1);
  } finally { closeDb(f.db); }
});
