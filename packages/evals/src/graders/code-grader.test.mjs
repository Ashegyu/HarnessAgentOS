import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FakeModelCliAdapter } from "@harness/agent";
import { closeDb, LocalStateService, openDb } from "@harness/storage";

import { runCodeGrader } from "./code-grader.ts";

const makeState = () => {
  const db = openDb({ filePath: ":memory:" });
  return { db, state: new LocalStateService(db) };
};

test("file_contains passes when the target file matches the pattern", async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), "hgos-code-grader-"));
  try {
    await writeFile(path.join(targetDir, "README.md"), "# Hello\n", "utf8");
    const { db, state } = makeState();
    try {
      const result = await runCodeGrader(
        {
          kind: "code",
          assertion: {
            type: "file_contains",
            path: "README.md",
            pattern: "^# Hello",
          },
        },
        {
          targetDir,
          state,
          taskRunId: "task-1",
          adapter: new FakeModelCliAdapter({ scenario: "ok-answer-only" }),
          workspaceRoot: targetDir,
        },
      );

      assert.equal(result.passed, true);
    } finally {
      closeDb(db);
    }
  } finally {
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("recorded_request_contains checks fake adapter introspection", async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), "hgos-code-grader-"));
  try {
    const { db, state } = makeState();
    const adapter = new FakeModelCliAdapter({
      scenario: "ok-answer-only",
      chunkDelayMs: 0,
    });
    try {
      await adapter.invoke(
        {
          invocationId: "inv-1",
          taskRunId: "task-1",
          cwd: targetDir,
          prompt: "Please write README.md",
          modelConfig: {
            provider: "claude",
            model: "fake",
            timeoutMs: 30_000,
            stallTimeoutMs: 10_000,
          },
          sandbox: {
            primaryDir: targetDir,
            enforceInPrompt: true,
          },
        },
        () => {},
      );

      const result = await runCodeGrader(
        {
          kind: "code",
          assertion: {
            type: "recorded_request_contains",
            needle: "README.md",
          },
        },
        {
          targetDir,
          state,
          taskRunId: "task-1",
          adapter,
          workspaceRoot: targetDir,
        },
      );

      assert.equal(result.passed, true);
    } finally {
      closeDb(db);
    }
  } finally {
    await rm(targetDir, { recursive: true, force: true });
  }
});
