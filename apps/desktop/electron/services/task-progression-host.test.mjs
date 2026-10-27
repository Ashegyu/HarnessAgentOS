import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTaskContract } from "@harness/core";
import { openDb, closeDb, LocalStateService } from "@harness/storage";
import { createTaskProgressionHost } from "./task-progression-host.ts";

for (const valid of [true, false]) {
  test(`pipeline consent reads the persisted markdown+JSON plan, not raw JSON (valid=${valid})`, async () => {
    const calls = [];
    const row = { id: "a", taskRunId: "task", actionType: "orchestration_plan", status: "pending", actionRevision: 1,
      policyEvaluation: { decision: "confirm", riskLevel: "high", allowAutoApprove: false } };
    const state = {
      getTaskRun: async () => ({ id: "task", status: "drafting", userRequest: "세 작업을 실행해줘" }),
      getSettings: async () => ({ approval: { autoApprove: false, autoExecuteWorkerFileActions: false } }),
      approvals: { listByTaskRun: async () => [structuredClone(row)] },
      listStepsByTaskRun: async () => [], listCheckpointsByTaskRun: async () => [],
      listAgentInvocationsByTaskRun: async () => [], agentProfiles: { list: async () => [] },
      aggregateAgentInvocationCostByProfileAndDay: async () => [],
      listArtifactsByTaskRun: async () => [{ kind: "orchestration_plan", taskRunId: "task",
        uri: valid ? "harness:orchestration/task/plan" : "agent:untrusted/plan",
        summary: '# Plan\n\n<!-- orchestration-plan:json -->\n```json\n{"id":"plan","mode":"multi_worker","workerSteps":[],"sourcePipelineId":"pipeline"}\n```\n' }],
    };
    const service = createTaskProgressionHost({ state,
      conversation: { approve: async () => { calls.push("approve"); row.status = "approved"; row.approvedRevision = 1; } },
      execute: async () => { calls.push("execute"); row.status = "executed"; }, evaluateQuality: async () => {}, changed: () => {},
    });
    await service.advance("task");
    assert.deepEqual(calls, valid ? ["approve", "execute"] : []);
  });
}

test("default profile restrictions apply even without an explicit active profile setting", async () => {
  const calls = [];
  const row = { id: "a", taskRunId: "task", actionType: "file_write", status: "pending", actionRevision: 1,
    proposedAction: { type: "file_write", filePatch: { path: "x.txt", after: "x" } } };
  const state = {
    getTaskRun: async () => ({ id: "task", status: "waiting_for_approval", userRequest: "파일을 생성해줘",
      contract: buildTaskContract({ userRequest: "파일을 생성해줘" }) }),
    getSettings: async () => ({ approval: { autoApprove: true, autoExecuteWorkerFileActions: true } }),
    approvals: { listByTaskRun: async (_id, order) => { assert.equal(order, "execution"); return [row]; } },
    listStepsByTaskRun: async () => [], listCheckpointsByTaskRun: async () => [],
    listArtifactsByTaskRun: async () => [], listAgentInvocationsByTaskRun: async () => [],
    agentProfiles: { list: async () => [{ id: "default", isDefault: true, permissions: { blockedActions: ["file_write"], autoApproveActions: [] } }] },
    aggregateAgentInvocationCostByProfileAndDay: async () => [],
    createStep: async () => ({ id: "failure" }), setStepStatus: async () => {},
    createArtifact: async () => {}, taskRuns: { updateStatus: async () => {} },
  };
  const service = createTaskProgressionHost({ state, conversation: { approve: async () => { calls.push("approve"); throw new Error("must not approve"); } },
    execute: async () => calls.push("execute"), evaluateQuality: async () => calls.push("QA"), changed: () => {} });
  await service.advance("task");
  assert.deepEqual(calls, []);
});

test("progression errors persist a redacted failure step/log and never resurrect cancelled work", async () => {
  let status = "waiting_for_approval";
  const writes = [];
  const state = {
    getTaskRun: async () => ({ id: "task", status }),
    listStepsByTaskRun: async () => [{ index: 4 }],
    createStep: async input => { writes.push(["step", input]); return { id: "failed-step" }; },
    setStepStatus: async (id, next, options) => writes.push(["step-status", next, options.outputSummary]),
    createArtifact: async input => writes.push(["artifact", input]),
    taskRuns: { updateStatus: async (_id, next, expected) => {
      assert.equal(status, expected);
      status = next;
    } },
  };
  const service = createTaskProgressionHost({ state, conversation: {}, execute: async () => {}, evaluateQuality: async () => {}, changed: () => {} });
  await service.fail("task", new Error("prep failed with sk-test-only and Bearer example-token"));
  assert.equal(status, "blocked");
  assert.equal(writes[0][1].index, 5);
  assert.equal(writes[1][1], "failed");
  assert.match(writes[2][1].uri, /^harness:progression-error\/task\//);
  assert.doesNotMatch(writes[2][1].summary, /sk-test-only|example-token/);
  status = "cancelled";
  await service.fail("task", new Error("late failure"));
  assert.equal(writes.length, 3);
  assert.equal(status, "cancelled");
});

for (const stoppedStatus of ["paused", "cancelled"]) {
  test(`progression failure preserves ${stoppedStatus} recorded while its diagnostic is being saved`, async () => {
    const db = openDb({ filePath: ":memory:" });
    try {
      const state = new LocalStateService(db);
      const thread = await state.createThread({ title: "late progression error" });
      const task = await state.createTaskRun({ threadId: thread.id,
        targetDir: process.cwd(), userRequest: "run the pipeline" });
      await state.setTaskRunStatus(task.id, "running");
      const createArtifact = state.createArtifact.bind(state);
      state.createArtifact = async input => {
        const artifact = await createArtifact(input);
        await state.setTaskRunStatus(task.id, stoppedStatus);
        return artifact;
      };
      const changed = [];
      const service = createTaskProgressionHost({ state, conversation: {},
        execute: async () => {}, evaluateQuality: async () => {},
        changed: id => changed.push(id) });

      await service.fail(task.id, new Error("worker failed while pausing"));

      assert.equal((await state.getTaskRun(task.id)).status, stoppedStatus);
      assert.equal((await state.listStepsByTaskRun(task.id)).at(-1).status, "failed");
      assert.match((await state.listArtifactsByTaskRun(task.id)).at(-1).summary,
        /worker failed while pausing/);
      assert.deepEqual(changed, [task.id]);
    } finally {
      closeDb(db);
    }
  });
}
