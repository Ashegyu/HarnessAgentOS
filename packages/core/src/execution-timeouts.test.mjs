import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AGENT_STALL_TIMEOUT_MS,
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_RUNNER_IDLE_TIMEOUT_MS,
  DEFAULT_RUNNER_SHELL_TIMEOUT_MS,
  DEFAULT_RUNNER_TEST_TIMEOUT_MS,
} from "./index.ts";

test("execution timeout defaults allow long-running real workloads", () => {
  assert.equal(DEFAULT_RUNNER_SHELL_TIMEOUT_MS, 30 * 60_000);
  assert.equal(DEFAULT_RUNNER_TEST_TIMEOUT_MS, 45 * 60_000);
  assert.equal(DEFAULT_AGENT_TIMEOUT_MS, 60 * 60_000);
  assert.equal(DEFAULT_RUNNER_IDLE_TIMEOUT_MS, 10 * 60_000);
  assert.equal(DEFAULT_AGENT_STALL_TIMEOUT_MS, 10 * 60_000);
});
