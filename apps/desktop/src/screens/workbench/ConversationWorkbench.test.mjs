import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const readSource = (file) => readFileSync(join(__dirname, file), "utf8");

test("ConversationWorkbench renders the current thread TaskRun flow", () => {
  const source = readSource("ConversationWorkbench.tsx");
  const inputSource = readSource("ConversationInput.tsx");
  const css = readSource("workbench.css");

  assert.match(source, /ThreadTaskFlow/);
  assert.match(source, /thread-task-flow/);
  assert.match(source, /이전 태스크/);
  assert.match(source, /다음 태스크/);
  assert.match(source, /onSelectTaskRun/);
  assert.match(source, /TaskRunStatusBadge/);
  assert.match(source, /followUpTaskRun/);

  assert.match(inputSource, /followUpTaskRunId/);
  assert.match(inputSource, /이어받기/);

  assert.match(css, /\.thread-task-flow/);
  assert.match(css, /\.thread-task-flow__connector/);
  assert.match(css, /\.thread-task-flow__node--selected/);
  assert.match(css, /\.chat-turn__thread-link/);
  assert.match(css, /\.conversation-input__followup/);
});
