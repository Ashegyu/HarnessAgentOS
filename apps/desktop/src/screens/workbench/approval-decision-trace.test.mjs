import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAutoApproveTraceRows } from "./ApprovalDecisionTrace.tsx";

const approval = {
  id: "apv_1",
  taskRunId: "tsk_1",
  checkpointId: "ckp_1",
  actionType: "file_write",
  actionSummary: "Write file",
  status: "approved",
  autoApproveDecision: {
    approved: true,
    decidedAt: "worker_file_action",
    reason: "Worker file action auto-execution is enabled.",
  },
};

test("buildAutoApproveTraceRows marks the decision step and skips later steps", () => {
  const rows = buildAutoApproveTraceRows(approval);
  assert.equal(rows.length, 7);
  assert.equal(rows[0].status, "pass");
  assert.equal(rows[5].step, "worker_file_action");
  assert.equal(rows[5].status, "stop");
  assert.equal(rows[5].result, "STOP - 승인");
  assert.equal(rows[6].status, "skip");
});

test("buildAutoApproveTraceRows returns empty rows when no decision is stored", () => {
  const rows = buildAutoApproveTraceRows({
    ...approval,
    autoApproveDecision: null,
  });
  assert.deepEqual(rows, []);
});
