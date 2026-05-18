import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGeneratedMcpServerDraft } from "./mcp-server-generator.ts";

test("buildGeneratedMcpServerDraft creates a disabled GitHub stdio draft with secret refs only", () => {
  const draft = buildGeneratedMcpServerDraft({
    userIntent: "GitHub 이슈를 읽는 MCP 서버가 필요하고 token 인증을 사용합니다.",
  });

  assert.equal(draft.name, "GitHub MCP");
  assert.equal(draft.transport, "stdio");
  assert.equal(draft.command, "npx");
  assert.deepEqual(draft.args, ["-y", "@modelcontextprotocol/server-github"]);
  assert.equal(draft.envSecretRefs.GITHUB_PERSONAL_ACCESS_TOKEN, "github_token");
  assert.deepEqual(draft.env, {});
  assert.equal(draft.enabled, false);
  assert.match(draft.rationale, /Codex MCP config remains unsupported/);
});

test("buildGeneratedMcpServerDraft infers remote http draft and bearer placeholder", () => {
  const draft = buildGeneratedMcpServerDraft({
    userIntent: "Use https://mcp.example.test/v1 with bearer token auth.",
  });

  assert.equal(draft.transport, "http");
  assert.equal(draft.url, "https://mcp.example.test/v1");
  assert.equal(Object.keys(draft.envSecretRefs)[0], "AUTH");
  assert.match(draft.envSecretRefs.AUTH, /bearer_token$/);
  assert.equal(draft.command, undefined);
});

test("buildGeneratedMcpServerDraft honors preferred transport and profile binding hints", () => {
  const draft = buildGeneratedMcpServerDraft({
    userIntent: "Asana MCP",
    preferredTransport: "sse",
    profileIds: ["agent_pm"],
  });

  assert.equal(draft.transport, "sse");
  assert.equal(draft.url, "https://mcp.example.com/sse");
  assert.equal(draft.scope, "per-agent");
  assert.deepEqual(draft.recommendedProfileIds, ["agent_pm"]);
});
