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

  const rejected = assert.rejects(() => run, (err) => err.code === "RUNNER_CANCELLED");
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
  child.emit("close", null);
  await rejected;
});

test("ShellRunner cancellation waits for close and tree cleanup before settling", async () => {
  const child = createMockChild();
  child.pid = 12345;
  const controller = new AbortController();
  let finishTree;
  const calls = [];
  const runner = new ShellRunner({
    spawn: () => child,
    terminateProcessTree: pid => { calls.push(pid); return new Promise(resolve => { finishTree = resolve; }); },
  });
  let settled = false;
  const run = runner.run({ command: "mock", cwd: process.cwd(), signal: controller.signal });
  const result = run.catch(error => { settled = true; return error; });
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(calls, [12345]);
  assert.deepEqual(child.killCalls, [], "keep root alive until tree cleanup starts");
  child.emit("close", null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  finishTree();
  assert.equal((await result).code, "RUNNER_CANCELLED");
});

test("ShellRunner reports unconfirmed termination when close never arrives", async () => {
  const child = createMockChild();
  const controller = new AbortController();
  const runner = new ShellRunner({ spawn: () => child, abortKillGraceMs: 1, terminationTimeoutMs: 15 });
  const run = runner.run({ command: "mock", cwd: process.cwd(), signal: controller.signal });
  controller.abort();
  await assert.rejects(run, error => error.code === "RUNNER_TERMINATION_UNCONFIRMED");
});

test("ShellRunner passes structured arguments without invoking a shell", async () => {
  const child = createMockChild();
  const spawnCalls = [];
  const runner = new ShellRunner({
    spawn: (...args) => {
      spawnCalls.push(args);
      queueMicrotask(() => child.emit("close", 0));
      return child;
    },
  });

  const result = await runner.run({
    command: "dotnet",
    args: [
      "test",
      "NOVA.Browser.Tests/NOVA.Browser.Tests.csproj",
      "-c",
      "Release",
    ],
    cwd: process.cwd(),
  });

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0][0], "dotnet");
  assert.deepEqual(spawnCalls[0][1], [
    "test",
    "NOVA.Browser.Tests/NOVA.Browser.Tests.csproj",
    "-c",
    "Release",
  ]);
  assert.equal(spawnCalls[0][2].shell, false);
  assert.equal(result.exitCode, 0);
});

test("ShellRunner applies the dangerous-command policy to structured arguments", async () => {
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
        command: "powershell",
        args: ["-NoProfile", "-Command", "Remove-Item -Recurse C:\\unsafe"],
        cwd: process.cwd(),
      }),
    (err) => err.code === "RUNNER_BLOCKED_HIGH_RISK",
  );
  assert.equal(spawnCalls.length, 0);
});
