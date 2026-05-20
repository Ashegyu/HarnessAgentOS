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

test("runApproved surfaces worker file_write approvals before later workers finish", async () => {
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
    const reviewGate = deferred();
    const starts = [];
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
        await reviewGate.promise;
        return { outputText: "Reviewer output" };
      },
    };
    const runner = new WorkerRunner({
      state,
      agentPlanning: fakeInvoker,
      onTaskRunChanged: (taskRunId) => changedTaskRuns.push(taskRunId),
    });

    const run = runner.runApproved({ approval: approved, plan: drafted.plan });

    await waitFor(
      () => starts.includes("Reviewer"),
      "reviewer should start after the first worker has finished",
    );
    const approvalsBeforeReviewFinishes =
      await state.listApprovalsByTaskRun(taskRun.id);
    const workerFileApprovals = approvalsBeforeReviewFinishes.filter(
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

    reviewGate.resolve();
    const result = await run;
    assert.deepEqual(result.proposedApprovalIds, [workerFileApprovals[0].id]);
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
