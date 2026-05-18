import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentInvocationQueue } from "./agent-invocation-queue.ts";

const deferred = () => {
  let resolveFn;
  let rejectFn;
  const promise = new Promise((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
};

test("two claude invocations serialize through the lane", async () => {
  const q = new AgentInvocationQueue();
  const order = [];
  const g1 = deferred();
  const g2 = deferred();
  const p1 = q.enqueue({
    provider: "claude",
    invocationId: "i1",
    work: async () => {
      order.push("i1-start");
      await g1.promise;
      order.push("i1-end");
      return "one";
    },
  });
  const p2 = q.enqueue({
    provider: "claude",
    invocationId: "i2",
    work: async () => {
      order.push("i2-start");
      await g2.promise;
      order.push("i2-end");
      return "two";
    },
  });

  // Give microtasks a tick.
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ["i1-start"]);
  assert.equal(q.getDepth("claude"), 2);
  g1.resolve();
  assert.equal(await p1, "one");
  await Promise.resolve();
  assert.deepEqual(order, ["i1-start", "i1-end", "i2-start"]);
  g2.resolve();
  assert.equal(await p2, "two");
  assert.equal(q.getDepth("claude"), 0);
});

test("claude and codex run in parallel", async () => {
  const q = new AgentInvocationQueue();
  const g = deferred();
  const order = [];
  const a = q.enqueue({
    provider: "claude",
    invocationId: "a",
    work: async () => {
      order.push("a-start");
      await g.promise;
      return "a";
    },
  });
  const b = q.enqueue({
    provider: "codex",
    invocationId: "b",
    work: async () => {
      order.push("b-start");
      return "b";
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(order.includes("a-start"));
  assert.ok(order.includes("b-start"));
  assert.equal(await b, "b");
  g.resolve();
  assert.equal(await a, "a");
});

test("same-provider independent lanes run in parallel", async () => {
  const q = new AgentInvocationQueue();
  const gate = deferred();
  const order = [];
  const a = q.enqueue({
    provider: "codex",
    invocationId: "worker-a",
    laneKey: "worker:worker-a",
    work: async () => {
      order.push("a-start");
      await gate.promise;
      return "a";
    },
  });
  const b = q.enqueue({
    provider: "codex",
    invocationId: "worker-b",
    laneKey: "worker:worker-b",
    work: async () => {
      order.push("b-start");
      return "b";
    },
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.ok(order.includes("a-start"));
  assert.ok(order.includes("b-start"));
  assert.equal(q.getDepth("codex"), 2);
  assert.equal(await b, "b");
  assert.equal(q.getDepth("codex"), 1);
  gate.resolve();
  assert.equal(await a, "a");
  assert.equal(q.getDepth("codex"), 0);
});

test("cancel queued entry rejects without invoking the work", async () => {
  const q = new AgentInvocationQueue();
  const block = deferred();
  const p1 = q.enqueue({
    provider: "claude",
    invocationId: "i1",
    work: async () => {
      await block.promise;
      return "one";
    },
  });
  let workInvoked = false;
  const p2 = q.enqueue({
    provider: "claude",
    invocationId: "i2",
    work: async () => {
      workInvoked = true;
      return "two";
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  const found = q.cancel("i2");
  assert.equal(found, true);
  await assert.rejects(() => p2, (err) => err.code === "AGENT_CANCELLED");
  assert.equal(workInvoked, false);
  block.resolve();
  assert.equal(await p1, "one");
});

test("cancel in-flight entry fires AbortController", async () => {
  const q = new AgentInvocationQueue();
  let aborted = false;
  const p = q.enqueue({
    provider: "codex",
    invocationId: "live",
    work: (signal) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("cancelled"));
        });
      }),
  });
  await Promise.resolve();
  await Promise.resolve();
  q.cancel("live");
  await assert.rejects(() => p, /cancelled/);
  assert.equal(aborted, true);
});

test("isBusy reflects queued and in-flight entries", async () => {
  const q = new AgentInvocationQueue();
  const g = deferred();
  const p = q.enqueue({
    provider: "claude",
    invocationId: "x",
    work: async () => {
      await g.promise;
      return null;
    },
  });
  assert.equal(q.isBusy("x"), true);
  g.resolve();
  await p;
  assert.equal(q.isBusy("x"), false);
});

// RED: cancel() of a queued (non-inflight) entry must NOT promote that entry
// to the inflight slot. Doing so corrupts lane.inflight and causes the next
// waiting entry (i3) to start before the current in-flight entry (i1) finishes,
// violating the 1-slot-per-provider invariant.
test("cancel of queued entry preserves 1-slot invariant (i3 must not start until i1 finishes)", async () => {
  const q = new AgentInvocationQueue();
  const gate1 = deferred();
  const gate3 = deferred();
  const order = [];

  const p1 = q.enqueue({
    provider: "claude",
    invocationId: "i1",
    work: async () => {
      order.push("i1-start");
      await gate1.promise;
      order.push("i1-end");
      return "one";
    },
  });

  const p2 = q.enqueue({
    provider: "claude",
    invocationId: "i2",
    work: async (signal) => {
      if (signal.aborted) throw new Error("cancelled");
      return "two";
    },
  });

  const p3 = q.enqueue({
    provider: "claude",
    invocationId: "i3",
    work: async () => {
      order.push("i3-start");
      await gate3.promise;
      order.push("i3-end");
      return "three";
    },
  });

  // Let i1 start (it becomes inflight immediately; i2 and i3 go to waiting).
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ["i1-start"]);
  assert.equal(q.getDepth("claude"), 3);

  // Cancel i2 (queued, not inflight).
  const found = q.cancel("i2");
  assert.equal(found, true);

  // Drain the microtask queue enough for any spurious run() to execute.
  for (let i = 0; i < 6; i++) await Promise.resolve();

  // i3 must NOT have started — i1 is still blocking the lane.
  assert.deepEqual(order, ["i1-start"], "i3 must not start while i1 is still in-flight");
  // Depth: i1 inflight (1) + i3 waiting (1) = 2.
  assert.equal(q.getDepth("claude"), 2);

  // p2 must already be rejected (cancelled before it could run).
  await assert.rejects(() => p2, (err) => err.code === "AGENT_CANCELLED");

  // Now finish i1 — this should trigger drain and start i3.
  gate1.resolve();
  assert.equal(await p1, "one");

  await Promise.resolve();
  await Promise.resolve();
  assert.ok(order.includes("i3-start"), "i3 must start after i1 finishes");

  gate3.resolve();
  assert.equal(await p3, "three");
  assert.deepEqual(order, ["i1-start", "i1-end", "i3-start", "i3-end"]);
});
