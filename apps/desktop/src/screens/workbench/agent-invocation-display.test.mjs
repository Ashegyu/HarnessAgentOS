import assert from "node:assert/strict";
import test from "node:test";

import {
  describeAgentInvocationForDisplay,
  orderedAgentInvocationsForDisplay,
} from "./agent-invocation-display.ts";

const invocation = (overrides = {}) => ({
  id: "inv_1",
  taskRunId: "task_1",
  provider: "codex",
  model: "gpt-5",
  status: "succeeded",
  promptArtifactId: "art_prompt",
  createdAt: "2026-05-15T00:00:00.000Z",
  updatedAt: "2026-05-15T00:00:00.000Z",
  ...overrides,
});

const step = (overrides = {}) => ({
  id: "step_1",
  taskRunId: "task_1",
  index: 0,
  kind: "summarize",
  title: "Worker[Reviewer] 분석",
  status: "succeeded",
  ...overrides,
});

test("orders all active invocations oldest-first for transcript display", () => {
  const reviewer = invocation({
    id: "inv_reviewer",
    provider: "claude",
    model: "sonnet",
    createdAt: "2026-05-15T00:03:00.000Z",
  });
  const worker = invocation({
    id: "inv_worker",
    createdAt: "2026-05-15T00:02:00.000Z",
  });
  const planner = invocation({
    id: "inv_planner",
    createdAt: "2026-05-15T00:01:00.000Z",
  });

  const ordered = orderedAgentInvocationsForDisplay([
    reviewer,
    worker,
    planner,
  ]);

  assert.deepEqual(
    ordered.map((item) => item.id),
    ["inv_planner", "inv_worker", "inv_reviewer"],
  );
});

test("keeps previous agent answers instead of collapsing to the latest invocation", () => {
  const ordered = orderedAgentInvocationsForDisplay([
    invocation({
      id: "inv_latest",
      createdAt: "2026-05-15T00:02:00.000Z",
    }),
    invocation({
      id: "inv_previous",
      createdAt: "2026-05-15T00:01:00.000Z",
    }),
  ]);

  assert.equal(ordered.length, 2);
  assert.deepEqual(
    ordered.map((item) => item.id),
    ["inv_previous", "inv_latest"],
  );
});

test("describes an invocation with the concrete worker agent name from its step", () => {
  const display = describeAgentInvocationForDisplay(
    invocation({ id: "inv_reviewer", stepId: "step_reviewer" }),
    [
      step({
        id: "step_reviewer",
        title: "Worker[Reviewer] 구현 결과 검토",
      }),
    ],
  );

  assert.deepEqual(display, {
    agentName: "Reviewer",
    detail: "구현 결과 검토",
    providerLabel: "codex:gpt-5",
  });
});

test("falls back to provider and model when no step identifies the agent", () => {
  const display = describeAgentInvocationForDisplay(
    invocation({ provider: "claude", model: "sonnet" }),
    [],
  );

  assert.deepEqual(display, {
    agentName: "claude:sonnet",
    detail: "Agent invocation",
    providerLabel: "claude:sonnet",
  });
});
