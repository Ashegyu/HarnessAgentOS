import { test } from "node:test";
import assert from "node:assert/strict";
import { AsyncWorkScope } from "./async-work-scope.ts";

test("sealing rejects new work while draining owns success, errors and cleanup", async () => {
  const scope = new AsyncWorkScope(() => new Error("closed"));
  let release, cleaned = false, drained = false;
  const gate = new Promise(resolve => { release = resolve; });
  const failure = new Error("owned failure");
  const first = scope.run(async () => { try { await gate; throw failure; } finally { cleaned = true; } });
  const observed = first.catch(error => error);
  const second = scope.run(async () => 42);
  scope.seal();
  const drain = scope.drain().then(() => { drained = true; });
  await assert.rejects(scope.run(async () => assert.fail("must not enter")), /closed/);
  assert.equal(drained, false);
  release(); await drain;
  assert.equal(await observed, failure);
  assert.equal(await second, 42);
  assert.equal(cleaned, true);
  await scope.drain();
});

test("synchronous exceptions are observed and removed from work ownership", async () => {
  const scope = new AsyncWorkScope();
  await assert.rejects(scope.run(() => { throw new Error("sync failure"); }), /sync failure/);
  scope.seal();
  await scope.drain();
});
