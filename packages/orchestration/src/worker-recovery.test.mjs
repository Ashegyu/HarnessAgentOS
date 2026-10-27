import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb, LocalStateService } from "../../storage/src/index.ts";
import { ConversationService } from "../../core/src/conversation/conversation-service.ts";
import { OrchestrationPlanner } from "./orchestration-planner.ts";
import { WorkerRunner } from "./worker-runner.ts";
import { formatWorkerStepArtifact } from "./orchestration-trace.ts";
import { buildWorkerHandoffPayload, formatWorkerHandoffPayload } from "./worker-handoff.ts";

const profileInput = (name) => ({
  name, description: "", category: "test", tags: [], provider: "claude", role: "reviewer", persona: "Review precisely.",
  tuning: { model: "test-model", timeoutMs: 300000, stallTimeoutMs: 60000, contextDepth: 5, systemPromptPrefix: "", systemPromptSuffix: "" },
  cli: { cliPathOverride: "", env: {}, envSecretRefs: {} },
  permissions: { autoApproveActions: [], blockedActions: [], allowedSkillIds: [], toolAllowlist: [], toolDenylist: [] },
  mcpServerIds: [], skillSourceIds: [], isDefault: false,
});

const fixture = async ({ count = 1, allowedActions = [] } = {}) => {
  const db = openDb({ filePath: ":memory:" });
  const state = new LocalStateService(db);
  const thread = await state.createThread({ title: "Worker recovery", targetDir: "/tmp/project" });
  const task = await state.createTaskRun({ threadId: thread.id, userRequest: "Inspect the project", targetDir: "/tmp/project", status: "running" });
  const profiles = [];
  for (let index = 0; index < count; index += 1) profiles.push(await state.agentProfiles.create(profileInput(`Recovery${index}`)));
  const pipeline = await state.agentPipelines.create({ name: "Recovery pipeline", description: "", steps: profiles.map((profile, index) => ({
    id: `recovery-${index}`, agentProfileId: profile.id, title: profile.name, instruction: `Inspect ${index}`,
    expectedArtifactKinds: ["log"], dependsOn: index === 0 ? [] : [`recovery-${index - 1}`], allowedActions,
  })) });
  const drafted = await new OrchestrationPlanner({ state }).draftPlan({ taskRunId: task.id, mode: "multi_worker", pipelineId: pipeline.id });
  const approval = await state.decideApproval(drafted.approval.id, "approved", "run");
  const conversation = new ConversationService({ state, pathExists: async () => true });
  return { db, state, task, profiles, plan: drafted.plan, approval, conversation };
};

test("a reviewed worker action waits for its replacement and resumes the remaining worker once", async () => {
  const f = await fixture({ count: 2, allowedActions: ["file_write"] });
  let calls = 0;
  try {
    const { buildTaskContract } = await import("@harness/core");
    f.db.prepare("UPDATE task_contracts SET contract_json=? WHERE task_run_id=?").run(JSON.stringify(buildTaskContract({ userRequest: "파일을 수정해줘", intent: "change" })), f.task.id);
    const runner = new WorkerRunner({ state: f.state, agentPlanning: { async invokeForWorker() {
      calls++;
      return calls === 1 ? { outputText: "proposed", proposedActions: [{ type: "file_write", path: "a.txt", after: "requested", rationale: "requested change" }] } : { outputText: "reviewed" };
    } } });
    const first = await runner.runApproved(f);
    const sourceId = first.proposedApprovalIds[0];
    await f.state.decideApproval(sourceId, "approved");
    await f.state.claimApprovalExecution(sourceId, 1, "failed-owner");
    await f.state.finishApprovalExecution(sourceId, "failed-owner", "uncertain");
    await f.state.setTaskRunStatus(f.task.id, "blocked");
    const replacement = await f.conversation.prepareActionRetry({ approvalId: sourceId, expectedRevision: 1,
      expectedExecutionState: "uncertain", reviewMessage: "부분 실행 결과와 새 승인의 필요성을 확인함" });
    const waiting = await runner.runApproved(f);
    assert.equal(calls, 1);
    assert.deepEqual(waiting.proposedApprovalIds, [replacement.id]);
    await f.conversation.approve({ approvalId: replacement.id, manualConfirmation: true });
    await f.state.claimApprovalExecution(replacement.id, 1, "reviewed-owner");
    await f.state.finishApprovalExecution(replacement.id, "reviewed-owner", "succeeded");
    await f.state.decideApproval(replacement.id, "executed");
    await runner.runApproved(f);
    assert.equal(calls, 2);
    assert.equal((await f.state.getApproval(sourceId)).executionState, "uncertain");
  } finally { closeDb(f.db); }
});

