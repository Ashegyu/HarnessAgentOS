import type { ProposedAction } from "./types";
import { toProposedAction } from "./approval-policy";

export interface DraftPlanInput {
  userRequest: string;
  targetDir: string;
  redirectFrom?: { previousPlanContent: string; instruction: string };
}

export interface DraftedPlan {
  /** Short headline used as the artifact title. */
  title: string;
  /** Markdown plan body suitable for inline storage in artifact summary. */
  content: string;
  /** Side-effecting actions the plan proposes. Each becomes an Approval row. */
  proposedActions: ProposedAction[];
}

/**
 * Phase 2 deterministic plan drafter. Per phase-02.md:
 *   "PlanDrafter는 MVP에서 deterministic template 기반으로 시작한다.
 *    모델 호출이 있더라도 파일 수정 전 단계까지만 사용하고, side effect는 만들지 않는다."
 *
 * This template version intentionally proposes a single `file_write`
 * placeholder action so the approval flow can be exercised end-to-end
 * before Phase 3 introduces real planner integration.
 */
export const draftPlan = (input: DraftPlanInput): DraftedPlan => {
  const trimmedRequest = input.userRequest.trim();
  const title = buildTitle(trimmedRequest, !!input.redirectFrom);

  const sections: string[] = [
    `# ${title}`,
    "",
    `**대상 폴더**: \`${input.targetDir}\``,
    "",
    `**요청**:`,
    "",
    `> ${trimmedRequest.replace(/\n+/g, "\n> ")}`,
    "",
    `## 제안된 단계`,
    "",
    `1. \`inspect\` — 대상 폴더와 요청을 분석한다.`,
    `2. \`plan\` — 변경 영역과 영향 범위를 정리한다.`,
    `3. \`approval\` — 사용자 승인 대기.`,
    "",
    `## 제안된 액션`,
    "",
    `- \`file_write\` (medium risk) — 요청에 따라 \`${input.targetDir}\` 내 파일 수정.`,
    "",
    `> Phase 2는 deterministic template이며, 실제 파일 수정은 승인 후 Phase 3 runner가 수행합니다.`,
  ];

  if (input.redirectFrom) {
    sections.push(
      "",
      `## Redirect`,
      "",
      `- 이전 계획에 대한 수정 지시: \`${input.redirectFrom.instruction}\``,
    );
  }

  const proposedActions: ProposedAction[] = [
    toProposedAction(
      "file_write",
      `Apply requested changes within ${input.targetDir} ("${trimmedRequest.slice(0, 80)}${
        trimmedRequest.length > 80 ? "…" : ""
      }")`,
    ),
  ];

  return {
    title,
    content: sections.join("\n"),
    proposedActions,
  };
};

const buildTitle = (request: string, isRedirect: boolean): string => {
  const firstLine = request.split(/\r?\n/, 1)[0] ?? "";
  const truncated = firstLine.slice(0, 80).trim() || "작업 계획";
  return isRedirect ? `재계획: ${truncated}` : truncated;
};
