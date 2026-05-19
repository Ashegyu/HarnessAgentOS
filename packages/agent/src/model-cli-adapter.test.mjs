import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DefaultModelCliAdapter } from "./model-cli-adapter.ts";
import {
  buildCliInvocation,
  extractCodexExecPayload,
  formatProviderExitFailure,
} from "./model-cli-invocation.ts";

const baseRequest = (overrides = {}) => ({
  invocationId: "inv-1",
  taskRunId: "tsk-1",
  cwd: "C:\\repo",
  prompt: "USER REQUEST",
  modelConfig: {
    provider: "claude",
    model: "claude-sonnet-4-6",
    timeoutMs: 300_000,
    stallTimeoutMs: 60_000,
  },
  sandbox: { primaryDir: "C:\\repo", enforceInPrompt: true },
  ...overrides,
});

const createMockChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: () => {} };
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    return true;
  };
  return child;
};

const makeAdapterRequest = () => ({
  invocationId: "inv_1",
  taskRunId: "tsk_1",
  cwd: process.cwd(),
  prompt: "answer",
  modelConfig: {
    provider: "codex",
    model: "gpt-5.5",
    timeoutMs: 5_000,
    stallTimeoutMs: 5_000,
  },
  sandbox: {
    primaryDir: process.cwd(),
    enforceInPrompt: true,
  },
});

test("buildCliInvocation keeps Claude-specific flags on the Claude command", () => {
  const plan = buildCliInvocation(
    baseRequest({
      sessionId: "claude-session",
      systemPrompt: "SYSTEM PROMPT",
      mcpConfigPath: "C:\\tmp\\mcp.json",
    }),
  );

  assert.equal(plan.command, "claude");
  assert.equal(plan.stdin, "USER REQUEST");
  assert.deepEqual(plan.args, [
    "--print",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--model",
    "claude-sonnet-4-6",
    "--system-prompt",
    "SYSTEM PROMPT",
    "--resume",
    "claude-session",
    "--mcp-config",
    "C:\\tmp\\mcp.json",
    "--strict-mcp-config",
  ]);
});

test("buildCliInvocation isolates Claude from external MCP configs", () => {
  const plan = buildCliInvocation(baseRequest());

  assert.equal(plan.command, "claude");
  assert.ok(plan.args.includes("--strict-mcp-config"));
  assert.ok(!plan.args.includes("--mcp-config"));
});

test("buildCliInvocation maps Claude tool policy to provider permission flags", () => {
  const plan = buildCliInvocation(
    baseRequest({
      toolPolicy: {
        toolAllowlist: [" Read ", "mcp__repo__search", "Read", ""],
        toolDenylist: ["Bash(git *)", " ", "mcp__repo__delete"],
      },
    }),
  );

  assert.equal(plan.command, "claude");
  const allowIndex = plan.args.indexOf("--allowedTools");
  const denyIndex = plan.args.indexOf("--disallowedTools");
  assert.ok(allowIndex >= 0, "Claude invocation must pass --allowedTools");
  assert.ok(denyIndex >= 0, "Claude invocation must pass --disallowedTools");
  assert.equal(plan.args[allowIndex + 1], "Read,mcp__repo__search");
  assert.equal(plan.args[denyIndex + 1], "Bash(git *),mcp__repo__delete");
});

test("buildCliInvocation uses Codex exec syntax and folds system prompt into stdin", () => {
  const plan = buildCliInvocation(
    baseRequest({
      modelConfig: {
        provider: "codex",
        model: "gpt-5.5",
        timeoutMs: 300_000,
        stallTimeoutMs: 60_000,
      },
      systemPrompt: "SYSTEM PROMPT",
      sessionId: "ignored-for-codex",
      mcpConfigPath: "C:\\tmp\\mcp.json",
    }),
  );

  assert.equal(plan.command, "codex");
  assert.deepEqual(plan.args, [
    "--model",
    "gpt-5.5",
    "--cd",
    "C:\\repo",
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-",
  ]);
  assert.match(plan.stdin, /SYSTEM INSTRUCTIONS/);
  assert.match(plan.stdin, /SYSTEM PROMPT/);
  assert.match(plan.stdin, /USER REQUEST/);
  assert.ok(!plan.args.includes("--system-prompt"));
  assert.ok(!plan.args.includes("--resume"));
  assert.ok(!plan.args.includes("--mcp-config"));
});

