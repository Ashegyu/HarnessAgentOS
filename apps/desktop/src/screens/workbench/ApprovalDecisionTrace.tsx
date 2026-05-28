import {
  AUTO_APPROVE_STEPS,
  type Approval,
  type AutoApproveStep,
} from "@harness/core";

type TraceStatus = "pass" | "stop" | "skip";

export interface AutoApproveTraceRow {
  step: AutoApproveStep;
  label: string;
  summary: string;
  status: TraceStatus;
  result: string;
}

export const AUTO_APPROVE_STEP_LABELS: Record<AutoApproveStep, string> = {
  blocked_action: "Block floor",
  policy_blocked: "Policy blocked",
  budget_blocked: "Budget gate",
  profile_auto_approve: "Profile auto-approve",
  policy_disallow_auto: "Policy manual-only",
  worker_file_action: "Worker file action",
  global_toggle: "Global toggle",
};

export const buildAutoApproveTraceRows = (
  approval: Approval,
): AutoApproveTraceRow[] => {
  const decision = approval.autoApproveDecision;
  if (!decision) return [];
  const decidedIndex = AUTO_APPROVE_STEPS.indexOf(decision.decidedAt);
  return AUTO_APPROVE_STEPS.map((step, index) => {
    const status: TraceStatus =
      index < decidedIndex ? "pass" : index === decidedIndex ? "stop" : "skip";
    return {
      step,
      label: AUTO_APPROVE_STEP_LABELS[step],
      summary: summarizeStep(step, approval),
      status,
      result: resultLabel(status, decision.approved),
    };
  });
};

export const ApprovalDecisionTrace = ({
  approval,
}: {
  approval: Approval;
}): JSX.Element | null => {
  const decision = approval.autoApproveDecision;
  if (!decision) return null;
  const rows = buildAutoApproveTraceRows(approval);
  return (
    <details className="approval-decision-trace">
      <summary className="approval-decision-trace__summary">
        <span>자동 승인 판단</span>
        <span className="approval-decision-trace__summary-step">
          {decision.decidedAt}
        </span>
      </summary>
      <ol className="approval-decision-trace__steps">
        {rows.map((row) => (
          <li
            key={row.step}
            className={`approval-decision-trace__step approval-decision-trace__step--${row.status}`}
          >
            <div className="approval-decision-trace__step-head">
              <span>{row.label}</span>
              <span>{row.result}</span>
            </div>
            <p>{row.summary}</p>
          </li>
        ))}
      </ol>
      <p className="approval-decision-trace__reason">{decision.reason}</p>
    </details>
  );
};

const resultLabel = (status: TraceStatus, approved: boolean): string => {
  if (status === "pass") return "PASS";
  if (status === "skip") return "SKIP";
  return approved ? "STOP - 승인" : "STOP - 차단";
};

const summarizeStep = (step: AutoApproveStep, approval: Approval): string => {
  const policy = approval.policyEvaluation;
  if (step === "blocked_action") {
    return `actionType: ${approval.actionType}; profile blockedActions 확인`;
  }
  if (step === "policy_blocked") {
    return policy
      ? `policy: ${policy.decision}; ${policy.reason}`
      : "policyEvaluation 없음";
  }
  if (step === "budget_blocked") {
    const cost = policy?.costEstimateUsd;
    const budget = policy?.budgetDecision;
    if (budget?.kind === "blocked" && budget.reason) return budget.reason;
    return cost === undefined
      ? "costEstimateUsd 없음"
      : `costEstimateUsd: $${cost.toFixed(2)}`;
  }
  if (step === "profile_auto_approve") {
    return `profile autoApproveActions에서 ${approval.actionType} 확인`;
  }
  if (step === "policy_disallow_auto") {
    return policy?.allowAutoApprove === false
      ? `allowAutoApprove=false; ${policy.reason}`
      : "allowAutoApprove=true 또는 policyEvaluation 없음";
  }
  if (step === "worker_file_action") {
    return approval.actionType === "file_patch" ||
      approval.actionType === "file_write"
      ? "worker file action 자동 실행 후보"
      : "file_write/file_patch가 아니므로 worker file action 아님";
  }
  return "settings.approval.autoApprove fallback";
};
