import { test } from "node:test";
import assert from "node:assert/strict";
import {
  feedStreamChunk,
  flushStreamParser,
  hydrateSavedAgentOutput,
  initStreamParserState,
  promoteIntermediateTextToFinal,
  setIntermediateAssistantText,
} from "./agent-stream-parser.ts";

const line = (obj) => JSON.stringify(obj) + "\n";

test("text_delta events accumulate into liveText", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hello " },
      },
    }) +
      line({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "world" },
        },
      }),
  );
  assert.equal(s.parsed.liveText, "hello world");
  assert.equal(s.parsed.finalText, null);
});

test("result line populates finalText and resultMeta", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1500,
      duration_api_ms: 1100,
      result: "pong",
      stop_reason: "end_turn",
      session_id: "sess-1",
      total_cost_usd: 0.0123,
      usage: { input_tokens: 5, output_tokens: 2 },
    }),
  );
  assert.equal(s.parsed.finalText, "pong");
  assert.deepEqual(s.parsed.resultMeta, {
    isError: false,
    durationMs: 1500,
    durationApiMs: 1100,
    stopReason: "end_turn",
    costUsd: 0.0123,
    usage: { input_tokens: 5, output_tokens: 2 },
    sessionId: "sess-1",
  });
});

test("tool_use name captured on content_block_start", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", name: "Read", input: {} },
      },
    }),
  );
  assert.equal(s.parsed.toolUses.length, 1);
  assert.equal(s.parsed.toolUses[0].name, "Read");
  assert.equal(s.parsed.toolUses[0].input, null);
});

test("tool_use input assembled from input_json_delta and finalised on content_block_stop", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", name: "Read", input: {} },
      },
    }) +
      line({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"path":' },
        },
      }) +
      line({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '"/x.md"}' },
        },
      }) +
      line({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      }),
  );
  assert.deepEqual(s.parsed.toolUses, [{ name: "Read", input: { path: "/x.md" } }]);
});

test("hooks and rate_limit_event are recorded", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "system",
      subtype: "hook_started",
      hook_name: "SessionStart:startup",
      hook_event: "SessionStart",
    }) +
      line({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", resetsAt: 1234, overageStatus: "ok" },
      }),
  );
  assert.equal(s.parsed.hooks.length, 1);
  assert.equal(s.parsed.hooks[0].phase, "started");
  assert.equal(s.parsed.rateLimit?.status, "allowed");
});

test("post_turn_summary is captured", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "system",
      subtype: "post_turn_summary",
      status_category: "review_ready",
      status_detail: "pong",
    }),
  );
  assert.deepEqual(s.parsed.turnSummary, {
    status: "review_ready",
    detail: "pong",
  });
});

test("split-across-chunk lines are reassembled", () => {
  const s = initStreamParserState();
  const full = line({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "abc" },
    },
  });
  // feed in three pieces — boundaries inside the JSON and between lines
  feedStreamChunk(s, full.slice(0, 20));
  feedStreamChunk(s, full.slice(20, 50));
  feedStreamChunk(s, full.slice(50));
  assert.equal(s.parsed.liveText, "abc");
});

test("non-JSON tail line surfaces via unknown after flush", () => {
  const s = initStreamParserState();
  feedStreamChunk(s, "this is not json");
  flushStreamParser(s);
  assert.deepEqual(s.parsed.unknown, ["this is not json"]);
});

test("thinking_delta events accumulate into thinkingText, separate from liveText", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      },
    }) +
      line({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Let me " },
        },
      }) +
      line({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "think about this..." },
        },
      }) +
      line({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      }) +
      line({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "Answer." },
        },
      }),
  );
  assert.equal(s.parsed.thinkingText, "Let me think about this...");
  assert.equal(s.parsed.liveText, "Answer.");
  assert.equal(s.parsed.finalText, null);
});

test("setIntermediateAssistantText records draft output without losing liveText", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "partial" },
      },
    }),
  );
  setIntermediateAssistantText(s, "draft answer");
  assert.equal(s.parsed.intermediateText, "draft answer");
  assert.equal(s.parsed.finalText, null);
  assert.equal(s.parsed.liveText, "partial");
});

