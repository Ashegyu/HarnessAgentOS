import type { EvalAttemptResult } from "./types.ts";

export const computePassAt1 = (attempts: ReadonlyArray<EvalAttemptResult>): number => {
  if (attempts.length === 0) {
    return 0;
  }

  const first = attempts.find((attempt) => attempt.attemptIdx === 0);
  return first?.passed ? 1 : 0;
};

export const computePassAtK = (
  attempts: ReadonlyArray<EvalAttemptResult>,
  k: number,
): number => {
  if (k <= 0) {
    return 0;
  }

  const attemptsWithinK = attempts.filter((attempt) => attempt.attemptIdx < k);
  if (attemptsWithinK.length === 0) {
    return 0;
  }

  return attemptsWithinK.some((attempt) => attempt.passed) ? 1 : 0;
};

export const computePassToTheK = (
  attempts: ReadonlyArray<EvalAttemptResult>,
  k: number,
): number => {
  if (k <= 0) {
    return 0;
  }

  const attemptsWithinK = attempts.filter((attempt) => attempt.attemptIdx < k);
  if (attemptsWithinK.length < k) {
    return 0;
  }

  return attemptsWithinK.every((attempt) => attempt.passed) ? 1 : 0;
};

export const computeConsistency = (
  attempts: ReadonlyArray<EvalAttemptResult>,
): number => {
  if (attempts.length === 0) {
    return 0;
  }

  const passed = attempts.filter((attempt) => attempt.passed).length;
  return passed / attempts.length;
};
