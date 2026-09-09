import assert from "node:assert/strict";
import test from "node:test";
import { copyAnswerText, copyAnswerTextWithRetry, MAX_CLIPBOARD_TEXT_LENGTH } from "./clipboard-service.ts";

test("copies the exact Unicode and Markdown text without trimming or executing it", () => {
  const text = '  # 한글 ✅\n\n```ps1\nWrite-Output "hello"\n```\n';
  const writes = [];
  assert.deepEqual(copyAnswerText({ text }, value => writes.push(value)), { ok: true, value: undefined });
  assert.deepEqual(writes, [text]);
});

test("rejects invalid, empty, NUL-containing, and oversized payloads without writing", () => {
  for (const input of [null, undefined, "answer", [], {}, {text: 1}, {text: ""}, {text: " \n"}, {text: "before\0after"}, {text: "x".repeat(MAX_CLIPBOARD_TEXT_LENGTH + 1)}]) {
    const result = copyAnswerText(input, () => assert.fail("must not touch clipboard"));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "IPC_INVALID_PAYLOAD");
  }
});

test("accepts the length boundary without silently truncating", () => {
  const text = "a".repeat(MAX_CLIPBOARD_TEXT_LENGTH);
  let actual;
  assert.equal(copyAnswerText({ text }, value => { actual = value; }).ok, true);
  assert.equal(actual, text);
});

test("clipboard errors are reported without leaking the answer or native error", () => {
  const result = copyAnswerText({ text: "private answer" }, () => { throw new Error("private native error"); });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "APP_CLIPBOARD_WRITE_FAILED");
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test("verified clipboard write compares exact content and reports unreadable clipboard", () => {
  let contents = "";
  assert.equal(copyAnswerText({ text: "한글\nanswer" }, text => { contents = text; }, () => contents).ok, true);
  assert.equal(copyAnswerText({ text: "answer" }, () => {}, () => { throw new Error("private read failure"); }).ok, false);
});

test("transient clipboard contention retries a bounded number of times before reporting success", async () => {
  let writes = 0;
  let waits = 0;
  const result = await copyAnswerTextWithRetry({ text: "answer" }, () => { writes++; },
    () => writes < 3 ? "" : "answer", async () => { waits++; });
  assert.equal(result.ok, true);
  assert.equal(writes, 3);
  assert.equal(waits, 2);
});

test("permanent clipboard failure remains a visible failure, and invalid inputs never retry", async () => {
  let writes = 0;
  assert.equal((await copyAnswerTextWithRetry({ text: "answer" }, () => { writes++; }, () => "", async () => {})).ok, false);
  assert.equal(writes, 3);
  const result = await copyAnswerTextWithRetry({ text: "" }, () => assert.fail(), () => assert.fail(), async () => assert.fail());
  assert.equal(result.error.code, "IPC_INVALID_PAYLOAD");
});