test("buildCliInvocation passes Codex reasoning effort through a verified -c override", () => {
  const plan = buildCliInvocation(
    baseRequest({
      modelConfig: {
        provider: "codex",
        model: "gpt-5.5",
        reasoningEffort: "xhigh",
        timeoutMs: 300_000,
        stallTimeoutMs: 60_000,
      },
    }),
  );

  assert.equal(plan.command, "codex");
  const effortIndex = plan.args.indexOf("model_reasoning_effort=xhigh");
  assert.ok(effortIndex > 0, "Codex invocation must pass model_reasoning_effort");
  assert.equal(plan.args[effortIndex - 1], "-c");
  assert.equal(
    plan.args.indexOf("exec") > effortIndex,
    true,
    "Codex -c overrides must appear before exec",
  );
  assert.ok(!plan.args.includes("--reasoning-effort"));
});

test("buildCliInvocation passes verified Codex MCP config overrides through -c", () => {
  const plan = buildCliInvocation(
    baseRequest({
      modelConfig: {
        provider: "codex",
        model: "gpt-5.5",
        timeoutMs: 300_000,
        stallTimeoutMs: 60_000,
      },
      codexConfigOverrides: [
        'mcp_servers.repo_mcp.command="node"',
        'mcp_servers.repo_mcp.args=["server.mjs"]',
      ],
    }),
  );

  assert.equal(plan.command, "codex");
  assert.deepEqual(plan.args, [
    "--model",
    "gpt-5.5",
    "--cd",
    "C:\\repo",
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    "-c",
    'mcp_servers.repo_mcp.command="node"',
    "-c",
    'mcp_servers.repo_mcp.args=["server.mjs"]',
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-",
  ]);
  assert.ok(!plan.args.includes("--mcp-config"));
});

test("buildCliInvocation does not pass unverified tool policy flags to Codex", () => {
  const plan = buildCliInvocation(
    baseRequest({
      modelConfig: {
        provider: "codex",
        model: "gpt-5.5",
        timeoutMs: 300_000,
        stallTimeoutMs: 60_000,
      },
      toolPolicy: {
        toolAllowlist: ["Read"],
        toolDenylist: ["Bash(*)"],
      },
    }),
  );

  assert.equal(plan.command, "codex");
  assert.ok(!plan.args.includes("--allowedTools"));
  assert.ok(!plan.args.includes("--disallowedTools"));
});

test("extractCodexExecPayload returns the final assistant message from JSONL", () => {
  const raw = [
    JSON.stringify({ type: "session_configured", session_id: "s1" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "msg-1",
        type: "assistant_message",
        role: "assistant",
        content: [{ type: "output_text", text: "first" }],
      },
    }),
    JSON.stringify({
      type: "item_completed",
      item: {
        id: "msg-2",
        type: "assistant_message",
        role: "assistant",
        text: "final",
      },
    }),
  ].join("\n");

  assert.equal(extractCodexExecPayload(raw), "final");
});

test("formatProviderExitFailure reads Codex JSON errors from stdout", () => {
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "thr" }),
    JSON.stringify({
      type: "error",
      message:
        "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
    }),
    JSON.stringify({
      type: "turn.failed",
      error: {
        message:
          "stream disconnected before completion: error sending request for url",
      },
    }),
  ].join("\n");

  const message = formatProviderExitFailure("codex", 1, stdout, "");
  assert.match(message, /codex exited with code 1/);
  assert.match(message, /authentication failed/);
  assert.match(message, /401 Unauthorized/);
});

test("formatProviderExitFailure falls back to stderr for non-Codex failures", () => {
  assert.equal(
    formatProviderExitFailure("claude", 1, "", "auth failed\n"),
    "claude exited with code 1: auth failed",
  );
});

test("DefaultModelCliAdapter passes AbortSignal into provider spawn options", async () => {
  const controller = new AbortController();
  const child = createMockChild();
  const spawnCalls = [];
  const adapter = new DefaultModelCliAdapter({
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from('{"role":"assistant","text":"ok"}\n'));
        child.emit("close", 0);
      });
      return child;
    },
  });

  const result = await adapter.invoke(makeAdapterRequest(), () => {}, controller.signal);

  assert.equal(result.stdout, "ok");
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].options.signal, controller.signal);
});

