import { test } from "node:test";
import assert from "node:assert/strict";
import {
  feedStreamChunk,
  flushStreamParser,
  initStreamParserState,
  setFinalAssistantText,
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

test("setFinalAssistantText overrides finalText without losing liveText", () => {
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
  setFinalAssistantText(s, "FINAL");
  assert.equal(s.parsed.finalText, "FINAL");
  assert.equal(s.parsed.liveText, "partial");
});