test("a failed worker log is rerun instead of recovered as a successful handoff", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const runner = new WorkerRunner({ state: f.state, agentPlanning: { async invokeForWorker() {
      calls += 1;
      if (calls === 1) throw new Error("provider failure");
      return { outputText: "verified output" };
    } } });
    const first = await runner.runApproved(f);
    assert.equal(first.workerSteps[0].status, "failed");
    const second = await runner.runApproved(f);
    assert.equal(calls, 2, "failure logs must not suppress the retry");
    assert.equal(second.workerSteps[0].status, "succeeded");
  } finally { closeDb(f.db); }
});

test("a worker log saved before interruption is not completion evidence", async () => {
  const f = await fixture();
  let calls = 0;
  const createArtifact = f.state.createArtifact.bind(f.state);
  let interrupt = true;
  f.state.createArtifact = async (input) => {
    const artifact = await createArtifact(input);
    if (interrupt && input.uri === `harness:orchestration/${f.plan.id}/${f.plan.workerSteps[0].id}`) {
      interrupt = false;
      throw new Error("interrupted after log persistence");
    }
    return artifact;
  };
  try {
    const runner = new WorkerRunner({ state: f.state, agentPlanning: { async invokeForWorker() { calls += 1; return { outputText: "candidate output" }; } } });
    await assert.rejects(runner.runApproved(f), /interrupted after log persistence/);
    const result = await runner.runApproved(f);
    assert.equal(calls, 2);
    assert.equal(result.workerSteps[0].status, "succeeded");
  } finally { closeDb(f.db); }
});

test("the latest failed execution invalidates an older success even when timestamps are equal", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const runner = new WorkerRunner({ state: f.state, agentPlanning: { async invokeForWorker() { calls += 1; return { outputText: "candidate" }; } } });
    await runner.runApproved(f);
    const priorArtifacts = await f.state.listArtifactsByTaskRun(f.task.id);
    const prior = priorArtifacts.find(a => a.uri === `harness:orchestration/${f.plan.id}/${f.plan.workerSteps[0].id}`);
    const latestStep = await f.state.createStep({ taskRunId: f.task.id, index: (await f.state.listStepsByTaskRun(f.task.id)).length, kind: "summarize", title: "new failed execution", status: "failed" });
    const latest = await f.state.createArtifact({ taskRunId: f.task.id, stepId: latestStep.id, kind: "log", title: "new failure", uri: prior.uri,
      summary: formatWorkerStepArtifact({ step: { ...f.plan.workerSteps[0], status: "failed" }, output: "latest failure" }) });
    f.db.prepare("UPDATE artifacts SET created_at=? WHERE id=?").run(prior.createdAt, latest.id);
    const result = await runner.runApproved(f);
    assert.equal(calls, 2);
    assert.equal(result.workerSteps[0].status, "succeeded");
    await runner.runApproved(f);
    assert.equal(calls, 2, "the completed retry is now the latest recoverable execution");
  } finally { closeDb(f.db); }
});

test("partial approval publication rolls back and never marks its worker recoverable", async () => {
  const f = await fixture({ allowedActions: ["file_write"] });
  let calls = 0;
  try {
    f.db.exec(`CREATE TRIGGER fail_second_worker_approval BEFORE INSERT ON approvals
      WHEN NEW.action_type='file_write' AND EXISTS(SELECT 1 FROM approvals WHERE task_run_id=NEW.task_run_id AND action_type='file_write')
      BEGIN SELECT RAISE(ABORT, 'injected approval publication failure'); END`);
    const runner = new WorkerRunner({ state: f.state, agentPlanning: { async invokeForWorker() {
      calls += 1;
      return { outputText: "two concrete file proposals", proposedActions: ["one.txt", "two.txt"].map(path => ({ type: "file_write", path, after: `content for ${path}\n`, rationale: "requested output" })) };
    } } });
    const checkpointsBefore = await f.state.listCheckpointsByTaskRun(f.task.id);
    await assert.rejects(runner.runApproved(f), /injected approval publication failure/);
    const workerSteps = (await f.state.listStepsByTaskRun(f.task.id)).filter(step => step.title.startsWith("Worker["));
    assert.equal(workerSteps[0].status, "running", "completion and approvals must commit together");
    assert.equal((await f.state.listApprovalsByTaskRun(f.task.id)).filter(a => a.actionType === "file_write").length, 0);
    assert.equal((await f.state.listCheckpointsByTaskRun(f.task.id)).length, checkpointsBefore.length);
    f.db.exec("DROP TRIGGER fail_second_worker_approval");
    const recovered = await runner.runApproved(f);
    assert.equal(calls, 2);
    assert.equal(recovered.proposedApprovalIds.length, 2);
  } finally { closeDb(f.db); }
});

