import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import {
  createA2AServerGateway,
  createInMemoryRateLimiter,
} from "./a2a-server-gateway.ts";

const targetRoot = resolve("C:/workspace/project");

const messageRequest = (overrides = {}) => ({
  remoteAddress: "127.0.0.1",
  headers: { authorization: "Bearer server-token" },
  body: {
    jsonrpc: "2.0",
    id: "req-1",
    method: "message/send",
    params: {
      message: {
        kind: "message",
        role: "user",
        parts: [{ kind: "text", text: "Review this project" }],
      },
      metadata: {
        targetDir: targetRoot,
      },
    },
  },
  ...overrides,
});

const gateway = (overrides = {}) => {
  const audit = [];
  const handled = [];
  return {
    audit,
    handled,
    gateway: createA2AServerGateway({
      enabled: () => true,
      expectedBearerToken: () => "server-token",
      allowedWorkspaceRoots: [targetRoot],
      now: () => "2026-05-15T00:00:00.000Z",
      createTaskId: () => "task-a2a-1",
      audit: (event) => audit.push(event),
      handleMessage: async (input) => {
        handled.push(input);
        return {
          text: `accepted: ${input.message}`,
          state: "completed",
        };
      },
      ...overrides,
    }),
  };
};

test("A2A server gateway is feature-flagged off by default", async () => {
  const audit = [];
  const disabled = createA2AServerGateway({
    expectedBearerToken: () => "server-token",
    allowedWorkspaceRoots: [targetRoot],
    audit: (event) => audit.push(event),
    handleMessage: async () => ({ text: "should not run", state: "completed" }),
  });

  const response = await disabled.handle(messageRequest());

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "A2A_SERVER_DISABLED");
  assert.equal(audit[0].decision, "denied");
  assert.equal(audit[0].reason, "disabled");
});

test("A2A server gateway requires bearer auth before invoking work", async () => {
  const { gateway: gw, handled, audit } = gateway();

  const response = await gw.handle(messageRequest({ headers: {} }));

  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "A2A_SERVER_UNAUTHORIZED");
  assert.deepEqual(handled, []);
  assert.equal(audit[0].decision, "denied");
  assert.equal(audit[0].reason, "unauthorized");
});

test("A2A server gateway enforces per-client rate limits", async () => {
  const limiter = createInMemoryRateLimiter({
    maxRequests: 1,
    windowMs: 60_000,
    nowMs: () => 1_000,
  });
  const { gateway: gw, handled, audit } = gateway({ rateLimiter: limiter });

  const first = await gw.handle(messageRequest());
  const second = await gw.handle(messageRequest({ body: { ...messageRequest().body, id: "req-2" } }));

  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.equal(second.body.error.code, "A2A_SERVER_RATE_LIMITED");
  assert.equal(handled.length, 1);
  assert.equal(audit.at(-1).reason, "rate_limited");
});

test("A2A server gateway blocks targetDir outside allowed workspace roots", async () => {
  const { gateway: gw, handled, audit } = gateway();

  const response = await gw.handle(
    messageRequest({
      body: {
        ...messageRequest().body,
        params: {
          ...messageRequest().body.params,
          metadata: { targetDir: "C:/workspace/other-project" },
        },
      },
    }),
  );

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "A2A_SERVER_WORKSPACE_DENIED");
  assert.deepEqual(handled, []);
  assert.equal(audit[0].reason, "workspace_denied");
});

test("A2A server gateway blocks targetDir after realpath-style resolution", async () => {
  const linkPath = join(targetRoot, "link-out");
  const { gateway: gw, handled, audit } = gateway({
    resolveWorkspacePath: async (path) => {
      const normalized = resolve(path);
      if (normalized === resolve(linkPath)) {
        return resolve("C:/workspace/other-project");
      }
      return normalized;
    },
  });

  const response = await gw.handle(
    messageRequest({
      body: {
        ...messageRequest().body,
        params: {
          ...messageRequest().body.params,
          metadata: { targetDir: linkPath },
        },
      },
    }),
  );

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "A2A_SERVER_WORKSPACE_DENIED");
  assert.deepEqual(handled, []);
  assert.equal(audit[0].reason, "workspace_denied");
  assert.equal(audit[0].targetDir, resolve(linkPath));
});

test("A2A server gateway invokes handler and emits an accepted audit event", async () => {
  const { gateway: gw, handled, audit } = gateway();

  const response = await gw.handle(messageRequest());

  assert.equal(response.status, 200);
  assert.deepEqual(handled, [
    {
      taskId: "task-a2a-1",
      message: "Review this project",
      targetDir: targetRoot,
      requestId: "req-1",
      remoteAddress: "127.0.0.1",
    },
  ]);
  assert.equal(response.body.result.kind, "task");
  assert.equal(response.body.result.id, "task-a2a-1");
  assert.equal(response.body.result.status.state, "completed");
  assert.equal(response.body.result.status.message.parts[0].text, "accepted: Review this project");
  assert.equal(audit[0].decision, "accepted");
  assert.equal(audit[0].taskId, "task-a2a-1");
});

test("A2A server gateway normalizes message text from text parts only", async () => {
  const { gateway: gw, handled } = gateway();

  await gw.handle(
    messageRequest({
      body: {
        ...messageRequest().body,
        params: {
          ...messageRequest().body.params,
          message: {
            kind: "message",
            role: "user",
            parts: [
              { kind: "text", text: "First" },
              { kind: "data", data: { ignored: true } },
              { kind: "text", text: "Second" },
            ],
          },
        },
      },
    }),
  );

  assert.equal(handled[0].message, "First\n\nSecond");
});
