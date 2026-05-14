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

const seedTaskRun = async (state) => {
  const thread = await state.createThread({ title: "t", targetDir: "/tmp/proj" });
  return state.createTaskRun({
    threadId: thread.id,
    userRequest: "do",
    targetDir: "/tmp/proj",
    status: "running",
  });
};

const validProfileInput = (overrides = {}) => ({
  name: "Coder",
  description: "",
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

const approvePlanApproval = async (state, approval) =>
  state.decideApproval(approval.id, "approved", "ok");

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
    assert.equal(calls[0].profileId, profile.id);
    assert.equal(calls[0].profileName, "CliCoder");
    // The full instruction must arrive at the invoker, not the 120-char
    // inputSummary truncation that the planner stores for display.
    assert.equal(
      calls[0].userRequest,
      "Refactor the parser without changing behaviour.",
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
    const downstream = approvals.filter((a) =>
      result.proposedApprovalIds.includes(a.id),
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
