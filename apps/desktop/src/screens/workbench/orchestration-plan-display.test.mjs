import { test } from "node:test";
import assert from "node:assert/strict";
import { stripEmbeddedOrchestrationPlanJson } from "./orchestration-plan-display.ts";

test("stripEmbeddedOrchestrationPlanJson hides the recovery JSON block", () => {
  const content = [
    "# Orchestration plan",
    "",
    "## Steps",
    "",
    "1. **coder** — 분석",
    "   - inputs: 현재 프로젝트를 분석",
    "",
    "<!-- orchestration-plan:json -->",
    "```json",
    JSON.stringify({
      id: "lrn_1",
      workerSteps: [
        {
          inputSummary: "현재 프로젝트를 분석",
          instruction: "현재 프로젝트를 분석",
        },
      ],
    }),
    "```",
    "",
  ].join("\n");

  assert.equal(
    stripEmbeddedOrchestrationPlanJson(content),
    [
      "# Orchestration plan",
      "",
      "## Steps",
      "",
      "1. **coder** — 분석",
      "   - inputs: 현재 프로젝트를 분석",
    ].join("\n"),
  );
});

test("stripEmbeddedOrchestrationPlanJson leaves normal text unchanged", () => {
  const content = "# Plan\n\nNo embedded recovery payload.";
  assert.equal(stripEmbeddedOrchestrationPlanJson(content), content);
});
