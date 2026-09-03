import { test } from "node:test";
import assert from "node:assert/strict";
import { TASK_RUN_STATUSES } from "../types/task-run.ts";
import {
  assertTaskRunTransition,
  isTaskRunTransitionAllowed,
} from "./task-run-transition.ts";

test("TaskRun transition policy allows observed lifecycle and idempotent writes", () => {
  for (const status of TASK_RUN_STATUSES) {
    assert.equal(isTaskRunTransitionAllowed(status, status), true);
  }

  const allowed = [
    ["drafting", "waiting_for_approval"],
    ["drafting", "blocked"],
    ["drafting", "quality_failed"],
    ["waiting_for_approval", "running"],
    ["waiting_for_approval", "paused"],
    ["waiting_for_approval", "quality_failed"],
    ["running", "quality_failed"],
    ["running", "ready_for_review"],
    ["running", "blocked"],
    ["paused", "waiting_for_approval"],
    ["paused", "running"],
    ["paused", "quality_failed"],
    ["paused", "ready_for_review"],
    ["quality_failed", "waiting_for_approval"],
    ["quality_failed", "ready_for_review"],
    ["ready_for_review", "running"],
    ["ready_for_review", "quality_failed"],
    ["ready_for_review", "done"],
    ["ready_for_review", "waiting_for_approval"],
    ["done", "waiting_for_approval"],
  ];
  for (const [from, to] of allowed) {
    assert.equal(isTaskRunTransitionAllowed(from, to), true, `${from} -> ${to}`);
  }
});

test("TaskRun transition policy rejects skipped and cancelled lifecycle regressions", () => {
  const rejected = [
    ["drafting", "done"],
    ["waiting_for_approval", "done"],
    ["paused", "done"],
    ["running", "drafting"],
    ["cancelled", "running"],
    ["done", "running"],
  ];
  for (const [from, to] of rejected) {
    assert.equal(isTaskRunTransitionAllowed(from, to), false, `${from} -> ${to}`);
    assert.throws(
      () => assertTaskRunTransition(from, to),
      /Invalid TaskRun transition/,
    );
  }
});
