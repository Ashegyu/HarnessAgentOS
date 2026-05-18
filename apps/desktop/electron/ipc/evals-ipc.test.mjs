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
