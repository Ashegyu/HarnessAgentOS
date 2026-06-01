import assert from "node:assert/strict";
import test from "node:test";

import {
  beginTaskRunDetailRefresh,
  beginThreadDetailRefresh,
} from "./workbench-refresh-state.ts";

test("beginThreadDetailRefresh keeps same-thread ready detail visible", () => {
  const previous = {
    kind: "ready",
    detail: {
      thread: { id: "thread-1" },
    },
  };

  assert.equal(beginThreadDetailRefresh(previous, "thread-1"), previous);
});

test("beginThreadDetailRefresh shows loading when switching threads", () => {
  const previous = {
    kind: "ready",
    detail: {
      thread: { id: "thread-1" },
    },
  };

  assert.deepEqual(beginThreadDetailRefresh(previous, "thread-2"), {
    kind: "loading",
    threadId: "thread-2",
  });
});

test("beginTaskRunDetailRefresh keeps same-task ready detail visible", () => {
  const previous = {
    kind: "ready",
    detail: {
      taskRun: { id: "task-1" },
    },
  };

  assert.equal(beginTaskRunDetailRefresh(previous, "task-1"), previous);
});

test("beginTaskRunDetailRefresh shows loading when switching task runs", () => {
  const previous = {
    kind: "ready",
    detail: {
      taskRun: { id: "task-1" },
    },
  };

  assert.deepEqual(beginTaskRunDetailRefresh(previous, "task-2"), {
    kind: "loading",
    taskRunId: "task-2",
  });
});
