import type {
  ApprovalActionType,
  AutoApproveStep,
  DecisionLogFilter,
} from "@harness/core";

export const ACTIVITY_LOG_PAGE_SIZE = 50;

export interface ActivityLogFilterDraft {
  selectedSteps: ReadonlySet<AutoApproveStep>;
  actionType: ApprovalActionType | "all";
  fromDate: string;
  toDate: string;
}

export const buildActivityLogFilter = (
  draft: ActivityLogFilterDraft,
): DecisionLogFilter | undefined => {
  const filter: DecisionLogFilter = {
    decidedAtSteps: [...draft.selectedSteps],
  };
  if (draft.actionType !== "all") {
    filter.actionTypes = [draft.actionType];
  }
  const sinceIso = dateInputToIso(draft.fromDate);
  if (sinceIso) filter.sinceIso = sinceIso;
  const untilIso = dateInputToExclusiveUntilIso(draft.toDate);
  if (untilIso) filter.untilIso = untilIso;
  return isEmptyFilter(filter) ? undefined : filter;
};

export const previousDecisionOffset = (offset: number): number =>
  Math.max(0, offset - ACTIVITY_LOG_PAGE_SIZE);

export const nextDecisionOffset = (offset: number): number =>
  offset + ACTIVITY_LOG_PAGE_SIZE;

const isEmptyFilter = (filter: DecisionLogFilter): boolean =>
  filter.decidedAtSteps === undefined &&
  filter.actionTypes === undefined &&
  filter.sinceIso === undefined &&
  filter.untilIso === undefined;

const dateInputToIso = (value: string): string | undefined => {
  const parts = parseDateInput(value);
  if (!parts) return undefined;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).toISOString();
};

const dateInputToExclusiveUntilIso = (value: string): string | undefined => {
  const parts = parseDateInput(value);
  if (!parts) return undefined;
  return new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + 1),
  ).toISOString();
};

const parseDateInput = (
  value: string,
): { year: number; month: number; day: number } | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
};
