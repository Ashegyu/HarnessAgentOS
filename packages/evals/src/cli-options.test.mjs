import { test } from "node:test";
import assert from "node:assert/strict";

import { parseEvalCliArgs } from "./cli-options.ts";

test("parseEvalCliArgs parses the real CLI smoke shape", () => {
  const options = parseEvalCliArgs(
    [
      "--suite=capability",
      "--case=file-write-readme",
      "--attempts=1",
      "--timeout-ms=300000",
      "--stall-timeout-ms=60000",
      "--real-cli",
    ],
    {},
  );

  assert.deepEqual(options, {
    suite: "capability",
    caseId: "file-write-readme",
    realCli: true,
    attemptsOverride: 1,
    timeoutMs: 300000,
    stallTimeoutMs: 60000,
  });
});

test("parseEvalCliArgs honors EVAL_REAL_CLI", () => {
  const options = parseEvalCliArgs(["--suite", "safety"], {
    EVAL_REAL_CLI: "1",
  });

  assert.equal(options.realCli, true);
  assert.equal(options.suite, "safety");
});

test("parseEvalCliArgs parses provider comparison option", () => {
  const options = parseEvalCliArgs(["--providers=claude,codex"], {});

  assert.deepEqual(options.providers, ["claude", "codex"]);
});

test("parseEvalCliArgs rejects invalid providers", () => {
  assert.throws(
    () => parseEvalCliArgs(["--providers=claude,openai"], {}),
    /--providers contains invalid provider: openai/,
  );
});

test("parseEvalCliArgs rejects invalid attempts", () => {
  assert.throws(
    () => parseEvalCliArgs(["--attempts=0"], {}),
    /--attempts must be an integer between 1 and 10/,
  );
});
