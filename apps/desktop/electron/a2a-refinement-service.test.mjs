import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, LocalStateService } from "@harness/storage";
import { createA2ARefinementService } from "./a2a-refinement-service.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-a2a-refinement-service-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const seedAttempt = async (state) => {
  const thread = await state.createThread({ title: "a2a refinement service" });
  const taskRun = await state.createTaskRun({
    threadId: thread.id,
    userRequest: "refine previous remote result",
    targetDir: process.cwd(),
  });
  const endpoint = await state.a2aRemoteAgents.upsertEndpoint({
    name: "Remote Reviewer",
    baseUrl: "https://agents.example.com/reviewer",
    agentCardUrl: "https://agents.example.com/reviewer/.well-known/agent-card.json",
    preferredTransport: "json-rpc",
    enabled: true,
    trusted: true,
  });
  const prompt = await state.createArtifact({
    taskRunId: taskRun.id,
    kind: "log",
    title: "original prompt",
    uri: "harness:test-original-prompt",
    summary: "original prompt",
  });
  const evidence = await state.createArtifact({
    taskRunId: taskRun.id,
    kind: "quality_report",
    title: "review finding",
    uri: "harness:test-review-finding",
    summary: "The acceptance criteria are missing.",
  });
  const targetInvocation = await state.createAgentInvocation({
    taskRunId: taskRun.id,
    provider: "codex",
    model: `a2a:${endpoint.id}`,
    promptArtifactId: prompt.id,
  });
  await state.a2aRemoteAgents.upsertRemoteTaskRef({
    invocationId: targetInvocation.id,
    endpointId: endpoint.id,
    remoteTaskId: "remote-task-original",
    remoteContextId: "remote-context-original",
    state: "completed",
  });
  const attempt = await state.a2aRefinements.create({
    taskRunId: taskRun.id,
    targetInvocationId: targetInvocation.id,
    endpointId: endpoint.id,
    feedbackSourceKind: "worker",
    feedbackArtifactId: evidence.id,
    parentRemoteTaskId: "remote-task-original",
    parentRemoteContextId: "remote-context-original",
    referenceTaskIds: ["remote-task-original"],
    referenceArtifactIds: [evidence.id],
    feedbackSignature: "sig-refinement-service",
  });
  return { taskRun, endpoint, targetInvocation, evidence, attempt };
};

test("A2ARefinementService runs an approved attempt as a new A2A invocation", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const { taskRun, endpoint, attempt, evidence } = await seedAttempt(state);
    const requests = [];
    const adapter = {
      async invoke(request, onEvent) {
        requests.push(request);
        onEvent({
          type: "progress",
          invocationId: request.invocationId,
          taskRunId: request.taskRunId,
          stage: "complete",
          message: "remote refinement complete",
          at: "2026-05-20T00:00:00.000Z",
        });
        return {
          outputText: "Refined remote answer.",
          remoteTask: {
            invocationId: request.invocationId,
            endpointId: request.endpointId,
            remoteTaskId: "remote-task-refined",
            remoteContextId: "remote-context-original",
            state: "completed",
            lastEventAt: "2026-05-20T00:00:00.000Z",
          },
          artifacts: [],
          normalizedEvents: [],
          requiresInput: false,
          requiresAuth: false,
        };
      },
    };
    const service = createA2ARefinementService({
      state,
      endpoint,
      adapter,
      now: () => "2026-05-20T00:00:00.000Z",
      createArtifactUriNonce: () => "nonce",
    });

    const result = await service.runApprovedAttempt({
      attemptId: attempt.id,
      instruction: "Please add acceptance criteria.",
    });

    assert.equal(result.attempt.status, "succeeded");
    assert.equal(result.attempt.remoteTaskId, "remote-task-refined");
    assert.equal(result.invocation.model, `a2a:${endpoint.id}`);
    assert.deepEqual(requests[0], {
      invocationId: result.invocation.id,
      taskRunId: taskRun.id,
      endpointId: endpoint.id,
      message: "Please add acceptance criteria.",
      contextId: "remote-context-original",
      referenceTaskIds: ["remote-task-original"],
      metadata: {
        harness: {
          refinementAttemptId: attempt.id,
          targetInvocationId: attempt.targetInvocationId,
          referenceArtifactIds: [evidence.id],
        },
      },
    });

    const remoteTask = await state.a2aRemoteAgents.getRemoteTaskRef(
      result.invocation.id,
    );
    assert.equal(remoteTask.remoteTaskId, "remote-task-refined");
    const artifacts = await state.listArtifactsByTaskRun(taskRun.id);
    assert.ok(
      artifacts.some((artifact) => artifact.title === "A2A refinement prompt"),
    );
    assert.ok(
      artifacts.some(
        (artifact) => artifact.title === "A2A refinement raw output",
      ),
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
