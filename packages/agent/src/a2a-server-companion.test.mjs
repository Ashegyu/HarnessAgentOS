import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { ClientFactory } from "@a2a-js/sdk/client";
import { createA2AServerGateway } from "./a2a-server-gateway.ts";
import { createA2ACompanionServer } from "./a2a-server-companion.ts";

const targetRoot = resolve("C:/tmp/harness-a2a-ops");

const messageSendBody = () => ({
  jsonrpc: "2.0",
  id: "ops-1",
  method: "message/send",
  params: {
    message: {
      kind: "message",
      messageId: "msg-ops-1",
      role: "user",
      parts: [{ kind: "text", text: "Run operational smoke." }],
    },
    metadata: { targetDir: targetRoot },
  },
});

const makeGateway = (events = [], handlerInputs = []) =>
  createA2AServerGateway({
    enabled: () => true,
    expectedBearerToken: () => "ops-token",
    allowedWorkspaceRoots: [targetRoot],
    audit: (event) => events.push(event),
    now: () => "2026-05-15T00:00:00.000Z",
    createTaskId: () => "task-ops-1",
    handleMessage: async (input) => {
      handlerInputs.push(input);
      return {
        state: "completed",
        text: `accepted: ${input.message}`,
      };
    },
  });

test("A2A companion serves an Agent Card and accepts SDK message/send over loopback", async () => {
  const events = [];
  const handlerInputs = [];
  const companion = createA2ACompanionServer({
    host: "127.0.0.1",
    port: 0,
    gateway: makeGateway(events, handlerInputs),
    card: {
      name: "Harness Ops Agent",
      description: "Operational smoke companion for HarnessAgentOS.",
      version: "0.0.0-ops",
      skills: [
        {
          id: "ops-smoke",
          name: "Ops Smoke",
          description: "Runs local operational smoke checks.",
          tags: ["ops", "smoke"],
        },
      ],
    },
  });

  const running = await companion.start();
  try {
    assert.match(running.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(
      running.agentCardUrl,
      `${running.baseUrl}/.well-known/agent-card.json`,
    );
    assert.equal(running.jsonRpcUrl, `${running.baseUrl}/a2a/jsonrpc`);

    const cardResponse = await fetch(running.agentCardUrl);
    assert.equal(cardResponse.status, 200);
    const card = await cardResponse.json();
    assert.equal(card.name, "Harness Ops Agent");
    assert.equal(card.protocolVersion, "0.3.0");
    assert.equal(card.url, running.jsonRpcUrl);
    assert.deepEqual(card.defaultInputModes, ["text"]);
    assert.deepEqual(card.defaultOutputModes, ["text"]);
    assert.deepEqual(card.capabilities, {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    });
    assert.deepEqual(card.additionalInterfaces, [
      { url: running.jsonRpcUrl, transport: "JSONRPC" },
    ]);

    const client = await new ClientFactory().createFromUrl(
      running.baseUrl,
      "/.well-known/agent-card.json",
    );
    const result = await client.sendMessage(messageSendBody().params, {
      serviceParameters: { Authorization: "Bearer ops-token" },
    });

    assert.equal(result.kind, "task");
    assert.equal(result.id, "task-ops-1");
    assert.equal(result.status.state, "completed");
    assert.equal(
      result.status.message.parts[0].text,
      "accepted: Run operational smoke.",
    );
    assert.equal(handlerInputs.length, 1);
    assert.equal(handlerInputs[0].remoteAddress, "127.0.0.1");
    assert.equal(events.at(-1).decision, "accepted");
  } finally {
    await running.close();
  }
});

test("A2A companion rejects unauthenticated JSON-RPC before invoking work", async () => {
  const handlerInputs = [];
  const companion = createA2ACompanionServer({
    host: "127.0.0.1",
    port: 0,
    gateway: makeGateway([], handlerInputs),
    card: { name: "Harness Ops Agent" },
  });

  const running = await companion.start();
  try {
    const response = await fetch(running.jsonRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(messageSendBody()),
    });
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.equal(body.error.code, "A2A_SERVER_UNAUTHORIZED");
    assert.equal(handlerInputs.length, 0);
  } finally {
    await running.close();
  }
});

test("A2A companion rejects oversized bodies before parsing or invoking work", async () => {
  const handlerInputs = [];
  const companion = createA2ACompanionServer({
    host: "127.0.0.1",
    port: 0,
    maxBodyBytes: 16,
    gateway: makeGateway([], handlerInputs),
    card: { name: "Harness Ops Agent" },
  });

  const running = await companion.start();
  try {
    const response = await fetch(running.jsonRpcUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer ops-token",
      },
      body: JSON.stringify(messageSendBody()),
    });
    const body = await response.json();

    assert.equal(response.status, 413);
    assert.equal(body.error.code, "A2A_COMPANION_BODY_TOO_LARGE");
    assert.equal(handlerInputs.length, 0);
  } finally {
    await running.close();
  }
});
