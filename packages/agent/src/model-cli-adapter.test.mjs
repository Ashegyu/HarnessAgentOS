import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn as spawnProcess } from "node:child_process";
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
    provider: "codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
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
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    timeoutMs: 5_000,
    stallTimeoutMs: 5_000,
  },
  sandbox: {
    primaryDir: process.cwd(),
    enforceInPrompt: true,
  },
});

test("buildCliInvocation uses Codex exec syntax and folds system prompt into stdin", () => {
  const plan = buildCliInvocation(
    baseRequest({
      modelConfig: {
        provider: "codex",
        model: "gpt-5.6-sol",
        timeoutMs: 300_000,
        stallTimeoutMs: 60_000,
      },
      systemPrompt: "SYSTEM PROMPT",
    }),
  );

  assert.equal(plan.command, "codex");
  assert.deepEqual(plan.args, [
    "--model",
    "gpt-5.6-sol",
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
        model: "gpt-5.6-sol",
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
        model: "gpt-5.6-sol",
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
    "gpt-5.6-sol",
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

test("buildCliInvocation maps Codex workspace-write and auto review options", () => {
  const plan = buildCliInvocation(
    baseRequest({
      modelConfig: {
        provider: "codex",
        model: "gpt-5.6-sol",
        timeoutMs: 300_000,
        stallTimeoutMs: 60_000,
      },
      sandbox: {
        primaryDir: "C:\\repo",
        mode: "workspace-write",
        autoReview: true,
        enforceInPrompt: true,
      },
    }),
  );

  assert.equal(plan.command, "codex");
  assert.deepEqual(plan.args, [
    "--model",
    "gpt-5.6-sol",
    "--cd",
    "C:\\repo",
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "on-request",
    "-c",
    'approvals_reviewer="auto_review"',
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-",
  ]);
});

test("buildCliInvocation does not pass unverified tool policy flags to Codex", () => {
  const plan = buildCliInvocation(
    baseRequest({
      modelConfig: {
        provider: "codex",
        model: "gpt-5.6-sol",
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

test("formatProviderExitFailure falls back to stderr for plain Codex failures", () => {
  assert.equal(
    formatProviderExitFailure("codex", 1, "", "auth failed\n"),
    "codex exited with code 1: auth failed",
  );
});

test("DefaultModelCliAdapter owns cancellation instead of delegating an early kill to spawn", async () => {
  const controller = new AbortController();
  const child = createMockChild();
  const spawnCalls = [];
  const adapter = new DefaultModelCliAdapter({
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(assistantLine("ok") + completedLine()));
        child.emit("close", 0);
      });
      return child;
    },
  });

  const result = await adapter.invoke(makeAdapterRequest(), () => {}, controller.signal);

  assert.equal(result.stdout, "ok");
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].options.signal, undefined);
  assert.equal(spawnCalls[0].options.windowsHide, true);
});

const jsonLine = (event) => JSON.stringify(event) + "\n";
const assistantLine = (text) => jsonLine({ type: "item.completed", item: { type: "agent_message", text } });
const completedLine = (usage = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5 }) =>
  jsonLine({ type: "turn.completed", usage });

const invokeChunks = async (stdoutChunks, { stderrChunks = [], ...deps } = {}) => {
  const child = createMockChild();
  const events = [];
  const adapter = new DefaultModelCliAdapter({ ...deps, spawn: () => {
    queueMicrotask(() => {
      for (const chunk of stdoutChunks) child.stdout.emit("data", Buffer.from(chunk));
      for (const chunk of stderrChunks) child.stderr.emit("data", Buffer.from(chunk));
      child.emit("close", 0);
    });
    return child;
  } });
  const result = await adapter.invoke(makeAdapterRequest(), (event) => events.push(event));
  return { result, events };
};

test("adapter validates a real child process JSONL pipe without invoking a model", async () => {
  const raw = assistantLine("실제 파이프 한글 🧪") + completedLine();
  const script = `const bytes=Buffer.from(${JSON.stringify(raw)}); let i=0;
    function send(){if(i<bytes.length)process.stdout.write(bytes.subarray(i,i+=1),send)};
    process.stdin.resume(); process.stdin.on('end',send);`;
  const adapter = new DefaultModelCliAdapter({
    spawn: (_command, _args, options) => spawnProcess(process.execPath, ["-e", script], options),
  });
  const result = await adapter.invoke(makeAdapterRequest(), () => {});
  assert.equal(result.stdout, "실제 파이프 한글 🧪");
  assert.equal(result.rawStdout, raw);
  assert.equal(result.tokenUsage.outputTokens, 20);
});

test("adapter never emits successful result on abnormal process exit despite a completed turn", async () => {
  for (const exitCode of [1, null]) {
    const child = createMockChild();
    const events = [];
    const adapter = new DefaultModelCliAdapter({ spawn: () => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(assistantLine("answer") + completedLine()));
        child.emit("close", exitCode);
      });
      return child;
    } });
    await assert.rejects(adapter.invoke(makeAdapterRequest(), (event) => events.push(event)),
      (error) => error.code === "AGENT_PROVIDER_UNAVAILABLE");
    assert.equal(events.some((event) => event.type === "result" || event.type === "assistant_text"), false);
  }
});

