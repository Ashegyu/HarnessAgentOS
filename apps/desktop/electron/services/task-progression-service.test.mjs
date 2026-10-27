import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTaskContract } from "@harness/core";
import { TaskProgressionService } from "./task-progression-service.ts";

const approval = (id, overrides = {}) => ({
  id, taskRunId: "task", checkpointId: "checkpoint", actionType: "file_write",
  actionSummary: "write report", status: "pending", actionRevision: 1,
  proposedAction: { type: "file_write", filePatch: { path: `${id}.html`, after: "report" } },
  ...overrides,
});
const fixture = (approvals = [], overrides = {}) => {
  const snapshot = {
    taskRun: { id: "task", userRequest: "보고서를 생성해줘", status: "waiting_for_approval",
      contract: buildTaskContract({ userRequest: "보고서를 생성해줘" }) },
    approvals, steps: [], artifacts: [], checkpoints: [], invocations: [],
    globalAutoApprove: false, workerFileActionAutoApprove: false,
    pipelineConsent: false, activeProfile: null, budget: {}, ...overrides,
  };
  const calls = [];
  const deps = {
    load: async () => structuredClone(snapshot),
    approve: async input => {
      calls.push(["approve", input.approvalId, input.expectedRevision]);
      const item = snapshot.approvals.find(a => a.id === input.approvalId);
      item.status = "approved"; item.approvedRevision = item.actionRevision;
    },
    execute: async item => {
      calls.push(["execute", item.id]);
      const row = snapshot.approvals.find(a => a.id === item.id);
      row.status = "executed"; row.executionState = "succeeded";
      snapshot.taskRun.status = "ready_for_review";
    },
    evaluateQuality: async id => { calls.push(["quality", id]); snapshot.taskRun.status = "done"; },
    recordFailure: async (id, error) => { calls.push(["failure", id, error.message]); snapshot.taskRun.status = "blocked"; },
    changed: id => calls.push(["changed", id]),
  };
  return { snapshot, calls, deps, service: new TaskProgressionService(deps) };
};

test("shutdown during snapshot loading drains it without approving or executing stale work", async () => {
  const f = fixture([approval("late")], { globalAutoApprove: true });
  let release;
  const loaded = new Promise(resolve => { release = resolve; });
  f.deps.load = () => loaded;
  const running = f.service.advance("task");
  await Promise.resolve();
  let stopped = false;
  const shutdown = f.service.shutdown().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
  release(f.snapshot); await shutdown; await running;
  await f.service.advance("task");
  assert.deepEqual(f.calls, []);
});

test("preparation holds automatic decisions until all proposals are ready", async () => {
  const f = fixture([approval("a")], { globalAutoApprove: true });
  const release = f.service.hold("task");
  await f.service.advance("task");
  assert.deepEqual(f.calls, []);
  release();
  await f.service.advance("task");
  assert.equal(f.calls.filter(c => c[0] === "execute").length, 1);
});

test("host-ready planning starts once after recommendation decisions, independently of renderer", async () => {
  const f = fixture([approval("advice", { actionType: "model_use", status: "rejected" })]);
  f.snapshot.taskRun.status = "drafting";
  f.deps.resumePlanning = async id => {
    f.calls.push(["plan", id]);
    f.snapshot.invocations.push({ status: "succeeded" });
    f.snapshot.taskRun.status = "ready_for_review";
  };
  await f.service.advance("task");
  assert.deepEqual(f.calls, []); // Legacy drafts are not implicitly started.
  f.snapshot.artifacts.push({ taskRunId: "task", kind: "snapshot", uri: "harness:planning-ready/task" });
  await Promise.all(Array.from({ length: 8 }, () => f.service.advance("task")));
  assert.equal(f.calls.filter(c => c[0] === "plan").length, 1);
  assert.equal(f.snapshot.taskRun.status, "done");
});

