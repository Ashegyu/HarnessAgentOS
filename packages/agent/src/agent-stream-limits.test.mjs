import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BoundedAgentStreamEventBuffer,
  BoundedTextBuffer,
} from "./agent-stream-limits.ts";

test("BoundedTextBuffer retains a UTF-8-safe tail and reports dropped bytes", () => {
  const buffer = new BoundedTextBuffer(8);
  buffer.append("abcd");
  buffer.append("한글ef");

  assert.ok(Buffer.byteLength(buffer.value(), "utf8") <= 8);
  assert.match(buffer.value(), /ef$/);
  assert.ok(buffer.droppedBytes > 0);
});

test("BoundedAgentStreamEventBuffer caps count and bytes without shifting arrays", () => {
  const buffer = new BoundedAgentStreamEventBuffer({
    maxEvents: 3,
    maxBytes: 400,
  });
  for (let index = 0; index < 8; index += 1) {
    buffer.push({
      type: "raw",
      invocationId: "inv",
      taskRunId: "task",
      source: "stdout",
      text: `event-${index}-${"x".repeat(40)}`,
    });
  }

  const events = buffer.toArray();
  assert.ok(events.length <= 3);
  assert.match(events.at(-1)?.text ?? "", /event-7/);
  assert.ok(buffer.droppedEvents >= 5);
  assert.ok(buffer.droppedBytes > 0);
});
