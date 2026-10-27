import assert from "node:assert/strict";
import test from "node:test";

import {
  beginTaskRunDetailRefresh,
  beginThreadDetailRefresh,
  createDetailRefreshController,
} from "./workbench-refresh-state.ts";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const loaderFixture = () => {
  const requests = [], ready = [], errors = [], begins = [];
  const controller = createDetailRefreshController({
    load: id => { const request = deferred(); requests.push({ id, ...request }); return request.promise; },
    keyOf: detail => detail.id, begin: id => begins.push(id), ready: detail => ready.push(detail), error: (id, error) => errors.push({ id, error }),
  });
  return { controller, requests, ready, errors, begins };
};
const tick = () => Promise.resolve();

test("late success and failure from an old selection cannot replace current detail", async () => {
  const f = loaderFixture();
  f.controller.select("A"); const a = f.controller.refresh("A"); await tick();
  f.controller.select("B"); const b = f.controller.refresh("B"); await tick();
  f.requests[1].resolve({ id: "B" }); await b;
  f.requests[0].reject(new Error("late A")); await a;
  assert.deepEqual(f.ready, [{ id: "B" }]); assert.deepEqual(f.errors, []);
});

test("A to B to A gives the second A a different selection lifetime", async () => {
  const f = loaderFixture();
  f.controller.select("A"); const old = f.controller.refresh("A"); await tick();
  f.controller.select("B");
  f.controller.select("A"); const fresh = f.controller.refresh("A"); await tick();
  f.requests[1].resolve({ id: "A", revision: 2 }); await fresh;
  f.requests[0].resolve({ id: "A", revision: 1 }); await old;
  assert.deepEqual(f.ready, [{ id: "A", revision: 2 }]);
});

test("push bursts coalesce into one trailing pull and do not publish its outdated predecessor", async () => {
  const f = loaderFixture(); f.controller.select("A");
  const pending = f.controller.refresh("A"); await tick();
  const bursts = Array.from({ length: 20 }, () => f.controller.refresh("A"));
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve({ id: "A", revision: 1 }); await tick(); await tick();
  assert.deepEqual(f.ready, []); assert.equal(f.requests.length, 2);
  f.requests[1].resolve({ id: "A", revision: 2 }); await Promise.all([pending, ...bursts]);
  assert.deepEqual(f.ready, [{ id: "A", revision: 2 }]);
});

test("deselect discards in-flight responses and wrong IDs are errors", async () => {
  const f = loaderFixture(); f.controller.select("A");
  const old = f.controller.refresh("A"); await tick(); f.controller.select(null);
  f.requests[0].resolve({ id: "A" }); await old; await f.controller.refresh("A");
  assert.deepEqual(f.ready, []); assert.equal(f.requests.length, 1);
  f.controller.select("B"); const current = f.controller.refresh("B"); await tick();
  f.requests[1].resolve({ id: "wrong" }); await current;
  assert.equal(f.errors.length, 1); assert.equal(f.errors[0].id, "B");
});

test("a trailing refresh recovers a failed predecessor and current failure is displayed", async () => {
  const f = loaderFixture(); f.controller.select("A");
  const first = f.controller.refresh("A"); await tick(); const trailing = f.controller.refresh("A");
  f.requests[0].reject(new Error("obsolete")); await tick(); await tick();
  f.requests[1].resolve({ id: "A" }); await Promise.all([first, trailing]);
  assert.equal(f.errors.length, 0);
  const failed = f.controller.refresh("A"); await tick(); f.requests[2].reject(new Error("current")); await failed;
  assert.equal(f.errors[0].error.message, "current");
});

test("a push after publication but before promise settlement starts a new pull", async () => {
  const f = loaderFixture(); f.controller.select("A");
  const first = f.controller.refresh("A"); await tick();
  f.requests[0].resolve({ id: "A", revision: 1 }); await tick();
  const second = f.controller.refresh("A"); await tick();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve({ id: "A", revision: 2 }); await Promise.all([first, second]);
  assert.equal(f.ready.at(-1).revision, 2);
});

test("beginThreadDetailRefresh keeps same-thread ready detail visible", () => {
  const previous = {
    kind: "ready",
    detail: {
      thread: { id: "thread-1" },
    },
  };

  assert.equal(beginThreadDetailRefresh(previous, "thread-1"), previous);
});

test("beginThreadDetailRefresh shows loading when switching threads", () => {
  const previous = {
    kind: "ready",
    detail: {
      thread: { id: "thread-1" },
    },
  };

  assert.deepEqual(beginThreadDetailRefresh(previous, "thread-2"), {
    kind: "loading",
    threadId: "thread-2",
  });
});

test("beginTaskRunDetailRefresh keeps same-task ready detail visible", () => {
  const previous = {
    kind: "ready",
    detail: {
      taskRun: { id: "task-1" },
    },
  };

  assert.equal(beginTaskRunDetailRefresh(previous, "task-1"), previous);
});

test("beginTaskRunDetailRefresh shows loading when switching task runs", () => {
  const previous = {
    kind: "ready",
    detail: {
      taskRun: { id: "task-1" },
    },
  };

  assert.deepEqual(beginTaskRunDetailRefresh(previous, "task-2"), {
    kind: "loading",
    taskRunId: "task-2",
  });
});