test("a no-progress continuation emitting events does not create a busy loop", async () => {
  const f = fixture([approval("orch", { actionType: "orchestration_plan", status: "approved", approvedRevision: 1 })]);
  let attempts = 0;
  f.deps.execute = async () => {
    attempts++;
    if (attempts < 4) f.service.schedule("task");
  };
  await f.service.advance("task");
  assert.equal(attempts, 1);
});

test("ordinary approved work runs once and finishes without a selected renderer", async () => {
  const f = fixture([approval("a", { status: "approved", approvedRevision: 1 })]);
  await Promise.all(Array.from({ length: 12 }, () => f.service.advance("task")));
  assert.deepEqual(f.calls.filter(c => ["execute", "quality"].includes(c[0])), [["execute", "a"], ["quality", "task"]]);
  assert.equal(f.snapshot.taskRun.status, "done");
});

test("reviewed uncertain attempts yield to a fresh manual approval without replay or auto consent", async () => {
  const old = approval("old", { status: "approved", approvedRevision: 1, executionState: "uncertain", retryApprovalId: "retry" });
  const next = approval("retry", { requiresManualApproval: true });
  const f = fixture([old, next], { globalAutoApprove: true, pipelineConsent: true });
  await f.service.advance("task");
  assert.deepEqual(f.calls, []);
  f.snapshot.approvals[1].status = "approved";
  f.snapshot.approvals[1].approvedRevision = 1;
  await f.service.advance("task");
  assert.deepEqual(f.calls.filter(c => ["execute", "quality"].includes(c[0])), [["execute", "retry"], ["quality", "task"]]);
  assert.equal(f.snapshot.approvals[0].executionState, "uncertain");
});

test("auto approval uses the current revision then executes in stored order", async () => {
  const f = fixture([approval("a", { actionRevision: 3 }), approval("b")], { globalAutoApprove: true });
  await f.service.advance("task");
  assert.deepEqual(f.calls.filter(c => ["approve", "execute"].includes(c[0])), [
    ["approve", "a", 3], ["execute", "a"], ["approve", "b", 1], ["execute", "b"],
  ]);
});

for (const actionType of ["shell", "file_delete"]) {
  test(`${actionType} requires manual consent even with pipeline and global automation`, async () => {
    const f = fixture([approval("a", { actionType })], { globalAutoApprove: true, pipelineConsent: true });
    await f.service.advance("task");
    assert.equal(f.calls.some(c => ["approve", "execute", "quality"].includes(c[0])), false);
  });
}

for (const status of ["paused", "blocked", "quality_failed", "cancelled", "done"]) {
  test(`a ${status} task never starts new automatic work`, async () => {
    const f = fixture([approval("a", { status: "approved", approvedRevision: 1 })]);
    f.snapshot.taskRun.status = status;
    await f.service.advance("task");
    assert.deepEqual(f.calls, []);
  });
}

for (const executionState of ["running", "succeeded", "uncertain"]) {
  test(`${executionState} approvals cannot be replayed or passed to QA`, async () => {
    const f = fixture([approval("a", { status: "approved", approvedRevision: 1, executionState })]);
    f.snapshot.taskRun.status = "ready_for_review";
    await f.service.advance("task");
    assert.equal(f.calls.some(c => ["execute", "quality"].includes(c[0])), false);
  });
}

test("missing details remain pending, not approved and not completed", async () => {
  const f = fixture([approval("a", { proposedAction: undefined })], { globalAutoApprove: true });
  await f.service.advance("task");
  assert.equal(f.calls.some(c => ["approve", "execute", "quality"].includes(c[0])), false);
});

test("profile blocks and read-only contracts override pipeline consent", async () => {
  for (const options of [
    { activeProfile: { permissions: { blockedActions: ["file_write"], autoApproveActions: [] } } },
    { taskRun: { id: "task", status: "waiting_for_approval", userRequest: "리뷰해줘", contract: buildTaskContract({ userRequest: "리뷰해줘" }) } },
  ]) {
    const f = fixture([approval("a")], { globalAutoApprove: true, pipelineConsent: true, ...options });
    await f.service.advance("task");
    assert.equal(f.calls.some(c => ["approve", "execute", "quality"].includes(c[0])), false);
  }
});

