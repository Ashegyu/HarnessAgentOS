import type {
  Approval,
  QualityGateResult,
  TaskRunDetail,
} from "@harness/core";

export type NotificationKind =
  | "budget_blocked"
  | "repair_failed"
  | "quality_failed"
  | "taskrun_cancelled";

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  taskRunId: string;
  title: string;
  message: string;
  createdAt: string;
  severity: "warning" | "failed" | "neutral";
}

export const NOTIFICATION_DISMISSED_KEY =
  "harness.notificationTray.dismissed";

export const buildTaskRunNotifications = (
  detail: TaskRunDetail,
  latestGate: QualityGateResult | null,
): NotificationItem[] => {
  const taskRun = detail.taskRun;
  const notifications: NotificationItem[] = [];
  for (const approval of detail.approvals) {
    const decision = approval.autoApproveDecision;
    if (isBudgetBlockedApproval(approval) && decision) {
      notifications.push({
        id: `budget_blocked:${approval.id}`,
        kind: "budget_blocked",
        taskRunId: taskRun.id,
        title: "Budget blocked",
        message: decision.reason,
        createdAt: approval.decidedAt ?? taskRun.updatedAt,
        severity: "warning",
      });
    }
  }

  if (hasFailedRepairSignal(detail)) {
    notifications.push({
      id: `repair_failed:${taskRun.id}`,
      kind: "repair_failed",
      taskRunId: taskRun.id,
      title: "Repair failed",
      message: taskRun.userRequest,
      createdAt: taskRun.updatedAt,
      severity: "failed",
    });
  }

  if (taskRun.status === "quality_failed" || latestGate?.status === "failed") {
    notifications.push({
      id: `quality_failed:${taskRun.id}`,
      kind: "quality_failed",
      taskRunId: taskRun.id,
      title: "Quality failed",
      message:
        latestGate?.knownRisks[0] ??
        latestGate?.id ??
        taskRun.userRequest,
      createdAt: latestGate?.createdAt ?? taskRun.updatedAt,
      severity: "failed",
    });
  }

  if (taskRun.status === "cancelled") {
    notifications.push({
      id: `taskrun_cancelled:${taskRun.id}`,
      kind: "taskrun_cancelled",
      taskRunId: taskRun.id,
      title: "TaskRun cancelled",
      message: taskRun.userRequest,
      createdAt: taskRun.updatedAt,
      severity: "neutral",
    });
  }

  return notifications;
};

export const mergeNotifications = (
  existing: readonly NotificationItem[],
  incoming: readonly NotificationItem[],
  dismissedIds: ReadonlySet<string>,
  limit = 10,
): NotificationItem[] => {
  const byId = new Map<string, NotificationItem>();
  for (const item of existing) {
    if (!dismissedIds.has(item.id)) byId.set(item.id, item);
  }
  for (const item of incoming) {
    if (!dismissedIds.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
};

export const loadDismissedNotificationIds = (
  storage: Pick<Storage, "getItem">,
  key = NOTIFICATION_DISMISSED_KEY,
): Set<string> => {
  try {
    const raw = storage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
};

export const saveDismissedNotificationIds = (
  storage: Pick<Storage, "setItem">,
  ids: ReadonlySet<string>,
  key = NOTIFICATION_DISMISSED_KEY,
): void => {
  storage.setItem(key, JSON.stringify([...ids]));
};

const isBudgetBlockedApproval = (approval: Approval): boolean =>
  approval.autoApproveDecision?.approved === false &&
  approval.autoApproveDecision.decidedAt === "budget_blocked";

const hasFailedRepairSignal = (detail: TaskRunDetail): boolean => {
  const failedRepairStep = detail.steps.some(
    (step) =>
      step.status === "failed" &&
      /repair/i.test(`${step.title} ${step.outputSummary ?? ""}`),
  );
  if (failedRepairStep) return true;
  return detail.agentInvocations.some(
    (invocation) =>
      invocation.status === "failed" &&
      detail.artifacts.some(
        (artifact) =>
          (artifact.id === invocation.parsedPlanArtifactId ||
            artifact.id === invocation.rawOutputArtifactId) &&
          /repair/i.test(`${artifact.title} ${artifact.summary ?? ""}`),
      ),
  );
};
