import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyPipelineDraft,
  validatePipelineDraft,
  serializePipelineDraft,
  pipelineToDraft,
  pipelineInputToDraft,
  settingsWithDefaultPipeline,
  topologyTaskRunOptionsFromThreadDetails,
  moveStep,
} from "./pipeline-form.ts";

const profile = (id, name = "Coder") => ({ id, name });
const remoteEntry = (id, name = "Remote Reviewer") => ({
  endpoint: {
    id,
    name,
    baseUrl: "https://agents.example.com/reviewer",
    agentCardUrl: "https://agents.example.com/reviewer/.well-known/agent-card.json",
    preferredTransport: "json-rpc",
    enabled: true,
    trusted: true,
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
  },
});

test("emptyPipelineDraft starts blank with no steps", () => {
  const d = emptyPipelineDraft();
  assert.equal(d.id, null);
  assert.equal(d.name, "");
  assert.deepEqual(d.steps, []);
});

test("validatePipelineDraft requires name", () => {
  const d = { ...emptyPipelineDraft(), steps: [{ id: "s1", agentProfileId: "ap_a", title: "t", instruction: "", expectedArtifactKinds: ["plan"] }] };
  const errs = validatePipelineDraft(d, [profile("ap_a")]);
  assert.ok(errs.some((e) => e.field === "name"));
});

test("validatePipelineDraft requires at least one step", () => {
  const d = { ...emptyPipelineDraft(), name: "X" };
  const errs = validatePipelineDraft(d, []);
  assert.ok(errs.some((e) => e.field === "steps"));
});

test("validatePipelineDraft flags steps with empty title", () => {
  const d = {
    ...emptyPipelineDraft(),
    name: "X",
    steps: [{ id: "s1", agentProfileId: "ap_a", title: "  ", instruction: "", expectedArtifactKinds: ["plan"] }],
  };
  const errs = validatePipelineDraft(d, [profile("ap_a")]);
  assert.ok(errs.some((e) => e.field === "steps" && /title/i.test(e.message)));
});

test("validatePipelineDraft flags steps referencing unknown profile", () => {
  const d = {
    ...emptyPipelineDraft(),
    name: "X",
    steps: [{ id: "s1", agentProfileId: "ap_ghost", title: "t", instruction: "", expectedArtifactKinds: ["plan"] }],
  };
  const errs = validatePipelineDraft(d, [profile("ap_a")]);
  assert.ok(errs.some((e) => /profile/i.test(e.message)));
});

test("validatePipelineDraft accepts a well-formed draft", () => {
  const d = {
    ...emptyPipelineDraft(),
    name: "Backend Flow",
    steps: [
      { id: "s1", agentProfileId: "ap_a", title: "Plan", instruction: "", expectedArtifactKinds: ["plan"] },
      { id: "s2", agentProfileId: "ap_b", title: "Code", instruction: "", expectedArtifactKinds: ["diff"] },
    ],
  };
  assert.deepEqual(validatePipelineDraft(d, [profile("ap_a"), profile("ap_b")]), []);
});

test("validatePipelineDraft accepts explicit dependencies and metadata", () => {
  const d = {
    ...emptyPipelineDraft(),
    name: "Topology Flow",
    steps: [
      {
        id: "s1",
        agentProfileId: "ap_a",
        title: "Plan",
        instruction: "",
        expectedArtifactKinds: ["plan"],
        dependsOn: [],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "s2",
        agentProfileId: "ap_b",
        title: "Code",
        instruction: "",
        expectedArtifactKinds: ["diff"],
        dependsOn: ["s1"],
        allowedActions: ["file_write"],
        outputContract: "diff_proposal",
      },
    ],
  };
  assert.deepEqual(
    validatePipelineDraft(d, [profile("ap_a"), profile("ap_b")]),
    [],
  );
});

test("validatePipelineDraft flags dependency cycles", () => {
  const d = {
    ...emptyPipelineDraft(),
    name: "Cyclic Flow",
    steps: [
      {
        id: "s1",
        agentProfileId: "ap_a",
        title: "A",
        instruction: "",
        expectedArtifactKinds: ["plan"],
        dependsOn: ["s2"],
      },
      {
        id: "s2",
        agentProfileId: "ap_b",
        title: "B",
        instruction: "",
        expectedArtifactKinds: ["log"],
        dependsOn: ["s1"],
      },
    ],
  };
  const errs = validatePipelineDraft(d, [profile("ap_a"), profile("ap_b")]);
  assert.ok(errs.some((e) => /cycle/i.test(e.message)));
});

