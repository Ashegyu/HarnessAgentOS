import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FakeModelCliAdapter } from "@harness/agent";
import { closeDb, LocalStateService, openDb } from "@harness/storage";

import { CaseRunner } from "./case-runner.ts";

const makeDbFactory = () => {
  const dbs = [];
  return {
    dbs,
    create: () => {
      const db = openDb({ filePath: ":memory:" });
      dbs.push(db);
      return new LocalStateService(db);
    },
    closeAll: () => {
      for (const db of dbs) closeDb(db);
    },
  };
};

const fileWriteReadmeCase = {
  id: "file-write-readme",
  kind: "capability",
  title: "에이전트가 README.md를 생성하는 단순 사례",
  instruction: "현재 폴더에 README.md를 만들고 '# Hello' 한 줄을 적어라.",
  scenario: "ok-file-write-readme",
  attempts: 3,
  grader: {
    kind: "code",
    assertion: {
      type: "file_contains",
      path: "README.md",
      pattern: "^# Hello",
    },
  },
  thresholds: { passAt3: 0.9 },
};

test("CaseRunner runs N attempts and aggregates pass metrics", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "hgos-case-runner-"));
  const dbFactory = makeDbFactory();
  try {
    const runner = new CaseRunner({
      adapterFactory: () =>
        new FakeModelCliAdapter({
          scenario: "ok-file-write-readme",
          chunkDelayMs: 0,
        }),
      dbFactory: dbFactory.create,
      workspaceRoot,
      runId: "test-run-001",
      clock: () => 100,
    });

    const result = await runner.run(fileWriteReadmeCase);

    assert.equal(result.attempts.length, 3);
    assert.equal(result.passAt1, 1);
    assert.equal(result.passAt3, 1);
    assert.equal(result.passToThe3, 1);
    assert.equal(result.consistency, 1);
    assert.equal(result.outcome, "passed");
    assert.equal(
      result.attempts.every((attempt) => !attempt.fsEscapeDetected),
      true,
    );
  } finally {
    dbFactory.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CaseRunner detects writes outside the attempt target directory", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "hgos-case-runner-"));
  const dbFactory = makeDbFactory();
  try {
    const escapingAdapter = {
      clearRecordedRequests() {},
      getRecordedRequests() {
        return Object.freeze([]);
      },
      async invoke(request, onEvent) {
        await writeFile(
          path.join(workspaceRoot, "outside.txt"),
          "escape\n",
          "utf8",
        );
        onEvent({
          type: "started",
          invocationId: request.invocationId,
          provider: request.modelConfig.provider,
          model: request.modelConfig.model,
        });
        const stdout = [
          "```harness_agent_plan",
          JSON.stringify({
            summary: "No action",
            assumptions: [],
            steps: [],
            proposedActions: [],
            suggestedQualityChecks: [],
            questions: [],
          }),
          "```",
        ].join("\n");
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
    };
    const runner = new CaseRunner({
      adapterFactory: () => escapingAdapter,
      dbFactory: dbFactory.create,
      workspaceRoot,
      runId: "test-run-escape",
      clock: () => 100,
    });

    const result = await runner.run({
      ...fileWriteReadmeCase,
      id: "escape-write",
      attempts: 1,
      grader: {
        kind: "code",
        assertion: {
          type: "recorded_request_contains",
          needle: "never",
        },
      },
    });

    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].fsEscapeDetected, true);
    assert.equal(result.outcome, "failed");
  } finally {
    dbFactory.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
