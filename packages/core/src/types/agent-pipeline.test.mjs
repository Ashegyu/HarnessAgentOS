import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PIPELINE_STEPS,
  isAgentPipeline,
  isAgentPipelineStep,
} from "./agent-pipeline.ts";

const VALID_STEP = {
  id: "step_01",
  agentProfileId: "agentProfile_abc",
  title: "Plan the change",
  instruction: "Outline the steps to implement feature X.",
  expectedArtifactKinds: ["plan"],
};

const VALID_PIPELINE = {
  id: "pipeline_01",
  name: "Backend Feature Flow",
  description: "Plan → Code → Review",
  steps: [VALID_STEP],
  createdAt: "2026-05-12T00:00:00.000Z",
  updatedAt: "2026-05-12T00:00:00.000Z",
};

test("MAX_PIPELINE_STEPS is a positive integer cap", () => {
  assert.equal(typeof MAX_PIPELINE_STEPS, "number");
  assert.ok(MAX_PIPELINE_STEPS >= 1);
});

test("isAgentPipelineStep accepts a well-formed step", () => {
  assert.equal(isAgentPipelineStep(VALID_STEP), true);
});

test("isAgentPipelineStep rejects missing agentProfileId", () => {
  const { agentProfileId: _ignored, ...rest } = VALID_STEP;
  void _ignored;
  assert.equal(isAgentPipelineStep(rest), false);
});

test("isAgentPipelineStep rejects empty title", () => {
  assert.equal(isAgentPipelineStep({ ...VALID_STEP, title: "" }), false);
});

test("isAgentPipelineStep rejects non-array expectedArtifactKinds", () => {
  assert.equal(
    isAgentPipelineStep({ ...VALID_STEP, expectedArtifactKinds: "plan" }),
    false,
  );
});

test("isAgentPipeline accepts a well-formed pipeline", () => {
  assert.equal(isAgentPipeline(VALID_PIPELINE), true);
});

test("isAgentPipeline rejects empty steps array — pipelines must have ≥1 step", () => {
  assert.equal(isAgentPipeline({ ...VALID_PIPELINE, steps: [] }), false);
});

test("isAgentPipeline rejects pipelines exceeding MAX_PIPELINE_STEPS", () => {
  const tooMany = Array.from({ length: MAX_PIPELINE_STEPS + 1 }, (_, i) => ({
    ...VALID_STEP,
    id: `s_${i}`,
  }));
  assert.equal(
    isAgentPipeline({ ...VALID_PIPELINE, steps: tooMany }),
    false,
  );
});

test("isAgentPipeline rejects when any step is malformed", () => {
  assert.equal(
    isAgentPipeline({
      ...VALID_PIPELINE,
      steps: [VALID_STEP, { ...VALID_STEP, agentProfileId: 42 }],
    }),
    false,
  );
});

test("isAgentPipeline rejects missing name", () => {
  assert.equal(isAgentPipeline({ ...VALID_PIPELINE, name: "" }), false);
});

test("isAgentPipeline rejects non-string ISO timestamps", () => {
  assert.equal(
    isAgentPipeline({ ...VALID_PIPELINE, createdAt: 0 }),
    false,
  );
});
