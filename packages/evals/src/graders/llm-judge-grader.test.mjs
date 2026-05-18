import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseLlmJudgeOutput,
  runLlmJudgeGrader,
} from "./llm-judge-grader.ts";

const grader = {
  kind: "llm_judge",
  rubric: [
    {
      id: "correctness",
      description: "Answer matches the requested behavior.",
      weight: 1,
    },
  ],
  passThreshold: 0.8,
  judgeAttempts: 2,
  judgeProvider: "claude",
  maxJudgeTokens: 1234,
};

const makeJudgeAdapter = (outputs, requests = []) => ({
  async invoke(request) {
    requests.push(request);
    const stdout = outputs.shift() ?? outputs.at(-1) ?? "";
    return {
      provider: request.modelConfig.provider,
      model: request.modelConfig.model,
      exitCode: 0,
      stdout,
      stderr: "",
      normalizedEvents: [],
      latencyMs: 1,
    };
  },
});

test("parseLlmJudgeOutput accepts JSON judge scores", () => {
  const parsed = parseLlmJudgeOutput(
    JSON.stringify({
      score: 0.86,
      passed: true,
      rubric: [
        {
          id: "correctness",
          score: 0.9,
          reason: "Implementation matches the instruction.",
        },
      ],
      risks: ["minor edge case"],
    }),
  );

  assert.equal(parsed.score, 0.86);
  assert.equal(parsed.passed, true);
  assert.equal(parsed.rubric[0].id, "correctness");
  assert.deepEqual(parsed.risks, ["minor edge case"]);
});

test("parseLlmJudgeOutput rejects malformed output", () => {
  assert.throws(
    () => parseLlmJudgeOutput("not json"),
    /LLM judge output is not valid JSON/,
  );
  assert.throws(
    () => parseLlmJudgeOutput(JSON.stringify({ score: 1.2 })),
    /LLM judge output schema invalid/,
  );
});

test("runLlmJudgeGrader separates known good and known bad scores", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hgos-judge-"));
  try {
    await writeFile(path.join(dir, "README.md"), "# Hello\n", "utf8");
    const good = await runLlmJudgeGrader(grader, {
      enabled: true,
      targetDir: dir,
      taskRunId: "tr-good",
      judgeAdapter: makeJudgeAdapter([
        JSON.stringify({ score: 0.9, rubric: [], risks: [] }),
        JSON.stringify({ score: 0.84, rubric: [], risks: [] }),
      ]),
    });
    const bad = await runLlmJudgeGrader(grader, {
      enabled: true,
      targetDir: dir,
      taskRunId: "tr-bad",
      judgeAdapter: makeJudgeAdapter([
        JSON.stringify({ score: 0.4, rubric: [], risks: ["missing tests"] }),
        JSON.stringify({ score: 0.5, rubric: [], risks: ["missing tests"] }),
      ]),
    });

    assert.equal(good.passed, true);
    assert.equal(bad.passed, false);
    assert.match(bad.reason, /average score 0\.45 below threshold 0\.8/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runLlmJudgeGrader requires the explicit LLM judge gate", async () => {
  const result = await runLlmJudgeGrader(grader, {
    enabled: false,
    targetDir: tmpdir(),
    taskRunId: "tr-disabled",
  });

  assert.equal(result.passed, false);
  assert.match(result.reason, /LLM judge disabled/);
});

test("runLlmJudgeGrader passes judge token cap to the model config", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hgos-judge-"));
  const requests = [];
  try {
    await writeFile(path.join(dir, "README.md"), "# Hello\n", "utf8");
    const result = await runLlmJudgeGrader({ ...grader, judgeAttempts: 1 }, {
      enabled: true,
      targetDir: dir,
      taskRunId: "tr-budget",
      judgeAdapter: makeJudgeAdapter(
        [JSON.stringify({ score: 1, rubric: [], risks: [] })],
        requests,
      ),
    });

    assert.equal(result.passed, true);
    assert.equal(requests[0].modelConfig.maxTokens, 1234);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
