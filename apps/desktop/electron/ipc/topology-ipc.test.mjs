import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTopologyHandlers } from "./topology-ipc.ts";

test("topology.recommend validates taskRunId", async () => {
  const handlers = buildTopologyHandlers({
    recommend: async () => [],
    recordFeedback: async () => {},
  });
  const result = await handlers.recommend({ taskRunId: "" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "STATE_INVALID_INPUT");
});

test("topology.recommend validates maxCandidates", async () => {
  const handlers = buildTopologyHandlers({
    recommend: async () => [],
    recordFeedback: async () => {},
  });
  const result = await handlers.recommend({
    taskRunId: "tsk_1",
    maxCandidates: "3",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "STATE_INVALID_INPUT");
});

test("topology.recommend returns ok-wrapped advisory candidates", async () => {
  let seen = null;
  const handlers = buildTopologyHandlers({
    recommend: async (input) => {
      seen = input;
      return [
        {
          id: "toprec_1",
          taskRunId: input.taskRunId,
          title: "Candidate",
          description: "",
          confidence: 0.6,
          rationale: "r",
          warnings: [],
          source: {
            capabilityIds: [],
            instinctIds: [],
            traceIds: [],
            templatePipelineIds: [],
          },
          steps: [],
          pipelineDraft: {
            name: "Draft",
            description: "",
            steps: [
              {
                id: "s1",
                agentProfileId: "ap_1",
                title: "Plan",
                instruction: "",
                expectedArtifactKinds: ["plan"],
                dependsOn: [],
                allowedActions: [],
                outputContract: "plan",
              },
            ],
          },
        },
      ];
    },
    recordFeedback: async () => {},
  });

  const result = await handlers.recommend({
    taskRunId: "tsk_1",
    maxCandidates: 2,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, { taskRunId: "tsk_1", maxCandidates: 2 });
  assert.equal(result.value[0].pipelineDraft.steps[0].dependsOn.length, 0);
});

test("topology.recordFeedback validates decision", async () => {
  const handlers = buildTopologyHandlers({
    recommend: async () => [],
    recordFeedback: async () => {},
  });
  const result = await handlers.recordFeedback({
    taskRunId: "tsk_1",
    recommendationId: "toprec_1",
    decision: "accepted",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "STATE_INVALID_INPUT");
});

test("topology.recordFeedback passes validated feedback to advisor", async () => {
  let seen = null;
  const handlers = buildTopologyHandlers({
    recommend: async () => [],
    recordFeedback: async (input) => {
      seen = input;
    },
  });
  const result = await handlers.recordFeedback({
    taskRunId: "tsk_1",
    recommendationId: "toprec_1",
    decision: "dismissed",
    reason: "not useful",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, {
    taskRunId: "tsk_1",
    recommendationId: "toprec_1",
    decision: "dismissed",
    reason: "not useful",
  });
});
