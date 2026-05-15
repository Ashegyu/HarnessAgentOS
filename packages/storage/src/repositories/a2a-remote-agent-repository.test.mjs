import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import { LocalStateService } from "../services/local-state-service.ts";
import { SqliteA2ARemoteAgentRepository } from "./a2a-remote-agent-repository.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-a2a-"));
  return {
    dir,
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const makeEndpoint = (overrides = {}) => ({
  name: "Remote Reviewer",
  baseUrl: "https://agents.example.com/reviewer",
  agentCardUrl: "https://agents.example.com/reviewer/.well-known/agent-card.json",
  preferredTransport: "json-rpc",
  enabled: true,
  trusted: false,
  ...overrides,
});

const makeCard = (endpointId) => ({
  endpointId,
  protocolVersion: "0.3.0",
  agentName: "Remote Reviewer",
  description: "Reviews repository changes",
  version: "1.2.3",
  skills: [
    {
      id: "review",
      name: "Code review",
      description: "Finds correctness and maintainability risks",
      tags: ["review", "code"],
    },
  ],
  inputModes: ["text/plain"],
  outputModes: ["text/plain", "application/json"],
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: true,
  },
  fetchedAt: "2026-05-15T00:00:00.000Z",
  etag: "\"card-v1\"",
  rawCardJson: JSON.stringify({ name: "Remote Reviewer" }),
});

const seedInvocation = async (state, targetDir) => {
  const thread = await state.createThread({ title: "A2A test" });
  const taskRun = await state.createTaskRun({
    threadId: thread.id,
    userRequest: "Ask remote reviewer",
    targetDir,
  });
  const prompt = await state.createArtifact({
    taskRunId: taskRun.id,
    kind: "log",
    title: "Remote prompt",
    uri: `harness:test-prompt/${taskRun.id}`,
    summary: "prompt",
  });
  return state.createAgentInvocation({
    taskRunId: taskRun.id,
    provider: "codex",
    model: "gpt-5.5",
    promptArtifactId: prompt.id,
  });
};

test("A2ARemoteAgentRepository.listEndpoints returns [] on an empty DB", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteA2ARemoteAgentRepository(db);
    assert.deepEqual(await repo.listEndpoints(), []);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("A2ARemoteAgentRepository.upsertEndpoint creates and updates an endpoint", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteA2ARemoteAgentRepository(db);
    const created = await repo.upsertEndpoint(makeEndpoint());
    assert.ok(created.id.startsWith("a2a_"));
    assert.equal(created.enabled, true);
    assert.equal(created.trusted, false);
    assert.equal(created.createdAt, created.updatedAt);

    await new Promise((r) => setTimeout(r, 5));
    const updated = await repo.upsertEndpoint({
      ...created,
      name: "Remote Reviewer Updated",
      trusted: true,
    });
    assert.equal(updated.id, created.id);
    assert.equal(updated.name, "Remote Reviewer Updated");
    assert.equal(updated.trusted, true);
    assert.equal(updated.createdAt, created.createdAt);
    assert.notEqual(updated.updatedAt, created.updatedAt);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("A2ARemoteAgentRepository stores and replaces Agent Card snapshots", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteA2ARemoteAgentRepository(db);
    const endpoint = await repo.upsertEndpoint(makeEndpoint());
    const stored = await repo.upsertCardSnapshot(makeCard(endpoint.id));
    assert.equal(stored.endpointId, endpoint.id);
    assert.equal(stored.agentName, "Remote Reviewer");
    assert.deepEqual(stored.inputModes, ["text/plain"]);
    assert.equal(stored.capabilities.streaming, true);
    assert.equal(stored.skills[0].tags[1], "code");

    const replaced = await repo.upsertCardSnapshot({
      ...stored,
      version: "1.2.4",
      etag: "\"card-v2\"",
    });
    assert.equal(replaced.version, "1.2.4");
    assert.equal(replaced.etag, "\"card-v2\"");
    const fetched = await repo.getCardSnapshot(endpoint.id);
    assert.equal(fetched.version, "1.2.4");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("A2ARemoteAgentRepository.toggleEndpoint flips enabled", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteA2ARemoteAgentRepository(db);
    const endpoint = await repo.upsertEndpoint(makeEndpoint({ enabled: true }));
    const disabled = await repo.toggleEndpoint(endpoint.id, false);
    assert.equal(disabled.enabled, false);
    const enabled = await repo.toggleEndpoint(endpoint.id, true);
    assert.equal(enabled.enabled, true);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("A2ARemoteAgentRepository.deleteEndpoint cascades card snapshot", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteA2ARemoteAgentRepository(db);
    const endpoint = await repo.upsertEndpoint(makeEndpoint());
    await repo.upsertCardSnapshot(makeCard(endpoint.id));
    await repo.deleteEndpoint(endpoint.id);
    assert.equal(await repo.getEndpoint(endpoint.id), null);
    assert.equal(await repo.getCardSnapshot(endpoint.id), null);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("A2ARemoteAgentRepository stores and updates remote task refs", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const repo = new SqliteA2ARemoteAgentRepository(db);
    const endpoint = await repo.upsertEndpoint(makeEndpoint());
    const invocation = await seedInvocation(state, t.dir);

    const stored = await repo.upsertRemoteTaskRef({
      invocationId: invocation.id,
      endpointId: endpoint.id,
      remoteTaskId: "remote-task-1",
      remoteContextId: "remote-context-1",
      state: "submitted",
      lastEventAt: "2026-05-15T00:00:00.000Z",
    });
    assert.deepEqual(stored, {
      invocationId: invocation.id,
      endpointId: endpoint.id,
      remoteTaskId: "remote-task-1",
      remoteContextId: "remote-context-1",
      state: "submitted",
      lastEventAt: "2026-05-15T00:00:00.000Z",
    });

    const updated = await repo.upsertRemoteTaskRef({
      invocationId: invocation.id,
      endpointId: endpoint.id,
      remoteTaskId: "remote-task-1",
      remoteContextId: "remote-context-1",
      state: "completed",
      lastEventAt: "2026-05-15T00:01:00.000Z",
    });
    assert.equal(updated.state, "completed");
    assert.equal(updated.lastEventAt, "2026-05-15T00:01:00.000Z");
    assert.deepEqual(await repo.getRemoteTaskRef(invocation.id), updated);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("A2ARemoteAgentRepository lists remote task refs by endpoint and cascades endpoint delete", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const repo = new SqliteA2ARemoteAgentRepository(db);
    const endpoint = await repo.upsertEndpoint(makeEndpoint());
    const invocation = await seedInvocation(state, t.dir);
    await repo.upsertRemoteTaskRef({
      invocationId: invocation.id,
      endpointId: endpoint.id,
      remoteTaskId: "remote-task-2",
      state: "working",
      lastEventAt: "2026-05-15T00:02:00.000Z",
    });

    const refs = await repo.listRemoteTaskRefsByEndpoint(endpoint.id);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].invocationId, invocation.id);
    assert.equal(refs[0].state, "working");

    await repo.deleteEndpoint(endpoint.id);
    assert.equal(await repo.getRemoteTaskRef(invocation.id), null);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
