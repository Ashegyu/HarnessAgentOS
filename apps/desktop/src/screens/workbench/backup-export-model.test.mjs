import { test } from "node:test";
import assert from "node:assert/strict";
import { safeFileStem, threadMarkdownDefaultFileName } from "./backup-export-model.ts";

test("safeFileStem removes unsafe filename characters", () => {
  assert.equal(safeFileStem("A/B:C* thread"), "A-B-C-thread");
  assert.equal(safeFileStem("   "), "thread-export");
});

test("threadMarkdownDefaultFileName includes sanitized thread title", () => {
  const name = threadMarkdownDefaultFileName({
    id: "thr_1",
    title: "My Thread/One",
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z",
  });
  assert.match(name, /^My-Thread-One-\d{8}\.md$/);
});
