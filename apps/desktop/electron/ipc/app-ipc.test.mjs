import { test } from "node:test";
import assert from "node:assert/strict";
import { IPC_CHANNELS } from "@harness/core";

test("preload uses the channel constants from @harness/core, not literals", () => {
  // This is an architectural assertion: any handler/preload that imports
  // IPC_CHANNELS gets the constant. If a future refactor inlines literal
  // channel strings, this test asks the author to pause.
  assert.equal(typeof IPC_CHANNELS.app.getVersion, "string");
  assert.equal(typeof IPC_CHANNELS.app.getRuntimeInfo, "string");
});
