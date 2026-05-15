import assert from "node:assert/strict";
import test from "node:test";

import { deriveTaskRunTimelineBadge } from "./task-run-timeline-status.ts";

test("ready_for_review timeline displays execution complete when all steps are terminal-successful", () => {
  assert.deepEqual(
    deriveTaskRunTimelineBadge({
      taskRunStatus: "ready_for_review",
      stepStatuses: ["succeeded", "skipped", "succeeded"],
    }),
    {
      status: "ready_for_review",
      label: "실행 완료",
      kind: "success",
    },
  );
});

test("ready_for_review timeline keeps review pending semantics while steps are still active", () => {
  assert.deepEqual(
    deriveTaskRunTimelineBadge({
      taskRunStatus: "ready_for_review",
      stepStatuses: ["succeeded", "pending"],
    }),
    { status: "ready_for_review" },
  );
  assert.deepEqual(
    deriveTaskRunTimelineBadge({
      taskRunStatus: "ready_for_review",
      stepStatuses: ["succeeded", "running"],
    }),
    { status: "ready_for_review" },
  );
});

test("timeline badge does not override other task statuses", () => {
  assert.deepEqual(
    deriveTaskRunTimelineBadge({
      taskRunStatus: "done",
      stepStatuses: ["succeeded"],
    }),
    { status: "done" },
  );
  assert.deepEqual(
    deriveTaskRunTimelineBadge({
      taskRunStatus: "blocked",
      stepStatuses: ["succeeded", "failed"],
    }),
    { status: "blocked" },
  );
});