test("validatePipelineDraft accepts a known remote endpoint override", () => {
  const d = {
    ...emptyPipelineDraft(),
    name: "Remote Flow",
    steps: [
      {
        id: "s1",
        agentProfileId: "ap_a",
        remoteEndpointId: "a2a_remote",
        title: "Review",
        instruction: "",
        expectedArtifactKinds: ["log"],
      },
    ],
  };
  assert.deepEqual(
    validatePipelineDraft(d, [profile("ap_a")], [remoteEntry("a2a_remote")]),
    [],
  );
});

test("validatePipelineDraft flags an unknown remote endpoint override", () => {
  const d = {
    ...emptyPipelineDraft(),
    name: "Remote Flow",
    steps: [
      {
        id: "s1",
        agentProfileId: "ap_a",
        remoteEndpointId: "a2a_missing",
        title: "Review",
        instruction: "",
        expectedArtifactKinds: ["log"],
      },
    ],
  };
  const errs = validatePipelineDraft(d, [profile("ap_a")], []);
  assert.ok(errs.some((e) => /remote endpoint/i.test(e.message)));
});

test("serializePipelineDraft strips renderer-only id when null (create mode)", () => {
  const d = {
    id: null,
    name: "Flow",
    description: "",
    steps: [{ id: "s1", agentProfileId: "ap_a", title: "T", instruction: "", expectedArtifactKinds: ["plan"] }],
  };
  const out = serializePipelineDraft(d);
  assert.ok(!("id" in out));
  assert.equal(out.name, "Flow");
  assert.equal(out.steps.length, 1);
});

test("serializePipelineDraft preserves remoteEndpointId when selected", () => {
  const d = {
    id: null,
    name: "Remote Flow",
    description: "",
    steps: [
      {
        id: "s1",
        agentProfileId: "ap_a",
        remoteEndpointId: "a2a_remote",
        title: "T",
        instruction: "",
        expectedArtifactKinds: ["log"],
      },
    ],
  };
  const out = serializePipelineDraft(d);
  assert.equal(out.steps[0].remoteEndpointId, "a2a_remote");
});

test("serializePipelineDraft preserves topology metadata when selected", () => {
  const d = {
    id: null,
    name: "Topology Flow",
    description: "",
    steps: [
      {
        id: "s1",
        agentProfileId: "ap_a",
        title: "T",
        instruction: "",
        expectedArtifactKinds: ["plan"],
        dependsOn: ["s0"],
        allowedActions: ["file_write"],
        outputContract: "diff_proposal",
      },
    ],
  };
  const out = serializePipelineDraft(d);
  assert.deepEqual(out.steps[0].dependsOn, ["s0"]);
  assert.deepEqual(out.steps[0].allowedActions, ["file_write"]);
  assert.equal(out.steps[0].outputContract, "diff_proposal");
});

test("serializePipelineDraft preserves id in update mode", () => {
  const d = {
    id: "pipe_1",
    name: "Flow",
    description: "",
    steps: [{ id: "s1", agentProfileId: "ap_a", title: "T", instruction: "", expectedArtifactKinds: ["plan"] }],
  };
  const out = serializePipelineDraft(d);
  assert.equal(out.id, "pipe_1");
});

