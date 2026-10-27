import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as core from "@harness/core";

test("IPC shutdown rejects new requests with the normal error envelope while owning accepted work", async () => {
  const handlers = new Map(), exports = {};
  const source = ts.transpileModule(readFileSync(new URL("./ipc-lifecycle.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, require: id => id === "electron"
    ? { ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) } } : core });
  let release, entered = 0, cleaned = false, drained = false;
  const gate = new Promise(resolve => { release = resolve; });
  exports.handleIpc("fixture", async () => { entered++; try { await gate; return core.ok(42); } finally { cleaned = true; } });
  const accepted = handlers.get("fixture")({});
  exports.ipcWorkScope.seal();
  const draining = exports.ipcWorkScope.drain().then(() => { drained = true; });
  const rejected = await handlers.get("fixture")({});
  assert.equal(rejected.ok, false); assert.equal(rejected.error.code, "APPLICATION_SHUTTING_DOWN");
  assert.equal(entered, 1); assert.equal(drained, false);
  release(); await draining;
  assert.equal((await accepted).value, 42); assert.equal(cleaned, true);
});
