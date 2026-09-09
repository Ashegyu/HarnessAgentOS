import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexExecStream, parseCodexTokenUsage } from "./codex-exec-stream.ts";

const message = (text, extra = {}) => ({ type: "item.completed", item: { type: "agent_message", text, ...extra } });
const terminal = (usage = { input_tokens: 10, output_tokens: 5 }) => ({ type: "turn.completed", usage });
const makeStream = (events, options) => {
  const stream = new CodexExecStream(options);
  stream.write(Buffer.from(events.map((event) => JSON.stringify(event)).join("\r\n") + "\r\n\r\n"));
  stream.end();
  return stream;
};

test("Codex reasoning usage is a subset of output tokens, not an additional charge", () => {
  assert.deepEqual(parseCodexTokenUsage({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5 }), {
    inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 5,
  });
  assert.equal(parseCodexTokenUsage({ input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 21 }), undefined);
});

test("JSONL accepts CRLF, blank lines, unknown metadata, and content blocks", () => {
  const stream = makeStream([
    { type: "thread.started", thread_id: "thread" }, { type: "future.metadata" },
    { type: "item.completed", item: { type: "assistant_message", content: [{ text: "한글" }, {}, { text: " 답변" }] } }, terminal(),
  ]);
  assert.equal(stream.result().text, "한글 답변");
  assert.equal(stream.end(), "");
  assert.equal(stream.write(Buffer.from("late")), "");
});

for (const event of [null, [], 1, { text: "not an event" }]) {
  test(`JSONL rejects invalid envelope ${JSON.stringify(event)}`, () => {
    assert.throws(() => makeStream([event, message("answer"), terminal()]).result(), /envelope/);
  });
}

test("JSONL rejects invalid encoding and partial UTF-8 at EOF", () => {
  for (const bytes of [[0xff], [0xed, 0xa0, 0x80], [0xe3, 0x81]]) {
    const stream = new CodexExecStream();
    stream.write(Buffer.from(bytes));
    stream.end();
    assert.throws(() => stream.result(), /UTF-8/);
    assert.equal(stream.tokenUsage, undefined);
  }
});

test("JSONL rejects oversized frames and final answers without accepting a later success", () => {
  const stream = new CodexExecStream({ maxFrameBytes: 128 });
  for (let i = 0; i < 500; i++) stream.write(Buffer.from("x".repeat(1_000)));
  stream.write(Buffer.from("\n" + JSON.stringify(message("ok")) + "\n" + JSON.stringify(terminal())));
  stream.end();
  assert.throws(() => stream.result(), /frame exceeds/);
  assert.throws(() => makeStream([message("한글"), terminal()], { maxFinalBytes: 5 }).result(), /final answer exceeds/);
});

test("JSONL does not promote commentary or partial assistant items to final output", () => {
  for (const event of [message("progress", { phase: "commentary" }), { type: "item.started", item: { type: "agent_message", text: "partial" } }]) {
    assert.throws(() => makeStream([event, terminal()]).result(), /Missing final/);
  }
  assert.equal(makeStream([message("final", { phase: "final_answer" }), terminal()]).result().text, "final");
});

test("JSONL uses the latest cumulative thread usage without adding earlier turns or replay", () => {
  const stream = makeStream([
    message("old"), terminal(), terminal(), { type: "turn.started" },
    message("new"), terminal({ input_tokens: 20, output_tokens: 10 }),
  ]);
  assert.deepEqual(stream.result(), { text: "new", tokenUsage: {
    inputTokens: 20, outputTokens: 10, cachedInputTokens: 0, reasoningOutputTokens: 0,
  } });
  const snapshot = stream.tokenUsage;
  snapshot.inputTokens = 999;
  assert.equal(stream.tokenUsage.inputTokens, 20);
});

test("JSONL rejects conflicting terminal replay and final messages after terminal", () => {
  assert.throws(() => makeStream([message("answer"), terminal(), terminal({ input_tokens: 20, output_tokens: 5 })]).result(), /Conflicting/);
  assert.throws(() => makeStream([message("answer"), terminal(), message("late")]).result(), /after Codex turn completion/);
  assert.throws(() => new CodexExecStream().result(), /EOF/);
});

test("unknown or invalid final usage is not exact zero or an earlier partial count", () => {
  for (const usage of [null, {}, { input_tokens: -1, output_tokens: 5 }, { input_tokens: 1.5, output_tokens: 2 },
    { input_tokens: 1, output_tokens: 2, cached_input_tokens: 2 },
    { input_tokens: 1, output_tokens: Number.MAX_SAFE_INTEGER, reasoning_output_tokens: 1 }]) {
    assert.equal(parseCodexTokenUsage(usage), undefined);
    assert.equal(makeStream([message("answer"), terminal(usage)]).result().tokenUsage, undefined);
  }
  assert.equal(makeStream([message("old"), terminal(), { type: "turn.started" }, message("new"), terminal(null)]).tokenUsage, undefined);
  assert.equal(makeStream([message("old"), terminal(null), { type: "turn.started" }, message("new"), terminal()]).tokenUsage.inputTokens, 10);
});
