import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDb, LocalStateService, openDb } from "@harness/storage";

import { sumTokensForTaskRun } from "./cost-tracker.ts";

const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hgos-cost-"));
  return {
    file: path.join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const createTaskRun = async (state) => {
  const thread = await state.createThread({
    title: "cost",
    targetDir: process.cwd(),
  });
  return state.createTaskRun({
    threadId: thread.id,
    userRequest: "cost",
    targetDir: process.cwd(),
  });
};

test("sumTokensForTaskRun prefers persisted result usage metadata", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const taskRun = await createTaskRun(state);
    const prompt = await state.createArtifact({
      taskRunId: taskRun.id,
      kind: "log",
      title: "Agent prompt",
      uri: "harness:test-prompt",
      summary: "prompt text",
    });
    const invocation = await state.createAgentInvocation({
      taskRunId: taskRun.id,
      provider: "claude",
      model: "claude-sonnet-4-6",
      promptArtifactId: prompt.id,
    });
    const raw = await state.createArtifact({
      taskRunId: taskRun.id,
      kind: "log",
      title: "Agent raw output",
      uri: "harness:test-output",
      summary: JSON.stringify({
        type: "result",
        invocationId: invocation.id,
        usage: {
          input_tokens: 9,
          output_tokens: 4,
          total_tokens: 13,
        },
      }),
    });
    await state.updateAgentInvocation(invocation.id, {
      rawOutputArtifactId: raw.id,
    });

    assert.equal(await sumTokensForTaskRun(state, taskRun.id), 13);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("sumTokensForTaskRun estimates from prompt and output artifacts without usage", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const taskRun = await createTaskRun(state);
    const prompt = await state.createArtifact({
      taskRunId: taskRun.id,
      kind: "log",
      title: "Agent prompt",
      uri: "harness:test-prompt",
      summary: "abcd",
    });
    const invocation = await state.createAgentInvocation({
      taskRunId: taskRun.id,
      provider: "codex",
      model: "gpt-5.4",
      promptArtifactId: prompt.id,
    });
    const raw = await state.createArtifact({
      taskRunId: taskRun.id,
      kind: "log",
      title: "Agent raw output",
      uri: "harness:test-output",
      summary: JSON.stringify({
        type: "assistant_text",
        invocationId: invocation.id,
        text: "abcdefgh",
      }),
    });
    await state.updateAgentInvocation(invocation.id, {
      rawOutputArtifactId: raw.id,
    });

    assert.equal(await sumTokensForTaskRun(state, taskRun.id), 3);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