test("successful recovery preserves the original handoff content and structured payload", async () => {
  const f = await fixture({ count: 2 });
  const handoffs = [];
  let calls = 0;
  try {
    const runner = new WorkerRunner({ state: f.state, agentPlanning: { async invokeForWorker(input) {
      calls += 1;
      if (calls === 1) await f.conversation.pauseTask({ taskRunId: f.task.id });
      else handoffs.push(...input.handoffMessages);
      return { outputText: calls === 1 ? "original advisory output" : "consumer output" };
    } } });
    const first = await runner.runApproved(f);
    assert.equal(first.needsContinuation, true);
    await f.conversation.resumeTask({ taskRunId: f.task.id });
    await runner.runApproved(f);
    assert.equal(calls, 2);
    assert.equal(handoffs.length, 1);
    assert.match(handoffs[0].content, /original advisory output/);
    assert.doesNotMatch(handoffs[0].content, /# Worker step:|## Output \(advisory/);
    assert.equal(handoffs[0].structuredPayload.producer.artifactId, handoffs[0].artifactId);
    assert.equal(handoffs[0].structuredPayload.producer.stepId, f.plan.workerSteps[0].id);
  } finally { closeDb(f.db); }
});

test("recovery retains CLI proposals in the structured handoff without publishing them twice", async () => {
  const f = await fixture({ count: 2, allowedActions: ["file_write"] });
  let calls = 0;
  const handoffs = [];
  const proposal = { type: "file_write", path: "exact.txt", after: "the requested content\n", rationale: "preserve this complete original rationale" };
  try {
    const runner = new WorkerRunner({ state: f.state, agentPlanning: { async invokeForWorker(input) {
      calls += 1;
      if (calls === 1) return { outputText: "proposal is supplied separately", proposedActions: [proposal] };
      handoffs.push(...input.handoffMessages);
      return { outputText: "consumed" };
    } } });
    const first = await runner.runApproved(f);
    assert.equal(first.proposedApprovalIds.length, 1);
    await f.state.decideApproval(first.proposedApprovalIds[0], "executed", "applied");
    await runner.runApproved(f);
    assert.equal(calls, 2);
    assert.deepEqual(handoffs[0].structuredPayload.proposedActions, [proposal]);
    assert.equal((await f.state.listApprovalsByTaskRun(f.task.id)).filter(a => a.actionType === "file_write").length, 1);
  } finally { closeDb(f.db); }
});

test("legacy succeeded logs without atomic publication evidence stop recovery safely", async () => {
  const f = await fixture();
  try {
    const step = await f.state.createStep({ taskRunId: f.task.id, index: 10, kind: "summarize", title: "legacy worker", status: "succeeded" });
    const artifact = await f.state.createArtifact({ taskRunId: f.task.id, stepId: step.id, kind: "log", title: "legacy success",
      uri: `harness:orchestration/${f.plan.id}/${f.plan.workerSteps[0].id}`,
      summary: formatWorkerStepArtifact({ step: { ...f.plan.workerSteps[0], status: "succeeded" }, output: "cannot prove all proposals were published" }) });
    await f.state.setStepStatus(step.id, "succeeded", { outputSummary: `worker artifact ${artifact.id}` });
    const runner = new WorkerRunner({ state: f.state });
    await assert.rejects(runner.loadCompletedWorkerHandoffs(f.plan), (error) => error.code === "WORKER_COMPLETION_UNVERIFIED");
    assert.equal((await f.state.listApprovalsByTaskRun(f.task.id)).length, 1, "recovery must not republish ambiguous old actions");
  } finally { closeDb(f.db); }
});

test("recovery does not resurrect structured proposals rejected by the worker action policy", async () => {
  const f = await fixture({ count: 2, allowedActions: [] });
  let calls = 0;
  const handoffs = [];
  const rejectedProposal = { type: "file_write", path: "rejected.txt", after: "must remain an unapproved proposal\n", rationale: "not permitted for this worker" };
  const payload = buildWorkerHandoffPayload({
    rawOutput: "the worker attempted an action outside its policy",
    producer: { taskRunId: f.task.id, planId: f.plan.id, stepId: f.plan.workerSteps[0].id,
      role: "reviewer", title: "untrusted metadata", artifactId: "untrusted-artifact" },
    outputContract: "review", proposedActions: [rejectedProposal],
  }).payload;
  try {
    const runner = new WorkerRunner({ state: f.state, agentPlanning: { async invokeForWorker(input) {
      calls += 1;
      if (calls === 1) {
        await f.conversation.pauseTask({ taskRunId: f.task.id });
        return { outputText: formatWorkerHandoffPayload(payload) };
      }
      handoffs.push(...input.handoffMessages);
      return { outputText: "consumed only policy-filtered advice" };
    } } });
    const paused = await runner.runApproved(f);
    assert.equal(paused.needsContinuation, true);
    assert.equal((await f.state.listApprovalsByTaskRun(f.task.id)).filter(a => a.actionType === "file_write").length, 0);
    await f.conversation.resumeTask({ taskRunId: f.task.id });
    await runner.runApproved(f);
    assert.equal(calls, 2);
    assert.deepEqual(handoffs[0].structuredPayload.proposedActions, [], "recovery must preserve the original policy rejection");
    assert.equal((await f.state.listApprovalsByTaskRun(f.task.id)).filter(a => a.actionType === "file_write").length, 0);
  } finally { closeDb(f.db); }
});
