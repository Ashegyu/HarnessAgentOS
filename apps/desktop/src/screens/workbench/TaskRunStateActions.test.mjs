import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

globalThis.React = React;
const { TaskRunStateActions } = await import("./TaskRunStateActions.tsx");

const taskRun = (status) => ({
  id: `task_${status}`,
  threadId: "thread_1",
  userRequest: "run",
  targetDir: process.cwd(),
  status,
  createdAt: "2026-05-18T00:00:00.000Z",
  updatedAt: "2026-05-18T00:00:00.000Z",
});

const renderActions = (status) =>
  renderToStaticMarkup(
    React.createElement(TaskRunStateActions, {
      taskRun: taskRun(status),
      approvals: [],
      onChanged: async () => {},
    }),
  );

test("TaskRunStateActions renders Stop only while TaskRun is running", () => {
  const running = renderActions("running");
  assert.match(running, />Stop</);

  const waiting = renderActions("waiting_for_approval");
  assert.doesNotMatch(waiting, />Stop</);

  const paused = renderActions("paused");
  assert.doesNotMatch(paused, />Stop</);
});