test("adapter handles pre-spawn cancellation and synchronous spawn errors", async () => {
  let spawnCalls = 0;
  const adapter = new DefaultModelCliAdapter({ spawn: () => { spawnCalls++; throw new Error("spawn failure"); } });
  await assert.rejects(adapter.invoke(makeAdapterRequest(), () => {}, AbortSignal.abort()),
    (error) => error.code === "AGENT_CANCELLED");
  assert.equal(spawnCalls, 0);
  await assert.rejects(adapter.invoke(makeAdapterRequest(), () => {}),
    (error) => error.code === "AGENT_SPAWN_FAILED");
});

test("adapter captures EPIPE and asynchronous spawn errors and rejects only after close", async () => {
  for (const source of ["stdin", "process"]) {
    const child = createMockChild();
    child.stdin = Object.assign(new EventEmitter(), { end: () => {} });
    const adapter = new DefaultModelCliAdapter({ spawn: () => child });
    let settled = false;
    const rejection = assert.rejects(adapter.invoke(makeAdapterRequest(), () => {}),
      (error) => error.code === "AGENT_SPAWN_FAILED").then(() => { settled = true; });
    (source === "stdin" ? child.stdin : child).emit("error", new Error(source === "stdin" ? "EPIPE" : "ENOENT"));
    await new Promise((resolve) => setImmediate(resolve));
    const beforeClose = settled;
    child.emit("close", -1);
    await rejection;
    assert.equal(beforeClose, false);
  }
});

test("adapter surfaces unconfirmed Windows tree cleanup and falls back to the owned root", async () => {
  const child = createMockChild();
  child.pid = 12345;
  const controller = new AbortController();
  const adapter = new DefaultModelCliAdapter({ spawn: () => child, platform: "win32",
    terminateProcessTree: async () => { throw new Error("cleanup failed"); },
  });
  const rejection = assert.rejects(adapter.invoke(makeAdapterRequest(), () => {}, controller.signal),
    (error) => error.code === "AGENT_CANCELLED" && error.processCleanupConfirmed === false && /cleanup was not confirmed/.test(error.message));
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(child.killCalls, ["SIGKILL"]);
  child.emit("close", null);
  await rejection;
});

test("stall watchdog stops once and cannot override cancellation", async () => {
  const child = createMockChild();
  const request = makeAdapterRequest();
  request.modelConfig.stallTimeoutMs = 1;
  let signalStop;
  const stopped = new Promise((resolve) => { signalStop = resolve; });
  child.kill = (signal) => { child.killCalls.push(signal); signalStop(); return true; };
  const adapter = new DefaultModelCliAdapter({ spawn: () => child });
  const rejection = assert.rejects(adapter.invoke(request, () => {}), (error) => error.code === "AGENT_STALL");
  await stopped;
  child.emit("close", null);
  await rejection;
  assert.deepEqual(child.killCalls, ["SIGKILL"]);
});

