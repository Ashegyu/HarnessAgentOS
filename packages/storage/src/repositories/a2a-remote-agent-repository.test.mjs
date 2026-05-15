import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import { SqliteA2ARemoteAgentRepository } from "./a2a-remote-agent-repository.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-a2a-"));
  return {
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
