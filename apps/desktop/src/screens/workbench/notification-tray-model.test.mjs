import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTaskRunNotifications,
  loadDismissedNotificationIds,
  mergeNotifications,
  saveDismissedNotificationIds,
} from "./notification-tray-model.ts";

const taskRun = {
  id: "tsk_1",
  threadId: "thr_1",
  userRequest: "Ship the feature",
  targetDir: "/tmp/project",
  status: "running",
  createdAt: "2026-05-18T00:00:00.000Z",
  updatedAt: "2026-05-18T01:00:00.000Z",
};

const detail = (patch = {}) => ({
  taskRun: { ...taskRun, ...(patch.taskRun ?? {}) },
  steps: patch.steps ?? [],
  approvals: patch.approvals ?? [],
  artifacts: patch.artifacts ?? [],
  checkpoints: [],
  agentInvocations: patch.agentInvocations ?? [],
  a2aRemoteTaskRefs: [],
  a2aRefinementAttempts: patch.a2aRefinementAttempts ?? [],
  a2aRefinementProposals: patch.a2aRefinementProposals ?? [],
});

class MemoryStorage {
  values = new Map();
  getItem(key) {
    return this.values.get(key) ?? null;
  }
  setItem(key, value) {
    this.values.set(key, value);
  }
}

test("buildTaskRunNotifications derives budget and cancellation alerts", () => {
  const notifications = buildTaskRunNotifications(
    detail({
      taskRun: { status: "cancelled" },
      approvals: [
        {
          id: "apv_1",
          taskRunId: "tsk_1",
          checkpointId: "ckp_1",
          actionType: "file_write",
          actionSummary: "write",
          status: "pending",
          decidedAt: "2026-05-18T00:30:00.000Z",
          autoApproveDecision: {
            approved: false,
            decidedAt: "budget_blocked",
            reason: "Daily budget exceeded",
          },
        },
      ],
    }),
    null,
  );

  assert.deepEqual(
    notifications.map((item) => item.kind),
    ["budget_blocked", "taskrun_cancelled"],
  );
});

test("mergeNotifications adds new notifications and omits dismissed ids", () => {
  const existing = [
    {
      id: "quality_failed:tsk_1",
      kind: "quality_failed",
      taskRunId: "tsk_1",
      title: "Quality failed",
      message: "tests failed",
      createdAt: "2026-05-18T00:00:00.000Z",
      severity: "failed",
    },
  ];
  const incoming = [
    {
      id: "taskrun_cancelled:tsk_1",
      kind: "taskrun_cancelled",
      taskRunId: "tsk_1",
      title: "TaskRun cancelled",
      message: "cancelled",
      createdAt: "2026-05-18T01:00:00.000Z",
      severity: "neutral",
    },
  ];

  assert.deepEqual(
    mergeNotifications(existing, incoming, new Set(["quality_failed:tsk_1"])).map(
      (item) => item.id,
    ),
    ["taskrun_cancelled:tsk_1"],
  );
});

test("dismissed notification ids persist in localStorage-compatible storage", () => {
  const storage = new MemoryStorage();
  const dismissed = new Set(["budget_blocked:apv_1"]);
  saveDismissedNotificationIds(storage, dismissed);

  assert.deepEqual(
    [...loadDismissedNotificationIds(storage)],
    ["budget_blocked:apv_1"],
  );
});
