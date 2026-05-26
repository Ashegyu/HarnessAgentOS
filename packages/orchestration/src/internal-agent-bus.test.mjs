import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInternalAgentMessage,
  formatHandoffMessages,
} from "./internal-agent-bus.ts";

const base = {
  taskRunId: "task_run_1",
  planId: "plan_1",
  fromStepId: "step_planner",
  fromRole: "planner",
  fromTitle: "Plan the work",
  artifactId: "artifact_1",
};

test("createInternalAgentMessage records bounded worker output as a handoff envelope", () => {
  const message = createInternalAgentMessage({
    ...base,
    content: "Planner says: inspect files first.",
    now: () => "2026-05-15T00:00:00.000Z",
    createId: () => "iam_1",
  });

  assert.deepEqual(message, {
    id: "iam_1",
    taskRunId: "task_run_1",
    planId: "plan_1",
    fromStepId: "step_planner",
    fromRole: "planner",
    fromTitle: "Plan the work",
    content: "Planner says: inspect files first.",
    artifactId: "artifact_1",
    createdAt: "2026-05-15T00:00:00.000Z",
  });
});

test("createInternalAgentMessage truncates long content for downstream context", () => {
  const message = createInternalAgentMessage({
    ...base,
    content: "x".repeat(12),
    maxContentChars: 5,
    now: () => "2026-05-15T00:00:00.000Z",
    createId: () => "iam_1",
  });

  assert.equal(message.content, "xxxxx\n[truncated 7 chars]");
});

test("createInternalAgentMessage preserves structured payload outside truncated content", () => {
  const structuredPayload = {
    schemaVersion: 1,
    status: "success",
    outputContract: "plan",
    producer: {
      taskRunId: "task_run_1",
      planId: "plan_1",
      stepId: "step_planner",
      role: "planner",
      title: "Plan the work",
      artifactId: "artifact_1",
    },
    summary: "Use dependency-scoped handoff only.",
    evidence: [],
    findings: [],
    proposedActions: [],
    changedFiles: [],
    verification: { run: [], passed: [], failed: [], notRun: [] },
    risks: [],
    nextActions: [],
  };
  const message = createInternalAgentMessage({
    ...base,
    content: "x".repeat(12),
    structuredPayload,
    maxContentChars: 5,
    now: () => "2026-05-15T00:00:00.000Z",
    createId: () => "iam_1",
  });

  assert.equal(message.content, "xxxxx\n[truncated 7 chars]");
  assert.deepEqual(message.structuredPayload, structuredPayload);
});

test("formatHandoffMessages renders ordered prior agent context", () => {
  const first = createInternalAgentMessage({
    ...base,
    content: "Plan output.",
    now: () => "2026-05-15T00:00:00.000Z",
    createId: () => "iam_1",
  });
  const second = createInternalAgentMessage({
    ...base,
    fromRole: "coder",
    fromTitle: "Implement",
    content: "Coder output.",
    artifactId: "artifact_2",
    now: () => "2026-05-15T00:00:01.000Z",
    createId: () => "iam_2",
  });

  assert.equal(
    formatHandoffMessages([first, second]),
    [
      "## Internal Agent Handoff",
      "",
      "### planner: Plan the work",
      "artifact: artifact_1",
      "",
      "Plan output.",
      "",
      "### coder: Implement",
      "artifact: artifact_2",
      "",
      "Coder output.",
    ].join("\n"),
  );
});
