import type { Approval } from "@harness/core";

interface InlineApprovalCardProps {
  approvals: Approval[];
  autoApprove: boolean;
  contextDrawerOpen: boolean;
  onOpenDrawer: () => void;
}

const labelForAction = (actionType: string): string => {
  switch (actionType) {
    case "capability_use":
      return "Skill 후보";
    case "model_use":
      return "모델 추천";
    case "file_patch":
      return "파일 패치";
    case "file_write":
      return "파일 쓰기";
    case "shell":
      return "쉘 명령";
    case "dependency_install":
      return "의존성 설치";
    case "network":
      return "네트워크 요청";
    case "git_commit":
      return "git commit";
    case "skill_script":
      return "skill 스크립트";
    case "orchestration_plan":
      return "오케스트레이션 plan";
    default:
      return actionType;
  }
};

export const InlineApprovalCard = ({
  approvals,
  autoApprove,
  contextDrawerOpen,
  onOpenDrawer,
}: InlineApprovalCardProps): JSX.Element | null => {
  const pending = approvals.filter((a) => a.status === "pending");
  if (pending.length === 0) return null;

  const summary = pending
    .map((a) => labelForAction(a.actionType))
    .slice(0, 3)
    .join(", ");
  const overflow = pending.length > 3 ? ` 외 ${pending.length - 3}건` : "";

  // When auto-approve is on the user doesn't need to act — pending rows are
  // a transient state between creation and execution. Surface that with a
  // calmer label + spinner-like glyph so it doesn't look like a stuck queue.
  const variantClass = autoApprove
    ? " inline-approval-card--auto"
    : "";

  return (
    <div
      className={`inline-approval-card${variantClass}`}
      role="status"
      aria-live="polite"
    >
      <div className="inline-approval-card__body">
        <span className="inline-approval-card__icon" aria-hidden>
          {autoApprove ? "↻" : "⚠"}
        </span>
        <div className="inline-approval-card__text">
          <span className="inline-approval-card__title">
            {autoApprove
              ? `자동 승인 처리 중 ${pending.length}건`
              : `승인 대기 ${pending.length}건`}
          </span>
          <span className="inline-approval-card__detail">
            {summary}
            {overflow}
          </span>
        </div>
      </div>
      {!autoApprove && !contextDrawerOpen && (
        <button
          type="button"
          className="inline-approval-card__action"
          onClick={(e) => {
            e.stopPropagation();
            onOpenDrawer();
          }}
        >
          승인 패널 열기
        </button>
      )}
    </div>
  );
};
