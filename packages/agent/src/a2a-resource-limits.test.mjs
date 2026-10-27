import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedJsonBytes, createA2ARequestScope, resolveA2ALimits, createA2ABoundedFetch } from "./a2a-resource-limits.ts";

test("JSON byte accounting matches UTF-8 serialization including escapes and shared values", () => {
  const shared = { title: "한글🙂", escaped: '"\\\n\u0000', lone: "\ud800" };
  for (const value of [null, true, false, -13.5, NaN, [undefined, null, false, 0, "한"], { missing: undefined, a: shared, b: shared }]) {
    const expected = Buffer.byteLength(JSON.stringify(value));
    assert.equal(boundedJsonBytes(value, expected), expected);
    assert.throws(() => boundedJsonBytes(value, expected - 1), error => error.code === "A2A_RESPONSE_LIMIT");
  }
});

test("cycles, deep values, accessors, non-JSON objects and oversized arrays fail closed", () => {
  const cycle = {}; cycle.self = cycle;
  let deep = {}; for (let i = 0; i < 40; i++) deep = { value: deep };
  let accessed = 0;
  const accessor = { get data() { accessed++; return "unsafe"; } };
  const array = []; Object.defineProperty(array, 0, { get() { accessed++; return "unsafe"; } });
  for (const value of [cycle, deep, accessor, array, { value: 1n }, new Date(), new Array(100_001)]) {
    assert.throws(() => boundedJsonBytes(value, 4 * 1024 * 1024), error => error.code === "A2A_RESPONSE_LIMIT");
  }
  assert.equal(accessed, 0);
});

test("invalid or infinite response budgets cannot disable guards", () => {
  for (const limits of [{ maxEvents: NaN }, { maxResponseBytes: Infinity }, { maxArtifacts: -1 }, { maxRetainedEvents: 0 }]) {
    assert.throws(() => resolveA2ALimits(limits), RangeError);
  }
  for (const timeout of [0, -1, NaN, Infinity, 1.5, 2 ** 40]) assert.throws(() => createA2ARequestScope(undefined, timeout), RangeError);
});

test("successful scope settlement removes upstream listeners and its deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const upstream = new AbortController(); let adds = 0, removes = 0;
  const add = upstream.signal.addEventListener.bind(upstream.signal), remove = upstream.signal.removeEventListener.bind(upstream.signal);
  upstream.signal.addEventListener = (...args) => { adds++; return add(...args); };
  upstream.signal.removeEventListener = (...args) => { removes++; return remove(...args); };
  const scope = createA2ARequestScope(upstream.signal, 10);
  assert.equal(await scope.run(() => 42), 42);
  scope.dispose(); t.mock.timers.tick(100);
  assert.equal(adds, removes); assert.equal(scope.signal.reason.name, "AbortError");
});

test("a timed-out fetch cancels a body that arrives late even when fetch ignored abort", async () => {
  let deliver, cancelled = 0;
  const late = new Promise(resolve => { deliver = resolve; });
  const scope = createA2ARequestScope(undefined, 10);
  const boundedFetch = createA2ABoundedFetch(scope, resolveA2ALimits(), async () => late)(1024);
  try {
    await assert.rejects(boundedFetch("https://fixture.invalid"), error => error.code === "A2A_REQUEST_TIMEOUT");
    deliver(new Response(new ReadableStream({ cancel() { cancelled++; } })));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(cancelled, 1);
  } finally { scope.dispose(); }
});
