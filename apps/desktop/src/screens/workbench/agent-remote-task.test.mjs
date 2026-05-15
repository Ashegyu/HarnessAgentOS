import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatRemoteTaskLabel,
  remoteTaskAttentionLabel,
  remoteTaskForInvocation,
  remoteTaskNeedsAttention,
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

test("remoteTaskNeedsAttention flags input and auth requirements", () => {
  assert.equal(
    remoteTaskNeedsAttention({ ...remoteRef, state: "input-required" }),
    true,
  );
  assert.equal(
    remoteTaskNeedsAttention({ ...remoteRef, state: "auth-required" }),
    true,
  );
  assert.equal(remoteTaskNeedsAttention(remoteRef), false);
});

test("remoteTaskAttentionLabel explains operator action", () => {
  assert.equal(
    remoteTaskAttentionLabel({ ...remoteRef, state: "input-required" }),
    "사용자 입력 필요",
  );
  assert.equal(
    remoteTaskAttentionLabel({ ...remoteRef, state: "auth-required" }),
    "인증 설정 필요",
  );
  assert.equal(remoteTaskAttentionLabel(remoteRef), null);
});
