import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { renderReport } from "./report-template.ts";
import { writeAttemptArtifacts, writeMarkdownReport } from "./reporter.ts";

const makeCaseResult = (id, kind, passed = true) => ({
  case: {
    id,
    kind,
    title: `${id} title`,
    instruction: "do it",
    scenario: "ok-answer-only",
    attempts: 3,
    grader: {
      kind: "code",
      assertion: {
        type: "recorded_request_contains",
        needle: "do it",
      },
    },
  },
  attempts: [
    {
      attemptIdx: 0,
      passed,
      tokens: 10,
      durationMs: 250,
      gateStatus: passed ? "passed" : "failed",
      approvalsCreated: 1,
      approvalsManual: 0,
      fsEscapeDetected: false,
      ...(passed ? {} : { graderReason: "expected failure" }),
    },
  ],
  passAt1: passed ? 1 : 0,
  passAt3: passed ? 1 : 0,
  passToThe3: passed ? 1 : 0,
  consistency: 1,
  totalTokens: 10,
  totalDurationMs: 250,
  outcome: passed ? "passed" : "failed",
});

const makeSummary = () => ({
  runId: "evrun_test",
  suite: "all",
  startedAt: "2026-05-17T14:00:00.000Z",
  finishedAt: "2026-05-17T14:01:00.000Z",
  status: "partial",
  harnessRevisionSha: "abc1234",
  cases: [
    makeCaseResult("capability-case", "capability", true),
    makeCaseResult("safety-case", "safety", false),
  ],
});

test("renderReport produces stable markdown sections", () => {
  const md = renderReport(makeSummary());

  assert.match(md, /^# Eval Report - all/m);
  assert.match(md, /## Summary by Suite/);
  assert.match(md, /\| capability \| 1\/1 \| 100% \| 100% \| 10 \| 250ms \|/);
  assert.match(md, /### `safety-case` - safety/);
  assert.match(md, /\*\*Failure reasons\*\*/);
});

test("writeMarkdownReport creates report.md", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hgos-report-"));
  try {
    const file = await writeMarkdownReport(makeSummary(), dir);

    assert.equal(file, path.join(dir, "report.md"));
    assert.equal((await stat(file)).isFile(), true);
    assert.match(await readFile(file, "utf8"), /Eval Report - all/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeAttemptArtifacts writes each attempt result json", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hgos-report-"));
  try {
    const caseResult = makeCaseResult("capability-case", "capability", true);

    await writeAttemptArtifacts(caseResult, dir);

    const file = path.join(dir, "capability-case", "attempt-0", "result.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.passed, true);
    assert.equal(saved.attemptIdx, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
