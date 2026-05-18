import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRepairAttemptRows } from "./quality-repair-model.ts";

const baseAttempt = (overrides = {}) => ({
  id: "rpa_1",
  taskRunId: "tsk_1",
  qualityGateId: "qg_1",
  attemptIndex: 0,
  failureSignature: "sig",
  status: "waiting_for_approval",
  generatedApprovalIds: ["apv_1"],
  createdAt: "2026-05-18T00:00:00.000Z",
  updatedAt: "2026-05-18T00:00:00.000Z",
  ...overrides,
});

test("buildRepairAttemptRows returns empty list for no attempts", () => {
  assert.deepEqual(
    buildRepairAttemptRows({
      attempts: [],
      qualityGates: [],
      approvals: [],
      artifacts: [],
    }),
    [],
  );
});

test("buildRepairAttemptRows joins gate status, approvals, and diff artifacts", () => {
  const rows = buildRepairAttemptRows({
    attempts: [baseAttempt()],
    qualityGates: [{ id: "qg_1", taskRunId: "tsk_1", status: "failed", knownRisks: [], evidenceArtifactIds: [], createdAt: "2026-05-18T00:00:00.000Z" }],
    approvals: [
      {
        id: "apv_1",
        taskRunId: "tsk_1",
        checkpointId: "ckp_1",
        actionType: "file_write",
        actionSummary: "repair src/a.ts",
        status: "executed",
        proposedAction: {
          type: "file_write",
          filePatch: { path: "src/a.ts", after: "ok" },
        },
      },
    ],
    artifacts: [
      {
        id: "art_1",
        taskRunId: "tsk_1",
        kind: "diff",
        title: "diff: src/a.ts",
        uri: "artifact://diff/1",
        createdAt: "2026-05-18T00:00:00.000Z",
      },
    ],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].attemptNumber, 1);
  assert.equal(rows[0].gateStatus, "failed");
  assert.equal(rows[0].generatedApprovals.length, 1);
  assert.equal(rows[0].diffArtifacts[0].id, "art_1");
});

test("buildRepairAttemptRows sorts multiple attempts by attempt index", () => {
  const rows = buildRepairAttemptRows({
    attempts: [
      baseAttempt({ id: "rpa_2", attemptIndex: 1, generatedApprovalIds: [] }),
      baseAttempt({ id: "rpa_1", attemptIndex: 0, generatedApprovalIds: [] }),
    ],
    qualityGates: [],
    approvals: [],
    artifacts: [],
  });
  assert.deepEqual(rows.map((row) => row.attempt.id), ["rpa_1", "rpa_2"]);
});
