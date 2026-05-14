import { test } from "node:test";
import assert from "node:assert/strict";
import { ShellRunner } from "./shell-runner.ts";

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
