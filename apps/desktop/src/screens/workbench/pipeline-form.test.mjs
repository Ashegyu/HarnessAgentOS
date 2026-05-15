import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyPipelineDraft,
  validatePipelineDraft,
  serializePipelineDraft,
  pipelineToDraft,
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
