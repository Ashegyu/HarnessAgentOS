import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertActionTypeAllowed,
  isActionAllowedForWorkerStep,
  orderWorkerStepsByDependencies,
  validatePlanShape,
  validateWorkerStep,
  validateWorkerTopology,
} from "./orchestration-policy.ts";

const stepBase = (overrides = {}) => ({
  id: "stp_1",
  title: "do",
  role: "coder",
  inputSummary: "x",
  expectedArtifactKinds: ["plan"],
  status: "pending",
  ...overrides,
});

const isCode = (code) => (e) => e && e.code === code;

test("assertActionTypeAllowed throws for forbidden actions", () => {
  assert.throws(
    () => assertActionTypeAllowed("file_write"),
    isCode("ORCH_DIRECT_ACTION_BLOCKED"),
  );
  assert.throws(
    () => assertActionTypeAllowed("shell"),
    isCode("ORCH_DIRECT_ACTION_BLOCKED"),
  );
});

test("assertActionTypeAllowed accepts summarize/plan", () => {
  assertActionTypeAllowed("summarize");
  assertActionTypeAllowed("plan");
});

test("validateWorkerStep rejects empty title", () => {
  assert.throws(
    () => validateWorkerStep(stepBase({ title: "  " })),
    isCode("ORCH_INVALID_PLAN"),
  );
});

test("validateWorkerStep rejects unsafe artifact kinds", () => {
  assert.throws(
    () => validateWorkerStep(stepBase({ expectedArtifactKinds: ["mysterious"] })),
    isCode("ORCH_INVALID_PLAN"),
  );
});

test("validateWorkerStep accepts topology metadata", () => {
  validateWorkerStep(
    stepBase({
      dependsOn: ["stp_0"],
      allowedActions: ["file_write"],
      outputContract: "diff_proposal",
    }),
  );
});

test("validateWorkerStep rejects malformed topology metadata", () => {
  assert.throws(
    () => validateWorkerStep(stepBase({ dependsOn: [""] })),
    isCode("ORCH_INVALID_PLAN"),
  );
  assert.throws(
    () => validateWorkerStep(stepBase({ allowedActions: ["git_push"] })),
    isCode("ORCH_INVALID_PLAN"),
  );
  assert.throws(
    () => validateWorkerStep(stepBase({ outputContract: "memo" })),
    isCode("ORCH_INVALID_PLAN"),
  );
});

test("validatePlanShape requires at least one step", () => {
  assert.throws(
    () => validatePlanShape({ mode: "single_worker", workerSteps: [] }),
    isCode("ORCH_INVALID_PLAN"),
  );
});

test("validateWorkerTopology rejects cycles and orders ready steps", () => {
  const planner = stepBase({ id: "plan", role: "planner" });
  const coder = stepBase({ id: "code", dependsOn: ["plan"] });
  const reviewer = stepBase({
    id: "review",
    role: "reviewer",
    dependsOn: ["code"],
  });
  assert.deepEqual(
    orderWorkerStepsByDependencies([reviewer, coder, planner]).map((s) => s.id),
    ["plan", "code", "review"],
  );
  assert.throws(
    () =>
      validateWorkerTopology([
        stepBase({ id: "a", dependsOn: ["b"] }),
        stepBase({ id: "b", dependsOn: ["a"] }),
      ]),
    isCode("ORCH_INVALID_PLAN"),
  );
});

test("isActionAllowedForWorkerStep preserves legacy default and explicit lists", () => {
  assert.equal(
    isActionAllowedForWorkerStep(stepBase({ role: "coder" }), "file_write"),
    true,
  );
  assert.equal(
    isActionAllowedForWorkerStep(stepBase({ role: "reviewer" }), "shell"),
    true,
  );
  assert.equal(
    isActionAllowedForWorkerStep(
      stepBase({ role: "coder", allowedActions: ["shell"] }),
      "shell",
    ),
    true,
  );
});

test("single_worker mode allows exactly one step", () => {
  validatePlanShape({
    mode: "single_worker",
    workerSteps: [stepBase()],
  });
  assert.throws(
    () =>
      validatePlanShape({
        mode: "single_worker",
        workerSteps: [stepBase(), stepBase({ id: "stp_2" })],
      }),
    isCode("ORCH_INVALID_PLAN"),
  );
});

test("planner_worker requires planner + worker", () => {
  assert.throws(
    () =>
      validatePlanShape({
        mode: "planner_worker",
        workerSteps: [stepBase({ role: "planner" })],
      }),
    isCode("ORCH_INVALID_PLAN"),
  );
  validatePlanShape({
    mode: "planner_worker",
    workerSteps: [
      stepBase({ id: "stp_1", role: "planner" }),
      stepBase({ id: "stp_2", role: "coder" }),
    ],
  });
});
