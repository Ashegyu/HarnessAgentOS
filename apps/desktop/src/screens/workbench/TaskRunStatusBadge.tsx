import type { TaskRunStatus } from "@harness/core";

interface TaskRunStatusBadgeProps {
  status: TaskRunStatus;
  label?: string;
  kind?: StatusBadgeKind;
}

export type StatusBadgeKind =
  | "neutral"
  | "pending"
  | "running"
  | "blocked"
  | "failed"
  | "success";

const LABEL: Record<TaskRunStatus, string> = {
  drafting: "초안",
  waiting_for_approval: "승인 대기",
  running: "실행 중",
  paused: "일시 중지",
  blocked: "차단됨",
  quality_failed: "품질 실패",
  ready_for_review: "검토 대기",
  done: "완료",
  cancelled: "취소됨",
};

const KIND: Record<TaskRunStatus, StatusBadgeKind> = {
  drafting: "neutral",
  waiting_for_approval: "pending",
  running: "running",
  paused: "neutral",
  blocked: "blocked",
  quality_failed: "failed",
  ready_for_review: "pending",
  done: "success",
  cancelled: "neutral",
};

export const TaskRunStatusBadge = ({
  status,
  label,
  kind,
}: TaskRunStatusBadgeProps): JSX.Element => {
  const displayLabel = label ?? LABEL[status];
  const displayKind = kind ?? KIND[status];
  return (
    <span
      className={`status-badge status-badge--${displayKind}`}
      data-status={status}
      aria-label={`작업 상태: ${displayLabel}`}
    >
      {displayLabel}
    </span>
  );
};
