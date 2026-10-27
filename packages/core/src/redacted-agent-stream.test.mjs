import { test } from "node:test";
import assert from "node:assert/strict";
import { createRedactedAgentStream } from "./redacted-agent-stream.ts";

const raw = (text, source = "stdout") => ({ type: "raw", invocationId: "audit", source, text });

test("audit buffering joins split JSON keys, keeps event order, and flushes incomplete values", () => {
  const events = [];
  const stream = createRedactedAgentStream({ emit: event => events.push(event) });
  stream.push(raw('{"to'));
  stream.push({ type: "progress", invocationId: "audit", stage: "cli", taskRunId: "task", message: "working", at: "now" });
  stream.push(raw('ken":\n"SYNTHETIC_STREAM_SECRET"}\n'));
  assert.deepEqual(events.map(e => e.type), ["raw", "progress", "raw"]);
  assert.doesNotMatch(JSON.stringify(events), /SYNTHETIC_STREAM_SECRET/);
  assert.ok(events.filter(e => e.type === "raw").map(e => e.text).join("").includes("[REDACTED]"));
  stream.push(raw('{"password":"SYNTHETIC_UNFINISHED_SECRET'));
  stream.push({ type: "cancelled", invocationId: "audit" });
  assert.equal(events.at(-1).type, "cancelled");
  assert.doesNotMatch(JSON.stringify(events), /SYNTHETIC_UNFINISHED_SECRET/);
});

test("audit overflow omits raw text until a safe boundary then resumes normally", () => {
  const events = [];
  const stream = createRedactedAgentStream({ emit: event => events.push(event), maxPendingChars: 32 });
  stream.push(raw('{"token":"' + "SYNTHETIC_SECRET".repeat(100)));
  stream.push(raw('SYNTHETIC_TAIL_SECRET"}\n'));
  stream.push(raw("normal output\n"));
  stream.flush();
  assert.doesNotMatch(JSON.stringify(events), /SYNTHETIC/);
  assert.ok(events.some(e => e.text?.includes("audit buffer limit")));
  assert.ok(events.some(e => e.text === "normal output\n"));
});

test("audit channels stay independent and ordinary ordered text survives batching", () => {
  const events = [];
  const stream = createRedactedAgentStream({ emit: event => events.push(event) });
  stream.push(raw("first "));
  stream.push(raw("diagnostic\n", "stderr"));
  stream.push(raw("second\n"));
  stream.push({ type: "result", invocationId: "audit" });
  assert.equal(events.filter(e => e.type === "raw" && e.source === "stdout").map(e => e.text).join(""), "first second\n");
  assert.equal(events.filter(e => e.type === "raw" && e.source === "stderr").map(e => e.text).join(""), "diagnostic\n");
  assert.deepEqual(events.map(e => e.type), ["raw", "raw", "raw", "result"]);
});

test("audit event-count bound flushes a marker and continues non-text telemetry", () => {
  const events = [];
  const stream = createRedactedAgentStream({ emit: event => events.push(event), maxPendingEvents: 2 });
  stream.push(raw('{"token":"SYNTHETIC_SECRET'));
  for (let i = 0; i < 5; i++) stream.push({ type: "progress", invocationId: "audit", taskRunId: "task", stage: "cli", message: `step ${i}`, at: "now" });
  stream.flush();
  assert.doesNotMatch(JSON.stringify(events), /SYNTHETIC_SECRET/);
  assert.equal(events.filter(e => e.type === "progress").length, 5);
  assert.ok(events.some(e => e.text?.includes("audit buffer limit")));
});
