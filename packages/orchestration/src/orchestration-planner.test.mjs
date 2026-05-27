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
import { OrchestrationPlanner } from "./orchestration-planner.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-orch-planner-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const seedTaskRun = async (state) => {
  const thread = await state.createThread({
    title: "t",
    targetDir: "/tmp/proj",
  });
  return state.createTaskRun({
    threadId: thread.id,
    userRequest: "ship feature X",
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
  persona: "",
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

test("draftPlan with mode falls back to hardcoded synthesizer (regression)", async () => {
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
    assert.equal(drafted.plan.workerSteps.length, 1);
    assert.equal(drafted.plan.workerSteps[0].role, "coder");
    assert.equal(drafted.plan.sourcePipelineId, undefined);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("draftPlan with pipelineId synthesizes steps from the pipeline", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const profile = await state.agentProfiles.create(validProfileInput());
    const reviewer = await state.agentProfiles.create(
      validProfileInput({ name: "Reviewer", role: "reviewer" }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Code → Review",
      description: "",
      steps: [
        {
          id: "s1",
          agentProfileId: profile.id,
          title: "Implement feature",
          instruction: "Write the change.",
          expectedArtifactKinds: ["plan", "diff"],
        },
        {
          id: "s2",
          agentProfileId: reviewer.id,
          title: "Review",
          instruction: "Check for risks.",
          expectedArtifactKinds: ["quality_report"],
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "single_worker", // mode is ignored when pipelineId is provided
      pipelineId: pipeline.id,
    });
    assert.equal(drafted.plan.workerSteps.length, 2);
    assert.equal(drafted.plan.workerSteps[0].agentProfileId, profile.id);
    assert.equal(drafted.plan.workerSteps[0].role, "coder");
    assert.equal(drafted.plan.workerSteps[0].title, "Implement feature");
    assert.equal(drafted.plan.workerSteps[1].agentProfileId, reviewer.id);
    assert.equal(drafted.plan.workerSteps[1].role, "reviewer");
    assert.equal(drafted.plan.workerSteps[0].dependsOn, undefined);
    assert.deepEqual(drafted.plan.workerSteps[1].dependsOn, [
      drafted.plan.workerSteps[0].id,
    ]);
    assert.equal(drafted.plan.workerSteps[0].allowedActions, undefined);
    assert.equal(drafted.plan.workerSteps[1].allowedActions, undefined);
    assert.equal(drafted.plan.workerSteps[0].outputContract, "diff_proposal");
    assert.equal(drafted.plan.workerSteps[1].outputContract, "review");
    assert.equal(drafted.plan.sourcePipelineId, pipeline.id);
    // v12 / Phase 2 — pipeline step.instruction must round-trip into
    // WorkerStep.instruction in full (no truncation). The inputSummary
    // remains the 120-char display slice.
    assert.equal(
      drafted.plan.workerSteps[0].instruction,
      "Write the change.",
    );
    assert.equal(
      drafted.plan.workerSteps[1].instruction,
      "Check for risks.",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("draftPlan visible summary preserves long pipeline instruction metadata", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const profile = await state.agentProfiles.create(validProfileInput());
    const longPrefix =
      "Read the project and produce a careful implementation plan. ".repeat(4);
    const instruction = [
      `${longPrefix}Do not lose the source metadata below.`,
      "Source harness: harness100/repo-quality",
      "Source workflow: Quality Review",
      "Source file: skills/repo-quality/SKILL.md",
      "Artifact contracts: plan, review",
    ].join("\n");
    const pipeline = await state.agentPipelines.create({
      name: "Harness source metadata",
      description: "",
      steps: [
        {
          id: "s1",
          agentProfileId: profile.id,
          title: "Review source metadata",
          instruction,
          expectedArtifactKinds: ["plan", "quality_report"],
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "single_worker",
      pipelineId: pipeline.id,
    });
    const visibleSummary = drafted.artifact.summary.split(
      "<!-- orchestration-plan:json -->",
    )[0];

    assert.equal(drafted.plan.workerSteps[0].instruction, instruction);
    assert.equal(
      drafted.plan.workerSteps[0].inputSummary,
      instruction.slice(0, 120),
    );
    assert.match(visibleSummary, /Source harness: harness100\/repo-quality/);
    assert.match(visibleSummary, /Source workflow: Quality Review/);
    assert.match(
      visibleSummary,
      /Source file: skills\/repo-quality\/SKILL\.md/,
    );
    assert.match(visibleSummary, /Artifact contracts: plan, review/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("draftPlan translates explicit pipeline dependencies to WorkerStep ids", async () => {
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
      name: "Fan out",
      description: "",
      steps: [
        {
          id: "plan",
          agentProfileId: plannerProfile.id,
          title: "Plan",
          instruction: "Plan.",
          expectedArtifactKinds: ["plan"],
          dependsOn: [],
        },
        {
          id: "code",
          agentProfileId: coderProfile.id,
          title: "Code",
          instruction: "Code.",
          expectedArtifactKinds: ["diff"],
          dependsOn: ["plan"],
          allowedActions: ["file_write"],
          outputContract: "diff_proposal",
        },
        {
          id: "test",
          agentProfileId: testerProfile.id,
          title: "Test",
          instruction: "Test.",
          expectedArtifactKinds: ["test_result"],
          dependsOn: ["plan"],
          allowedActions: ["shell"],
          outputContract: "test_result",
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "multi_worker",
      pipelineId: pipeline.id,
    });

    const [plan, code, testStep] = drafted.plan.workerSteps;
    assert.deepEqual(plan.dependsOn, []);
    assert.deepEqual(code.dependsOn, [plan.id]);
    assert.deepEqual(testStep.dependsOn, [plan.id]);
    assert.deepEqual(code.allowedActions, ["file_write"]);
    assert.equal(testStep.outputContract, "test_result");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("draftPlan remaps pipeline backflow rule step ids to WorkerStep ids", async () => {
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
      name: "Backflow",
      description: "",
      steps: [
        {
          id: "plan",
          agentProfileId: plannerProfile.id,
          title: "Plan",
          instruction: "Plan.",
          expectedArtifactKinds: ["plan"],
          dependsOn: [],
        },
        {
          id: "code",
          agentProfileId: coderProfile.id,
          title: "Code",
          instruction: "Code.",
          expectedArtifactKinds: ["diff"],
          dependsOn: ["plan"],
        },
      ],
      backflowRules: [
        {
          id: "bf_code",
          trigger: "step_failed",
          targetStepId: "plan",
          retryStepId: "code",
          maxAttempts: 2,
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "multi_worker",
      pipelineId: pipeline.id,
    });

    const [plan, code] = drafted.plan.workerSteps;
    assert.deepEqual(drafted.plan.backflowRules, [
      {
        id: "bf_code",
        trigger: "step_failed",
        targetStepId: plan.id,
        retryStepId: code.id,
        maxAttempts: 2,
      },
    ]);
    assert.match(drafted.artifact.summary, /backflow rules/i);
    assert.match(drafted.artifact.summary, new RegExp(plan.id));
    assert.match(drafted.artifact.summary, new RegExp(code.id));
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("draftPlan preserves remoteEndpointId for A2A pipeline steps", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const profile = await state.agentProfiles.create(validProfileInput());
    const endpoint = await state.a2aRemoteAgents.upsertEndpoint(
      validEndpointInput(),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Remote review",
      description: "",
      steps: [
        {
          id: "s_remote",
          agentProfileId: profile.id,
          remoteEndpointId: endpoint.id,
          title: "Remote review",
          instruction: "Review remotely.",
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

    assert.equal(drafted.plan.workerSteps[0].agentProfileId, profile.id);
    assert.equal(drafted.plan.workerSteps[0].remoteEndpointId, endpoint.id);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("draftPlan rejects an unavailable remote endpoint before execution", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const profile = await state.agentProfiles.create(validProfileInput());
    const endpoint = await state.a2aRemoteAgents.upsertEndpoint(
      validEndpointInput({ enabled: false }),
    );
    const pipeline = await state.agentPipelines.create({
      name: "Disabled remote review",
      description: "",
      steps: [
        {
          id: "s_remote",
          agentProfileId: profile.id,
          remoteEndpointId: endpoint.id,
          title: "Remote review",
          instruction: "Review remotely.",
          expectedArtifactKinds: ["log"],
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });

    await assert.rejects(
      () =>
        planner.draftPlan({
          taskRunId: taskRun.id,
          mode: "single_worker",
          pipelineId: pipeline.id,
        }),
      (e) => e.code === "PIPELINE_REMOTE_ENDPOINT_UNAVAILABLE",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("draftPlan throws PIPELINE_NOT_FOUND for unknown pipelineId", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const planner = new OrchestrationPlanner({ state });
    await assert.rejects(
      () =>
        planner.draftPlan({
          taskRunId: taskRun.id,
          mode: "single_worker",
          pipelineId: "pipe_ghost",
        }),
      (e) => e.code === "PIPELINE_NOT_FOUND",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("draftPlan throws PIPELINE_REFERENCED_PROFILE_MISSING when a step's profile was deleted", async () => {
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
    // Force-delete the profile from under the pipeline (bypassing the
    // IPC delete-protection) to simulate a stale reference, then ensure
    // the planner fail-fasts at run time.
    await state.agentProfiles.delete(profile.id);
    const planner = new OrchestrationPlanner({ state });
    await assert.rejects(
      () =>
        planner.draftPlan({
          taskRunId: taskRun.id,
          mode: "single_worker",
          pipelineId: pipeline.id,
        }),
      (e) => e.code === "PIPELINE_REFERENCED_PROFILE_MISSING",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