test("result promotion moves intermediate assistant output to finalText", () => {
  const s = initStreamParserState();
  setIntermediateAssistantText(s, "final after result");
  assert.equal(s.parsed.finalText, null);

  promoteIntermediateTextToFinal(s);

  assert.equal(s.parsed.finalText, "final after result");
  assert.equal(s.parsed.intermediateText, "final after result");
});

test("hydrateSavedAgentOutput preserves plain saved output as final text", () => {
  const s = initStreamParserState();

  hydrateSavedAgentOutput(s, "full saved answer\nwith details", {
    terminal: true,
    latencyMs: 1234,
  });

  assert.equal(s.parsed.finalText, "full saved answer\nwith details");
  assert.equal(s.parsed.intermediateText, "full saved answer\nwith details");
  assert.deepEqual(s.parsed.unknown, []);
  assert.equal(s.parsed.resultMeta?.durationMs, 1234);
});

test("hydrateSavedAgentOutput replays saved stream json lines", () => {
  const s = initStreamParserState();

  hydrateSavedAgentOutput(
    s,
    line({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "streamed answer" },
      },
    }),
    { terminal: true },
  );

  assert.equal(s.parsed.liveText, "streamed answer");
  assert.equal(s.parsed.finalText, "streamed answer");
});

test("hydrateSavedAgentOutput preserves completed stream sections", () => {
  const s = initStreamParserState();

  hydrateSavedAgentOutput(
    s,
    line({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "checking context" },
      },
    }) +
      line({
        type: "item.completed",
        item: {
          type: "local_shell_call",
          command: "npm run check",
        },
      }) +
      line({
        type: "item.completed",
        item: {
          type: "assistant_message",
          role: "assistant",
          content: [{ type: "output_text", text: "draft answer" }],
        },
      }) +
      line({
        type: "result",
        is_error: false,
        duration_ms: 1200,
        duration_api_ms: 900,
        result: "final answer",
      }),
    { terminal: true },
  );

  assert.equal(s.parsed.thinkingText, "checking context");
  assert.deepEqual(s.parsed.toolUses, [
    { name: "local_shell_call", input: "npm run check" },
  ]);
  assert.equal(s.parsed.intermediateText, "draft answer");
  assert.equal(s.parsed.finalText, "final answer");
  assert.equal(s.parsed.resultMeta?.durationMs, 1200);
});

test("codex delta events accumulate into liveText", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({ type: "item.delta", delta: "hello " }) +
      line({ type: "item_delta", item: { delta: { text: "codex" } } }),
  );
  assert.equal(s.parsed.liveText, "hello codex");
  assert.deepEqual(s.parsed.unknown, []);
});

test("codex completed assistant item stays intermediate while running", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({ type: "thread.started", thread_id: "thr-1" }) +
      line({ type: "turn.started" }) +
      line({
        type: "item.completed",
        item: {
          type: "assistant_message",
          role: "assistant",
          content: [{ type: "output_text", text: "final answer" }],
        },
      }),
  );
  assert.equal(s.parsed.intermediateText, "final answer");
  assert.equal(s.parsed.finalText, null);
  assert.equal(s.parsed.resultMeta, null);
  assert.deepEqual(s.parsed.unknown, []);
});

test("codex completed assistant item is final only after result promotion", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "item.completed",
      item: {
        type: "assistant_message",
        role: "assistant",
        content: [{ type: "output_text", text: "final answer" }],
      },
    }),
  );
  assert.equal(s.parsed.finalText, null);

  promoteIntermediateTextToFinal(s);

  assert.equal(s.parsed.finalText, "final answer");
  assert.equal(s.parsed.resultMeta?.isError, false);
  assert.deepEqual(s.parsed.unknown, []);
});

test("codex tool item is captured as tool use", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "item.completed",
      item: {
        type: "local_shell_call",
        command: "npm test",
      },
    }),
  );
  assert.deepEqual(s.parsed.toolUses, [
    { name: "local_shell_call", input: "npm test" },
  ]);
});

test("codex failed turn records error summary", () => {
  const s = initStreamParserState();
  feedStreamChunk(
    s,
    line({
      type: "turn.failed",
      error: { message: "The model is not supported" },
    }),
  );
  assert.deepEqual(s.parsed.turnSummary, {
    status: "turn.failed",
    detail: "The model is not supported",
  });
  assert.equal(s.parsed.resultMeta?.isError, true);
});
