import type { FakeModelCliAdapter } from "@harness/agent";

import type { RuleGrader } from "../grader-types.ts";
import type { GraderResult } from "./code-grader.ts";

export interface RuleGraderContext {
  readonly adapter: Pick<FakeModelCliAdapter, "getRecordedRequests">;
}

export const runRuleGrader = (
  grader: RuleGrader,
  ctx: RuleGraderContext,
): GraderResult => {
  for (const rule of grader.rules) {
    const value = readTarget(rule.target, ctx);
    if (!value.ok) {
      return { passed: false, reason: value.reason };
    }
    if (rule.check === "regex") {
      const pattern = rule.pattern ?? "";
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          passed: false,
          reason: `${rule.description}: invalid regex ${pattern}: ${message}`,
        };
      }
      if (!re.test(value.value)) {
        return {
          passed: false,
          reason: `${rule.description}: ${value.value} does not match ${pattern}`,
        };
      }
      continue;
    }
    if (rule.check === "count") {
      const count = Number(value.value);
      if (!Number.isFinite(count)) {
        return {
          passed: false,
          reason: `${rule.description}: target ${rule.target} is not countable`,
        };
      }
      const min = rule.count?.min ?? Number.NEGATIVE_INFINITY;
      const max = rule.count?.max ?? Number.POSITIVE_INFINITY;
      if (count < min || count > max) {
        return {
          passed: false,
          reason: `${rule.description}: count ${count} outside ${min}..${max}`,
        };
      }
      continue;
    }
    return {
      passed: false,
      reason: `${rule.description}: schema checks are not implemented`,
    };
  }
  return { passed: true };
};

const readTarget = (
  target: string,
  ctx: RuleGraderContext,
): { ok: true; value: string } | { ok: false; reason: string } => {
  if (target === "recorded_requests.count") {
    return { ok: true, value: String(ctx.adapter.getRecordedRequests().length) };
  }

  const match = /^recorded_request\[(\d+)\]\.(model|prompt|provider)$/.exec(
    target,
  );
  if (!match) {
    return { ok: false, reason: `unsupported rule target ${target}` };
  }
  const index = Number(match[1]);
  const field = match[2];
  const request = ctx.adapter.getRecordedRequests()[index];
  if (!request) {
    return { ok: false, reason: `missing recorded_request[${index}]` };
  }
  if (field === "model") {
    return { ok: true, value: request.modelConfig.model };
  }
  if (field === "provider") {
    return { ok: true, value: request.modelConfig.provider };
  }
  return { ok: true, value: request.prompt };
};
