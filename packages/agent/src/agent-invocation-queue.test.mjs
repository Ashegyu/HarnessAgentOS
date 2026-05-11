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

test("cancel queued entry runs the work with already-aborted signal", async () => {
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
  let observed;
  const p2 = q.enqueue({
    provider: "claude",
    invocationId: "i2",
    work: async (signal) => {
      observed = signal.aborted;
      if (signal.aborted) throw new Error("aborted-before-start");
      return "two";
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  const found = q.cancel("i2");
  assert.equal(found, true);
  await assert.rejects(() => p2, /aborted-before-start/);
  assert.equal(observed, true);
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
