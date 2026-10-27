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
import { ConversationService } from "../../core/src/conversation/conversation-service.ts";
import { OrchestrationService } from "./orchestration-service.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-wr-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const seedTaskRun = async (state, overrides = {}) => {
  const thread = await state.createThread({ title: "t", targetDir: "/tmp/proj" });
  return state.createTaskRun({
    threadId: thread.id,
    userRequest: overrides.userRequest ?? "do",
    targetDir: "/tmp/proj",
    status: "running",
  });
};

const validProfileInput = (overrides = {}) => ({
  name: "Coder",
  description: "",
  category: "test",
  tags: ["coder"],
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

const validEndpointInput = (overrides = {}) => ({
  name: "Remote Reviewer",
  baseUrl: "https://agents.example.com/reviewer",
  agentCardUrl: "https://agents.example.com/reviewer/.well-known/agent-card.json",
  preferredTransport: "json-rpc",
  enabled: true,
  trusted: true,
  ...overrides,
});

const approvePlanApproval = async (state, approval) =>
  state.decideApproval(approval.id, "approved", "ok");

test("read-only contract blocks a pre-approved orchestration before worker side effects", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state, { userRequest: "코드를 검토만 해줘" });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({ taskRunId: taskRun.id, mode: "single_worker" });
    const approved = await approvePlanApproval(state, drafted.approval);
    const before = await state.listStepsByTaskRun(taskRun.id);
    const runner = new WorkerRunner({ state });
    await assert.rejects(runner.runApproved({ approval: { ...approved, taskRunId: "different-task" }, plan: drafted.plan }),
      (error) => error.code === "ORCH_APPROVAL_TASK_MISMATCH");
    await assert.rejects(runner.runApproved({ approval: approved, plan: drafted.plan }),
      (error) => error.code === "TASK_CONTRACT_ACTION_BLOCKED");
    assert.deepEqual(await state.listStepsByTaskRun(taskRun.id), before);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const waitFor = async (predicate, message) => {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
};

const createPauseFixture = async ({ parallel = false, count = 3 } = {}) => {
  const db = openDb({ filePath: ":memory:" });
  const state = new LocalStateService(db);
  const settings = await state.getSettings();
  await state.updateSettings({
    ...settings,
    orchestration: { ...settings.orchestration, maxParallelWorkers: 2 },
  });
  const taskRun = await seedTaskRun(state);
  const profiles = await Promise.all(Array.from({ length: count }, (_, index) =>
    state.agentProfiles.create(validProfileInput({ name: `PauseWorker${index}`, role: "reviewer" })),
  ));
  const pipeline = await state.agentPipelines.create({
    name: "Pause boundaries",
    description: "",
    steps: profiles.map((profile, index) => ({
      id: `pause-${index}`,
      agentProfileId: profile.id,
      title: profile.name,
      instruction: `Review ${profile.name}.`,
      expectedArtifactKinds: ["log"],
      dependsOn: parallel || index === 0 ? [] : [`pause-${index - 1}`],
      allowedActions: [],
    })),
  });
  const planner = new OrchestrationPlanner({ state });
  const drafted = await planner.draftPlan({ taskRunId: taskRun.id, mode: "multi_worker", pipelineId: pipeline.id });
  const approved = await approvePlanApproval(state, drafted.approval);
  const conversation = new ConversationService({ state, pathExists: async () => true });
  return { db, state, taskRun, profiles, drafted, approved, conversation };
};

test("parallel continuation reserves the final item once after delayed liveness reads", async () => {
  const f = await createPauseFixture({ parallel: true, count: 3 });
  const reads = deferred();
  const starts = [];
  let continuationReads = 0;
  try {
    const runner = new WorkerRunner({ state: f.state, agentPlanning: {
      async invokeForWorker({ profile }) { starts.push(profile.name); return { outputText: "reviewed" }; },
    } });
    const isActive = runner.isTaskRunActive.bind(runner);
    // Delay only the asynchronous liveness boundary; execute the real runner,
    // persistence, publication and recovery paths without extracting a helper.
    runner.isTaskRunActive = async id => {
      if (starts.length === 2 && continuationReads < 2) {
        continuationReads++;
        if (continuationReads === 2) reads.resolve();
        await reads.promise;
      }
      return isActive(id);
    };
    const result = await runner.runApproved({ approval: f.approved, plan: f.drafted.plan });
    assert.equal(continuationReads, 2);
    assert.deepEqual(starts, f.profiles.map(profile => profile.name));
    assert.equal(result.workerSteps.length, 3);
    assert.ok(result.workerSteps.every(step => step.status === "succeeded"));
    const steps = (await f.state.listStepsByTaskRun(f.taskRun.id)).filter(step => step.title.startsWith("Worker["));
    assert.equal(steps.length, 3);
    assert.equal(new Set(steps.map(step => step.index)).size, 3);
  } finally { reads.resolve(); closeDb(f.db); }
});

for (const failureAt of ["artifact persistence", "result publication"]) {
  test(`parallel ${failureAt} failure drains started workers and stops queued dispatch before releasing the service`, async () => {
    const f = await createPauseFixture({ parallel: true, count: 4 });
    const finishSurvivor = deferred();
    const failureReached = deferred();
    const survivorPublished = deferred();
    const starts = [];
    const expected = new Error(`injected ${failureAt} failure`);
    let failed = false;
    let settled = false;
    let run;
    const createArtifact = f.state.createArtifact.bind(f.state);
    if (failureAt === "artifact persistence") f.state.createArtifact = async input => {
      if (input.title === `Worker output: ${f.profiles[0].name}`) {
        failed = true;
        failureReached.resolve();
        throw expected;
      }
      return createArtifact(input);
    };
    const service = new OrchestrationService({ state: f.state, enabled: () => true,
      agentPlanning: { async invokeForWorker({ profile }) {
        starts.push(profile.name);
        if (profile.id === f.profiles[1].id) await finishSurvivor.promise;
        return { outputText: "reviewed" };
      } },
      onTaskRunChanged: () => {
        if (failureAt === "result publication" && !failed) {
          failed = true;
          failureReached.resolve();
          throw expected;
        }
        survivorPublished.resolve();
      },
    });
    try {
      run = service.runApproved({ approvalId: f.approved.id });
      run.then(() => { settled = true; }, () => { settled = true; });
      await failureReached.promise;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, "a failed lane must not release ownership while its sibling still writes");
      assert.equal(service.runApproved({ approvalId: f.approved.id }), run, "duplicate requests must share the draining run");
      assert.deepEqual(starts, f.profiles.slice(0, 2).map(profile => profile.name));
      finishSurvivor.resolve();
      await assert.rejects(run, error => error === expected);
      await survivorPublished.promise;
      assert.deepEqual(starts, f.profiles.slice(0, 2).map(profile => profile.name));
      const steps = await f.state.listStepsByTaskRun(f.taskRun.id);
      assert.equal(steps.find(step => step.title.includes(f.profiles[1].name)).status, "succeeded");
      assert.equal((await f.state.getTaskRun(f.taskRun.id)).status, "blocked");
      assert.equal((await f.state.getApproval(f.approved.id)).status, "approved", "failed run remains available for explicit recovery");
    } finally {
      finishSurvivor.resolve();
      if (run) await run.catch(() => {});
      await survivorPublished.promise;
      closeDb(f.db);
    }
  });
}

for (const scenario of [
  { name: "sequential", parallel: false, count: 3, active: 1 },
  { name: "parallel queued", parallel: true, count: 3, active: 2 },
  { name: "last worker", parallel: false, count: 1, active: 1 },
]) {
  test(`Pause preserves ${scenario.name} progress and Resume starts only unfinished workers`, async () => {
    const f = await createPauseFixture(scenario);
    const gate = deferred();
    const starts = [];
    let run;
    try {
      const runner = new WorkerRunner({ state: f.state, agentPlanning: {
        async invokeForWorker({ profile }) {
          starts.push(profile.name);
          await gate.promise;
          return { outputText: `${profile.name} finished` };
        },
      } });
      run = runner.runApproved({ approval: f.approved, plan: f.drafted.plan });
      await waitFor(() => starts.length === scenario.active, "initial workers must start");
      await f.conversation.pauseTask({ taskRunId: f.taskRun.id });
      gate.resolve();
      const paused = await run;
      assert.equal((await f.state.getTaskRun(f.taskRun.id)).status, "paused");
      assert.deepEqual(starts, f.profiles.slice(0, scenario.active).map(profile => profile.name));
      assert.equal(paused.workerSteps.length, scenario.active);
      assert.equal(paused.needsContinuation, true, "parent approval must survive until explicit Resume");
      assert.ok(paused.workerSteps.every(step => step.status === "succeeded"), "in-flight results must be retained");

      await f.conversation.resumeTask({ taskRunId: f.taskRun.id });
      const resumed = await runner.runApproved({ approval: f.approved, plan: f.drafted.plan });
      assert.deepEqual(starts, f.profiles.map(profile => profile.name), "completed workers must not be replayed");
      assert.equal(resumed.workerSteps.length, scenario.count - scenario.active);
      assert.equal(resumed.needsContinuation, undefined);
      assert.equal((await f.state.getTaskRun(f.taskRun.id)).status, "ready_for_review");
    } finally {
      gate.resolve();
      await run?.catch(() => {});
      closeDb(f.db);
    }
  });
}

test("Pause during worker entry prevents invocation and leaves the worker resumable", async () => {
  const f = await createPauseFixture({ count: 1 });
  let calls = 0;
  const setCurrentStep = f.state.setTaskRunCurrentStep.bind(f.state);
  let injectPause = true;
  f.state.setTaskRunCurrentStep = async (...args) => {
    if (injectPause) {
      injectPause = false;
      await f.conversation.pauseTask({ taskRunId: f.taskRun.id });
    }
    return setCurrentStep(...args);
  };
  try {
    const runner = new WorkerRunner({ state: f.state, agentPlanning: {
      async invokeForWorker() { calls += 1; return { outputText: "done" }; },
    } });
    const paused = await runner.runApproved({ approval: f.approved, plan: f.drafted.plan });
    assert.equal(calls, 0);
    assert.equal((await f.state.getTaskRun(f.taskRun.id)).status, "paused");
    assert.equal(paused.needsContinuation, true);
    await f.conversation.resumeTask({ taskRunId: f.taskRun.id });
    await runner.runApproved({ approval: f.approved, plan: f.drafted.plan });
    assert.equal(calls, 1);
    assert.equal((await f.state.getTaskRun(f.taskRun.id)).status, "ready_for_review");
  } finally { closeDb(f.db); }
});

test("Pause racing with final status publication is not overwritten", async () => {
  const f = await createPauseFixture({ count: 1 });
  const updateStatus = f.state.taskRuns.updateStatus.bind(f.state.taskRuns);
  let injectPause = true;
  f.state.taskRuns.updateStatus = async (id, status, expectedStatus) => {
    if (injectPause && status === "ready_for_review") {
      injectPause = false;
      await updateStatus(id, "paused");
    }
    return updateStatus(id, status, expectedStatus);
  };
  try {
    const runner = new WorkerRunner({ state: f.state });
    const paused = await runner.runApproved({ approval: f.approved, plan: f.drafted.plan });
    assert.equal((await f.state.getTaskRun(f.taskRun.id)).status, "paused");
    assert.equal(paused.needsContinuation, true);
  } finally { closeDb(f.db); }
});

for (const duringEntry of [false, true]) {
  test(`orchestration service preserves Pause ${duringEntry ? "during" : "before"} approval entry`, async () => {
    const f = await createPauseFixture({ count: 1 });
    let calls = 0;
    try {
      const service = new OrchestrationService({ state: f.state, enabled: () => true, agentPlanning: {
        async invokeForWorker() { calls += 1; return { outputText: "done" }; },
      } });
      if (duringEntry) {
        const setStepStatus = f.state.setStepStatus.bind(f.state);
        let injectPause = true;
        f.state.setStepStatus = async (...args) => {
          if (injectPause) {
            injectPause = false;
            await f.conversation.pauseTask({ taskRunId: f.taskRun.id });
          }
          return setStepStatus(...args);
        };
      } else {
        await f.conversation.pauseTask({ taskRunId: f.taskRun.id });
      }
      const paused = await service.runApproved({ approvalId: f.approved.id });
      assert.equal(calls, 0);
      assert.equal(paused.needsContinuation, true);
      assert.equal((await f.state.getTaskRun(f.taskRun.id)).status, "paused");
      assert.equal((await f.state.getApproval(f.approved.id)).status, "approved");
      await f.conversation.resumeTask({ taskRunId: f.taskRun.id });
      await service.runApproved({ approvalId: f.approved.id });
      assert.equal(calls, 1);
      assert.equal((await f.state.getApproval(f.approved.id)).status, "executed");
    } finally { closeDb(f.db); }
  });
}

for (const status of ["cancelled", "done", "missing"]) {
  for (const entry of ["service", "worker"]) {
    test(`${entry} rejects ${status} task entry without consuming its approved plan`, async () => {
      const f = await createPauseFixture({ count: 1 });
      let calls = 0;
      try {
        if (status === "missing") {
          f.state.getTaskRun = async () => null;
        } else {
          if (status === "done") await f.state.setTaskRunStatus(f.taskRun.id, "ready_for_review");
          await f.state.setTaskRunStatus(f.taskRun.id, status);
        }
        const agentPlanning = { async invokeForWorker() { calls += 1; return { outputText: "never" }; } };
        const run = entry === "service"
          ? new OrchestrationService({ state: f.state, enabled: () => true, agentPlanning })
            .runApproved({ approvalId: f.approved.id })
          : new WorkerRunner({ state: f.state, agentPlanning })
            .runApproved({ approval: f.approved, plan: f.drafted.plan });
        await assert.rejects(run, error => error.code === "ORCHESTRATION_TASK_NOT_RUNNABLE");
        assert.equal(calls, 0);
        assert.equal((await f.state.getApproval(f.approved.id)).status, "approved");
        if (status !== "missing") assert.equal((await f.state.getTaskRun(f.taskRun.id)).status, status);
      } finally { closeDb(f.db); }
    });
  }
}

test("service rejects cancellation during approval entry without consuming its plan", async () => {
  const f = await createPauseFixture({ count: 1 });
  const setStepStatus = f.state.setStepStatus.bind(f.state);
  let calls = 0;
  f.state.setStepStatus = async (...args) => {
    await f.state.setTaskRunStatus(f.taskRun.id, "cancelled");
    return setStepStatus(...args);
  };
  try {
    const service = new OrchestrationService({ state: f.state, enabled: () => true, agentPlanning: {
      async invokeForWorker() { calls += 1; return { outputText: "never" }; },
    } });
    await assert.rejects(service.runApproved({ approvalId: f.approved.id }),
      error => error.code === "ORCHESTRATION_TASK_NOT_RUNNABLE");
    assert.equal(calls, 0);
    assert.equal((await f.state.getApproval(f.approved.id)).status, "approved");
    assert.equal((await f.state.getTaskRun(f.taskRun.id)).status, "cancelled");
  } finally { closeDb(f.db); }
});

test("Cancel after Pause remains terminal while in-flight workers drain", async () => {
  const f = await createPauseFixture({ parallel: true });
  const gate = deferred();
  const starts = [];
  let run;
  try {
    const runner = new WorkerRunner({ state: f.state, agentPlanning: {
      async invokeForWorker({ profile }) {
        starts.push(profile.name);
        await gate.promise;
        return { outputText: "done" };
      },
    } });
    run = runner.runApproved({ approval: f.approved, plan: f.drafted.plan });
    await waitFor(() => starts.length === 2, "initial workers must start");
    await f.conversation.pauseTask({ taskRunId: f.taskRun.id });
    await f.state.setTaskRunStatus(f.taskRun.id, "cancelled");
    gate.resolve();
    const result = await run;
    assert.equal(starts.length, 2);
    assert.equal(result.needsContinuation, undefined);
    assert.equal((await f.state.getTaskRun(f.taskRun.id)).status, "cancelled");
  } finally { gate.resolve(); await run?.catch(() => {}); closeDb(f.db); }
});

test("orchestration failure reporting does not overwrite concurrent Pause", async () => {
  const f = await createPauseFixture({ count: 1 });
  const error = new Error("profile read failed while pausing");
  f.state.agentProfiles.get = async () => {
    await f.conversation.pauseTask({ taskRunId: f.taskRun.id });
    throw error;
  };
  try {
    const service = new OrchestrationService({ state: f.state, enabled: () => true });
    await assert.rejects(service.runApproved({ approvalId: f.approved.id }), error);
    assert.equal((await f.state.getTaskRun(f.taskRun.id)).status, "paused");
    assert.equal((await f.state.getApproval(f.approved.id)).status, "approved");
  } finally { closeDb(f.db); }
});

test("Pause retains an in-flight proposal for approval after Resume", async () => {
  const f = await createPauseFixture({ count: 2 });
  f.drafted.plan.workerSteps[0].allowedActions = ["file_write"];
  const gate = deferred();
  const starts = [];
  let run;
  try {
    const runner = new WorkerRunner({ state: f.state, agentPlanning: {
      async invokeForWorker({ profile }) {
        starts.push(profile.name);
        await gate.promise;
        return { outputText: "done", proposedActions: profile.id === f.profiles[0].id
          ? [{ type: "file_write", path: "result.txt", after: "result\n", rationale: "write result" }]
          : [] };
      },
    } });
    run = runner.runApproved({ approval: f.approved, plan: f.drafted.plan });
    await waitFor(() => starts.length === 1, "first worker must start");
    await f.conversation.pauseTask({ taskRunId: f.taskRun.id });
    gate.resolve();
    const result = await run;
    assert.equal((await f.state.getTaskRun(f.taskRun.id)).status, "paused");
    assert.equal(result.proposedApprovalIds.length, 1);
    assert.equal((await f.state.getApproval(result.proposedApprovalIds[0])).status, "pending");
    assert.equal((await f.conversation.resumeTask({ taskRunId: f.taskRun.id })).status, "waiting_for_approval");
    await f.state.decideApproval(result.proposedApprovalIds[0], "executed", "test fixture applied");
    await runner.runApproved({ approval: f.approved, plan: f.drafted.plan });
    assert.deepEqual(starts, f.profiles.map(profile => profile.name));
  } finally { gate.resolve(); await run?.catch(() => {}); closeDb(f.db); }
});

test("Pause during backflow drains its worker without starting the retry", async () => {
  const f = await createPauseFixture();
  f.drafted.plan.backflowRules = [{
    id: "pause-backflow", trigger: "step_failed", maxAttempts: 2,
    targetStepId: f.drafted.plan.workerSteps[0].id,
    retryStepId: f.drafted.plan.workerSteps[1].id,
  }];
  const starts = [];
  try {
    const runner = new WorkerRunner({ state: f.state, agentPlanning: {
      async invokeForWorker({ profile }) {
        starts.push(profile.name);
        if (starts.length === 2) throw new Error("retry needed");
        if (starts.length === 3) await f.conversation.pauseTask({ taskRunId: f.taskRun.id });
        return { outputText: "done" };
      },
    } });
    const result = await runner.runApproved({ approval: f.approved, plan: f.drafted.plan });
    assert.deepEqual(starts, [f.profiles[0].name, f.profiles[1].name, f.profiles[0].name]);
    assert.equal((await f.state.getTaskRun(f.taskRun.id)).status, "paused");
    assert.equal(result.needsContinuation, true);
    const attempts = await f.state.pipelineBackflows.listByTaskRun(f.taskRun.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, "running", "Pause preserves the unfinished backflow for Resume");
  } finally { closeDb(f.db); }
});

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

// Phase 2 — when a WorkerCliInvoker is injected, pipeline-driven steps
// route through the real CLI (here mocked). The worker body must be the
// invoker's outputText, prefixed with the profile attribution line.
test("runApproved invokes the CLI invoker with profile+instruction and persists its output", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state, {
      userRequest: "Create a Kanban SaaS app with billing.",
    });
    const profile = await state.agentProfiles.create(
      validProfileInput({ name: "CliCoder", persona: "Be precise." }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Solo",
      description: "",
      steps: [
        {
          id: "s1",
          agentProfileId: profile.id,
          title: "Implement",
          instruction: "Refactor the parser without changing behaviour.",
          expectedArtifactKinds: ["log"],
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

    // Fake invoker — records calls so we can assert what the worker
    // forwarded, and returns deterministic text so the artifact body
    // is checkable. Real CLI is never touched.
    const calls = [];
    const fakeInvoker = {
      async invokeForWorker(input) {
        calls.push({
          taskRunId: input.taskRunId,
          stepId: input.stepId,
          profileId: input.profile.id,
          profileName: input.profile.name,
          userRequest: input.userRequest,
        });
        return { outputText: "MOCK_CLI_OUTPUT" };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });
    const result = await runner.runApproved({
      approval: approved,
      plan: drafted.plan,
    });
    assert.equal(result.workerSteps.length, 1);
    assert.equal(result.workerSteps[0].status, "succeeded");

    assert.equal(calls.length, 1, "invoker must be called once");
    assert.equal(calls[0].taskRunId, taskRun.id);
    assert.match(calls[0].stepId, /^stp_/);
    assert.equal(calls[0].profileId, profile.id);
    assert.equal(calls[0].profileName, "CliCoder");
    // The original user request and the full pipeline instruction must
    // both arrive at the invoker. Without this, pipeline workers only see
    // the static step instruction and lose what the user actually typed.
    assert.match(calls[0].userRequest, /ORIGINAL USER REQUEST/);
    assert.match(
      calls[0].userRequest,
      /Create a Kanban SaaS app with billing\./,
    );
    assert.match(calls[0].userRequest, /PIPELINE STEP INSTRUCTION/);
    assert.match(
      calls[0].userRequest,
      /Refactor the parser without changing behaviour\./,
    );
    assert.match(calls[0].userRequest, /WORKER OUTPUT CONTRACT/);
    assert.match(calls[0].userRequest, /file_write\.after/);
    assert.match(calls[0].userRequest, /Do not answer that direct modification is impossible/);
    assert.match(calls[0].userRequest, /emit proposedActions/);
    assert.match(calls[0].userRequest, /auto-approved and executed/);
    assert.match(calls[0].userRequest, /manual-only approval work/);
    assert.match(calls[0].userRequest, /I will not apply changes directly/);

    const artifacts = await state.listArtifactsByTaskRun(taskRun.id);
    const workerArtifact = artifacts.find(
      (a) => a.kind === "log" && a.title.startsWith("Worker output"),
    );
    assert.ok(workerArtifact, "worker artifact must exist");
    // The mocked CLI output must appear verbatim in the artifact.
    assert.match(workerArtifact.summary, /MOCK_CLI_OUTPUT/);
    // And the profile attribution line is still present.
    assert.match(workerArtifact.summary, /CliCoder/);
    const steps = await state.listStepsByTaskRun(taskRun.id);
    assert.ok(
      steps.some(
        (step) =>
          step.id === calls[0].stepId &&
          step.title === "Worker[CliCoder] Implement",
      ),
      "worker invocation step must carry the concrete agent profile name",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved passes prior worker outputs as internal handoff messages", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const plannerProfile = await state.agentProfiles.create(
      validProfileInput({
        name: "LocalPlanner",
        role: "planner",
        persona: "Plan local work.",
      }),
    );
    const coderProfile = await state.agentProfiles.create(
      validProfileInput({
        name: "LocalCoder",
        role: "coder",
        persona: "Implement from handoff.",
      }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Internal handoff",
      description: "",
      steps: [
        {
          id: "planner",
          agentProfileId: plannerProfile.id,
          title: "Plan",
          instruction: "Plan the parser change.",
          expectedArtifactKinds: ["log"],
        },
        {
          id: "coder",
          agentProfileId: coderProfile.id,
          title: "Implement",
          instruction: "Implement from the planner handoff.",
          expectedArtifactKinds: ["log"],
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "planner_worker",
      pipelineId: pipeline.id,
    });
    const approved = await approvePlanApproval(state, drafted.approval);
    const calls = [];
    const fakeInvoker = {
      async invokeForWorker(input) {
        calls.push({
          profileName: input.profile.name,
          userRequest: input.userRequest,
          handoffMessages: input.handoffMessages ?? [],
        });
        return {
          outputText:
            input.profile.name === "LocalPlanner"
              ? "Planner handoff: inspect worker-runner first."
              : "Coder consumed planner handoff.",
        };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });

    const result = await runner.runApproved({
      approval: approved,
      plan: drafted.plan,
    });

    assert.equal(result.workerSteps.length, 2);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].profileName, "LocalPlanner");
    assert.deepEqual(calls[0].handoffMessages, []);
    assert.equal(calls[1].profileName, "LocalCoder");
    assert.equal(calls[1].handoffMessages.length, 1);
    assert.equal(calls[1].handoffMessages[0].fromRole, "planner");
    assert.equal(calls[1].handoffMessages[0].fromTitle, "Plan");
    assert.match(
      calls[1].handoffMessages[0].content,
      /Planner handoff: inspect worker-runner first/,
    );
    assert.match(calls[1].handoffMessages[0].artifactId, /^art_/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved carries structured handoff payloads to dependent workers", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const plannerProfile = await state.agentProfiles.create(
      validProfileInput({
        name: "StructuredPlanner",
        role: "planner",
        persona: "Produce structured handoff.",
      }),
    );
    const coderProfile = await state.agentProfiles.create(
      validProfileInput({
        name: "StructuredCoder",
        role: "coder",
        persona: "Consume structured handoff.",
      }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Structured handoff",
      description: "",
      steps: [
        {
          id: "planner",
          agentProfileId: plannerProfile.id,
          title: "Plan",
          instruction: "Plan with evidence.",
          expectedArtifactKinds: ["log"],
          outputContract: "plan",
        },
        {
          id: "coder",
          agentProfileId: coderProfile.id,
          title: "Implement",
          instruction: "Implement from structured handoff.",
          expectedArtifactKinds: ["log"],
          dependsOn: ["planner"],
          outputContract: "diff_proposal",
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "multi_worker",
      pipelineId: pipeline.id,
    });
    const approved = await approvePlanApproval(state, drafted.approval);
    const calls = [];
    const fakeInvoker = {
      async invokeForWorker(input) {
        calls.push({
          profileName: input.profile.name,
          handoffMessages: input.handoffMessages ?? [],
        });
        if (input.profile.name === "StructuredPlanner") {
          return {
            outputText: [
              "Planner summary.",
              "",
              "```harness_worker_handoff_v1",
              JSON.stringify({
                schemaVersion: 1,
                status: "success",
                outputContract: "plan",
                producer: {
                  taskRunId: "spoofed",
                  planId: "spoofed",
                  stepId: "spoofed",
                  role: "planner",
                  title: "Spoofed",
                  artifactId: "spoofed",
                },
                summary: "Inspect worker-runner before implementation.",
                evidence: [
                  {
                    kind: "file",
                    ref: "packages/orchestration/src/worker-runner.ts",
                    note: "Handoff is created after worker output.",
                  },
                ],
                findings: [],
                proposedActions: [],
                changedFiles: [],
                verification: { run: [], passed: [], failed: [], notRun: [] },
                risks: [],
                nextActions: ["Implement structured payload propagation."],
              }),
              "```",
            ].join("\n"),
          };
        }
        return { outputText: "Coder consumed structured handoff." };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });

    await runner.runApproved({ approval: approved, plan: drafted.plan });

    assert.equal(calls.length, 2);
    const coderCall = calls[1];
    assert.equal(coderCall.profileName, "StructuredCoder");
    assert.equal(coderCall.handoffMessages.length, 1);
    const structuredPayload = coderCall.handoffMessages[0].structuredPayload;
    assert.ok(structuredPayload, "structured payload must be attached");
    assert.equal(
      structuredPayload.summary,
      "Inspect worker-runner before implementation.",
    );
    assert.equal(structuredPayload.producer.taskRunId, taskRun.id);
    assert.equal(structuredPayload.producer.stepId, drafted.plan.workerSteps[0].id);
    assert.match(structuredPayload.producer.artifactId, /^art_/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved limits handoff messages to declared dependencies", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const plannerProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Planner", role: "planner" }),
    );
    const reviewerProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Reviewer", role: "reviewer" }),
    );
    const testerProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Tester", role: "tester" }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Fanout",
      description: "",
      steps: [
        {
          id: "plan",
          agentProfileId: plannerProfile.id,
          title: "Plan",
          instruction: "Plan first.",
          expectedArtifactKinds: ["log"],
          dependsOn: [],
        },
        {
          id: "review",
          agentProfileId: reviewerProfile.id,
          title: "Review",
          instruction: "Review from plan.",
          expectedArtifactKinds: ["log"],
          dependsOn: ["plan"],
        },
        {
          id: "test",
          agentProfileId: testerProfile.id,
          title: "Test",
          instruction: "Test from plan.",
          expectedArtifactKinds: ["log"],
          dependsOn: ["plan"],
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "multi_worker",
      pipelineId: pipeline.id,
    });
    const approved = await approvePlanApproval(state, drafted.approval);
    const calls = [];
    const fakeInvoker = {
      async invokeForWorker(input) {
        calls.push({
          profileName: input.profile.name,
          handoffMessages: input.handoffMessages ?? [],
        });
        return { outputText: `${input.profile.name} output` };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });

    await runner.runApproved({ approval: approved, plan: drafted.plan });

    assert.equal(calls.length, 3);
    assert.equal(calls[1].profileName, "Reviewer");
    assert.deepEqual(
      calls[1].handoffMessages.map((m) => m.fromTitle),
      ["Plan"],
    );
    assert.equal(calls[2].profileName, "Tester");
    assert.deepEqual(
      calls[2].handoffMessages.map((m) => m.fromTitle),
      ["Plan"],
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved treats missing dependsOn as previous-step-only handoff", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const plannerProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Planner", role: "planner" }),
    );
    const coderProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Coder", role: "coder" }),
    );
    const reviewerProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Reviewer", role: "reviewer" }),
    );
    const testerProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Tester", role: "tester" }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Legacy linear handoff",
      description: "",
      steps: [
        {
          id: "plan",
          agentProfileId: plannerProfile.id,
          title: "Plan",
          instruction: "Plan first.",
          expectedArtifactKinds: ["log"],
        },
        {
          id: "code",
          agentProfileId: coderProfile.id,
          title: "Code",
          instruction: "Code second.",
          expectedArtifactKinds: ["log"],
        },
        {
          id: "review",
          agentProfileId: reviewerProfile.id,
          title: "Review",
          instruction: "Review third.",
          expectedArtifactKinds: ["log"],
        },
        {
          id: "test",
          agentProfileId: testerProfile.id,
          title: "Test",
          instruction: "Test fourth.",
          expectedArtifactKinds: ["log"],
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "multi_worker",
      pipelineId: pipeline.id,
    });
    const approved = await approvePlanApproval(state, drafted.approval);
    const legacyPlan = {
      ...drafted.plan,
      workerSteps: drafted.plan.workerSteps.map((step) => {
        const { dependsOn, ...withoutDependsOn } = step;
        return withoutDependsOn;
      }),
    };
    const calls = [];
    const fakeInvoker = {
      async invokeForWorker(input) {
        calls.push({
          profileName: input.profile.name,
          handoffTitles: (input.handoffMessages ?? []).map(
            (message) => message.fromTitle,
          ),
        });
        return { outputText: `${input.profile.name} output` };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });

    await runner.runApproved({ approval: approved, plan: legacyPlan });

    assert.deepEqual(
      calls.map((call) => [call.profileName, call.handoffTitles]),
      [
        ["Planner", []],
        ["Coder", ["Plan"]],
        ["Reviewer", ["Code"]],
        ["Tester", ["Review"]],
      ],
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved does not include transitive ancestor handoffs unless explicitly declared", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const plannerProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Planner", role: "planner" }),
    );
    const coderProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Coder", role: "coder" }),
    );
    const reviewerProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Reviewer", role: "reviewer" }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Direct-only handoff",
      description: "",
      steps: [
        {
          id: "plan",
          agentProfileId: plannerProfile.id,
          title: "Plan",
          instruction: "Plan first.",
          expectedArtifactKinds: ["log"],
          dependsOn: [],
        },
        {
          id: "code",
          agentProfileId: coderProfile.id,
          title: "Code",
          instruction: "Code from plan.",
          expectedArtifactKinds: ["log"],
          dependsOn: ["plan"],
        },
        {
          id: "review",
          agentProfileId: reviewerProfile.id,
          title: "Review",
          instruction: "Review code only.",
          expectedArtifactKinds: ["log"],
          dependsOn: ["code"],
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "multi_worker",
      pipelineId: pipeline.id,
    });
    const approved = await approvePlanApproval(state, drafted.approval);
    const calls = [];
    const fakeInvoker = {
      async invokeForWorker(input) {
        calls.push({
          profileName: input.profile.name,
          handoffTitles: (input.handoffMessages ?? []).map(
            (message) => message.fromTitle,
          ),
        });
        return { outputText: `${input.profile.name} output` };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });

    await runner.runApproved({ approval: approved, plan: drafted.plan });

    assert.deepEqual(
      calls.map((call) => [call.profileName, call.handoffTitles]),
      [
        ["Planner", []],
        ["Coder", ["Plan"]],
        ["Reviewer", ["Code"]],
      ],
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved executes read-only dependency waves in parallel", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const plannerProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Planner", role: "planner" }),
    );
    const reviewerProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Reviewer", role: "reviewer" }),
    );
    const perfProfile = await state.agentProfiles.create(
      validProfileInput({
        name: "Performance",
        role: "performance-reviewer",
      }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Parallel review",
      description: "",
      steps: [
        {
          id: "plan",
          agentProfileId: plannerProfile.id,
          title: "Plan",
          instruction: "Plan first.",
          expectedArtifactKinds: ["log"],
          dependsOn: [],
          allowedActions: [],
        },
        {
          id: "review",
          agentProfileId: reviewerProfile.id,
          title: "Review",
          instruction: "Review from plan.",
          expectedArtifactKinds: ["log"],
          dependsOn: ["plan"],
          allowedActions: [],
        },
        {
          id: "performance",
          agentProfileId: perfProfile.id,
          title: "Performance",
          instruction: "Review performance from plan.",
          expectedArtifactKinds: ["log"],
          dependsOn: ["plan"],
          allowedActions: [],
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "multi_worker",
      pipelineId: pipeline.id,
    });
    const approved = await approvePlanApproval(state, drafted.approval);
    const reviewGate = deferred();
    const performanceGate = deferred();
    const starts = [];
    const finishes = [];
    const fakeInvoker = {
      async invokeForWorker(input) {
        starts.push(input.profile.name);
        if (input.profile.name === "Planner") {
          finishes.push(input.profile.name);
          return { outputText: "Planner output" };
        }
        if (input.profile.name === "Reviewer") {
          await reviewGate.promise;
        }
        if (input.profile.name === "Performance") {
          await performanceGate.promise;
        }
        finishes.push(input.profile.name);
        return { outputText: `${input.profile.name} output` };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });

    const run = runner.runApproved({ approval: approved, plan: drafted.plan });

    await waitFor(
      () => starts.includes("Reviewer") && starts.includes("Performance"),
      "read-only sibling steps should both start before either gate resolves",
    );
    assert.deepEqual(finishes, ["Planner"]);

    reviewGate.resolve();
    performanceGate.resolve();
    const result = await run;

    assert.deepEqual(
      result.workerSteps.map((step) => step.title),
      ["Plan", "Review", "Performance"],
    );
    assert.deepEqual(
      result.workerSteps.map((step) => step.status),
      ["succeeded", "succeeded", "succeeded"],
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved executes independent approval-gated local workers in parallel when direct writes are disabled", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const coderProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Coder", role: "coder" }),
    );
    const testerProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Tester", role: "tester" }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Parallel implementation",
      description: "",
      steps: [
        {
          id: "code",
          agentProfileId: coderProfile.id,
          title: "Code",
          instruction: "Propose the code change.",
          expectedArtifactKinds: ["log"],
          dependsOn: [],
          allowedActions: ["file_patch"],
        },
        {
          id: "test",
          agentProfileId: testerProfile.id,
          title: "Test",
          instruction: "Propose the tests.",
          expectedArtifactKinds: ["log"],
          dependsOn: [],
          allowedActions: ["file_write", "shell"],
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "multi_worker",
      pipelineId: pipeline.id,
    });
    const approved = await approvePlanApproval(state, drafted.approval);
    const coderGate = deferred();
    const testerGate = deferred();
    const starts = [];
    const fakeInvoker = {
      async invokeForWorker(input) {
        starts.push(input.profile.name);
        if (input.profile.name === "Coder") await coderGate.promise;
        if (input.profile.name === "Tester") await testerGate.promise;
        if (input.profile.name === "Coder") {
          return {
            outputText: "Coder output",
            proposedActions: [
              {
                type: "file_patch",
                path: "src/parallel.ts",
                patch:
                  "--- a/src/parallel.ts\n+++ b/src/parallel.ts\n@@ -1 +1 @@\n-old\n+new\n",
                rationale: "apply the proposed implementation",
              },
            ],
          };
        }
        return {
          outputText: "Tester output",
          proposedActions: [
            {
              type: "shell",
              command: "npm",
              args: ["run", "check"],
              rationale: "verify the proposed implementation",
            },
          ],
        };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });

    const run = runner.runApproved({ approval: approved, plan: drafted.plan });

    await waitFor(
      () => starts.includes("Coder") && starts.includes("Tester"),
      "independent workers should both start while proposed actions remain approval-gated",
    );

    coderGate.resolve();
    testerGate.resolve();
    const result = await run;

    assert.deepEqual(starts, ["Coder", "Tester"]);
    assert.deepEqual(
      result.workerSteps.map((step) => step.status),
      ["succeeded", "succeeded"],
    );
    assert.equal(result.proposedApprovalIds.length, 2);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved keeps approval-gated workers serial when direct workspace writes are enabled", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const currentSettings = await state.getSettings();
    await state.updateSettings({
      ...currentSettings,
      agent: { ...currentSettings.agent, codexWorkspaceWrite: true },
    });
    const taskRun = await seedTaskRun(state);
    const firstProfile = await state.agentProfiles.create(
      validProfileInput({ name: "DirectWriterOne", role: "reviewer" }),
    );
    const secondProfile = await state.agentProfiles.create(
      validProfileInput({ name: "DirectWriterTwo", role: "reviewer" }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Serial direct writers",
      description: "",
      steps: [
        {
          id: "first",
          agentProfileId: firstProfile.id,
          title: "First",
          instruction: "Inspect and edit first.",
          expectedArtifactKinds: ["log"],
          dependsOn: [],
          allowedActions: ["file_patch"],
        },
        {
          id: "second",
          agentProfileId: secondProfile.id,
          title: "Second",
          instruction: "Inspect and edit second.",
          expectedArtifactKinds: ["log"],
          dependsOn: [],
          allowedActions: ["file_patch"],
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "multi_worker",
      pipelineId: pipeline.id,
    });
    const approved = await approvePlanApproval(state, drafted.approval);
    const firstGate = deferred();
    const starts = [];
    const fakeInvoker = {
      async invokeForWorker(input) {
        starts.push(input.profile.name);
        if (input.profile.name === "DirectWriterOne") await firstGate.promise;
        return { outputText: `${input.profile.name} output` };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });

    const run = runner.runApproved({ approval: approved, plan: drafted.plan });

    await waitFor(
      () => starts.includes("DirectWriterOne"),
      "first direct writer should start",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(starts, ["DirectWriterOne"]);

    firstGate.resolve();
    await waitFor(
      () => starts.includes("DirectWriterTwo"),
      "second direct writer should wait for the first",
    );
    await run;
    assert.deepEqual(starts, ["DirectWriterOne", "DirectWriterTwo"]);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved limits concurrent workers and starts queued work when a slot opens", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const currentSettings = await state.getSettings();
    await state.updateSettings({
      ...currentSettings,
      orchestration: {
        ...currentSettings.orchestration,
        maxParallelWorkers: 2,
      },
    });
    const taskRun = await seedTaskRun(state);
    const profiles = await Promise.all(
      ["One", "Two", "Three"].map((name) =>
        state.agentProfiles.create(
          validProfileInput({ name, role: "reviewer" }),
        ),
      ),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Bounded parallel review",
      description: "",
      steps: profiles.map((profile, index) => ({
        id: `review-${index}`,
        agentProfileId: profile.id,
        title: profile.name,
        instruction: `Review ${profile.name}.`,
        expectedArtifactKinds: ["log"],
        dependsOn: [],
        allowedActions: [],
      })),
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "multi_worker",
      pipelineId: pipeline.id,
    });
    const approved = await approvePlanApproval(state, drafted.approval);
    const gates = new Map(profiles.map((profile) => [profile.name, deferred()]));
    const starts = [];
    const fakeInvoker = {
      async invokeForWorker(input) {
        starts.push(input.profile.name);
        await gates.get(input.profile.name).promise;
        return { outputText: `${input.profile.name} output` };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });

    const run = runner.runApproved({ approval: approved, plan: drafted.plan });
    await waitFor(() => starts.length === 2, "two worker slots should start");
    assert.deepEqual(starts, ["One", "Two"]);

    gates.get("One").resolve();
    await waitFor(() => starts.length === 3, "queued worker should start when a slot opens");
    assert.deepEqual(starts, ["One", "Two", "Three"]);

    gates.get("Two").resolve();
    gates.get("Three").resolve();
    await run;
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved does not start queued workers or overwrite status after TaskRun cancellation", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const currentSettings = await state.getSettings();
    await state.updateSettings({
      ...currentSettings,
      orchestration: { ...currentSettings.orchestration, maxParallelWorkers: 2 },
    });
    const taskRun = await seedTaskRun(state);
    const profiles = await Promise.all(
      ["CancelOne", "CancelTwo", "NeverStarts"].map((name) =>
        state.agentProfiles.create(validProfileInput({ name, role: "reviewer" })),
      ),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Cancellable wave",
      description: "",
      steps: profiles.map((profile, index) => ({
        id: `cancel-${index}`,
        agentProfileId: profile.id,
        title: profile.name,
        instruction: "Review.",
        expectedArtifactKinds: ["log"],
        dependsOn: [],
        allowedActions: [],
      })),
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({ taskRunId: taskRun.id, mode: "multi_worker", pipelineId: pipeline.id });
    const approved = await approvePlanApproval(state, drafted.approval);
    const gate = deferred();
    const starts = [];
    const runner = new WorkerRunner({
      state,
      agentPlanning: {
        async invokeForWorker(input) {
          starts.push(input.profile.name);
          await gate.promise;
          return { outputText: `${input.profile.name} output` };
        },
      },
    });

    const run = runner.runApproved({ approval: approved, plan: drafted.plan });
    await waitFor(() => starts.length === 2, "active wave slots should start");
    await state.setTaskRunStatus(taskRun.id, "cancelled");
    gate.resolve();
    await run;

    assert.deepEqual(starts, ["CancelOne", "CancelTwo"]);
    assert.equal((await state.getTaskRun(taskRun.id)).status, "cancelled");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved waits for every declared dependency before a fan-in worker", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const plannerProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Planner", role: "planner" }),
    );
    const reviewerProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Reviewer", role: "reviewer" }),
    );
    const architectProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Architect", role: "orchestrator" }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Fan in",
      description: "",
      steps: [
        {
          id: "plan",
          agentProfileId: plannerProfile.id,
          title: "Plan",
          instruction: "Plan first.",
          expectedArtifactKinds: ["log"],
          dependsOn: [],
          allowedActions: [],
        },
        {
          id: "review",
          agentProfileId: reviewerProfile.id,
          title: "Review",
          instruction: "Review independently.",
          expectedArtifactKinds: ["log"],
          dependsOn: [],
          allowedActions: [],
        },
        {
          id: "synthesize",
          agentProfileId: architectProfile.id,
          title: "Synthesize",
          instruction: "Use both upstream results.",
          expectedArtifactKinds: ["log"],
          dependsOn: ["plan", "review"],
          allowedActions: [],
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "multi_worker",
      pipelineId: pipeline.id,
    });
    const approved = await approvePlanApproval(state, drafted.approval);
    const planGate = deferred();
    const reviewGate = deferred();
    const calls = [];
    const fakeInvoker = {
      async invokeForWorker(input) {
        calls.push({
          profileName: input.profile.name,
          handoffMessages: input.handoffMessages ?? [],
        });
        if (input.profile.name === "Planner") await planGate.promise;
        if (input.profile.name === "Reviewer") await reviewGate.promise;
        return { outputText: `${input.profile.name} output` };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });

    const run = runner.runApproved({ approval: approved, plan: drafted.plan });

    await waitFor(
      () =>
        calls.some((call) => call.profileName === "Planner") &&
        calls.some((call) => call.profileName === "Reviewer"),
      "parallel upstream workers should start first",
    );
    assert.equal(
      calls.some((call) => call.profileName === "Architect"),
      false,
      "fan-in worker must not start until all dependencies finish",
    );

    planGate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      calls.some((call) => call.profileName === "Architect"),
      false,
      "fan-in worker must still wait for the second dependency",
    );

    reviewGate.resolve();
    await waitFor(
      () => calls.some((call) => call.profileName === "Architect"),
      "fan-in worker should start after every dependency finishes",
    );
    await run;

    const architectCall = calls.find((call) => call.profileName === "Architect");
    assert.deepEqual(
      architectCall.handoffMessages.map((message) => message.fromTitle),
      ["Plan", "Review"],
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved keeps non-read-only waves serial even when dependencies are empty", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const firstProfile = await state.agentProfiles.create(
      validProfileInput({ name: "ReviewerOne", role: "reviewer" }),
    );
    const secondProfile = await state.agentProfiles.create(
      validProfileInput({ name: "ReviewerTwo", role: "reviewer" }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Default action scope",
      description: "",
      steps: [
        {
          id: "first",
          agentProfileId: firstProfile.id,
          title: "First",
          instruction: "Inspect first.",
          expectedArtifactKinds: ["log"],
          dependsOn: [],
        },
        {
          id: "second",
          agentProfileId: secondProfile.id,
          title: "Second",
          instruction: "Inspect second.",
          expectedArtifactKinds: ["log"],
          dependsOn: [],
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "multi_worker",
      pipelineId: pipeline.id,
    });
    const approved = await approvePlanApproval(state, drafted.approval);
    const firstGate = deferred();
    const starts = [];
    const fakeInvoker = {
      async invokeForWorker(input) {
        starts.push(input.profile.name);
        if (input.profile.name === "ReviewerOne") {
          await firstGate.promise;
        }
        return { outputText: `${input.profile.name} output` };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });

    const run = runner.runApproved({ approval: approved, plan: drafted.plan });

    await waitFor(
      () => starts.includes("ReviewerOne"),
      "first serial step should start",
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(starts, ["ReviewerOne"]);

    firstGate.resolve();
    await waitFor(
      () => starts.includes("ReviewerTwo"),
      "second serial step should start after the first finishes",
    );
    const result = await run;

    assert.deepEqual(
      result.workerSteps.map((step) => step.title),
      ["First", "Second"],
    );
    assert.deepEqual(starts, ["ReviewerOne", "ReviewerTwo"]);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved forwards remoteEndpointId to the worker invoker", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const profile = await state.agentProfiles.create(
      validProfileInput({ name: "RemoteController", persona: "Route to A2A." }),
    );
    const endpoint = await state.a2aRemoteAgents.upsertEndpoint(
      validEndpointInput(),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Remote worker",
      description: "",
      steps: [
        {
          id: "s_remote",
          agentProfileId: profile.id,
          remoteEndpointId: endpoint.id,
          title: "Remote implement",
          instruction: "Do remote work.",
          expectedArtifactKinds: ["log"],
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
    const calls = [];
    const fakeInvoker = {
      async invokeForWorker(input) {
        calls.push(input);
        return { outputText: "REMOTE_OUTPUT" };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });

    const result = await runner.runApproved({
      approval: approved,
      plan: drafted.plan,
    });

    assert.equal(result.workerSteps[0].status, "succeeded");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].remoteEndpointId, endpoint.id);
    const artifacts = await state.listArtifactsByTaskRun(taskRun.id);
    const workerArtifact = artifacts.find(
      (a) => a.kind === "log" && a.title.startsWith("Worker output"),
    );
    assert.match(workerArtifact.summary, /Remote A2A/);
    assert.match(workerArtifact.summary, /Remote Reviewer/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved creates downstream approvals for worker file_write proposals", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const profile = await state.agentProfiles.create(
      validProfileInput({ name: "CliCoder", persona: "Be precise." }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Solo",
      description: "",
      steps: [
        {
          id: "s1",
          agentProfileId: profile.id,
          title: "Implement",
          instruction: "Create and update files.",
          expectedArtifactKinds: ["log"],
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

    const fakeInvoker = {
      async invokeForWorker() {
        return {
          outputText: "Worker proposed file changes.",
          proposedActions: [
            {
              type: "file_write",
              path: "created.txt",
              after: "created\n",
              rationale: "create requested file",
            },
            {
              type: "file_write",
              path: "existing.txt",
              before: "old\n",
              after: "new\n",
              rationale: "modify requested file",
            },
          ],
        };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });
    const result = await runner.runApproved({
      approval: approved,
      plan: drafted.plan,
    });

    assert.equal(result.proposedApprovalIds.length, 2);
    const approvals = await state.listApprovalsByTaskRun(taskRun.id);
    const downstream = approvals
      .filter((a) => result.proposedApprovalIds.includes(a.id))
      .sort((a, b) =>
        a.proposedAction.filePatch.path.localeCompare(
          b.proposedAction.filePatch.path,
        ),
      );
    assert.equal(downstream.length, 2);
    assert.deepEqual(
      downstream.map((a) => a.status),
      ["pending", "pending"],
    );
    assert.deepEqual(
      downstream.map((a) => a.actionType),
      ["file_write", "file_write"],
    );
    assert.deepEqual(downstream[0].proposedAction, {
      type: "file_write",
      filePatch: { path: "created.txt", after: "created\n" },
    });
    assert.deepEqual(downstream[1].proposedAction, {
      type: "file_write",
      filePatch: { path: "existing.txt", before: "old\n", after: "new\n" },
    });
    const updatedTaskRun = await state.getTaskRun(taskRun.id);
    assert.equal(updatedTaskRun.status, "waiting_for_approval");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved creates downstream approvals for worker file_patch proposals", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const profile = await state.agentProfiles.create(
      validProfileInput({ name: "PatchCoder", persona: "Patch precisely." }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Patch flow",
      description: "",
      steps: [
        {
          id: "s1",
          agentProfileId: profile.id,
          title: "Patch",
          instruction: "Patch one file.",
          expectedArtifactKinds: ["log"],
          allowedActions: ["file_patch"],
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
    const rawPatch = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index 2bb0f4f..7b1d2ce 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const normalizedPatch = "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const fakeInvoker = {
      async invokeForWorker() {
        return {
          outputText: "Worker proposed a patch.",
          proposedActions: [
            {
              type: "file_patch",
              path: "src/foo.ts",
              patch: rawPatch,
              rationale: "partial update",
            },
          ],
        };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });
    const result = await runner.runApproved({
      approval: approved,
      plan: drafted.plan,
    });

    assert.equal(result.proposedApprovalIds.length, 1);
    const approval = await state.getApproval(result.proposedApprovalIds[0]);
    assert.equal(approval.actionType, "file_patch");
    assert.deepEqual(approval.proposedAction, {
      type: "file_patch",
      unifiedPatch: { path: "src/foo.ts", patch: normalizedPatch },
    });
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved turns worker shell proposals into approvals without executing them", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const profile = await state.agentProfiles.create(
      validProfileInput({ name: "ShellPlanner", role: "coder" }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Shell approval",
      description: "",
      steps: [
        {
          id: "s1",
          agentProfileId: profile.id,
          title: "Plan command",
          instruction: "Suggest a verification command.",
          expectedArtifactKinds: ["log"],
          allowedActions: ["shell"],
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
    const fakeInvoker = {
      async invokeForWorker() {
        return {
          outputText: "Worker proposed a command.",
          proposedActions: [
            {
              type: "shell",
              command: "npm",
              args: ["run", "check"],
              rationale: "verify types before review",
            },
          ],
        };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });
    const result = await runner.runApproved({
      approval: approved,
      plan: drafted.plan,
    });

    assert.equal(result.proposedApprovalIds.length, 1);
    const approvals = await state.listApprovalsByTaskRun(taskRun.id);
    const shellApprovals = approvals.filter(
      (approval) => approval.actionType === "shell",
    );
    assert.equal(shellApprovals.length, 1);
    assert.deepEqual(shellApprovals[0].proposedAction, {
      type: "shell",
      command: "npm",
      args: ["run", "check"],
    });
    const steps = await state.listStepsByTaskRun(taskRun.id);
    assert.equal(
      steps.some((step) => step.kind === "shell"),
      false,
      "worker shell proposals must not create shell runner steps before approval",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved creates approvals from structured worker handoff proposedActions", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const profile = await state.agentProfiles.create(
      validProfileInput({ name: "StructuredCoder", role: "coder" }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Structured handoff actions",
      description: "",
      steps: [
        {
          id: "patch",
          agentProfileId: profile.id,
          title: "Patch",
          instruction: "Patch an existing file.",
          expectedArtifactKinds: ["log"],
          outputContract: "diff_proposal",
          allowedActions: ["file_patch"],
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
    const patch = [
      "--- a/src/render.ts",
      "+++ b/src/render.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const fakeInvoker = {
      async invokeForWorker() {
        return {
          outputText: [
            "Patch proposal.",
            "",
            "```harness_worker_handoff_v1",
            JSON.stringify({
              schemaVersion: 1,
              status: "success",
              outputContract: "diff_proposal",
              producer: {
                taskRunId: "spoofed",
                planId: "spoofed",
                stepId: "spoofed",
                role: "coder",
                title: "Spoofed",
                artifactId: "spoofed",
              },
              summary: "Propose a single-file patch.",
              evidence: [],
              findings: [],
              proposedActions: [
                {
                  type: "file_patch",
                  path: "src/render.ts",
                  patch,
                  rationale: "update stale render order",
                },
              ],
              changedFiles: [],
              verification: { run: [], passed: [], failed: [], notRun: [] },
              risks: [],
              nextActions: [],
            }),
            "```",
          ].join("\n"),
        };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });

    const result = await runner.runApproved({
      approval: approved,
      plan: drafted.plan,
    });

    assert.equal(result.proposedApprovalIds.length, 1);
    const approvals = await state.listApprovalsByTaskRun(taskRun.id);
    const patchApproval = approvals.find(
      (approval) => approval.actionType === "file_patch",
    );
    assert.ok(patchApproval, "worker handoff file_patch should become an approval");
    assert.deepEqual(patchApproval.proposedAction, {
      type: "file_patch",
      unifiedPatch: {
        path: "src/render.ts",
        patch,
      },
    });
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved fails diff_proposal worker steps with no file action approvals", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const profile = await state.agentProfiles.create(
      validProfileInput({ name: "AssetBuilder", role: "coder" }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "3D asset flow",
      description: "",
      steps: [
        {
          id: "modeling",
          agentProfileId: profile.id,
          title: "3D modeling",
          instruction: "Create model files.",
          expectedArtifactKinds: ["file", "log"],
          outputContract: "diff_proposal",
          allowedActions: ["file_write", "file_patch"],
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
    const fakeInvoker = {
      async invokeForWorker() {
        return {
          outputText:
            "I described the model and texture layout, but emitted no file action.",
          proposedActions: [],
        };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });

    const result = await runner.runApproved({
      approval: approved,
      plan: drafted.plan,
    });

    assert.equal(result.proposedApprovalIds.length, 0);
    assert.equal(result.workerSteps.length, 1);
    assert.equal(result.workerSteps[0].status, "failed");
    const updatedTaskRun = await state.getTaskRun(taskRun.id);
    assert.equal(updatedTaskRun.status, "blocked");
    const artifacts = await state.listArtifactsByTaskRun(taskRun.id);
    const workerArtifact = artifacts.find((artifact) =>
      artifact.title.startsWith("Worker output: 3D modeling"),
    );
    assert.ok(workerArtifact, "worker output artifact should be persisted");
    assert.match(
      workerArtifact.summary,
      /diff_proposal worker did not produce a file_write or file_patch approval/,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved fails test_result worker steps with no shell approval", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const profile = await state.agentProfiles.create(
      validProfileInput({ name: "Verifier", role: "tester" }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "3D validation flow",
      description: "",
      steps: [
        {
          id: "execution-validation",
          agentProfileId: profile.id,
          title: "Execution validation",
          instruction: "Run the narrow smoke check.",
          expectedArtifactKinds: ["test_result", "log"],
          outputContract: "test_result",
          allowedActions: ["shell"],
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
    const fakeInvoker = {
      async invokeForWorker() {
        return {
          outputText: "I recommend running npm test later.",
          proposedActions: [],
        };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });

    const result = await runner.runApproved({
      approval: approved,
      plan: drafted.plan,
    });

    assert.equal(result.proposedApprovalIds.length, 0);
    assert.equal(result.workerSteps.length, 1);
    assert.equal(result.workerSteps[0].status, "failed");
    const updatedTaskRun = await state.getTaskRun(taskRun.id);
    assert.equal(updatedTaskRun.status, "blocked");
    const artifacts = await state.listArtifactsByTaskRun(taskRun.id);
    const workerArtifact = artifacts.find((artifact) =>
      artifact.title.startsWith("Worker output: Execution validation"),
    );
    assert.ok(workerArtifact, "worker output artifact should be persisted");
    assert.match(
      workerArtifact.summary,
      /test_result worker did not produce a shell approval/,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved pauses downstream workers until worker file approvals execute", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const coderProfile = await state.agentProfiles.create(
      validProfileInput({ name: "CliCoder", role: "coder" }),
    );
    const reviewerProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Reviewer", role: "reviewer" }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Immediate approvals",
      description: "",
      steps: [
        {
          id: "write",
          agentProfileId: coderProfile.id,
          title: "Write",
          instruction: "Create a file.",
          expectedArtifactKinds: ["log"],
          dependsOn: [],
          allowedActions: ["file_write"],
        },
        {
          id: "review",
          agentProfileId: reviewerProfile.id,
          title: "Review",
          instruction: "Review after the write proposal.",
          expectedArtifactKinds: ["log"],
          dependsOn: ["write"],
          allowedActions: [],
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "multi_worker",
      pipelineId: pipeline.id,
    });
    const approved = await approvePlanApproval(state, drafted.approval);
    const starts = [];
    const reviewerPrompts = [];
    const reviewerHandoffs = [];
    const changedTaskRuns = [];
    const fakeInvoker = {
      async invokeForWorker(input) {
        starts.push(input.profile.name);
        if (input.profile.name === "CliCoder") {
          return {
            outputText: "Worker proposed file changes.",
            proposedActions: [
              {
                type: "file_write",
                path: "created-early.txt",
                after: "created early\n",
                rationale: "create as soon as this worker finishes",
              },
            ],
          };
        }
        reviewerPrompts.push(input.userRequest);
        reviewerHandoffs.push(...(input.handoffMessages ?? []));
        return { outputText: "Reviewer output" };
      },
    };
    const runner = new WorkerRunner({
      state,
      agentPlanning: fakeInvoker,
      onTaskRunChanged: (taskRunId) => changedTaskRuns.push(taskRunId),
    });

    const firstResult = await runner.runApproved({
      approval: approved,
      plan: drafted.plan,
    });

    assert.deepEqual(starts, ["CliCoder"]);
    assert.equal(firstResult.needsContinuation, true);
    const approvalsAfterPause = await state.listApprovalsByTaskRun(taskRun.id);
    const workerFileApprovals = approvalsAfterPause.filter(
      (approval) =>
        approval.actionType === "file_write" &&
        approval.proposedAction?.filePatch?.path === "created-early.txt",
    );
    assert.equal(
      workerFileApprovals.length,
      1,
      "first worker file proposal should be visible before later workers finish",
    );
    assert.ok(
      changedTaskRuns.includes(taskRun.id),
      "approval creation should notify the renderer immediately",
    );
    const pausedTaskRun = await state.getTaskRun(taskRun.id);
    assert.equal(pausedTaskRun.status, "waiting_for_approval");

    await state.decideApproval(workerFileApprovals[0].id, "executed", "applied");
    const secondResult = await runner.runApproved({
      approval: approved,
      plan: drafted.plan,
    });
    assert.deepEqual(starts, ["CliCoder", "Reviewer"]);
    assert.equal(secondResult.needsContinuation, undefined);
    assert.deepEqual(secondResult.proposedApprovalIds, []);
    assert.match(
      reviewerHandoffs.map((message) => message.content).join("\n"),
      /Worker proposed file changes\./,
      "reviewer should receive the implementation handoff after resume",
    );
    assert.match(reviewerPrompts[0], /Review after the write proposal/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved rejects proposed actions outside step allowedActions", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const profile = await state.agentProfiles.create(
      validProfileInput({ name: "ReadOnlyCoder", persona: "Do not edit." }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Read only",
      description: "",
      steps: [
        {
          id: "s1",
          agentProfileId: profile.id,
          title: "Inspect",
          instruction: "Inspect only.",
          expectedArtifactKinds: ["log"],
          allowedActions: [],
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
    const fakeInvoker = {
      async invokeForWorker() {
        return {
          outputText: "Tried to propose a write.",
          proposedActions: [
            {
              type: "file_write",
              path: "blocked.txt",
              after: "blocked\n",
              rationale: "should be blocked",
            },
          ],
        };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });
    const result = await runner.runApproved({
      approval: approved,
      plan: drafted.plan,
    });

    assert.deepEqual(result.proposedApprovalIds, []);
    const artifacts = await state.listArtifactsByTaskRun(taskRun.id);
    const policyArtifact = artifacts.find(
      (a) => a.title === "Worker action policy report",
    );
    assert.ok(policyArtifact, "policy report artifact must be created");
    assert.match(policyArtifact.summary, /not allowed for this worker step/);
    const updatedTaskRun = await state.getTaskRun(taskRun.id);
    assert.equal(updatedTaskRun.status, "ready_for_review");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved rejects worker file_write proposals whose after is an instruction", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const profile = await state.agentProfiles.create(
      validProfileInput({ name: "CliCoder", role: "coder" }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Instruction after guard",
      description: "",
      steps: [
        {
          id: "s1",
          agentProfileId: profile.id,
          title: "Implement",
          instruction: "Create the contract file.",
          expectedArtifactKinds: ["log"],
          allowedActions: ["file_write"],
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
    const fakeInvoker = {
      async invokeForWorker() {
        return {
          outputText: "Worker proposed an instruction instead of file content.",
          proposedActions: [
            {
              type: "file_write",
              path: "src/FlyContract.cs",
              after:
                "이 파일에 public contract를 명확히 하는 인터페이스 설명과 검증 로직을 추가하세요.",
              rationale: "clarify the contract",
            },
          ],
        };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });
    const result = await runner.runApproved({
      approval: approved,
      plan: drafted.plan,
    });

    assert.deepEqual(result.proposedApprovalIds, []);
    const approvals = await state.listApprovalsByTaskRun(taskRun.id);
    assert.equal(
      approvals.filter((approval) => approval.actionType === "file_write").length,
      0,
      "instruction-like after content must not become a file_write approval",
    );
    const artifacts = await state.listArtifactsByTaskRun(taskRun.id);
    const policyArtifact = artifacts.find(
      (artifact) => artifact.title === "Worker action policy report",
    );
    assert.ok(policyArtifact, "policy report artifact must explain the rejection");
    assert.match(policyArtifact.summary, /complete file content/i);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

// Phase 2 — when the invoker throws, the worker step is marked failed
// and the error message is captured in the artifact. The runner must
// not unwind subsequent steps in the same plan; the loop already breaks
// on `status === "failed"` as part of the policy.
test("runApproved marks the step failed when the CLI invoker throws", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const profile = await state.agentProfiles.create(validProfileInput());
    const pipeline = await state.agentPipelines.create({
      name: "Solo",
      description: "",
      steps: [
        {
          id: "s1",
          agentProfileId: profile.id,
          title: "Implement",
          instruction: "Do work.",
          expectedArtifactKinds: ["log"],
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

    const failingInvoker = {
      async invokeForWorker() {
        throw new Error("CLI exploded");
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: failingInvoker });
    const result = await runner.runApproved({
      approval: approved,
      plan: drafted.plan,
    });
    assert.equal(result.workerSteps[0].status, "failed");
    const artifacts = await state.listArtifactsByTaskRun(taskRun.id);
    const workerArtifact = artifacts.find(
      (a) => a.kind === "log" && a.title.startsWith("Worker output"),
    );
    assert.ok(workerArtifact, "worker artifact must exist even on failure");
    assert.match(workerArtifact.summary, /CLI exploded/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved routes a failed step through configured pipeline backflow and retries it", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const plannerProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Planner", role: "planner" }),
    );
    const coderProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Coder", role: "coder" }),
    );
    const testerProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Tester", role: "tester" }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Backflow delivery",
      description: "",
      steps: [
        {
          id: "plan",
          agentProfileId: plannerProfile.id,
          title: "Plan",
          instruction: "Plan first.",
          expectedArtifactKinds: ["log"],
          dependsOn: [],
        },
        {
          id: "code",
          agentProfileId: coderProfile.id,
          title: "Code",
          instruction: "Code from plan.",
          expectedArtifactKinds: ["log"],
          dependsOn: ["plan"],
        },
        {
          id: "test",
          agentProfileId: testerProfile.id,
          title: "Test",
          instruction: "Test after code.",
          expectedArtifactKinds: ["log"],
          dependsOn: ["code"],
        },
      ],
      backflowRules: [
        {
          id: "bf_code",
          trigger: "step_failed",
          targetStepId: "plan",
          retryStepId: "code",
          maxAttempts: 2,
          instruction: "Revise the plan before retrying code.",
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "multi_worker",
      pipelineId: pipeline.id,
    });
    const approved = await approvePlanApproval(state, drafted.approval);
    const calls = [];
    const fakeInvoker = {
      async invokeForWorker(input) {
        calls.push(input.profile.name);
        if (
          input.profile.name === "Coder" &&
          calls.filter((name) => name === "Coder").length === 1
        ) {
          throw new Error("code failed first");
        }
        return { outputText: `${input.profile.name} output` };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });

    const result = await runner.runApproved({ approval: approved, plan: drafted.plan });

    assert.deepEqual(calls, ["Planner", "Coder", "Planner", "Coder", "Tester"]);
    assert.equal(result.workerSteps.at(-1).title, "Test");
    assert.equal(result.workerSteps.at(-1).status, "succeeded");
    assert.equal((await state.getTaskRun(taskRun.id)).status, "ready_for_review");
    const attempts = await state.pipelineBackflows.listByTaskRun(taskRun.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].ruleId, "bf_code");
    assert.equal(attempts[0].status, "succeeded");
    const events = await state.pipelineBackflows.listActivityEvents({
      limit: 25,
      offset: 0,
    });
    assert.deepEqual(
      events.items.map((event) => event.eventType).reverse(),
      ["triggered", "target_started", "target_succeeded", "retry_started", "retry_succeeded"],
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved replays the dependency path from backflow target to retry step", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const plannerProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Planner", role: "planner" }),
    );
    const coderProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Coder", role: "coder" }),
    );
    const reviewerProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Reviewer", role: "reviewer" }),
    );
    const testerProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Tester", role: "tester" }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Backflow path replay",
      description: "",
      steps: [
        {
          id: "plan",
          agentProfileId: plannerProfile.id,
          title: "Plan",
          instruction: "Plan first.",
          expectedArtifactKinds: ["log"],
          dependsOn: [],
        },
        {
          id: "code",
          agentProfileId: coderProfile.id,
          title: "Code",
          instruction: "Code from plan.",
          expectedArtifactKinds: ["log"],
          dependsOn: ["plan"],
        },
        {
          id: "review",
          agentProfileId: reviewerProfile.id,
          title: "Review",
          instruction: "Review code.",
          expectedArtifactKinds: ["log"],
          dependsOn: ["code"],
        },
        {
          id: "test",
          agentProfileId: testerProfile.id,
          title: "Test",
          instruction: "Test after review.",
          expectedArtifactKinds: ["log"],
          dependsOn: ["review"],
        },
      ],
      backflowRules: [
        {
          id: "bf_test",
          trigger: "step_failed",
          targetStepId: "plan",
          retryStepId: "test",
          maxAttempts: 2,
          instruction: "Refresh the whole path before retrying tests.",
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "multi_worker",
      pipelineId: pipeline.id,
    });
    const approved = await approvePlanApproval(state, drafted.approval);
    const calls = [];
    const fakeInvoker = {
      async invokeForWorker(input) {
        calls.push(input.profile.name);
        if (
          input.profile.name === "Tester" &&
          calls.filter((name) => name === "Tester").length === 1
        ) {
          throw new Error("test failed first");
        }
        return { outputText: `${input.profile.name} output` };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });

    await runner.runApproved({ approval: approved, plan: drafted.plan });

    assert.deepEqual(calls, [
      "Planner",
      "Coder",
      "Reviewer",
      "Tester",
      "Planner",
      "Coder",
      "Reviewer",
      "Tester",
    ]);
    assert.equal((await state.getTaskRun(taskRun.id)).status, "ready_for_review");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("runApproved blocks when backflow maxAttempts is already exhausted", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const plannerProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Planner", role: "planner" }),
    );
    const coderProfile = await state.agentProfiles.create(
      validProfileInput({ name: "Coder", role: "coder" }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Backflow max",
      description: "",
      steps: [
        {
          id: "plan",
          agentProfileId: plannerProfile.id,
          title: "Plan",
          instruction: "Plan first.",
          expectedArtifactKinds: ["log"],
          dependsOn: [],
        },
        {
          id: "code",
          agentProfileId: coderProfile.id,
          title: "Code",
          instruction: "Code from plan.",
          expectedArtifactKinds: ["log"],
          dependsOn: ["plan"],
        },
      ],
      backflowRules: [
        {
          id: "bf_code",
          trigger: "step_failed",
          targetStepId: "plan",
          retryStepId: "code",
          maxAttempts: 1,
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "multi_worker",
      pipelineId: pipeline.id,
    });
    await state.pipelineBackflows.createAttempt({
      taskRunId: taskRun.id,
      planId: drafted.plan.id,
      ruleId: "bf_code",
      trigger: "step_failed",
      targetStepId: drafted.plan.backflowRules[0].targetStepId,
      retryStepId: drafted.plan.backflowRules[0].retryStepId,
      maxAttempts: 1,
      status: "failed",
    });
    const approved = await approvePlanApproval(state, drafted.approval);
    const fakeInvoker = {
      async invokeForWorker(input) {
        if (input.profile.name === "Coder") {
          throw new Error("still failing");
        }
        return { outputText: `${input.profile.name} output` };
      },
    };
    const runner = new WorkerRunner({ state, agentPlanning: fakeInvoker });

    await runner.runApproved({ approval: approved, plan: drafted.plan });

    assert.equal((await state.getTaskRun(taskRun.id)).status, "blocked");
    const events = await state.pipelineBackflows.listActivityEvents({
      limit: 25,
      offset: 0,
    });
    assert.equal(events.items[0].eventType, "max_attempts_reached");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

// Without an invoker injected, the legacy deterministic stub remains
// the source of truth — important for backward compatibility with
// existing tests and for legacy mode-driven plans where no profile
// is attached.
test("runApproved falls back to deterministic stub when no invoker is injected", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const profile = await state.agentProfiles.create(
      validProfileInput({ name: "StubCoder", persona: "" }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Solo",
      description: "",
      steps: [
        {
          id: "s1",
          agentProfileId: profile.id,
          title: "Implement",
          instruction: "Do work.",
          expectedArtifactKinds: ["log"],
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
    const runner = new WorkerRunner({ state }); // no agentPlanning
    const result = await runner.runApproved({
      approval: approved,
      plan: drafted.plan,
    });
    assert.equal(result.workerSteps[0].status, "succeeded");
    const artifacts = await state.listArtifactsByTaskRun(taskRun.id);
    const workerArtifact = artifacts.find(
      (a) => a.kind === "log" && a.title.startsWith("Worker output"),
    );
    // Deterministic role-body content for "coder" — see roleBody().
    assert.match(workerArtifact.summary, /Coder summarized intended edits/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