test("exec stream preserves Korean and emoji split at every UTF-8 byte", async () => {
  const answer = "한글 응답입니다 🧭";
  const raw = Buffer.from(assistantLine(answer) + completedLine());
  const stderr = Buffer.from("진단 로그 🧪");
  const { result, events } = await invokeChunks([...raw].map((b) => [b]), {
    stderrChunks: [...stderr].map((b) => [b]),
  });
  assert.equal(result.stdout, answer);
  assert.equal(result.stderr, stderr.toString());
  assert.equal(events.filter((e) => e.type === "raw" && e.source === "stdout").map((e) => e.text).join(""), raw.toString());
});

for (const [name, stdout] of [
  ["turn failed with exit zero", assistantLine("partial") + jsonLine({ type: "turn.failed", error: { message: "disconnected" } })],
  ["missing terminal", assistantLine("partial")],
  ["missing final answer", completedLine()],
  ["truncated JSON EOF", assistantLine("partial") + '{"type":"turn.completed"'],
  ["invalid JSON frame", 'not-json\n' + assistantLine("answer") + completedLine()],
  ["error followed by completion", jsonLine({ type: "error", message: "failed" }) + assistantLine("answer") + completedLine()],
  ["unfinished newer turn", assistantLine("old") + completedLine() + jsonLine({ type: "turn.started" })],
]) {
  test(`exec stream rejects ${name}`, async () => {
    await assert.rejects(invokeChunks([stdout]), (error) => error.code === "AGENT_INVALID_OUTPUT");
  });
}

test("exec stream retains terminal usage and final answer outside the raw log tail", async () => {
  const { result } = await invokeChunks([
    assistantLine("important final answer"), completedLine(),
    jsonLine({ type: "diagnostic", text: "x".repeat(5_000) }),
  ], { maxStdoutBytes: 128 });
  assert.equal(result.stdout, "important final answer");
  assert.deepEqual(result.tokenUsage, { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, reasoningOutputTokens: 5 });
  assert.ok(result.truncation.stdoutDroppedBytes > 0);
});

test("exec stream accepts a complete final JSON frame without newline", async () => {
  const { result } = await invokeChunks([assistantLine("answer") + completedLine().trimEnd()]);
  assert.equal(result.stdout, "answer");
});

test("adapter marks missing terminal usage as explicitly unavailable", async () => {
  const { result } = await invokeChunks([assistantLine("answer") + jsonLine({ type: "turn.completed" })]);
  assert.equal(result.tokenUsage, null);
});

test("read-only CLI policy disables each discovered MCP server and rejects unverified inventory", () => {
  const request = baseRequest({
    sandbox: { primaryDir: "C:\\repo", enforceInPrompt: true, mode: "workspace-write", autoReview: true, readOnlyTask: true },
    codexConfigOverrides: ['mcp_servers.writer.enabled=true', 'sandbox_mode="danger-full-access"'],
    readOnlyMcpServerNames: ["writer", "name-with-dashes"],
  });
  const { args } = buildCliInvocation(request);
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(args[args.indexOf("--ask-for-approval") + 1], "never");
  assert.ok(args.includes('mcp_servers.writer.enabled=false'));
  assert.ok(args.includes('mcp_servers.name-with-dashes.enabled=false'));
  assert.ok(args.includes('features.plugins=false'));
  assert.ok(!args.includes('mcp_servers.writer.enabled=true'));
  assert.ok(!args.includes('sandbox_mode="danger-full-access"'));
  assert.throws(() => buildCliInvocation({ ...request, readOnlyMcpServerNames: undefined }), /inventory/i);
  assert.throws(() => buildCliInvocation({ ...request, readOnlyMcpServerNames: ["name.with.dots"] }), /identity/i);
});

test("read-only adapter fails closed before model spawn when MCP inventory cannot be checked", async () => {
  let spawned = false;
  const adapter = new DefaultModelCliAdapter({
    spawn: () => { spawned = true; throw new Error("must not spawn"); },
    readMcpServerNames: async () => { throw new Error("unavailable"); },
  });
  const request = makeAdapterRequest();
  request.sandbox.readOnlyTask = true;
  await assert.rejects(adapter.invoke(request, () => {}),
    (error) => error.code === "TASK_CONTRACT_PREFLIGHT_FAILED");
  assert.equal(spawned, false);
});

