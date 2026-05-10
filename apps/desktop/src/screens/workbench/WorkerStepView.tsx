import type { WorkerStep } from "@harness/core";

interface WorkerStepViewProps {
  step: WorkerStep;
}

export const WorkerStepView = ({ step }: WorkerStepViewProps): JSX.Element => {
  return (
    <li className={`worker-step worker-step--${step.status}`}>
      <header className="worker-step__header">
        <span className="worker-step__role">{step.role}</span>
        <span className={`status-pill status-pill--${statusClass(step.status)}`}>
          {step.status}
        </span>
      </header>
      <p className="worker-step__title">{step.title}</p>
      <p className="muted worker-step__inputs">
        입력: {step.inputSummary || "(empty)"}
      </p>
      {step.expectedArtifactKinds.length > 0 ? (
        <p className="muted worker-step__artifacts">
          기대 artifact: {step.expectedArtifactKinds.join(", ")}
        </p>
      ) : null}
    </li>
  );
};

const statusClass = (s: WorkerStep["status"]): string => {
  if (s === "succeeded") return "passed";
  if (s === "failed") return "failed";
  if (s === "running") return "warning";
  return "neutral";
};
