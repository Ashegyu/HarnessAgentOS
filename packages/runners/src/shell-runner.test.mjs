import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ShellRunner } from "./shell-runner.ts";

const createMockChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    return true;
  };
  return child;
};

test("ShellRunner rejects immediately when signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const spawnCalls = [];
  const runner = new ShellRunner({
    spawn: (...args) => {
      spawnCalls.push(args);
      return createMockChild();
    },
  });

  await assert.rejects(
    () =>
      runner.run({
        command: "mock-command",
        cwd: process.cwd(),
        signal: controller.signal,
      }),
    (err) => err.code === "RUNNER_CANCELLED",
  );
  assert.equal(spawnCalls.length, 0);
});

test("ShellRunner abort kills the child and rejects with RUNNER_CANCELLED", async () => {
  const child = createMockChild();
  const controller = new AbortController();
  const runner = new ShellRunner({
    spawn: () => child,
    abortKillGraceMs: 1,
  });

  const run = runner.run({
    command: "mock-command",
    cwd: process.cwd(),
    signal: controller.signal,
    timeoutMs: 5_000,
    idleTimeoutMs: 5_000,
  });
  await Promise.resolve();
  controller.abort();

  await assert.rejects(() => run, (err) => err.code === "RUNNER_CANCELLED");
  assert.equal(child.killCalls[0], "SIGTERM");

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(
    child.killCalls.includes("SIGKILL"),
    `expected SIGKILL fallback, got ${JSON.stringify(child.killCalls)}`,
  );
});

test("ShellRunner aborts a quiet process on idle timeout", async () => {
  const runner = new ShellRunner();
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
    "setTimeout(() => {}, 1000);",
  )}`;

  await assert.rejects(
    () =>
      runner.run({
        command,
        cwd: process.cwd(),
        timeoutMs: 5_000,
        idleTimeoutMs: 50,
      }),
    /idle timed out after 50ms/,
  );
});
