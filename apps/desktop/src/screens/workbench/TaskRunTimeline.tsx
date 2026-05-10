import type { Step, StepStatus, TaskRun } from "@harness/core";
import { TaskRunStatusBadge } from "./TaskRunStatusBadge";

interface TaskRunTimelineProps {
  taskRun: TaskRun;
  steps: Step[];
  onSelect?: (taskRunId: string) => void;
  isActive?: boolean;
}

const STEP_STATUS_LABEL: Record<StepStatus, string> = {
  pending: "대기",
  running: "실행 중",
  succeeded: "완료",
  failed: "실패",
  skipped: "건너뜀",
};

const STEP_STATUS_KIND: Record<StepStatus, string> = {
  pending: "neutral",
  running: "running",
  succeeded: "success",
  failed: "failed",
  skipped: "neutral",
};

export const TaskRunTimeline = ({
  taskRun,
  steps,
  onSelect,
  isActive,
}: TaskRunTimelineProps): JSX.Element => {
  return (
    <article
      className={`task-timeline${isActive ? " task-timeline--active" : ""}`}
      onClick={onSelect ? () => onSelect(taskRun.id) : undefined}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
    >
      <header className="task-timeline__header">
        <span className="task-timeline__title">{taskRun.userRequest}</span>
        <TaskRunStatusBadge status={taskRun.status} />
      </header>
      <div className="task-timeline__meta">
        <span title={taskRun.targetDir}>{taskRun.targetDir}</span>
      </div>
      <ol className="task-timeline__steps">
        {steps.map((s) => (
          <li key={s.id} className="task-timeline__step">
            <span
              className={`task-timeline__step-marker task-timeline__step-marker--${STEP_STATUS_KIND[s.status]}`}
              aria-hidden
            />
            <span className="task-timeline__step-kind">{s.kind}</span>
            <span className="task-timeline__step-title">{s.title}</span>
            <span
              className={`status-badge status-badge--${STEP_STATUS_KIND[s.status]}`}
            >
              {STEP_STATUS_LABEL[s.status]}
            </span>
          </li>
        ))}
        {steps.length === 0 && (
          <li className="task-timeline__step task-timeline__step--empty">
            아직 단계 없음
          </li>
        )}
      </ol>
    </article>
  );
};
