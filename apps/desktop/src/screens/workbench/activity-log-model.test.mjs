import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVITY_LOG_PAGE_SIZE,
  buildActivityLogFilter,
  nextDecisionOffset,
  previousDecisionOffset,
} from "./activity-log-model.ts";

test("buildActivityLogFilter keeps selected steps and action type", () => {
  const filter = buildActivityLogFilter({
    selectedSteps: new Set(["budget_blocked", "global_toggle"]),
    actionType: "file_write",
    fromDate: "",
    toDate: "",
  });

  assert.deepEqual(filter?.decidedAtSteps, [
    "budget_blocked",
    "global_toggle",
  ]);
  assert.deepEqual(filter?.actionTypes, ["file_write"]);
});

test("buildActivityLogFilter converts date inputs to an exclusive UTC window", () => {
  const filter = buildActivityLogFilter({
    selectedSteps: new Set(["profile_auto_approve"]),
    actionType: "all",
    fromDate: "2026-05-01",
    toDate: "2026-05-03",
  });

  assert.equal(filter?.sinceIso, "2026-05-01T00:00:00.000Z");
  assert.equal(filter?.untilIso, "2026-05-04T00:00:00.000Z");
});

test("activity log pagination offsets are fixed at 50 rows per page", () => {
  assert.equal(ACTIVITY_LOG_PAGE_SIZE, 50);
  assert.equal(nextDecisionOffset(0), 50);
  assert.equal(previousDecisionOffset(50), 0);
  assert.equal(previousDecisionOffset(10), 0);
});
