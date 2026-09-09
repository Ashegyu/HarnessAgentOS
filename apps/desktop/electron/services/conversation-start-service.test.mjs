import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTaskContract } from "@harness/core";
import { ConversationStartService, parseStartTaskInput } from "./conversation-start-service.ts";

const fixture = (request = "보고서를 저장해줘") => {
  const calls = [];
  const taskRun = { id: "task", status: "drafting", userRequest: request,
    contract: buildTaskContract({ userRequest: request }) };
  const deps = {
    createTask: async input => { calls.push(["create", input]); return { taskRun }; },
    hold: id => { calls.push(["hold", id]); return () => calls.push(["release", id]); },
    getTaskRun: async () => taskRun,
    proposeCapabilities: async id => calls.push(["capability", id]),
    proposeRecommendation: async id => calls.push(["learner", id]),
    draftOrchestration: async input => calls.push(["orchestrate", input]),
    markPlanningReady: async id => calls.push(["ready", id]),
    changed: id => calls.push(["changed", id]),
    fail: async (id, error) => { calls.push(["failure", error.message]); taskRun.status = "blocked"; },
    onError: () => {},
  };
  return { calls, taskRun, deps, service: new ConversationStartService(deps) };
};

test("one submission returns the draft while main prepares; release follows both recommendations", async () => {
  const f = fixture();
  let releaseCandidate;
  f.deps.proposeCapabilities = async () => {
    f.calls.push(["capability"]);
    await new Promise(resolve => { releaseCandidate = resolve; });
  };
  const draft = await f.service.start({ userRequest: f.taskRun.userRequest });
  assert.equal(draft.taskRun.id, "task");
  assert.equal(f.calls.some(c => c[0] === "release"), false);
  releaseCandidate();
  await f.service.waitForPreparation("task");
  assert.deepEqual(f.calls.map(c => c[0]), ["create", "hold", "changed", "capability", "learner", "ready", "release", "changed"]);
  assert.equal(f.calls[0][1].mode, "agent");
});

test("a pipeline is drafted once without also starting ordinary AI preparation", async () => {
  const f = fixture();
  await f.service.start({ userRequest: f.taskRun.userRequest, orchPipelineId: "pipeline" });
  await f.service.waitForPreparation("task");
  assert.deepEqual(f.calls.filter(c => ["orchestrate", "ready", "capability", "learner"].includes(c[0])), [
    ["orchestrate", { taskRunId: "task", mode: "single_worker", pipelineId: "pipeline" }],
  ]);
});

test("a read-only contract rejects a selected write harness without silently rerouting", async () => {
  const f = fixture("코드 리뷰만 해줘. 파일을 저장하지 마.");
  await assert.rejects(f.service.start({ userRequest: f.taskRun.userRequest,
    orchHarness: { packageId: "package", bindingSetId: "bindings" } }), /읽기 전용/);
  assert.deepEqual(f.calls, []);
});

test("optional recommendation failure does not suppress planning", async () => {
  const f = fixture();
  f.deps.proposeCapabilities = async () => { throw new Error("optional"); };
  await f.service.start({ userRequest: f.taskRun.userRequest });
  await f.service.waitForPreparation("task");
  assert.equal(f.calls.filter(c => c[0] === "ready").length, 1);
  assert.equal(f.calls.some(c => c[0] === "failure"), false);
});

test("preparation failure is visible and the hold is always released", async () => {
  const f = fixture();
  f.deps.draftOrchestration = async () => { throw new Error("invalid binding"); };
  await f.service.start({ userRequest: f.taskRun.userRequest, orchPipelineId: "missing" });
  await f.service.waitForPreparation("task");
  assert.equal(f.taskRun.status, "blocked");
  assert.equal(f.calls.filter(c => c[0] === "release").length, 1);
  assert.equal(f.calls.some(c => c[0] === "ready"), false);
});

test("cancellation while preparing cannot create a planning-ready marker", async () => {
  const f = fixture();
  f.deps.proposeCapabilities = async () => { f.taskRun.status = "cancelled"; };
  await f.service.start({ userRequest: f.taskRun.userRequest });
  await f.service.waitForPreparation("task");
  assert.equal(f.calls.some(c => ["learner", "ready"].includes(c[0])), false);
});

test("start input rejects malformed or conflicting routes and ignores caller-supplied authorization", () => {
  for (const input of [null, [], {}, { userRequest: " " }, { userRequest: "x", intent: "root" },
    { userRequest: "x", orchMode: "unknown" }, { userRequest: "x", targetDir: 42 },
    { userRequest: "x", orchHarness: {} }, { userRequest: "x", orchPipelineId: "p", orchHarness: { packageId: "p", bindingSetId: "b" } }]) {
    assert.throws(() => parseStartTaskInput(input));
  }
  assert.deepEqual(parseStartTaskInput({ userRequest: "x", intent: "change", mode: "template", contract: { authorization: "allow" } }),
    { userRequest: "x", intent: "change" });
});
