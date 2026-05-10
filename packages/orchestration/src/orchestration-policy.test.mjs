import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertActionTypeAllowed,
  validatePlanShape,
  validateWorkerStep,
} from "./orchestration-policy.ts";

const stepBase = (overrides = {}) => ({
  id: overrides.id ?? "stp_1",
  title: overrides.title ?? "do",
  role: overrides.role ?? "coder",
  inputSummary: overrides.inputSummary ?? "x",
  expectedArtifactKinds: overrides.expectedArtifactKinds ?? ["plan"],
  status: overrides.status ?? "pending",
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

test("validatePlanShape requires at least one step", () => {
  assert.throws(
    () => validatePlanShape({ mode: "single_worker", workerSteps: [] }),
    isCode("ORCH_INVALID_PLAN"),
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
