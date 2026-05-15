import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentTopology } from "./agent-topology-model.ts";

const taskRun = (overrides = {}) => ({
  id: "task_1",
  threadId: "thread_1",
  userRequest: "에이전트 연결 상태를 보여줘",
  targetDir: "C:\\work",
  status: "running",
  createdAt: "2026-05-15T00:00:00.000Z",
  updatedAt: "2026-05-15T00:00:00.000Z",
  ...overrides,
});

const step = (overrides = {}) => ({
  id: "step_1",
  taskRunId: "task_1",
  index: 0,
  kind: "summarize",
  title: "Worker[Coder] 구현",
  status: "succeeded",
  ...overrides,
});

const invocation = (overrides = {}) => ({
  id: "inv_1",
  taskRunId: "task_1",
  stepId: "step_1",
  provider: "codex",
  model: "gpt-5",
  status: "succeeded",
  promptArtifactId: "art_prompt",
  createdAt: "2026-05-15T00:01:00.000Z",
  updatedAt: "2026-05-15T00:01:00.000Z",
  ...overrides,
});

const approval = (overrides = {}) => ({
  id: "appr_1",
  taskRunId: "task_1",
  checkpointId: "cp_1",
  actionType: "shell",
  actionSummary: "npm run build",
  status: "pending",
  ...overrides,
});

test("builds a chronological local agent chain with animated running edge", () => {
  const graph = buildAgentTopology({
    taskRun: taskRun(),
    steps: [
      step({ id: "step_coder", title: "Worker[Coder] 구현" }),
      step({
        id: "step_reviewer",
        index: 1,
        title: "Worker[Reviewer] 검토",
        status: "running",
      }),
    ],
    invocations: [
      invocation({
        id: "inv_reviewer",
        stepId: "step_reviewer",
        status: "running",
        createdAt: "2026-05-15T00:02:00.000Z",
      }),
      invocation({
        id: "inv_coder",
        stepId: "step_coder",
        createdAt: "2026-05-15T00:01:00.000Z",
      }),
    ],
    approvals: [],
    remoteTaskRefs: [],
  });

  assert.deepEqual(
    graph.nodes.map((node) => [node.id, node.kind, node.label, node.status]),
    [
      ["request:task_1", "request", "User Request", "running"],
      ["agent:inv_coder", "agent", "Coder", "succeeded"],
      ["agent:inv_reviewer", "agent", "Reviewer", "running"],
    ],
  );
  assert.deepEqual(
    graph.edges.map((edge) => [
      edge.source,
      edge.target,
      edge.kind,
      edge.status,
      edge.animated,
    ]),
    [
      ["request:task_1", "agent:inv_coder", "starts", "succeeded", false],
      ["agent:inv_coder", "agent:inv_reviewer", "handoff", "running", true],
    ],
  );
  assert.deepEqual(graph.summary, {
    active: 1,
    waiting: 0,
    failed: 0,
    remote: 0,
    completed: 1,
  });
});

test("uses concrete agent names as visible graph labels", () => {
  const graph = buildAgentTopology({
    taskRun: taskRun(),
    steps: [step({ id: "step_coder", title: "Worker[Coder] 구현" })],
    invocations: [
      invocation({
        id: "inv_coder",
        stepId: "step_coder",
      }),
    ],
    approvals: [],
    remoteTaskRefs: [],
  });

  assert.equal(
    graph.nodes.find((node) => node.id === "agent:inv_coder")?.displayLabel,
    "Coder",
  );
});

test("adds waiting approval and remote A2A attention nodes", () => {
  const graph = buildAgentTopology({
    taskRun: taskRun({ status: "waiting_for_approval" }),
    steps: [step()],
    invocations: [invocation()],
    approvals: [approval()],
    remoteTaskRefs: [
      {
        invocationId: "inv_1",
        endpointId: "endpoint_1",
        remoteTaskId: "remote_1",
        state: "input-required",
        lastEventAt: "2026-05-15T00:03:00.000Z",
      },
    ],
  });

  assert.deepEqual(
    graph.nodes.map((node) => [node.id, node.kind, node.label, node.status]),
    [
      ["request:task_1", "request", "User Request", "waiting"],
      ["agent:inv_1", "agent", "Coder", "succeeded"],
      ["remote:inv_1", "remote", "A2A endpoint_1", "waiting"],
      ["approval:appr_1", "approval", "shell", "waiting"],
    ],
  );
  assert.deepEqual(
    graph.edges.map((edge) => [edge.source, edge.target, edge.kind, edge.status]),
    [
      ["request:task_1", "agent:inv_1", "starts", "succeeded"],
      ["agent:inv_1", "remote:inv_1", "remote", "waiting"],
      ["agent:inv_1", "approval:appr_1", "approval", "waiting"],
    ],
  );
  assert.deepEqual(graph.summary, {
    active: 0,
    waiting: 2,
    failed: 0,
    remote: 1,
    completed: 1,
  });
});
