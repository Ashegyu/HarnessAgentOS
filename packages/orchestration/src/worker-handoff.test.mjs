import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkerHandoffPayload,
  formatWorkerHandoffPayload,
  parseWorkerHandoffPayload,
} from "./worker-handoff.ts";

const producer = {
  taskRunId: "task_run_1",
  planId: "plan_1",
  stepId: "worker_step_1",
  role: "reviewer",
  title: "Review",
  artifactId: "artifact_1",
};

const payload = {
  schemaVersion: 1,
  status: "success",
  outputContract: "review",
  producer,
  summary: "Review found one high-confidence issue.",
  evidence: [
    {
      kind: "file",
      ref: "packages/orchestration/src/worker-runner.ts",
      note: "Worker handoff is created after artifact persistence.",
    },
  ],
  findings: [
    {
      severity: "warning",
      claim: "Downstream workers need machine-readable handoff context.",
      basis: "evidence",
      refs: ["artifact_1"],
    },
  ],
  proposedActions: [],
  changedFiles: [],
  verification: {
    run: ["node --import tsx --test packages/orchestration/src/worker-handoff.test.mjs"],
    passed: [],
    failed: [],
    notRun: [],
  },
  risks: ["Parser remains soft-enforced in phase 1."],
  nextActions: ["Wire the parsed payload into InternalAgentMessage."],
};

test("formatWorkerHandoffPayload emits a fenced JSON payload that parses back", () => {
  const rendered = formatWorkerHandoffPayload(payload);

  assert.match(rendered, /^```harness_worker_handoff_v1\n/);
  const parsed = parseWorkerHandoffPayload(rendered);

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.payload, payload);
});

test("buildWorkerHandoffPayload trusts model content only for payload body, not producer identity", () => {
  const spoofed = {
    ...payload,
    producer: {
      ...producer,
      taskRunId: "spoofed_task",
      stepId: "spoofed_step",
      artifactId: "spoofed_artifact",
    },
  };

  const built = buildWorkerHandoffPayload({
    rawOutput: formatWorkerHandoffPayload(spoofed),
    producer,
    outputContract: "review",
    proposedActions: [],
  });

  assert.equal(built.status, "structured");
  assert.equal(built.payload.status, "success");
  assert.equal(built.payload.summary, payload.summary);
  assert.deepEqual(built.payload.producer, producer);
});

test("buildWorkerHandoffPayload synthesizes a warning payload for malformed structured output", () => {
  const built = buildWorkerHandoffPayload({
    rawOutput: "```harness_worker_handoff_v1\n{\"schemaVersion\":1,\n```",
    producer,
    outputContract: "review",
    proposedActions: [],
  });

  assert.equal(built.status, "warning");
  assert.equal(built.payload.status, "warning");
  assert.match(built.payload.summary, /valid structured handoff/i);
  assert.equal(built.payload.evidence[0].kind, "artifact");
  assert.equal(built.payload.evidence[0].ref, "artifact_1");
});

test("parseWorkerHandoffPayload accepts raw newlines inside JSON strings", () => {
  const rendered = `\`\`\`harness_worker_handoff_v1
{
  "schemaVersion": 1,
  "status": "success",
  "outputContract": "diff_proposal",
  "producer": {
    "taskRunId": "task_run_1",
    "planId": "plan_1",
    "stepId": "worker_step_1",
    "role": "coder",
    "title": "Implementation",
    "artifactId": "artifact_1"
  },
  "summary": "Patch proposal
with wrapped text",
  "evidence": [],
  "findings": [],
  "proposedActions": [
    {
      "type": "file_patch",
      "path": "src/foo.ts",
      "patch": "--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new
",
      "rationale": "partial edit
without whole-file replacement"
    }
  ],
  "changedFiles": [],
  "verification": { "run": [], "passed": [], "failed": [], "notRun": [] },
  "risks": [],
  "nextActions": []
}
\`\`\``;

  const parsed = parseWorkerHandoffPayload(rendered);

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.payload.proposedActions, [
      {
        type: "file_patch",
        path: "src/foo.ts",
        patch: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n",
        rationale: "partial edit\nwithout whole-file replacement",
      },
    ]);
  }
});
