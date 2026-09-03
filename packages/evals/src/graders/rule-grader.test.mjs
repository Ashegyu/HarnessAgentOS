import { test } from "node:test";
import assert from "node:assert/strict";

import { runRuleGrader } from "./rule-grader.ts";

const request = (model, prompt = "prompt") => ({
  invocationId: `inv-${model}`,
  taskRunId: "tr-1",
  cwd: "C:\\tmp\\project",
  prompt,
  modelConfig: {
    provider: "codex",
    model,
    timeoutMs: 30_000,
    stallTimeoutMs: 10_000,
  },
  sandbox: {
    primaryDir: "C:\\tmp\\project",
    enforceInPrompt: true,
  },
});

test("runRuleGrader matches regex against a recorded request model", () => {
  const result = runRuleGrader(
    {
      kind: "rule",
      rules: [
        {
          description: "second invocation uses learner selected model",
          check: "regex",
          target: "recorded_request[1].model",
          pattern: "^gpt-5\\.6-terra$",
        },
      ],
    },
    {
      adapter: {
        getRecordedRequests: () =>
          Object.freeze([
            request("gpt-5.6-sol"),
            request("gpt-5.6-terra"),
          ]),
      },
    },
  );

  assert.equal(result.passed, true);
});

test("runRuleGrader reports missing recorded request targets", () => {
  const result = runRuleGrader(
    {
      kind: "rule",
      rules: [
        {
          description: "third invocation exists",
          check: "regex",
          target: "recorded_request[2].model",
          pattern: ".+",
        },
      ],
    },
    {
      adapter: {
        getRecordedRequests: () => Object.freeze([request("gpt-5.4")]),
      },
    },
  );

  assert.equal(result.passed, false);
  assert.match(result.reason ?? "", /missing recorded_request\[2\]/);
});
