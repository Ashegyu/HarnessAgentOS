import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "./redact-secrets.ts";

test("redactSecrets masks nested JSON secret keys without hiding usage counters", () => {
  const text = JSON.stringify({ nested: [{ token: "SYNTHETIC_TOKEN_VALUE", api_key: "SYNTHETIC_API_VALUE" }],
    accessToken: "SYNTHETIC_ACCESS_VALUE", client_secret: "SYNTHETIC_CLIENT_VALUE",
    tokenUsage: { inputTokens: 12, output_tokens: 9 }, filename: "token-guide.md" });
  const result = redactSecrets(text, 10000);
  assert.doesNotMatch(result, /SYNTHETIC_/);
  assert.deepEqual(JSON.parse(result), { nested: [{ token: "[REDACTED]", api_key: "[REDACTED]" }],
    accessToken: "[REDACTED]", client_secret: "[REDACTED]",
    tokenUsage: { inputTokens: 12, output_tokens: 9 }, filename: "token-guide.md" });
});

test("redactSecrets decodes escaped JSON keys before checking sensitivity", () => {
  const text = '{"API\\u005fKEY":"SYNTHETIC_ESCAPED_KEY","nested":{"password":"SYNTHETIC_PASSWORD"}}';
  const result = redactSecrets(text, 10000);
  assert.doesNotMatch(result, /SYNTHETIC_/);
  assert.equal(JSON.parse(result).API_KEY, "[REDACTED]");
});

test("redactSecrets masks JSON values containing whitespace and escaped quotes inside prose", () => {
  const text = 'Tool input:\n```json\n' + JSON.stringify({ token: 'SYNTHETIC spaced "quoted" secret', note: "keep this" }) + '\n```';
  const result = redactSecrets(text, 10000);
  assert.doesNotMatch(result, /SYNTHETIC|spaced|quoted|secret/);
  assert.match(result, /"note":"keep this"/);
});

test("redactSecrets masks a JSON-encoded JSON value recursively", () => {
  const text = JSON.stringify({ input: JSON.stringify({ refresh_token: "SYNTHETIC_INNER_TOKEN" }) });
  const result = redactSecrets(text, 10000);
  assert.doesNotMatch(result, /SYNTHETIC_INNER_TOKEN/);
  assert.equal(JSON.parse(JSON.parse(result).input).refresh_token, "[REDACTED]");
});

test("redactSecrets masks encoded JSON strings inside a fenced execution plan without rewriting the source", () => {
  const after = JSON.stringify({ token: "SYNTHETIC_FENCED_FILE_VALUE", tokenUsage: 4 });
  const plan = { proposedActions: [{ type: "file_write", path: "result.json", after }], note: "ordinary formatting" };
  const source = "```harness_agent_plan\n" + JSON.stringify(plan) + "\n```";
  const audit = redactSecrets(source, 10000);
  assert.doesNotMatch(audit, /SYNTHETIC_FENCED_FILE_VALUE/);
  assert.equal(plan.proposedActions[0].after, after);
  const parsed = JSON.parse(audit.split("\n")[1]);
  assert.deepEqual(JSON.parse(parsed.proposedActions[0].after), { token: "[REDACTED]", tokenUsage: 4 });
  assert.equal(parsed.note, plan.note);
});

test("redactSecrets removes values before applying the output length limit", () => {
  const result = redactSecrets('{"token":"SYNTHETIC_TRUNCATION_SECRET","after":"long tail"}', 25);
  assert.doesNotMatch(result, /SYNTHETIC/);
  assert.ok(result.length <= 25);
});

test("redactSecrets preserves ordinary text and JSON formatting when nothing is sensitive", () => {
  for (const text of ['A token budget of 1200 bytes.', '{ "tokenUsage": 4, "file": "api_key.md" }', "const tokenCount = 2;"]) {
    assert.equal(redactSecrets(text, 10000), text);
  }
  assert.equal(redactSecrets("const token=synthetic_assignment", 10000), "const [REDACTED]");
});

test("redactSecrets masks an unfinished quoted JSON credential before clipping", () => {
  for (const text of ['{"token":"SYNTHETIC_UNFINISHED', 'prefix {"api_key":"SYNTHETIC_UNFINISHED', JSON.stringify({ secret: 'SYNTHETIC escaped "tail' }).slice(0, -2)]) {
    assert.doesNotMatch(redactSecrets(text, 10000), /SYNTHETIC|UNFINISHED|tail/);
  }
});
