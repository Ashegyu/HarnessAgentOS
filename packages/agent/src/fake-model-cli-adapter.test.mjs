import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeModelCliAdapter } from "./fake-model-cli-adapter.ts";

const request = (prompt) => ({
  invocationId: `inv-${prompt}`,
  taskRunId: `task-${prompt}`,
  cwd: "C:\\tmp\\project",
  prompt,
  modelConfig: {
    provider: "claude",
    model: "fake-model",
    timeoutMs: 30_000,
    stallTimeoutMs: 10_000,
  },
  sandbox: {
    primaryDir: "C:\\tmp\\project",
    enforceInPrompt: true,
  },
});

test("FakeModelCliAdapter records every invoke request", async () => {
  const adapter = new FakeModelCliAdapter({
    scenario: "ok-answer-only",
    chunkDelayMs: 0,
  });

  await adapter.invoke(request("hello"), () => {});
  await adapter.invoke(request("world"), () => {});

  const recorded = adapter.getRecordedRequests();
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0].prompt, "hello");
  assert.equal(recorded[1].prompt, "world");
});

test("getRecordedRequests returns a frozen immutable array copy", async () => {
  const adapter = new FakeModelCliAdapter({
    scenario: "ok-answer-only",
    chunkDelayMs: 0,
  });

  await adapter.invoke(request("hello"), () => {});
  const recorded = adapter.getRecordedRequests();

  assert.ok(Object.isFrozen(recorded));
  assert.throws(() => {
    recorded.push(request("mutate"));
  });
  assert.equal(adapter.getRecordedRequests().length, 1);
});

test("clearRecordedRequests resets requests between attempts", async () => {
  const adapter = new FakeModelCliAdapter({
    scenario: "ok-answer-only",
    chunkDelayMs: 0,
  });

  await adapter.invoke(request("a"), () => {});
  adapter.clearRecordedRequests();

  assert.equal(adapter.getRecordedRequests().length, 0);
});

test("injected now and idGen make timestamps and session ids deterministic", async () => {
  const adapter = new FakeModelCliAdapter({
    scenario: "ok-answer-only",
    chunkDelayMs: 0,
    now: () => 1_700_000_000_000,
    idGen: () => "session-001",
  });
  const events = [];

  const result = await adapter.invoke(request("deterministic"), (event) => {
    events.push(event);
  });

  assert.equal(adapter.currentTimeMs(), 1_700_000_000_000);
  assert.equal(result.sessionId, "fake_session-001");
  const resultEvent = events.find((event) => event.type === "result");
  assert.equal(resultEvent.latencyMs, 0);
});

test("scenarios option advances per invocation", async () => {
  const adapter = new FakeModelCliAdapter({
    scenarios: ["fail-first-pass-second", "fail-first-pass-second"],
    chunkDelayMs: 0,
  });

  const first = await adapter.invoke(request("first"), () => {});
  const second = await adapter.invoke(request("second"), () => {});

  assert.match(first.stdout, /a - b/);
  assert.match(second.stdout, /a \+ b/);
});

test("ok-shell-pwd emits a cross-platform cwd echo command", async () => {
  const adapter = new FakeModelCliAdapter({
    scenario: "ok-shell-pwd",
    chunkDelayMs: 0,
  });

  const result = await adapter.invoke(request("shell"), () => {});

  assert.match(result.stdout, /node -e/);
  assert.match(result.stdout, /process\.cwd/);
});

test("safety injection scenarios expose their intended blocked actions", async () => {
  const shell = new FakeModelCliAdapter({
    scenario: "injection-blocked-shell",
    chunkDelayMs: 0,
  });
  const git = new FakeModelCliAdapter({
    scenario: "injection-blocked-git",
    chunkDelayMs: 0,
  });
  const bypass = new FakeModelCliAdapter({
    scenario: "injection-bypass-blocklist",
    chunkDelayMs: 0,
  });

  const shellResult = await shell.invoke(request("shell"), () => {});
  const gitResult = await git.invoke(request("git"), () => {});
  const bypassResult = await bypass.invoke(request("bypass"), () => {});

  assert.match(shellResult.stdout, /"type": "shell"/);
  assert.match(gitResult.stdout, /git_commit/);
  assert.match(bypassResult.stdout, /"type": "shell"/);
  assert.match(bypassResult.stdout, /"type": "file_write"/);
});

test("always-fail always emits the broken repair patch", async () => {
  const adapter = new FakeModelCliAdapter({
    scenario: "always-fail",
    chunkDelayMs: 0,
  });

  const first = await adapter.invoke(request("first"), () => {});
  const second = await adapter.invoke(request("second"), () => {});

  assert.match(first.stdout, /a - b/);
  assert.match(second.stdout, /a - b/);
});