test("no-search tasks disable search and external tools without revoking approved file-write mode", () => {
  const { args } = buildCliInvocation(baseRequest({
    sandbox: { primaryDir: "C:\\repo", enforceInPrompt: true, mode: "workspace-write", disableWebSearch: true },
    readOnlyMcpServerNames: ["search"],
  }));
  assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes('mcp_servers.search.enabled=false'));
});

test("DefaultModelCliAdapter does not leak parent Codex desktop session variables", async () => {
  const child = createMockChild();
  const spawnCalls = [];
  const original = {
    appToolsPipe: process.env.CODEX_APP_TOOLS_PIPE_PATH,
    sessionId: process.env.CODEX_SESSION_ID,
    threadId: process.env.CODEX_THREAD_ID,
    codexHome: process.env.CODEX_HOME,
  };
  process.env.CODEX_APP_TOOLS_PIPE_PATH = "stale-parent-tools-pipe";
  process.env.CODEX_SESSION_ID = "parent-session";
  process.env.CODEX_THREAD_ID = "parent-thread";
  process.env.CODEX_HOME = "C:\\codex-home";
  try {
    const adapter = new DefaultModelCliAdapter({
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        queueMicrotask(() => {
          child.stdout.emit(
            "data",
            Buffer.from(assistantLine("ok") + completedLine()),
          );
          child.emit("close", 0);
        });
        return child;
      },
    });

    await adapter.invoke(makeAdapterRequest(), () => {});

    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].options.env.CODEX_APP_TOOLS_PIPE_PATH, undefined);
    assert.equal(spawnCalls[0].options.env.CODEX_SESSION_ID, undefined);
    assert.equal(spawnCalls[0].options.env.CODEX_THREAD_ID, undefined);
    assert.equal(spawnCalls[0].options.env.CODEX_HOME, "C:\\codex-home");
  } finally {
    restoreEnv("CODEX_APP_TOOLS_PIPE_PATH", original.appToolsPipe);
    restoreEnv("CODEX_SESSION_ID", original.sessionId);
    restoreEnv("CODEX_THREAD_ID", original.threadId);
    restoreEnv("CODEX_HOME", original.codexHome);
  }
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
    model: "gpt-5.6-sol",
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

  child.stdout.emit("data", Buffer.from(completedLine()));
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

