import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDecisionTimelineRows,
  filterDecisionRows,
} from "./decisions-panel-model.ts";

const approval = (id, decision, decidedAt = undefined) => ({
  id,
  taskRunId: "tsk_1",
  checkpointId: "ckp_1",
  actionType: "file_write",
  actionSummary: `approval ${id}`,
  status: decision?.approved ? "approved" : "pending",
  autoApproveDecision: decision,
  ...(decidedAt ? { decidedAt } : {}),
});

test("buildDecisionTimelineRows skips manual approvals without a trace", () => {
  const rows = buildDecisionTimelineRows([
    approval("apv_manual", null),
    approval(
      "apv_auto",
      {
        approved: true,
        decidedAt: "global_toggle",
        reason: "Global auto approve is on.",
      },
      "2026-05-18T01:00:00.000Z",
    ),
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].approvalId, "apv_auto");
  assert.equal(rows[0].decidedAtStep, "global_toggle");
});

test("filterDecisionRows keeps only selected decision steps", () => {
  const rows = buildDecisionTimelineRows([
    approval(
      "apv_blocked",
      {
        approved: false,
        decidedAt: "budget_blocked",
        reason: "Budget exceeded.",
      },
      "2026-05-18T01:00:00.000Z",
    ),
    approval(
      "apv_approved",
      {
        approved: true,
        decidedAt: "worker_file_action",
        reason: "Worker file actions enabled.",
      },
      "2026-05-18T01:01:00.000Z",
    ),
  ]);

  assert.deepEqual(
    filterDecisionRows(rows, new Set(["budget_blocked"])).map(
      (row) => row.approvalId,
    ),
    ["apv_blocked"],
  );
  assert.deepEqual(filterDecisionRows(rows, new Set()), []);
});
