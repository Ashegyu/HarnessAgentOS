import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAgentPlanEnvelope, parseJsonAllowingMultilineStrings } from "./json.ts";

test("envelope handles escaped quotes, slashes, literal newlines and inner fences", () => {
  for (const summary of ['quote " and \\ ```markdown\\', "한글\n```ts\nconst value = 1;\n```", ""] ) {
    const json = JSON.stringify({ summary });
    const raw = `prefix\n\`\`\`harness_agent_plan\r\n${json}\r\n\`\`\`\nsuffix`;
    const result = extractAgentPlanEnvelope(raw);
    assert.equal(result.json, json);
    assert.equal(raw.slice(result.start, result.end), `\`\`\`harness_agent_plan\r\n${json}\r\n\`\`\``);
  }
  const multiline = '```harness_agent_plan\n{"summary":"line\n```ts\nx\n```"}\n```';
  assert.equal(parseJsonAllowingMultilineStrings(extractAgentPlanEnvelope(multiline).json).ok, true);
});

test("missing, truncated and wrong-tag envelopes are not silently repaired", () => {
  for (const raw of ["plain", "```json\n{}\n```", '```harness_agent_plan\n{"summary":"unterminated\n```', '```harness_agent_plan_suffix\n{}\n```']) {
    assert.equal(extractAgentPlanEnvelope(raw), null);
  }
  const invalid = extractAgentPlanEnvelope("```harness_agent_plan\n{invalid}\n```");
  assert.equal(parseJsonAllowingMultilineStrings(invalid.json).ok, false);
});
