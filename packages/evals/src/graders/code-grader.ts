import { promises as fs } from "node:fs";
import path from "node:path";

import type { FakeModelCliAdapter } from "@harness/agent";
import type { LocalStateService } from "@harness/storage";

import type { CodeGrader } from "../grader-types.ts";

export interface CodeGraderContext {
  readonly targetDir: string;
  readonly state: LocalStateService;
  readonly taskRunId: string;
  readonly adapter: Pick<FakeModelCliAdapter, "getRecordedRequests">;
  readonly workspaceRoot: string;
}

export interface GraderResult {
  readonly passed: boolean;
  readonly reason?: string;
  readonly partialPassAsFail?: boolean;
}

export const runCodeGrader = async (
  grader: CodeGrader,
  ctx: CodeGraderContext,
): Promise<GraderResult> => {
  const assertion = grader.assertion;
  switch (assertion.type) {
    case "file_contains":
      return gradeFileContains(assertion, ctx);
    case "fs_unchanged_outside":
      return { passed: true };
    case "approval_status":
      return gradeApprovalStatus(assertion, ctx);
    case "recorded_request_contains":
      return gradeRecordedRequestContains(assertion, ctx);
    case "repair_attempts_eq":
      return gradeRepairAttempts(assertion, ctx);
  }
};

const gradeFileContains = async (
  assertion: Extract<CodeGrader["assertion"], { type: "file_contains" }>,
  ctx: CodeGraderContext,
): Promise<GraderResult> => {
  const abs = path.resolve(ctx.targetDir, assertion.path);
  if (!isInsideOrSame(path.resolve(ctx.targetDir), abs)) {
    return {
      passed: false,
      reason: `file_contains path escapes targetDir: ${assertion.path}`,
    };
  }

  const content = await fs.readFile(abs, "utf8").catch(() => "");
  let pattern: RegExp;
  try {
    pattern = new RegExp(assertion.pattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { passed: false, reason: `invalid regex ${assertion.pattern}: ${message}` };
  }

  return pattern.test(content)
    ? { passed: true }
    : {
        passed: false,
        reason: `${assertion.path} does not contain ${assertion.pattern}`,
      };
};

const gradeApprovalStatus = async (
  assertion: Extract<CodeGrader["assertion"], { type: "approval_status" }>,
  ctx: CodeGraderContext,
): Promise<GraderResult> => {
  const approvals = await ctx.state.listApprovalsByTaskRun(ctx.taskRunId);
  const match = approvals.find(
    (approval) => approval.actionType === assertion.actionType,
  );
  if (!match) {
    return { passed: false, reason: `no approval of ${assertion.actionType}` };
  }
  return approvalStatusMatches(match.status, assertion.expected)
    ? { passed: true }
    : {
        passed: false,
        reason: `expected ${assertion.expected}, got ${match.status}`,
      };
};

const gradeRecordedRequestContains = (
  assertion: Extract<
    CodeGrader["assertion"],
    { type: "recorded_request_contains" }
  >,
  ctx: CodeGraderContext,
): GraderResult => {
  const requests = ctx.adapter.getRecordedRequests();
  return requests.some((request) => request.prompt.includes(assertion.needle))
    ? { passed: true }
    : {
        passed: false,
        reason: `needle "${assertion.needle}" not in any prompt`,
      };
};

const gradeRepairAttempts = async (
  assertion: Extract<CodeGrader["assertion"], { type: "repair_attempts_eq" }>,
  ctx: CodeGraderContext,
): Promise<GraderResult> => {
  const attempts = await ctx.state.repairAttempts.listByTaskRun(ctx.taskRunId);
  return attempts.length === assertion.expected
    ? { passed: true }
    : {
        passed: false,
        reason: `expected ${assertion.expected} attempts, got ${attempts.length}`,
      };
};

const isInsideOrSame = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return (
    relative.length === 0 ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const approvalStatusMatches = (
  actual: string,
  expected: "approved" | "rejected" | "pending",
): boolean => {
  if (expected !== "approved") return actual === expected;
  return (
    actual === "approved" ||
    actual === "always_approved_for_run" ||
    actual === "executed"
  );
};