test("DefaultModelCliAdapter scopes live stream events to the task run before close", async () => {
  const child = createMockChild();
  const adapter = new DefaultModelCliAdapter({
    spawn: () => child,
  });
  const events = [];

  const run = adapter.invoke(makeAdapterRequest(), (event) => events.push(event));
  await Promise.resolve();

  assert.deepEqual(events[0], {
    type: "started",
    invocationId: "inv_1",
    taskRunId: "tsk_1",
    provider: "codex",
    model: "gpt-5.5",
  });

  child.stdout.emit(
    "data",
    Buffer.from(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "assistant_message",
          role: "assistant",
          text: "streamed before close",
        },
      }) + "\n",
    ),
  );
  assert.equal(
    events.find((event) => event.type === "raw")?.taskRunId,
    "tsk_1",
  );

  child.emit("close", 0);
  await run;

  assert.equal(
    events.find((event) => event.type === "assistant_text")?.taskRunId,
    "tsk_1",
  );
  assert.equal(
    events.find((event) => event.type === "result")?.taskRunId,
    "tsk_1",
  );
});

test("DefaultModelCliAdapter abort sends SIGTERM then SIGKILL fallback", async () => {
  const controller = new AbortController();
  const child = createMockChild();
  const adapter = new DefaultModelCliAdapter({
    spawn: () => child,
    abortKillGraceMs: 1,
  });

  const run = adapter.invoke(makeAdapterRequest(), () => {}, controller.signal);
  await Promise.resolve();
  controller.abort();
  assert.equal(child.killCalls[0], "SIGTERM");

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(
    child.killCalls.includes("SIGKILL"),
    `expected SIGKILL fallback, got ${JSON.stringify(child.killCalls)}`,
  );
  child.emit("close", null);
  await assert.rejects(() => run, (err) => err.code === "AGENT_CANCELLED");
});

test("DefaultModelCliAdapter keeps SIGKILL fallback after abort error event", async () => {
  const controller = new AbortController();
  const child = createMockChild();
  const adapter = new DefaultModelCliAdapter({
    spawn: () => child,
    abortKillGraceMs: 1,
  });

  const run = adapter.invoke(makeAdapterRequest(), () => {}, controller.signal);
  await Promise.resolve();
  controller.abort();
  child.emit("error", new Error("AbortError"));

  await assert.rejects(() => run, (err) => err.code === "AGENT_CANCELLED");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(
    child.killCalls.includes("SIGKILL"),
    `expected SIGKILL fallback after abort error, got ${JSON.stringify(child.killCalls)}`,
  );
});

test("DefaultModelCliAdapter emits normalized Claude tool_call stream events", async () => {
  const child = createMockChild();
  const adapter = new DefaultModelCliAdapter({
    spawn: () => {
      queueMicrotask(() => {
        child.stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              type: "stream_event",
              event: {
                type: "content_block_start",
                index: 2,
                content_block: {
                  type: "tool_use",
                  id: "toolu_1",
                  name: "mcp_repo__search",
                  input: { query: "agent profile" },
                },
              },
            }) + "\n",
          ),
        );
        child.stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              type: "result",
              result: "done",
            }) + "\n",
          ),
        );
        child.emit("close", 0);
      });
      return child;
    },
  });
  const events = [];

  await adapter.invoke(baseRequest(), (event) => events.push(event));

  assert.deepEqual(
    events.find((event) => event.type === "tool_call"),
    {
      type: "tool_call",
      invocationId: "inv-1",
      taskRunId: "tsk-1",
      provider: "claude",
      source: "stdout",
      phase: "started",
      toolName: "mcp_repo__search",
      toolCallId: "toolu_1",
      input: { query: "agent profile" },
    },
  );
});

test("DefaultModelCliAdapter emits normalized Codex tool_call stream events", async () => {
  const child = createMockChild();
  const adapter = new DefaultModelCliAdapter({
    spawn: () => {
      queueMicrotask(() => {
        child.stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              type: "response_item",
              payload: {
                type: "function_call",
                call_id: "call_1",
                name: "shell_command",
                arguments: JSON.stringify({
                  command: "npm run check",
                  workdir: "C:\\work",
                }),
              },
            }) + "\n",
          ),
        );
        child.stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              type: "item.completed",
              item: {
                type: "assistant_message",
                role: "assistant",
                text: "done",
              },
            }) + "\n",
          ),
        );
        child.emit("close", 0);
      });
      return child;
    },
  });
  const events = [];

  await adapter.invoke(makeAdapterRequest(), (event) => events.push(event));

  assert.deepEqual(
    events.find((event) => event.type === "tool_call"),
    {
      type: "tool_call",
      invocationId: "inv_1",
      taskRunId: "tsk_1",
      provider: "codex",
      source: "stdout",
      phase: "started",
      toolName: "shell_command",
      toolCallId: "call_1",
      input: {
        command: "npm run check",
        workdir: "C:\\work",
      },
    },
  );
});
