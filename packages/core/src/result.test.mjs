import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ok,
  err,
  isOk,
  isErr,
  unwrap,
  harnessError,
  isHarnessError,
} from "./index.ts";

test("ok wraps value with ok=true", () => {
  const r = ok(42);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, 42);
});

test("err wraps HarnessError with ok=false", () => {
  const e = harnessError("X_TEST", "boom");
  const r = err(e);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, "X_TEST");
});

test("isOk and isErr are mutually exclusive", () => {
  const o = ok(1);
  const e = err(harnessError("X", "x"));
  assert.equal(isOk(o), true);
  assert.equal(isErr(o), false);
  assert.equal(isOk(e), false);
  assert.equal(isErr(e), true);
});

test("unwrap returns value on ok", () => {
  assert.equal(unwrap(ok("hello")), "hello");
});

test("unwrap throws Error tagged with harnessError on err", () => {
  const e = harnessError("X_FAIL", "no good", { reason: "test" });
  let caught = null;
  try {
    unwrap(err(e));
  } catch (thrown) {
    caught = thrown;
  }
  assert.ok(caught instanceof Error);
  assert.match(caught.message, /\[X_FAIL\] no good/);
  assert.equal(caught.harnessError.code, "X_FAIL");
  assert.deepEqual(caught.harnessError.details, { reason: "test" });
});

test("isHarnessError accepts shape with code+message strings", () => {
  assert.equal(isHarnessError({ code: "X", message: "y" }), true);
  assert.equal(isHarnessError({ code: 1, message: "y" }), false);
  assert.equal(isHarnessError(null), false);
  assert.equal(isHarnessError("string"), false);
});

test("harnessError omits details when undefined", () => {
  const e = harnessError("X", "msg");
  assert.equal(Object.prototype.hasOwnProperty.call(e, "details"), false);
});
