import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveA2ARefinementProposals } from "./a2a-refinement-proposals.ts";

const now = "2026-05-20T00:00:00.000Z";

const taskRun = {
  id: "tsk_1",
  threadId: "thr_1",
  userRequest: "implement feature",
  targetDir: process.cwd(),
  status: "quality_failed",
  createdAt: now,
  updatedAt: now,
};

const endpoint = {
  id: "a2a_1",
  name: "Remote Coder",
  baseUrl: "https://agents.example.com/coder",
  agentCardUrl: "https://agents.example.com/coder/.well-known/agent-card.json",
  preferredTransport: "json-rpc",
  enabled: true,
  trusted: true,
  createdAt: now,
  updatedAt: now,
};

const planArtifact = {
  id: "art_plan",
  taskRunId: "tsk_1",
  kind: "orchestration_plan",
  title: "Orchestration plan",
  uri: "harness:orchestration/tsk_1/plan_1",
  createdAt: now,
  summary: [
    "# plan",
    "",
    "```json",
    JSON.stringify({
      id: "plan_1",
      mode: "multi_worker",
      workerSteps: [
        {
          id: "code",
          title: "Remote implementation",
          role: "coder",
          inputSummary: "implement",
          expectedArtifactKinds: ["log"],
          remoteEndpointId: "a2a_1",
          outputContract: "diff_proposal",
        },
        {
          id: "review",
          title: "Review result",
          role: "reviewer",
          inputSummary: "review",
          expectedArtifactKinds: ["quality_report"],
          dependsOn: ["code"],
          outputContract: "review",
        },
      ],
    }),
    "```",
  ].join("\n"),
};

const codeArtifact = {
  id: "art_code",
  taskRunId: "tsk_1",
  stepId: "step_code",
  kind: "log",
  title: "Worker output: Remote implementation",
  uri: "harness:orchestration/plan_1/code",
  summary: "Remote implementation output",
  createdAt: now,
};

const reviewArtifact = {
  id: "art_review",
  taskRunId: "tsk_1",
  stepId: "step_review",
  kind: "log",
  title: "Worker output: Review result",
  uri: "harness:orchestration/plan_1/review",
  summary: "Reviewer found that acceptance criteria are missing.",
  createdAt: now,
};

const codeStep = {
  id: "step_code",
  taskRunId: "tsk_1",
  index: 1,
  kind: "summarize",
  title: "Worker[Remote Coder -> Remote Coder] Remote implementation",
  status: "succeeded",
};

const reviewStep = {
  id: "step_review",
  taskRunId: "tsk_1",
  index: 2,
  kind: "summarize",
  title: "Worker[Reviewer] Review result",
  status: "succeeded",
};

const codeInvocation = {
  id: "ainv_code",
  taskRunId: "tsk_1",
  stepId: "step_code",
  provider: "codex",
  model: "a2a:a2a_1",
  status: "succeeded",
  promptArtifactId: "art_prompt_code",
  rawOutputArtifactId: "art_code",
  createdAt: now,
  updatedAt: now,
};

const reviewInvocation = {
  id: "ainv_review",
  taskRunId: "tsk_1",
  stepId: "step_review",
  provider: "codex",
  model: "gpt-5.6-sol",
  status: "succeeded",
  promptArtifactId: "art_prompt_review",
  rawOutputArtifactId: "art_review",
  createdAt: now,
  updatedAt: now,
};

const remoteTaskRef = {
  invocationId: "ainv_code",
  endpointId: "a2a_1",
  remoteTaskId: "remote-task-code",
  remoteContextId: "remote-context-code",
  state: "completed",
  lastEventAt: now,
};

test("deriveA2ARefinementProposals creates worker feedback proposals for reviewer/tester findings", () => {
  const proposals = deriveA2ARefinementProposals({
    taskRun,
    steps: [codeStep, reviewStep],
    artifacts: [planArtifact, codeArtifact, reviewArtifact],
    qualityGates: [],
    agentInvocations: [codeInvocation, reviewInvocation],
    a2aRemoteTaskRefs: [remoteTaskRef],
    a2aRefinementAttempts: [],
    a2aEndpoints: [endpoint],
  });

  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].sourceKind, "worker_finding");
  assert.equal(proposals[0].feedbackSourceKind, "worker");
  assert.equal(proposals[0].targetInvocationId, "ainv_code");
  assert.equal(proposals[0].feedbackSourceStepId, "step_review");
  assert.equal(proposals[0].feedbackSourceInvocationId, "ainv_review");
  assert.equal(proposals[0].feedbackArtifactId, "art_review");
  assert.deepEqual(proposals[0].referencedArtifactIds, ["art_review", "art_code"]);
  assert.match(proposals[0].instruction, /acceptance criteria/);
});

test("deriveA2ARefinementProposals creates quality gate proposals only when evidence maps to a remote invocation", () => {
  const proposals = deriveA2ARefinementProposals({
    taskRun,
    steps: [codeStep],
    artifacts: [planArtifact, codeArtifact],
    qualityGates: [
      {
        id: "qg_1",
        taskRunId: "tsk_1",
        status: "failed",
        knownRisks: ["tests failed"],
        evidenceArtifactIds: ["art_code"],
        createdAt: now,
      },
      {
        id: "qg_2",
        taskRunId: "tsk_1",
        status: "passed",
        knownRisks: [],
        evidenceArtifactIds: ["art_code"],
        createdAt: now,
      },
    ],
    agentInvocations: [codeInvocation],
    a2aRemoteTaskRefs: [remoteTaskRef],
    a2aRefinementAttempts: [],
    a2aEndpoints: [endpoint],
  });

  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].sourceKind, "quality_gate");
  assert.equal(proposals[0].feedbackSourceKind, "quality_gate");
  assert.equal(proposals[0].qualityGateId, "qg_1");
  assert.equal(proposals[0].feedbackArtifactId, "art_code");
  assert.equal(proposals[0].targetInvocationId, "ainv_code");
  assert.match(proposals[0].instruction, /tests failed/);
});
