import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShadowHandlers } from "./shadow-ipc.ts";

test("createPreview validates input", async () => {
  const h = buildShadowHandlers({
    shadow: {
      createPreview: async () => {
        throw new Error("should not be called");
      },
    },
  });

  const result = await h.createPreview({});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "STATE_INVALID_INPUT");
});

test("createPreview delegates to service", async () => {
  const h = buildShadowHandlers({
    shadow: {
      createPreview: async ({ approvalId }) => ({
        id: "shd_1",
        taskRunId: "tsk_1",
        approvalId,
        targetDir: "C:/tmp/project",
        relativePath: "README.md",
        shadowPath: "C:/tmp/shadow/README.md",
        artifactIds: ["art_1"],
        createdAt: "2026-05-16T00:00:00.000Z",
      }),
    },
  });

  const result = await h.createPreview({ approvalId: "apv_1" });
  assert.equal(result.ok, true);
  assert.equal(result.value.approvalId, "apv_1");
});
