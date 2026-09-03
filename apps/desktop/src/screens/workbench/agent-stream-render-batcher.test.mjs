import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentStreamRenderBatcher } from "./agent-stream-render-batcher.ts";

test("agent stream render batcher coalesces burst updates into one frame", () => {
  const scheduled = [];
  let renders = 0;
  const batcher = createAgentStreamRenderBatcher(
    () => {
      renders += 1;
    },
    {
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancel: () => {},
    },
  );

  for (let index = 0; index < 100; index += 1) batcher.request();
  assert.equal(scheduled.length, 1);
  assert.equal(renders, 0);
  scheduled[0]?.();
  assert.equal(renders, 1);

  batcher.request();
  batcher.flushNow();
  assert.equal(renders, 2);
});

test("agent stream render batcher cancels a pending frame on teardown", () => {
  const cancelled = [];
  const batcher = createAgentStreamRenderBatcher(() => {}, {
    schedule: () => 42,
    cancel: (handle) => cancelled.push(handle),
  });

  batcher.request();
  batcher.cancel();

  assert.deepEqual(cancelled, [42]);
});