test("execution failure stops subsequent actions and records a visible blocked state", async () => {
  const f = fixture([approval("a"), approval("b")], { globalAutoApprove: true });
  f.deps.execute = async item => { f.calls.push(["execute", item.id]); throw new Error("disk write failed"); };
  await f.service.advance("task");
  assert.deepEqual(f.calls.filter(c => c[0] === "execute"), [["execute", "a"]]);
  assert.equal(f.snapshot.taskRun.status, "blocked");
  assert.ok(f.calls.some(c => c[0] === "failure" && c[2] === "disk write failed"));
});

test("explicit automation repairs a confirmed checker failure once and stops at the next manual check", async () => {
  const f = fixture([approval("check", { actionType: "shell", status: "approved", approvedRevision: 1,
    proposedAction: { type: "shell", command: "node", args: ["--test", "source.test.mjs"] } })], { globalAutoApprove: true });
  const execute = f.deps.execute;
  f.deps.execute = async item => {
    if (item.id !== "check") return execute(item);
    f.calls.push(["execute", item.id]);
    Object.assign(f.snapshot.approvals[0], { status: "executed", executionState: "failed" });
    f.snapshot.taskRun.status = "blocked";
    throw new Error("checker exit 1");
  };
  f.deps.recoverValidationFailure = async id => {
    f.calls.push(["repair", id]);
    f.snapshot.approvals.push(approval("fix"), approval("recheck", { actionType: "shell", proposedAction: { type: "shell", command: "node", args: ["--test", "source.test.mjs"] } }));
    f.snapshot.taskRun.status = "waiting_for_approval";
    return true;
  };
  await f.service.advance("task");
  assert.deepEqual(f.calls.filter(c => c[0] === "repair"), [["repair", "task"]]);
  assert.deepEqual(f.calls.filter(c => c[0] === "execute"), [["execute", "check"], ["execute", "fix"]]);
  assert.equal(f.snapshot.approvals.find(a => a.id === "recheck").status, "pending");
  assert.equal(f.calls.some(c => c[0] === "failure"), false);
});

for (const [automation, outcome] of [[false, "failed"], [true, "uncertain"]]) {
  test(`automatic repair never bypasses consent or unknown outcomes (${automation}/${outcome})`, async () => {
    const f = fixture([approval("check", { actionType: "shell", status: "approved", approvedRevision: 1 })], { globalAutoApprove: automation });
    f.deps.execute = async () => { Object.assign(f.snapshot.approvals[0], { status: "executed", executionState: outcome }); f.snapshot.taskRun.status = "blocked"; throw new Error("exit"); };
    let repairs = 0; f.deps.recoverValidationFailure = async () => { repairs++; return true; };
    await f.service.advance("task");
    assert.equal(repairs, 0);
  });
}

test("cancellation during an action prevents the next action", async () => {
  const f = fixture([approval("a"), approval("b")], { globalAutoApprove: true });
  const execute = f.deps.execute;
  f.deps.execute = async item => { await execute(item); f.snapshot.taskRun.status = "cancelled"; };
  await f.service.advance("task");
  assert.deepEqual(f.calls.filter(c => c[0] === "execute"), [["execute", "a"]]);
});

test("QA cannot run with unresolved work from a different checkpoint", async () => {
  const f = fixture([approval("a", { checkpointId: "other" })]);
  f.snapshot.taskRun.status = "ready_for_review";
  await f.service.advance("task");
  assert.equal(f.calls.some(c => c[0] === "quality"), false);
});

test("worker file approvals finish before an approved orchestration is continued", async () => {
  const f = fixture([
    approval("orch", { actionType: "orchestration_plan", status: "approved", approvedRevision: 1, proposedAction: undefined }),
    approval("file", { status: "approved", approvedRevision: 1 }),
  ]);
  await f.service.advance("task");
  assert.deepEqual(f.calls.filter(c => c[0] === "execute"), [["execute", "file"], ["execute", "orch"]]);
});

