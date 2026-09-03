import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

globalThis.React = React;
const { AgentPanel } = await import("./AgentPanel.tsx");

const now = "2026-05-18T00:00:00.000Z";

const invocation = (id, createdAt, stepId) => ({
  id,
  taskRunId: "task_1",
  provider: "codex",
  model: "gpt-5.6-sol",
  status: "running",
  promptArtifactId: `prompt_${id}`,
  stepId,
  createdAt,
  updatedAt: createdAt,
});

const step = (id, title, index) => ({
  id,
  taskRunId: "task_1",
  index,
  kind: "summarize",
  title,
  status: "running",
});

const taskRun = {
  id: "task_1",
  threadId: "thread_1",
  userRequest: "run workers",
  targetDir: process.cwd(),
  status: "running",
  createdAt: now,
  updatedAt: now,
};

test("AgentPanel renders parallel invocations in one stable stack", () => {
  const html = renderToStaticMarkup(
    React.createElement(AgentPanel, {
      taskRun,
      invocations: [
        invocation("inv_c", "2026-05-18T00:00:03.000Z", "step_c"),
        invocation("inv_a", "2026-05-18T00:00:01.000Z", "step_a"),
        invocation("inv_b", "2026-05-18T00:00:02.000Z", "step_b"),
      ],
      steps: [
        step("step_a", "Worker[Planner] 계획", 0),
        step("step_b", "Worker[Reviewer] 검토", 1),
        step("step_c", "Worker[Tester] 테스트", 2),
      ],
      artifacts: [],
      remoteTaskRefs: [],
      onRetry: async () => {},
      onCancel: async () => {},
      onUseFallback: async () => {},
      onGenerate: async () => {},
      agentAvailable: true,
      pendingAdvisoryApprovals: 0,
      orchestrationDriven: true,
    }),
  );

  assert.equal((html.match(/class="agent-panel__stream"/g) ?? []).length, 3);
  assert.match(html, /Planner/);
  assert.match(html, /Reviewer/);
  assert.match(html, /Tester/);
  assert.doesNotMatch(html, /이전 Agent 응답/);
});

test("AgentPanel renders pipeline backflow attempt route details", () => {
  const html = renderToStaticMarkup(
    React.createElement(AgentPanel, {
      taskRun,
      invocations: [invocation("inv_a", "2026-05-18T00:00:01.000Z", "step_a")],
      steps: [step("step_a", "Worker[Coder] 구현", 0)],
      artifacts: [],
      remoteTaskRefs: [],
      refinementAttempts: [],
      pipelineBackflowAttempts: [
        {
          id: "pbf_1",
          taskRunId: "task_1",
          planId: "orch_1",
          ruleId: "bf_rule_1",
          trigger: "step_failed",
          targetStepId: "worker_plan",
          retryStepId: "worker_code",
          maxAttempts: 2,
          attemptIndex: 0,
          status: "succeeded",
          reason: "Worker step failed: Coder",
          createdAt: now,
          updatedAt: now,
          completedAt: now,
        },
      ],
      onRetry: async () => {},
      onCancel: async () => {},
      onUseFallback: async () => {},
      onGenerate: async () => {},
      agentAvailable: true,
      pendingAdvisoryApprovals: 0,
      orchestrationDriven: true,
    }),
  );

  assert.match(html, /Pipeline backflow/);
  assert.match(html, /bf_rule_1/);
  assert.match(html, /worker_plan/);
  assert.match(html, /worker_code/);
  assert.match(html, /attempt 1\/2/);
});
