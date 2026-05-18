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

test("renderReport includes attempt-level performance summary", () => {
  const md = renderReport({
    ...makeSummary(),
    cases: [
      {
        ...makeCaseResult("capability-case", "capability", false),
        attempts: [
          {
            attemptIdx: 0,
            passed: true,
            tokens: 1_000,
            durationMs: 1_000,
            gateStatus: "passed",
            approvalsCreated: 1,
            approvalsManual: 0,
            fsEscapeDetected: false,
          },
          {
            attemptIdx: 1,
            passed: false,
            tokens: 2_000,
            durationMs: 2_000,
            gateStatus: "failed",
            approvalsCreated: 2,
            approvalsManual: 1,
            fsEscapeDetected: false,
            graderReason: "expected failure",
          },
          {
            attemptIdx: 2,
            passed: true,
            tokens: 3_000,
            durationMs: 4_000,
            gateStatus: "passed",
            approvalsCreated: 0,
            approvalsManual: 0,
            fsEscapeDetected: false,
          },
        ],
        passAt1: 1,
        passAt3: 1,
        passToThe3: 0,
        consistency: 2 / 3,
        totalTokens: 6_000,
        totalDurationMs: 7_000,
        outcome: "partial",
      },
    ],
  });

  assert.match(md, /## Performance Summary/);
  assert.match(md, /\| Suite \| Attempts \| Avg Time \| P50 Time \| P95 Time \| Avg Tokens \| Tokens\/Passed Attempt \| Approvals Created \| Manual Approvals \| Attempt Pass Rate \|/);
  assert.match(md, /\| capability \| 3 \| 2\.3s \| 2\.0s \| 4\.0s \| 2,000 \| 3,000 \| 3 \| 1 \| 67% \|/);
});

test("renderReport marks Pass^3 as n/a when fewer than three attempts ran", () => {
  const md = renderReport({
    ...makeSummary(),
    suite: "capability",
    cases: [
      {
        ...makeCaseResult("real-smoke-case", "capability", true),
        case: {
          ...makeCaseResult("real-smoke-case", "capability", true).case,
          attempts: 1,
        },
        attempts: [
          {
            attemptIdx: 0,
            passed: true,
            tokens: 691,
            durationMs: 21_600,
            gateStatus: null,
            approvalsCreated: 1,
            approvalsManual: 1,
            fsEscapeDetected: false,
          },
        ],
        passAt1: 1,
        passAt3: 1,
        passToThe3: 0,
        consistency: 1,
        totalTokens: 691,
        totalDurationMs: 21_600,
        outcome: "passed",
      },
    ],
  });

  assert.match(md, /\| capability \| 1\/1 \| 100% \| n\/a \| 691 \| 21\.6s \|/);
  assert.match(
    md,
    /Pass@1: 100% \| Pass@3: 100% \| Pass\^3: n\/a \| Consistency: 100%/,
  );
});

test("renderReport includes performance notes for expensive real-smoke attempts", () => {
  const md = renderReport({
    ...makeSummary(),
    cases: [
      {
        ...makeCaseResult("real-smoke-case", "capability", true),
        attempts: [
          {
            attemptIdx: 0,
            passed: true,
            tokens: 67_728,
            durationMs: 34_201,
            gateStatus: null,
            approvalsCreated: 1,
            approvalsManual: 1,
            fsEscapeDetected: false,
          },
        ],
        totalTokens: 67_728,
        totalDurationMs: 34_201,
      },
    ],
  });

  assert.match(md, /## Performance Notes/);
  assert.match(md, /\| capability \| real-smoke-case \| 0 \| High tokens \| 67,728 tokens \| 50,000 tokens \|/);
  assert.match(md, /\| capability \| real-smoke-case \| 0 \| Slow attempt \| 34\.2s \| 30\.0s \|/);
});

test("renderReport includes provider comparison rows and provider case headings", () => {
  const claudeResult = {
    ...makeCaseResult("file-write-readme", "capability", true),
    provider: "claude",
    providerGroupId: "file-write-readme",
    case: {
      ...makeCaseResult("file-write-readme", "capability", true).case,
      attempts: 1,
      provider: "claude",
    },
  };
  const codexResult = {
    ...makeCaseResult("file-write-readme", "capability", true),
    provider: "codex",
    providerGroupId: "file-write-readme",
    case: {
      ...makeCaseResult("file-write-readme", "capability", true).case,
      attempts: 1,
      provider: "codex",
    },
    attempts: [
      {
        attemptIdx: 0,
        passed: true,
        tokens: 1234,
        durationMs: 1500,
        gateStatus: "passed",
        approvalsCreated: 1,
        approvalsManual: 0,
        fsEscapeDetected: false,
      },
    ],
    totalTokens: 1234,
    totalDurationMs: 1500,
  };

  const md = renderReport({
    ...makeSummary(),
    mode: "head_to_head",
    cases: [claudeResult, codexResult],
  });

  assert.match(md, /## Provider Comparison/);
  assert.match(
    md,
    /\| Case \| Provider \| Attempts \| Pass@3 \| Pass\^3 \| Avg Time \| P95 Time \| Avg Tokens \| Tokens\/Passed \|/,
  );
  assert.match(
    md,
    /\| file-write-readme \| claude \| 1 \| 100% \| n\/a \| 250ms \| 250ms \| 10 \| 10 \|/,
  );
  assert.match(
    md,
    /\| file-write-readme \| codex \| 1 \| 100% \| n\/a \| 1\.5s \| 1\.5s \| 1,234 \| 1,234 \|/,
  );
  assert.match(md, /### `file-write-readme` - capability - claude/);
  assert.match(md, /### `file-write-readme` - capability - codex/);
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

test("writeAttemptArtifacts writes provider-specific attempt result json", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hgos-report-"));
  try {
    const caseResult = {
      ...makeCaseResult("capability-case", "capability", true),
      provider: "codex",
      providerGroupId: "capability-case",
    };

    await writeAttemptArtifacts(caseResult, dir);

    const file = path.join(
      dir,
      "capability-case",
      "codex",
      "attempt-0",
      "result.json",
    );
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.passed, true);
    assert.equal(saved.attemptIdx, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
