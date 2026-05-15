import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyRemoteAgentDraft,
  remoteAgentDraftFromEndpoint,
  serializeRemoteAgentDraft,
  validateRemoteAgentDraft,
} from "./remote-agent-form.ts";

const endpoint = {
  id: "a2a_existing",
  name: "Remote Reviewer",
  baseUrl: "https://agents.example.com/reviewer",
  agentCardUrl: "https://agents.example.com/reviewer/.well-known/agent-card.json",
  preferredTransport: "json-rpc",
  enabled: true,
  trusted: false,
  createdAt: "2026-05-15T00:00:00.000Z",
  updatedAt: "2026-05-15T00:00:00.000Z",
};

test("remote agent form starts with safe registry-only defaults", () => {
  const draft = emptyRemoteAgentDraft();
  assert.equal(draft.id, null);
  assert.equal(draft.name, "");
  assert.equal(draft.preferredTransport, "json-rpc");
  assert.equal(draft.enabled, true);
  assert.equal(draft.trusted, false);
});

test("validateRemoteAgentDraft rejects missing identity and insecure URLs", () => {
  const draft = emptyRemoteAgentDraft();
  const errors = validateRemoteAgentDraft({
    ...draft,
    name: "",
    baseUrl: "http://agents.example.com",
    agentCardUrl: "file:///tmp/card.json",
  });
  assert.ok(errors.includes("이름은 필수입니다."));
  assert.ok(errors.includes("Base URL은 https:// URL이어야 합니다."));
  assert.ok(errors.includes("Agent Card URL은 https:// URL이어야 합니다."));
});

test("validateRemoteAgentDraft allows localhost only when explicitly trusted", () => {
  const draft = {
    ...emptyRemoteAgentDraft(),
    name: "Local Dev Agent",
    baseUrl: "http://127.0.0.1:4123",
    agentCardUrl: "http://127.0.0.1:4123/.well-known/agent-card.json",
    trusted: false,
  };
  assert.ok(validateRemoteAgentDraft(draft).some((e) => e.includes("localhost")));
  assert.deepEqual(validateRemoteAgentDraft({ ...draft, trusted: true }), []);
});

test("remoteAgentDraftFromEndpoint and serializeRemoteAgentDraft round-trip", () => {
  const draft = remoteAgentDraftFromEndpoint(endpoint);
  assert.equal(draft.id, endpoint.id);
  assert.equal(draft.agentCardUrl, endpoint.agentCardUrl);

  const serialized = serializeRemoteAgentDraft({
    ...draft,
    name: "Renamed",
    authSecretRef: "A2A_TOKEN",
  });
  assert.equal(serialized.id, endpoint.id);
  assert.equal(serialized.name, "Renamed");
  assert.equal(serialized.authSecretRef, "A2A_TOKEN");
  assert.equal(serialized.createdAt, endpoint.createdAt);
});
