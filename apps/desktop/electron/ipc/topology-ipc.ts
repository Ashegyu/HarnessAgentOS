import {
  STATE_INVALID_INPUT,
  TOPOLOGY_TASK_NOT_FOUND,
  err,
  harnessError,
  ok,
  type HarnessResult,
  type RecordTopologyFeedbackInput,
  type RecommendTopologyInput,
  type TopologyRecommendation,
} from "@harness/core";
import { TopologyAdvisor, TopologyAdvisorError } from "@harness/learner";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const wrapErr = <T>(
  e: unknown,
  code = TOPOLOGY_TASK_NOT_FOUND,
): HarnessResult<T> => {
  if (e instanceof TopologyAdvisorError) {
    return err(harnessError(e.code, e.message));
  }
  const msg = e instanceof Error ? e.message : String(e);
  return err(harnessError(code, msg));
};

const parseRecommendInput = (
  input: unknown,
): HarnessResult<RecommendTopologyInput> => {
  if (!isObject(input)) {
    return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
  }
  const cast = input as { taskRunId?: unknown; maxCandidates?: unknown };
  if (!isNonEmptyString(cast.taskRunId)) {
    return err(
      harnessError(STATE_INVALID_INPUT, "taskRunId must be non-empty string"),
    );
  }
  if (
    cast.maxCandidates !== undefined &&
    typeof cast.maxCandidates !== "number"
  ) {
    return err(
      harnessError(STATE_INVALID_INPUT, "maxCandidates must be a number"),
    );
  }
  const parsed: RecommendTopologyInput = { taskRunId: cast.taskRunId };
  if (typeof cast.maxCandidates === "number") {
    parsed.maxCandidates = cast.maxCandidates;
  }
  return ok(parsed);
};

const parseFeedbackInput = (
  input: unknown,
): HarnessResult<RecordTopologyFeedbackInput> => {
  if (!isObject(input)) {
    return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
  }
  const cast = input as {
    taskRunId?: unknown;
    recommendationId?: unknown;
    decision?: unknown;
    reason?: unknown;
  };
  if (!isNonEmptyString(cast.taskRunId)) {
    return err(
      harnessError(STATE_INVALID_INPUT, "taskRunId must be non-empty string"),
    );
  }
  if (!isNonEmptyString(cast.recommendationId)) {
    return err(
      harnessError(
        STATE_INVALID_INPUT,
        "recommendationId must be non-empty string",
      ),
    );
  }
  if (cast.decision !== "applied" && cast.decision !== "dismissed") {
    return err(
      harnessError(
        STATE_INVALID_INPUT,
        "decision must be 'applied' or 'dismissed'",
      ),
    );
  }
  if (cast.reason !== undefined && typeof cast.reason !== "string") {
    return err(harnessError(STATE_INVALID_INPUT, "reason must be a string"));
  }
  const parsed: RecordTopologyFeedbackInput = {
    taskRunId: cast.taskRunId,
    recommendationId: cast.recommendationId,
    decision: cast.decision,
  };
  if (typeof cast.reason === "string") parsed.reason = cast.reason;
  return ok(parsed);
};

export const buildTopologyHandlers = (advisor: TopologyAdvisor) => ({
  recommend: async (
    input: unknown,
  ): Promise<HarnessResult<TopologyRecommendation[]>> => {
    const parsed = parseRecommendInput(input);
    if (!parsed.ok) return parsed;
    try {
      return ok(await advisor.recommend(parsed.value));
    } catch (e) {
      return wrapErr<TopologyRecommendation[]>(e);
    }
  },
  recordFeedback: async (input: unknown): Promise<HarnessResult<null>> => {
    const parsed = parseFeedbackInput(input);
    if (!parsed.ok) return parsed;
    try {
      await advisor.recordFeedback(parsed.value);
      return ok(null);
    } catch (e) {
      return wrapErr<null>(e);
    }
  },
});