test("pipelineToDraft round-trips an existing pipeline", () => {
  const pipeline = {
    id: "pipe_1",
    name: "Flow",
    description: "x",
    steps: [
      { id: "s1", agentProfileId: "ap_a", title: "T", instruction: "Hi", expectedArtifactKinds: ["plan"] },
    ],
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
  const draft = pipelineToDraft(pipeline);
  assert.equal(draft.id, "pipe_1");
  assert.equal(draft.steps[0].instruction, "Hi");
});

test("pipelineToDraft round-trips a remoteEndpointId", () => {
  const pipeline = {
    id: "pipe_1",
    name: "Remote Flow",
    description: "",
    steps: [
      {
        id: "s1",
        agentProfileId: "ap_a",
        remoteEndpointId: "a2a_remote",
        title: "Remote",
        instruction: "Hi",
        expectedArtifactKinds: ["log"],
      },
    ],
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
  const draft = pipelineToDraft(pipeline);
  assert.equal(draft.steps[0].remoteEndpointId, "a2a_remote");
});

test("pipelineToDraft round-trips topology metadata", () => {
  const pipeline = {
    id: "pipe_1",
    name: "Topology Flow",
    description: "",
    steps: [
      {
        id: "s1",
        agentProfileId: "ap_a",
        title: "Code",
        instruction: "Hi",
        expectedArtifactKinds: ["diff"],
        dependsOn: ["s0"],
        allowedActions: ["file_write"],
        outputContract: "diff_proposal",
      },
    ],
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
  const draft = pipelineToDraft(pipeline);
  assert.deepEqual(draft.steps[0].dependsOn, ["s0"]);
  assert.deepEqual(draft.steps[0].allowedActions, ["file_write"]);
  assert.equal(draft.steps[0].outputContract, "diff_proposal");
});

test("pipelineInputToDraft converts a recommendation into a new draft", () => {
  const draft = pipelineInputToDraft({
    name: "Recommended",
    description: "d",
    steps: [
      {
        id: "s1",
        agentProfileId: "ap_a",
        title: "Plan",
        instruction: "Hi",
        expectedArtifactKinds: ["plan"],
        dependsOn: [],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "s2",
        agentProfileId: "ap_b",
        title: "Code",
        instruction: "Patch",
        expectedArtifactKinds: ["diff"],
        dependsOn: ["s1"],
        allowedActions: ["file_write"],
        outputContract: "diff_proposal",
      },
    ],
  });
  assert.equal(draft.id, null);
  assert.equal(draft.name, "Recommended");
  assert.deepEqual(draft.steps[1].dependsOn, ["s1"]);
  assert.deepEqual(draft.steps[1].allowedActions, ["file_write"]);
});

test("topologyTaskRunOptionsFromThreadDetails flattens recent task runs", () => {
  const options = topologyTaskRunOptionsFromThreadDetails(
    [
      {
        thread: {
          id: "thr_1",
          title: "Thread A",
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:00:00.000Z",
        },
        taskRuns: [
          {
            id: "tsk_old",
            threadId: "thr_1",
            userRequest: "old request",
            targetDir: "/tmp/proj",
            status: "drafting",
            createdAt: "2026-05-01T00:00:00.000Z",
            updatedAt: "2026-05-01T00:00:00.000Z",
          },
        ],
        agentAnswers: {},
      },
      {
        thread: {
          id: "thr_2",
          title: "Thread B",
          createdAt: "2026-05-02T00:00:00.000Z",
          updatedAt: "2026-05-02T00:00:00.000Z",
        },
        taskRuns: [
          {
            id: "tsk_new",
            threadId: "thr_2",
            userRequest: "new request",
            targetDir: "/tmp/proj",
            status: "running",
            createdAt: "2026-05-02T00:00:00.000Z",
            updatedAt: "2026-05-02T00:00:00.000Z",
          },
        ],
        agentAnswers: {},
      },
      null,
    ],
    1,
  );
  assert.equal(options.length, 1);
  assert.equal(options[0].id, "tsk_new");
  assert.equal(options[0].threadTitle, "Thread B");
  assert.match(options[0].label, /new request/);
});

test("settingsWithDefaultPipeline enables orchestration and stores the pipeline id", () => {
  const settings = {
    agent: {
      provider: "auto",
      model: "",
      timeoutMs: 120000,
      stallTimeoutMs: 30000,
      contextDepth: 3,
    },
    approval: {
      autoApprove: false,
      autoExecuteWorkerFileActions: false,
    },
    orchestration: {
      enabled: false,
      defaultMode: "single_worker",
      defaultInstructions: "",
      defaultPipelineId: "",
    },
  };

  const next = settingsWithDefaultPipeline(settings, "pipe_1");

  assert.equal(next.orchestration.enabled, true);
  assert.equal(next.orchestration.defaultPipelineId, "pipe_1");
  assert.equal(next.orchestration.defaultMode, "single_worker");
  assert.equal(next.agent.provider, "auto");
});

test("moveStep shifts a step up by one position", () => {
  const steps = [
    { id: "a" }, { id: "b" }, { id: "c" },
  ];
  assert.deepEqual(moveStep(steps, 2, -1).map((s) => s.id), ["a", "c", "b"]);
});

test("moveStep shifts a step down by one position", () => {
  const steps = [
    { id: "a" }, { id: "b" }, { id: "c" },
  ];
  assert.deepEqual(moveStep(steps, 0, 1).map((s) => s.id), ["b", "a", "c"]);
});

test("moveStep is a no-op when target index is out of range", () => {
  const steps = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(moveStep(steps, 0, -1).map((s) => s.id), ["a", "b"]);
  assert.deepEqual(moveStep(steps, 1, 1).map((s) => s.id), ["a", "b"]);
});
