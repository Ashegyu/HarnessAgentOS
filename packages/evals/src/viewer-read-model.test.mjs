import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evalRunRecordToDetail,
  evalRunRecordToListItem,
} from "./viewer-read-model.ts";

const record = {
  id: "evrun_1",
  suite: "capability",
  startedAt: "2026-05-18T01:00:00.000Z",
  finishedAt: "2026-05-18T01:01:00.000Z",
  status: "passed",
  harnessSha: "abc1234",
  createdAt: "2026-05-18T01:00:00.000Z",
  summary: {
    runId: "evrun_1",
    suite: "capability",
    startedAt: "2026-05-18T01:00:00.000Z",
    finishedAt: "2026-05-18T01:01:00.000Z",
    status: "passed",
    mode: "real_cli",
    harnessRevisionSha: "abc1234",
    cases: [
      {
        case: {
          id: "file-write-readme-sol",
          kind: "capability",
          title: "Write README",
          attempts: 1,
        },
        provider: "codex",
        attempts: [
          {
            attemptIdx: 0,
            passed: true,
            tokens: 100,
            durationMs: 250,
            approvalsCreated: 1,
            approvalsManual: 1,
          },
        ],
        passAt3: 1,
        passToThe3: 0,
        totalTokens: 100,
        totalDurationMs: 250,
        outcome: "passed",
      },
      {
        case: {
          id: "file-write-readme-terra",
          kind: "capability",
          title: "Write README",
          attempts: 1,
        },
        provider: "codex",
        attempts: [
          {
            attemptIdx: 0,
            passed: false,
            tokens: 300,
            durationMs: 750,
            approvalsCreated: 1,
            approvalsManual: 0,
          },
        ],
        passAt3: 0,
        passToThe3: 0,
        totalTokens: 300,
        totalDurationMs: 750,
        outcome: "failed",
      },
    ],
  },
};

test("evalRunRecordToListItem summarizes totals for the viewer", () => {
  const item = evalRunRecordToListItem(record);

  assert.equal(item.id, "evrun_1");
  assert.equal(item.mode, "real_cli");
  assert.equal(item.caseCount, 2);
  assert.equal(item.attemptCount, 2);
  assert.equal(item.totalTokens, 400);
  assert.equal(item.totalDurationMs, 1000);
  assert.equal(item.passRate, 0.5);
});

test("evalRunRecordToDetail exposes case rows without raw artifacts", () => {
  const detail = evalRunRecordToDetail(record);

  assert.equal(detail.run.id, "evrun_1");
  assert.deepEqual(
    detail.cases.map((caseRow) => [
      caseRow.caseId,
      caseRow.provider,
      caseRow.attemptCount,
      caseRow.passedAttempts,
    ]),
    [
      ["file-write-readme-sol", "codex", 1, 1],
      ["file-write-readme-terra", "codex", 1, 0],
    ],
  );
});
