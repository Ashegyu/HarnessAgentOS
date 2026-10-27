import { test } from "node:test";
import assert from "node:assert/strict";
import { formatWorkerStepArtifact } from "./orchestration-trace.ts";

test("worker audit output masks secrets without changing the execution source", () => {
  const output = '{"token":"SYNTHETIC_WORKER_SECRET","result":"reviewed"}';
  const step = { id: "worker", role: "reviewer", title: "Worker", status: "succeeded",
    inputSummary: "Review", expectedArtifactKinds: ["log"] };
  const before = structuredClone(step);
  const summary = formatWorkerStepArtifact({ step, output });
  assert.equal(summary.includes("SYNTHETIC_WORKER_SECRET"), false);
  assert.ok(summary.includes("[REDACTED]"));
  assert.ok(summary.includes("reviewed"));
  assert.equal(output, '{"token":"SYNTHETIC_WORKER_SECRET","result":"reviewed"}');
  assert.deepEqual(step, before);
});

test("worker audit headers cannot preserve a secret from a provider display name", () => {
  const summary = formatWorkerStepArtifact({
    step: { id: "worker", role: "reviewer", title: "Worker", status: "failed", inputSummary: "", expectedArtifactKinds: ["log"] },
    output: "provider failed", remoteEndpointName: 'endpoint {"api_key":"SYNTHETIC_ENDPOINT_SECRET"}',
  });
  assert.equal(summary.includes("SYNTHETIC_ENDPOINT_SECRET"), false);
  assert.ok(summary.includes("provider failed"));
});
