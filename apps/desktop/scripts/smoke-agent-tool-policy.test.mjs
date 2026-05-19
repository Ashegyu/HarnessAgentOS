import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeToolPolicySmokeRequest,
  isDeniedToolCall,
  isPolicyBlockError,
  summarizePolicySmokeOutcome,
} from "./smoke-agent-tool-policy.mjs";

test("buildClaudeToolPolicySmokeRequest scopes allow mode to Read only", () => {
  const request = buildClaudeToolPolicySmokeRequest({
    mode: "allow",
    fixtureDir: "C:\\tmp\\hgos-policy",
    invocationId: "inv-allow",
    timeoutMs: 90_000,
  });

  assert.equal(request.invocationId, "inv-allow");
  assert.equal(request.cwd, "C:\\tmp\\hgos-policy");
  assert.equal(request.modelConfig.provider, "claude");
  assert.match(request.prompt, /fixture\.json/);
  assert.deepEqual(request.toolPolicy, {
    toolAllowlist: ["Read"],
    toolDenylist: ["Bash", "Edit", "MultiEdit", "Write", "NotebookEdit", "Task"],
  });
});

test("buildClaudeToolPolicySmokeRequest scopes deny mode to a conflicting Read policy", () => {
  const request = buildClaudeToolPolicySmokeRequest({
    mode: "deny",
    fixtureDir: "C:\\tmp\\hgos-policy",
    invocationId: "inv-deny",
    timeoutMs: 90_000,
  });

  assert.deepEqual(request.toolPolicy, {
    toolAllowlist: ["Read"],
    toolDenylist: [
      "Bash",
      "Edit",
      "MultiEdit",
      "Write",
      "NotebookEdit",
      "Task",
      "Read",
    ],
  });
});

test("isDeniedToolCall matches the requested tool name only", () => {
  assert.equal(
    isDeniedToolCall(
      { type: "tool_call", provider: "claude", phase: "started", toolName: "Read" },
      "Read",
    ),
    true,
  );
  assert.equal(
    isDeniedToolCall(
      { type: "tool_call", provider: "claude", phase: "started", toolName: "Bash" },
      "Read",
    ),
    false,
  );
});

test("isPolicyBlockError recognizes permission failures without masking auth failures", () => {
  assert.equal(isPolicyBlockError("Tool Read is disallowed by permissions"), true);
  assert.equal(isPolicyBlockError("permission denied for tool Read"), true);
  assert.equal(isPolicyBlockError("401 Unauthorized: missing API key"), false);
});

test("summarizePolicySmokeOutcome validates allow and deny expectations", () => {
  const readCall = {
    type: "tool_call",
    provider: "claude",
    phase: "started",
    toolName: "Read",
  };

  assert.equal(
    summarizePolicySmokeOutcome({
      mode: "allow",
      deniedToolName: "Read",
      toolCalls: [readCall],
    }).ok,
    true,
  );
  assert.equal(
    summarizePolicySmokeOutcome({
      mode: "allow",
      deniedToolName: "Read",
      toolCalls: [],
    }).ok,
    false,
  );
  assert.equal(
    summarizePolicySmokeOutcome({
      mode: "deny",
      deniedToolName: "Read",
      toolCalls: [readCall],
    }).ok,
    false,
  );
  assert.equal(
    summarizePolicySmokeOutcome({
      mode: "deny",
      deniedToolName: "Read",
      toolCalls: [
        {
          type: "tool_call",
          provider: "claude",
          phase: "started",
          toolName: "Glob",
        },
      ],
    }).ok,
    true,
  );
  assert.equal(
    summarizePolicySmokeOutcome({
      mode: "deny",
      deniedToolName: "Read",
      toolCalls: [
        {
          type: "tool_call",
          provider: "claude",
          phase: "started",
          toolName: "Bash",
        },
      ],
    }).ok,
    false,
  );
  assert.equal(
    summarizePolicySmokeOutcome({
      mode: "deny",
      deniedToolName: "Read",
      toolCalls: [],
      error: new Error("Tool Read is disallowed by permissions"),
    }).ok,
    true,
  );
});
