import {
  A2AInvocationAdapter,
  OfficialA2AClientPort,
} from "../../../packages/agent/src/index.ts";
import { header, bootstrap, expect } from "./smoke-shared.mjs";

const remoteUrl = process.env.HARNESS_A2A_REMOTE_URL?.trim();
const bearerToken = process.env.HARNESS_A2A_BEARER_TOKEN?.trim();
const authSecretRef = process.env.HARNESS_A2A_AUTH_SECRET_REF?.trim();
const timeoutMs = Number(process.env.HARNESS_A2A_SMOKE_TIMEOUT_MS ?? 30_000);
const cancelAfterMs = Number(process.env.HARNESS_A2A_SMOKE_CANCEL_AFTER_MS ?? 0);
const message =
  process.env.HARNESS_A2A_SMOKE_MESSAGE?.trim() ??
  "HarnessAgentOS live outbound A2A smoke. Reply with a short acknowledgement.";

header("A2A remote live smoke");

if (!remoteUrl) {
  console.log("  SKIP  HARNESS_A2A_REMOTE_URL is not set");
  process.exit(0);
}

const ctx = bootstrap();

try {
  const endpoint = await ctx.state.a2aRemoteAgents.upsertEndpoint({
    name: "Live smoke A2A endpoint",
    baseUrl: remoteUrl,
    agentCardUrl:
      process.env.HARNESS_A2A_AGENT_CARD_URL?.trim() ??
      new URL("/.well-known/agent-card.json", remoteUrl).toString(),
    preferredTransport: "json-rpc",
    enabled: true,
    trusted: true,
    ...(authSecretRef ? { authSecretRef } : {}),
  });
  await refreshCardSnapshot(ctx, endpoint, bearerToken);

  const thread = await ctx.state.createThread({
    title: "a2a live smoke",
    targetDir: ctx.projectDir,
  });
  const taskRun = await ctx.state.createTaskRun({
    threadId: thread.id,
    userRequest: message,
    targetDir: ctx.projectDir,
  });
  const promptArtifact = await ctx.state.createArtifact({
    taskRunId: taskRun.id,
    kind: "log",
    title: "A2A live smoke prompt",
    uri: `harness:a2a-live-smoke/${taskRun.id}/prompt`,
    summary: redactToken(message, bearerToken),
  });
  const invocation = await ctx.state.createAgentInvocation({
    taskRunId: taskRun.id,
    provider: "codex",
    model: "a2a-remote",
    promptArtifactId: promptArtifact.id,
  });
  await ctx.state.updateAgentInvocation(invocation.id, {
    status: "running",
    startedAt: new Date().toISOString(),
  });

  const adapter = new A2AInvocationAdapter({
    client: new OfficialA2AClientPort({
      endpoint,
      timeoutMs,
    }),
  });

  if (cancelAfterMs > 0) {
    await runOptionalCancellationProbe(ctx, adapter, {
      invocationId: `${invocation.id}_cancel_probe`,
      taskRunId: taskRun.id,
      endpointId: endpoint.id,
      message,
      cancelAfterMs,
      bearerToken,
    });
  }

  const startedAt = Date.now();
  const events = [];
  const result = await adapter.invoke(
    {
      invocationId: invocation.id,
      taskRunId: taskRun.id,
      endpointId: endpoint.id,
      message,
    },
    (event) => events.push(event),
  );
  await ctx.state.a2aRemoteAgents.upsertRemoteTaskRef(result.remoteTask);
  const rawArtifact = await ctx.state.createArtifact({
    taskRunId: taskRun.id,
    kind: "log",
    title: "A2A live smoke output",
    uri: `harness:a2a-live-smoke/${taskRun.id}/output`,
    summary: redactToken(
      JSON.stringify({ outputText: result.outputText, events }, null, 2),
      bearerToken,
    ),
  });
  await ctx.state.updateAgentInvocation(invocation.id, {
    status: "succeeded",
    rawOutputArtifactId: rawArtifact.id,
    latencyMs: Date.now() - startedAt,
    finishedAt: new Date().toISOString(),
  });

  expect(result.remoteTask.state === "completed", "remote task completed");
  expect(Boolean(result.outputText), "remote output captured");
  console.log(`  INFO  db=${ctx.dbFile}`);
  console.log(`  INFO  artifact=${rawArtifact.id}`);
} catch (error) {
  console.error(`  FAIL  ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  ctx.cleanup();
}

async function refreshCardSnapshot(ctx, endpoint, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(endpoint.agentCardUrl, { headers });
  if (!response.ok) {
    console.log(`  WARN  agent card fetch failed: HTTP ${response.status}`);
    return;
  }
  const card = await response.json();
  await ctx.state.a2aRemoteAgents.upsertCardSnapshot({
    endpointId: endpoint.id,
    protocolVersion: stringOrUndefined(card.protocolVersion),
    agentName: String(card.name ?? card.agentName ?? "A2A remote agent"),
    description: stringOrUndefined(card.description),
    version: stringOrUndefined(card.version),
    skills: Array.isArray(card.skills)
      ? card.skills.map((skill, index) => ({
          id: String(skill.id ?? `skill-${index}`),
          name: String(skill.name ?? `Skill ${index + 1}`),
          description: String(skill.description ?? ""),
          tags: Array.isArray(skill.tags)
            ? skill.tags.filter((tag) => typeof tag === "string")
            : [],
        }))
      : [],
    inputModes: Array.isArray(card.defaultInputModes)
      ? card.defaultInputModes.filter((mode) => typeof mode === "string")
      : [],
    outputModes: Array.isArray(card.defaultOutputModes)
      ? card.defaultOutputModes.filter((mode) => typeof mode === "string")
      : [],
    capabilities:
      typeof card.capabilities === "object" && card.capabilities !== null
        ? {
            streaming: boolOrUndefined(card.capabilities.streaming),
            pushNotifications: boolOrUndefined(card.capabilities.pushNotifications),
            stateTransitionHistory: boolOrUndefined(card.capabilities.stateTransitionHistory),
          }
        : {},
    fetchedAt: new Date().toISOString(),
    rawCardJson: redactToken(JSON.stringify(card), token),
  });
  console.log("  PASS  agent card snapshot refreshed");
}

async function runOptionalCancellationProbe(ctx, adapter, input) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.cancelAfterMs);
  try {
    await adapter.invoke(
      {
        invocationId: input.invocationId,
        taskRunId: input.taskRunId,
        endpointId: input.endpointId,
        message: input.message,
      },
      () => {},
      controller.signal,
    );
    await ctx.state.createArtifact({
      taskRunId: input.taskRunId,
      kind: "log",
      title: "A2A cancellation probe",
      uri: `harness:a2a-live-smoke/${input.taskRunId}/cancel`,
      summary: "Cancellation probe completed before abort fired.",
    });
  } catch (error) {
    await ctx.state.createArtifact({
      taskRunId: input.taskRunId,
      kind: "log",
      title: "A2A cancellation probe",
      uri: `harness:a2a-live-smoke/${input.taskRunId}/cancel`,
      summary: redactToken(
        `Cancellation probe observed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        input.bearerToken,
      ),
    });
  } finally {
    clearTimeout(timer);
  }
}

function stringOrUndefined(value) {
  return typeof value === "string" ? value : undefined;
}

function boolOrUndefined(value) {
  return typeof value === "boolean" ? value : undefined;
}

function redactToken(value, token) {
  return token ? value.split(token).join("[REDACTED_A2A_TOKEN]") : value;
}
