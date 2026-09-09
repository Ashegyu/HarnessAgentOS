import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveChatTurnDisplayStatus,
  deriveChatTurnStatusBadge,
  taskRunWithActiveOverride,
} from "./chat-turn-status.ts";

const taskRun = (overrides = {}) => ({
  id: "task-1",
  threadId: "thread-1",
  userRequest: "요청",
  targetDir: "C:\\work",
  status: "running",
  createdAt: "2026-05-15T00:00:00.000Z",
  updatedAt: "2026-05-15T00:00:00.000Z",
  ...overrides,
});

test("taskRunWithActiveOverride prefers fresher selected task detail", () => {
  const stale = taskRun({ status: "running" });
  const fresh = taskRun({
    status: "ready_for_review",
    updatedAt: "2026-05-15T00:01:00.000Z",
  });

  assert.equal(taskRunWithActiveOverride(stale, fresh).status, "ready_for_review");
});

test("taskRunWithActiveOverride leaves unrelated rows unchanged", () => {
  const stale = taskRun({ id: "task-1", status: "running" });
  const other = taskRun({ id: "task-2", status: "ready_for_review" });

  assert.equal(taskRunWithActiveOverride(stale, other).status, "running");
});

test("model completion alone cannot override the host execution state", () => {
  assert.equal(
    deriveChatTurnDisplayStatus({
      taskRunStatus: "running",
      invocationStatus: "succeeded",
      approvals: [],
    }),
    "running",
  );
});

test("deriveChatTurnDisplayStatus keeps approval wait visible after succeeded invocation", () => {
  assert.equal(
    deriveChatTurnDisplayStatus({
      taskRunStatus: "running",
      invocationStatus: "succeeded",
      approvals: [{ status: "pending" }],
    }),
    "waiting_for_approval",
  );
});

test("deriveChatTurnDisplayStatus preserves genuinely running invocations", () => {
  assert.equal(
    deriveChatTurnDisplayStatus({
      taskRunStatus: "running",
      invocationStatus: "running",
      approvals: [],
    }),
    "running",
  );
});

test("deriveChatTurnDisplayStatus maps terminal failure while task row is stale", () => {
  assert.equal(
    deriveChatTurnDisplayStatus({
      taskRunStatus: "running",
      invocationStatus: "failed",
      approvals: [],
    }),
    "blocked",
  );
});

test("an answer awaiting validation is never shown as successful task completion", () => {
  assert.deepEqual(
    deriveChatTurnStatusBadge({
      taskRunStatus: "ready_for_review",
      invocationStatus: "succeeded",
      approvals: [],
      hasFinalAnswer: true,
    }),
    {
      status: "ready_for_review",
    },
  );
});

test("approved but unexecuted work stays running after a model answer", () => {
  assert.deepEqual(deriveChatTurnStatusBadge({
    taskRunStatus: "running", invocationStatus: "succeeded",
    approvals: [{ status: "approved" }], hasFinalAnswer: true,
  }), { status: "running" });
});

for (const status of ["blocked", "paused", "quality_failed", "done", "cancelled"]) {
  test(`a final answer preserves host state ${status}`, () => {
    assert.deepEqual(deriveChatTurnStatusBadge({
      taskRunStatus: status, invocationStatus: "succeeded", hasFinalAnswer: true,
    }), { status });
  });
}

test("deriveChatTurnStatusBadge keeps review pending when no answer is ready yet", () => {
  assert.deepEqual(
    deriveChatTurnStatusBadge({
      taskRunStatus: "ready_for_review",
      approvals: [],
      hasFinalAnswer: false,
    }),
    { status: "ready_for_review" },
  );
});

test("deriveChatTurnStatusBadge keeps approval wait visible", () => {
  assert.deepEqual(
    deriveChatTurnStatusBadge({
      taskRunStatus: "running",
      invocationStatus: "succeeded",
      approvals: [{ status: "pending" }],
      hasFinalAnswer: true,
    }),
    { status: "waiting_for_approval" },
  );
});
