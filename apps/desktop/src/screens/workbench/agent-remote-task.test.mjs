import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatRemoteTaskLabel,
  remoteTaskForInvocation,
  remoteTaskTitle,
} from "./agent-remote-task.ts";

const remoteRef = {
  invocationId: "inv_1",
  endpointId: "a2a_remote",
  remoteTaskId: "task_remote_1",
  remoteContextId: "ctx_remote_1",
  state: "working",
  lastEventAt: "2026-05-15T00:00:00.000Z",
};

test("remoteTaskForInvocation matches refs by invocation id", () => {
  assert.deepEqual(remoteTaskForInvocation([remoteRef], "inv_1"), remoteRef);
  assert.equal(remoteTaskForInvocation([remoteRef], "inv_missing"), null);
});

test("formatRemoteTaskLabel summarizes A2A state and task id", () => {
  assert.equal(formatRemoteTaskLabel(remoteRef), "A2A working · task_remote_1");
});

test("remoteTaskTitle includes endpoint, context, and timestamp", () => {
  assert.match(remoteTaskTitle(remoteRef), /endpoint a2a_remote/);
  assert.match(remoteTaskTitle(remoteRef), /context ctx_remote_1/);
  assert.match(remoteTaskTitle(remoteRef), /2026-05-15T00:00:00.000Z/);
});
