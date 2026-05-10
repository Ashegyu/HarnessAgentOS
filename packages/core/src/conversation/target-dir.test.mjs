import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAbsoluteTargetDir } from "./target-dir.ts";

test("validateAbsoluteTargetDir accepts POSIX absolute", () => {
  const r = validateAbsoluteTargetDir("/home/me/Code");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.normalized, "/home/me/Code");
});

test("validateAbsoluteTargetDir accepts Win32 drive paths and normalizes", () => {
  const r = validateAbsoluteTargetDir("C:/Users/me");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.normalized, "C:\\Users\\me");
});

test("validateAbsoluteTargetDir rejects relative paths", () => {
  const r = validateAbsoluteTargetDir("./relative");
  assert.equal(r.ok, false);
});

test("validateAbsoluteTargetDir rejects empty / non-string", () => {
  assert.equal(validateAbsoluteTargetDir("").ok, false);
  assert.equal(validateAbsoluteTargetDir(null).ok, false);
  assert.equal(validateAbsoluteTargetDir(123).ok, false);
});