test("a waiting orchestration is not retried without new progress", async () => {
  const f = fixture([approval("orch", { actionType: "orchestration_plan", status: "approved", approvedRevision: 1 })]);
  f.deps.execute = async item => { f.calls.push(["execute", item.id]); };
  await f.service.advance("task");
  assert.equal(f.calls.filter(c => c[0] === "execute").length, 1);
});

test("quality exceptions produce an attention state, not a silent console-only failure", async () => {
  const f = fixture();
  f.snapshot.taskRun.status = "ready_for_review";
  f.deps.evaluateQuality = async () => { throw new Error("quality unavailable"); };
  await f.service.advance("task");
  assert.equal(f.snapshot.taskRun.status, "blocked");
});

test("a pending manual action is an ordering barrier for later writes", async () => {
  const f = fixture([approval("shell", { actionType: "shell" }), approval("later")], { globalAutoApprove: true });
  await f.service.advance("task");
  assert.equal(f.calls.some(c => c[0] === "execute"), false);
});

test("an executed row with an uncertain outcome still blocks completion", async () => {
  const f = fixture([approval("a", { status: "executed", executionState: "uncertain" })]);
  f.snapshot.taskRun.status = "ready_for_review";
  await f.service.advance("task");
  assert.equal(f.calls.some(c => c[0] === "quality"), false);
});

test("an active runner or queued invocation blocks progression", async () => {
  for (const overrides of [{ steps: [{ status: "running" }] }, { invocations: [{ status: "queued" }] }]) {
    const f = fixture([approval("a", { status: "approved", approvedRevision: 1 })], overrides);
    await f.service.advance("task");
    assert.deepEqual(f.calls, []);
  }
});

test("events arriving during execution are coalesced without losing newly created actions", async () => {
  const f = fixture([approval("a")], { globalAutoApprove: true });
  const execute = f.deps.execute;
  f.deps.execute = async item => {
    await execute(item);
    if (item.id === "a") { f.snapshot.approvals.push(approval("b")); f.service.schedule("task"); }
  };
  await f.service.advance("task");
  assert.deepEqual(f.calls.filter(c => c[0] === "execute"), [["execute", "a"], ["execute", "b"]]);
});

test("normal Resume continues quality backflow even when its parent approval is already executed", async () => {
  const f = fixture([approval("orch", { actionType: "orchestration_plan", status: "executed", executionState: "succeeded" })]);
  f.snapshot.taskRun.status = "running";
  f.deps.resumeBackflow = async id => {
    f.calls.push(["backflow", id]);
    f.snapshot.taskRun.status = "ready_for_review";
    f.snapshot.steps.push({ id: "backflow-worker", status: "succeeded" });
    return f.calls.filter(c => c[0] === "backflow").length === 1;
  };
  await Promise.all(Array.from({ length: 8 }, () => f.service.advance("task")));
  assert.equal(f.calls.filter(c => c[0] === "backflow").length, 2);
  assert.deepEqual(f.calls.filter(c => ["execute", "quality"].includes(c[0])), [["quality", "task"]]);
  assert.equal(f.snapshot.taskRun.status, "done");
});

test("quality backflow waits for child actions and resumes before evaluating quality", async () => {
  const f = fixture([approval("file", { status: "approved", approvedRevision: 1 })]);
  f.deps.resumeBackflow = async id => {
    f.calls.push(["backflow", id]);
    assert.equal(f.snapshot.approvals[0].status, "executed");
    return false;
  };
  await f.service.advance("task");
  assert.deepEqual(f.calls.filter(c => ["execute", "backflow", "quality"].includes(c[0])),
    [["execute", "file"], ["backflow", "task"], ["quality", "task"]]);
});

test("a quality continuation emitting events without persisted progress does not spin or enter QA", async () => {
  const f = fixture();
  f.snapshot.taskRun.status = "ready_for_review";
  let calls = 0;
  f.deps.resumeBackflow = async () => { calls += 1; f.service.schedule("task"); return true; };
  await f.service.advance("task");
  assert.equal(calls, 1);
  assert.equal(f.calls.some(c => c[0] === "quality"), false);
});