test("structured invocation uses a schema after exec and validates before publishing success", async () => {
  const child = createMockChild();
  const events = [];
  let disposed = false;
  const request = { ...makeAdapterRequest(), outputContract: { revision: 1, intent: "answer", authorization: { mode: "read_only" }, externalSearch: "allowed" } };
  const final = JSON.stringify({ schemaVersion: 1, taskIntent: "answer", summary: "한글 답변", assumptions: [], steps: [], proposedActions: [], suggestedQualityChecks: [], questions: [] });
  const adapter = new DefaultModelCliAdapter({
    prepareOutputSchema: async input => {
      assert.deepEqual(input.schema.properties.taskIntent.enum, ["answer"]);
      return { path: "C:\\temporary schema\\output.json", cliVersion: "0.153.4", dispose: async () => { disposed = true; } };
    },
    spawn: (_command, args) => {
      assert.ok(args.indexOf("--output-schema") > args.indexOf("exec"));
      assert.equal(args[args.indexOf("--output-schema") + 1], "C:\\temporary schema\\output.json");
      queueMicrotask(() => { child.stdout.emit("data", Buffer.from(assistantLine(final) + completedLine())); child.emit("close", 0); });
      return child;
    },
  });
  const result = await adapter.invoke(request, event => events.push(event));
  assert.match(result.stdout, /^```harness_agent_plan/);
  assert.match(result.stdout, /한글 답변/);
  assert.equal(disposed, true);
  assert.equal(events.filter(e => e.type === "result").length, 1);
});

for (const scenario of ["malformed", "spawn-failed", "provider-failed", "cancelled"]) {
  test(`schema cleanup and no success on ${scenario}`, async () => {
    const child = createMockChild();
    const controller = new AbortController();
    let disposed = false;
    const events = [];
    const adapter = new DefaultModelCliAdapter({
      prepareOutputSchema: async () => ({ path: "schema.json", cliVersion: "0.153.4", dispose: async () => { disposed = true; } }),
      spawn: () => {
        if (scenario === "spawn-failed") throw new Error("spawn failed");
        queueMicrotask(() => {
          if (scenario === "cancelled") controller.abort();
          child.stdout.emit("data", Buffer.from(assistantLine("invalid final JSON") + completedLine()));
          child.emit("close", scenario === "provider-failed" ? 1 : 0);
        });
        return child;
      },
    });
    await assert.rejects(adapter.invoke({ ...makeAdapterRequest(), outputContract: { revision: 1, intent: "change", authorization: { mode: "approval_required" }, externalSearch: "allowed" } }, e => events.push(e), controller.signal));
    assert.equal(disposed, true);
    assert.equal(events.some(e => e.type === "result" || e.type === "assistant_text"), false);
  });
}

test("unsupported output schema CLI fails before model spawn without leaking preflight output", async () => {
  let spawned = false;
  const adapter = new DefaultModelCliAdapter({
    prepareOutputSchema: async () => { throw new Error("secret settings"); },
    spawn: () => { spawned = true; throw new Error("should not spawn"); },
  });
  await assert.rejects(adapter.invoke({ ...makeAdapterRequest(), outputContract: { revision: 1, intent: "change", authorization: { mode: "approval_required" }, externalSearch: "allowed" } }, () => {}), error => error.code === "TASK_CONTRACT_PREFLIGHT_FAILED" && !error.message.includes("secret"));
  assert.equal(spawned, false);
});

test("schema cleanup errors cannot replace the original invocation failure", async () => {
  const events = [];
  const adapter = new DefaultModelCliAdapter({
    prepareOutputSchema: async () => ({ path: "schema.json", cliVersion: "0.153.4", dispose: async () => { throw new Error("sensitive path"); } }),
    spawn: () => { throw new Error("original spawn failure"); },
  });
  await assert.rejects(adapter.invoke({ ...makeAdapterRequest(), outputContract: { revision: 1, intent: "change", authorization: { mode: "approval_required" }, externalSearch: "allowed" } }, event => events.push(event)), { code: "AGENT_SPAWN_FAILED" });
  assert.ok(events.some(e => e.type === "raw" && e.source === "stderr" && /임시 스키마/.test(e.text)));
  assert.equal(JSON.stringify(events).includes("sensitive path"), false);
});

const restoreEnv = (name, value) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

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
  let settled = false;
  const rejection = assert.rejects(run, (err) => err.code === "AGENT_CANCELLED").then(() => { settled = true; });
  await Promise.resolve();
  controller.abort();
  child.emit("error", new Error("AbortError"));

  await new Promise((resolve) => setTimeout(resolve, 5));
  const settledBeforeClose = settled;
  child.emit("close", null);
  await rejection;
  assert.equal(settledBeforeClose, false, "the queue slot must remain held until process close");
  assert.ok(
    child.killCalls.includes("SIGKILL"),
    `expected SIGKILL fallback after abort error, got ${JSON.stringify(child.killCalls)}`,
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
        child.stdout.emit("data", Buffer.from(completedLine()));
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

test("buildCliInvocation passes every supported Codex reasoning effort", () => {
  for (const reasoningEffort of [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]) {
    const plan = buildCliInvocation(
      baseRequest({
        modelConfig: {
          provider: "codex",
          model: "gpt-5.6-terra",
          reasoningEffort,
          timeoutMs: 300_000,
          stallTimeoutMs: 60_000,
        },
      }),
    );
    assert.ok(
      plan.args.includes(`model_reasoning_effort=${reasoningEffort}`),
      reasoningEffort,
    );
  }
});

test("Windows cancellation waits for both the owned process tree cleanup and close", async () => {
  const child = createMockChild();
  child.pid = 12345;
  const controller = new AbortController();
  const treePids = [];
  let finishCleanup;
  const cleanupDone = new Promise((resolve) => { finishCleanup = resolve; });
  const adapter = new DefaultModelCliAdapter({ spawn: () => child, platform: "win32",
    terminateProcessTree: (pid) => { treePids.push(pid); return cleanupDone; },
  });
  let settled = false;
  const rejection = assert.rejects(adapter.invoke(makeAdapterRequest(), () => {}, controller.signal),
    (err) => err.code === "AGENT_CANCELLED").then(() => { settled = true; });
  controller.abort();
  child.emit("error", new Error("AbortError"));
  child.emit("close", null);
  await new Promise((resolve) => setImmediate(resolve));
  const settledBeforeCleanup = settled;
  finishCleanup();
  await rejection;
  assert.deepEqual(treePids, [12345]);
  assert.deepEqual(child.killCalls, [], "do not kill the root before discovering its descendants");
  assert.equal(settledBeforeCleanup, false);
});

test("stdin write failure terminates the child and waits for close", async () => {
  const child = createMockChild();
  child.stdin.end = () => { throw new Error("stdin unavailable"); };
  let settled = false;
  const adapter = new DefaultModelCliAdapter({ spawn: () => child });
  const rejection = assert.rejects(adapter.invoke(makeAdapterRequest(), () => {}),
    (err) => err.code === "AGENT_SPAWN_FAILED").then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  const settledBeforeClose = settled;
  child.emit("close", 1);
  await rejection;
  assert.equal(settledBeforeClose, false);
  assert.ok(child.killCalls.includes("SIGKILL"));
});

test("timeout cleanup keeps the original reason when abort races with close", async () => {
  const child = createMockChild();
  child.pid = 12345;
  const controller = new AbortController();
  const request = makeAdapterRequest();
  request.modelConfig.timeoutMs = 1;
  const pids = [];
  let terminate;
  const terminated = new Promise((resolve) => { terminate = resolve; });
  const adapter = new DefaultModelCliAdapter({ spawn: () => child, platform: "win32",
    terminateProcessTree: async (pid) => { pids.push(pid); terminate(); },
  });
  const run = adapter.invoke(request, () => {}, controller.signal);
  // Also observe the old direct-kill path so the regression fails rather than hanging.
  child.kill = (signal) => { child.killCalls.push(signal); terminate(); return true; };
  await terminated;
  controller.abort();
  child.emit("close", null);
  await assert.rejects(run, (err) => err.code === "AGENT_TIMEOUT");
  assert.deepEqual(pids, [12345]);
});

test("buildCliInvocation upgrades unsupported GPT-6 Astra none effort to low", () => {
  const plan = buildCliInvocation(
    baseRequest({
      modelConfig: {
        provider: "codex",
        model: "gpt-6-astra",
        reasoningEffort: "none",
        timeoutMs: 300_000,
        stallTimeoutMs: 60_000,
      },
    }),
  );

  assert.ok(plan.args.includes("model_reasoning_effort=low"));
  assert.equal(plan.args.includes("model_reasoning_effort=none"), false);
});

test("DefaultModelCliAdapter bounds retained stdout and stderr while preserving the final payload", async () => {
  const child = createMockChild();
  const adapter = new DefaultModelCliAdapter({
    maxStdoutBytes: 256,
    maxStderrBytes: 64,
    spawn: () => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(jsonLine({ type: "diagnostic", text: "x".repeat(2_000) })));
        child.stderr.emit("data", Buffer.from("e".repeat(500)));
        child.stdout.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({
              type: "item.completed",
              item: {
                type: "assistant_message",
                role: "assistant",
                text: "done",
              },
            })}\n`,
          ),
        );
        child.stdout.emit("data", Buffer.from(completedLine()));
        child.emit("close", 0);
      });
      return child;
    },
  });

  const result = await adapter.invoke(makeAdapterRequest(), () => {});

  assert.equal(result.stdout, "done");
  assert.ok(Buffer.byteLength(result.rawStdout ?? "", "utf8") <= 256);
  assert.ok(Buffer.byteLength(result.stderr, "utf8") <= 64);
  assert.ok((result.truncation?.stdoutDroppedBytes ?? 0) > 0);
  assert.ok((result.truncation?.stderrDroppedBytes ?? 0) > 0);
});
