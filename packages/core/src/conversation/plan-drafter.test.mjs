import { test } from "node:test";
import assert from "node:assert/strict";
import { draftPlan } from "./plan-drafter.ts";

test("draftPlan produces title from first line of userRequest", () => {
  const r = draftPlan({
    userRequest: "Refactor settings module\nMore details here",
    targetDir: "/tmp/x",
  });
  assert.equal(r.title, "Refactor settings module");
});

test("draftPlan content references targetDir", () => {
  const r = draftPlan({
    userRequest: "do thing",
    targetDir: "C:\\Users\\me\\Code",
  });
  // Match a single literal backslash per regex `\\` token.
  assert.match(r.content, /C:\\Users\\me\\Code/);
});

test("draftPlan emits at least one ProposedAction with requiresApproval=true", () => {
  const r = draftPlan({ userRequest: "x", targetDir: "/tmp" });
  assert.ok(r.proposedActions.length >= 1);
  for (const a of r.proposedActions) {
    assert.equal(a.requiresApproval, true);
  }
});

test("draftPlan with redirect adds Redirect section", () => {
  const r = draftPlan({
    userRequest: "x",
    targetDir: "/tmp",
    redirectFrom: { previousPlanContent: "", instruction: "use a different approach" },
  });
  assert.match(r.title, /^재계획/);
  assert.match(r.content, /Redirect/);
  assert.match(r.content, /use a different approach/);
});

test("draftPlan does not perform any side effects", () => {
  // Sanity: pure function returns same shape twice.
  const a = draftPlan({ userRequest: "same", targetDir: "/x" });
  const b = draftPlan({ userRequest: "same", targetDir: "/x" });
  assert.equal(a.title, b.title);
  assert.equal(a.content, b.content);
  assert.equal(a.proposedActions.length, b.proposedActions.length);
});
