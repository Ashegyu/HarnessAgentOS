import { test } from "node:test";
import assert from "node:assert/strict";

import { buildEvalsHandlers } from "./evals-ipc.ts";

const makeRecord = (id, status = "passed") => ({
  id,
  suite: "capability",
  startedAt: "2026-05-18T01:00:00.000Z",
  finishedAt: "2026-05-18T01:01:00.000Z",
  status,
  harnessSha: "abc1234",
  createdAt: "2026-05-18T01:00:00.000Z",
  summary: {
    runId: id,
    suite: "capability",
    startedAt: "2026-05-18T01:00:00.000Z",
    finishedAt: "2026-05-18T01:01:00.000Z",
    status,
    cases: [],
  },
});

test("buildEvalsHandlers lists eval runs through the read model", async () => {
  const calls = [];
  const handlers = buildEvalsHandlers({
    evalRuns: {
      list: async (filters) => {
        calls.push(filters);
        return [makeRecord("evrun_1")];
      },
      get: async () => null,
    },
  });

  const result = await handlers.listRuns({ limit: 20, suite: "capability" });

  assert.equal(result.ok, true);
  assert.equal(result.value[0].id, "evrun_1");
  assert.deepEqual(calls, [{ limit: 20, suite: "capability" }]);
});

test("buildEvalsHandlers rejects malformed getRun input", async () => {
  const handlers = buildEvalsHandlers({
    evalRuns: {
      list: async () => [],
      get: async () => makeRecord("evrun_1"),
    },
  });

  const result = await handlers.getRun({ runId: "" });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "STATE_INVALID_INPUT");
});

test("buildEvalsHandlers returns not found for unknown eval runs", async () => {
  const handlers = buildEvalsHandlers({
    evalRuns: {
      list: async () => [],
      get: async () => null,
    },
  });

  const result = await handlers.getRun({ runId: "missing" });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "EVAL_RUN_NOT_FOUND");
});

test("buildEvalsHandlers returns cost trend from eval run summaries", async () => {
  const handlers = buildEvalsHandlers({
    evalRuns: {
      list: async (filters) => [
        {
          ...makeRecord("evrun_2"),
          startedAt: "2026-05-18T01:01:00.000Z",
          summary: {
            ...makeRecord("evrun_2").summary,
            mode: "fake",
            cases: [
              {
                attempts: [
                  { passed: true, tokens: 1500, durationMs: 1900 },
                ],
              },
            ],
          },
          filters,
        },
        {
          ...makeRecord("evrun_1"),
          startedAt: "2026-05-18T01:00:00.000Z",
          summary: {
            ...makeRecord("evrun_1").summary,
            mode: "fake",
            cases: [
              {
                attempts: [
                  { passed: true, tokens: 1000, durationMs: 1500 },
                ],
              },
            ],
          },
        },
      ],
      get: async () => null,
    },
  });

  const result = await handlers.getCostTrend({
    suite: "capability",
    limit: 20,
    baselineWindow: 1,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.value.points.map((point) => point.runId),
    ["evrun_1", "evrun_2"],
  );
  assert.deepEqual(
    result.value.warnings.map((warning) => warning.kind),
    ["tokens_increase"],
  );
});

test("buildEvalsHandlers returns runtime latency summary from agent invocations", async () => {
  const handlers = buildEvalsHandlers({
    evalRuns: {
      list: async () => [],
      get: async () => null,
    },
    agentInvocations: {
      listRecentWithLatency: async (limit) =>
        Array.from({ length: limit }, (_, index) => ({
          id: `inv_${index}`,
          taskRunId: "task_1",
          provider: "codex",
          model: "gpt-5",
          status: "succeeded",
          promptArtifactId: "artifact_1",
          latencyMs: 100 + index,
          createdAt: "2026-05-18T00:00:00.000Z",
          updatedAt: "2026-05-18T00:00:00.000Z",
        })),
    },
  });

  const result = await handlers.getRuntimeLatencySummary({ limit: 20 });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, [
    {
      kind: "agent_invocation_to_final_result",
      count: 20,
      p50Ms: 109.5,
      p95Ms: 118,
      p99Ms: null,
      maxMs: 119,
    },
  ]);
});
