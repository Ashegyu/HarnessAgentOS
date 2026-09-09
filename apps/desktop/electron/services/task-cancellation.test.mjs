import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelTaskAndExecutions } from "./task-cancellation.ts";

test("task cancellation persists first, stops both owners and waits for runner cleanup", async () => {
  const calls = [];
  let release;
  let done = false;
  const task = { id: "task", status: "cancelled" };
  const result = cancelTaskAndExecutions({ taskRunId: "task", reason: "stop" }, {
    conversation: { cancelTask: async () => { calls.push("persist"); return task; } },
    agentPlanning: { cancelTaskInvocations: async () => { calls.push("agent"); } },
    runner: { cancelExecution: async () => { calls.push("runner"); await new Promise(resolve => { release = resolve; }); } },
    changed: () => calls.push("changed"),
  }).then(value => { done = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["persist", "agent", "runner"]);
  assert.equal(done, false);
  release();
  assert.equal(await result, task);
  assert.equal(calls.at(-1), "changed");
});

test("agent cancellation failure still stops runner and refreshes cancelled state", async () => {
  const calls = [];
  await assert.rejects(cancelTaskAndExecutions({ taskRunId: "task", reason: "stop" }, {
    conversation: { cancelTask: async () => ({ id: "task", status: "cancelled" }) },
    agentPlanning: { cancelTaskInvocations: () => { throw new Error("agent failed"); } },
    runner: { cancelExecution: async () => { calls.push("runner"); } },
    changed: () => calls.push("changed"),
  }), /agent failed/);
  assert.deepEqual(calls, ["runner", "changed"]);
});
