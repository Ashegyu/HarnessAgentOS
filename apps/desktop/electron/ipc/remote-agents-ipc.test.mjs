import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDb,
  openDb,
  SqliteA2ARemoteAgentRepository,
} from "@harness/storage";
import { buildRemoteAgentsHandlers } from "./remote-agents-ipc.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-remote-agents-ipc-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const endpoint = (overrides = {}) => ({
  name: "Remote Reviewer",
  baseUrl: "https://agents.example.com/reviewer",
  agentCardUrl: "https://agents.example.com/reviewer/.well-known/agent-card.json",
  preferredTransport: "json-rpc",
  enabled: true,
  trusted: false,
  ...overrides,
});

const card = (endpointId) => ({
  endpointId,
  protocolVersion: "0.3.0",
  agentName: "Remote Reviewer",
  description: "Reviews code changes",
  version: "1.0.0",
  skills: [{ id: "review", name: "Review", description: "", tags: ["code"] }],
  inputModes: ["text/plain"],
  outputModes: ["text/plain"],
  capabilities: { streaming: true },
  fetchedAt: "2026-05-15T00:00:00.000Z",
  rawCardJson: JSON.stringify({ name: "Remote Reviewer" }),
});

const setup = (file) => {
  const db = openDb({ filePath: file });
  return {
    db,
    handlers: buildRemoteAgentsHandlers({
      remoteAgents: new SqliteA2ARemoteAgentRepository(db),
    }),
  };
};

test("remoteAgents.list returns ok([]) on a fresh DB", async () => {
  const t = tmp();
  const { db, handlers } = setup(t.file);
  try {
    const r = await handlers.list();
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, []);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("remoteAgents.upsertEndpoint creates an endpoint and list attaches card snapshots", async () => {
  const t = tmp();
  const { db, handlers } = setup(t.file);
  try {
    const created = await handlers.upsertEndpoint({ endpoint: endpoint() });
    assert.equal(created.ok, true);
    assert.ok(created.value.id.startsWith("a2a_"));

    const savedCard = await handlers.upsertCardSnapshot({
      snapshot: card(created.value.id),
    });
    assert.equal(savedCard.ok, true);

    const listed = await handlers.list();
    assert.equal(listed.ok, true);
    assert.equal(listed.value.length, 1);
    assert.equal(listed.value[0].endpoint.id, created.value.id);
    assert.equal(listed.value[0].card.agentName, "Remote Reviewer");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("remoteAgents.upsertEndpoint rejects invalid transports", async () => {
  const t = tmp();
  const { db, handlers } = setup(t.file);
  try {
    const r = await handlers.upsertEndpoint({
      endpoint: endpoint({ preferredTransport: "websocket" }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "STATE_INVALID_INPUT");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("remoteAgents.toggle returns A2A_ENDPOINT_NOT_FOUND for unknown endpoint", async () => {
  const t = tmp();
  const { db, handlers } = setup(t.file);
  try {
    const r = await handlers.toggle({ endpointId: "a2a_missing", enabled: false });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "A2A_ENDPOINT_NOT_FOUND");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
