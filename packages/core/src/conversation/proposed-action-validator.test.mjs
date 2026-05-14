import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProposedActionDetails } from "./proposed-action-validator.ts";

test("rejects non-object input", () => {
  const r = validateProposedActionDetails(null, "file_write");
  assert.equal(r.ok, false);
});

test("rejects mismatched action type", () => {
  const r = validateProposedActionDetails(
    { type: "shell", command: "ls" },
    "file_write",
  );
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /must match approval.actionType/);
});

test("rejects renderer-supplied cwd", () => {
  const r = validateProposedActionDetails(
    { type: "shell", command: "ls", cwd: "/etc" },
    "shell",
  );
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /cwd is not allowed/);
});

test("file_write rejects absolute path", () => {
  const r = validateProposedActionDetails(
    { type: "file_write", filePatch: { path: "C:\\evil", after: "x" } },
    "file_write",
  );
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /relative to TaskRun.targetDir/);
});

test("file_write rejects parent traversal", () => {
  const r = validateProposedActionDetails(
    { type: "file_write", filePatch: { path: "../etc/passwd", after: "x" } },
    "file_write",
  );
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /traverse parent/);
});

test("file_write accepts relative path", () => {
  const r = validateProposedActionDetails(
    {
      type: "file_write",
      filePatch: { path: "src/foo.ts", after: "content" },
    },
    "file_write",
  );
  assert.equal(r.ok, true);
  assert.equal(r.details.type, "file_write");
  assert.equal(r.details.filePatch.path, "src/foo.ts");
});

test("file_write strips disallowed extra fields", () => {
  const r = validateProposedActionDetails(
    {
      type: "file_write",
      filePatch: { path: "x", after: "y" },
      command: "rm -rf /",
    },
    "file_write",
  );
  assert.equal(r.ok, true);
  assert.equal(r.details.command, undefined);
});

test("shell requires non-empty command", () => {
  const r = validateProposedActionDetails(
    { type: "shell", command: "  " },
    "shell",
  );
  assert.equal(r.ok, false);
});

test("shell normalizes args", () => {
  const r = validateProposedActionDetails(
    { type: "shell", command: "echo", args: ["hi"] },
    "shell",
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.details.args, ["hi"]);
});

test("shell rejects non-string args", () => {
  const r = validateProposedActionDetails(
    { type: "shell", command: "echo", args: [1] },
    "shell",
  );
  assert.equal(r.ok, false);
});

test("capability_use accepts normalized capability selection details", () => {
  const r = validateProposedActionDetails(
    {
      type: "capability_use",
      capabilityUse: {
        capabilityId: " cap_refactor ",
        capabilityName: " Refactor ",
        reason: " Matched trigger terms: refactor ",
        matchedTerms: ["refactor"],
      },
      command: "echo should be stripped",
    },
    "capability_use",
  );
  assert.equal(r.ok, true);
  assert.equal(r.details.type, "capability_use");
  assert.equal(r.details.capabilityUse.capabilityId, "cap_refactor");
  assert.equal(r.details.capabilityUse.capabilityName, "Refactor");
  assert.deepEqual(r.details.capabilityUse.matchedTerms, ["refactor"]);
  assert.equal(r.details.command, undefined);
});

test("capability_use rejects missing capabilityUse payload", () => {
  const r = validateProposedActionDetails(
    { type: "capability_use" },
    "capability_use",
  );
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /capabilityUse object/);
});

test("model_use accepts normalized learner model recommendation details", () => {
  const r = validateProposedActionDetails(
    {
      type: "model_use",
      modelUse: {
        model: " gpt-5.5 ",
        reason: " Highest reward ",
        recommendationId: " rec_1 ",
        confidence: 0.74,
      },
      command: "ignored",
    },
    "model_use",
  );
  assert.equal(r.ok, true);
  assert.equal(r.details.type, "model_use");
  assert.deepEqual(r.details.modelUse, {
    model: "gpt-5.5",
    reason: "Highest reward",
    recommendationId: "rec_1",
    confidence: 0.74,
  });
  assert.equal(r.details.command, undefined);
});

test("model_use rejects missing modelUse payload", () => {
  const r = validateProposedActionDetails(
    { type: "model_use" },
    "model_use",
  );
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /modelUse object/);
});
