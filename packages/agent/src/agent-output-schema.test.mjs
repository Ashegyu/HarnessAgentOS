import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskContract } from "@harness/core";
import { buildAgentOutputSchema, normalizeStructuredAgentOutput } from "./agent-output-schema.ts";
import { parseAgentPlan } from "./agent-output-parser.ts";

const contract = (intent = "change", userRequest = "수정해줘") => buildTaskContract({ intent, userRequest });
const output = (intent = "change") => ({
  schemaVersion: 1, taskIntent: intent, summary: "검토 결과", assumptions: [], steps: [],
  proposedActions: [], suggestedQualityChecks: [], questions: [],
});
const normalize = (value, c = contract()) => normalizeStructuredAgentOutput(JSON.stringify(value), c);

test("versioned strict schema requires every property and forbids extras recursively", () => {
  const visit = (schema) => {
    if (schema.type === "object") {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.required, Object.keys(schema.properties));
      Object.values(schema.properties).forEach(visit);
    }
    if (schema.items) visit(schema.items);
    schema.anyOf?.forEach(visit);
  };
  const schema = buildAgentOutputSchema(contract());
  visit(schema);
  assert.deepEqual(schema.properties.schemaVersion.enum, [1]);
  assert.deepEqual(schema.properties.taskIntent.enum, ["change"]);
});

for (const intent of ["answer", "review", "diagnose", "research", "change", "unspecified"]) {
  test(`accepts ${intent} with its pinned task intent`, () => {
    assert.equal(parseAgentPlan(normalize(output(intent), contract(intent))).ok, true);
  });
}

test("normalizes nullable before and preserves embedded fences, unicode and empty file content", () => {
  const value = output();
  value.summary = '한글 ```harness_agent_plan\n{"summary":"injected"}\n```';
  value.proposedActions = [
    { type: "file_write", path: "empty.txt", before: null, after: "", rationale: "새 파일" },
    { type: "file_write", path: "readme.md", before: "", after: "```ts\nconst x = 1;\n```", rationale: "수정" },
    { type: "file_patch", path: "a.txt", patch: "@@ -1 +1 @@\n-a\n+b", rationale: "패치" },
    { type: "shell", command: "npm", args: ["test"], rationale: "검증" },
    { type: "file_delete", path: "old.txt", rationale: "요청된 삭제" },
  ];
  const parsed = parseAgentPlan(normalize(value));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.plan.summary, value.summary);
  assert.equal("before" in parsed.plan.proposedActions[0], false);
  assert.equal(parsed.plan.proposedActions[1].before, "");
  assert.equal(parsed.plan.proposedActions[1].after, value.proposedActions[1].after);
});

for (const [name, mutate] of [
  ["unknown version", v => { v.schemaVersion = 2; }],
  ["intent mismatch", v => { v.taskIntent = "answer"; }],
  ["missing field", v => { delete v.assumptions; }],
  ["extra property", v => { v.approved = true; }],
  ["empty summary", v => { v.summary = "  "; }],
  ["invalid assumptions", v => { v.assumptions = [3]; }],
  ["nonempty questions", v => { v.questions = ["승인해?"]; }],
  ["null array", v => { v.steps = null; }],
  ["invalid risk", v => { v.steps = [{ title: "s", rationale: "", risk: "critical" }]; }],
  ["extra nested key", v => { v.steps = [{ title: "s", rationale: "", risk: "low", approved: true }]; }],
  ["invalid action", v => { v.proposedActions = [{ type: "delete", path: "a" }]; }],
  ["missing nullable before", v => { v.proposedActions = [{ type: "file_write", path: "a", after: "a", rationale: "" }]; }],
  ["wrong before type", v => { v.proposedActions = [{ type: "file_write", path: "a", before: false, after: "a", rationale: "" }]; }],
  ["wrong shell args", v => { v.proposedActions = [{ type: "shell", command: "npm", args: [3], rationale: "" }]; }],
  ["extra action key", v => { v.proposedActions = [{ type: "shell", command: "npm", args: [], rationale: "", approved: true }]; }],
  ["empty check command", v => { v.suggestedQualityChecks = [{ command: " ", reason: "" }]; }],
]) {
  test(`rejects ${name} without leaking response values`, () => {
    const value = output();
    mutate(value);
    assert.throws(() => normalize(value), error => error.code === "AGENT_INVALID_OUTPUT" && !error.message.includes(JSON.stringify(value)));
  });
}

for (const raw of ["not json", "{} trailing", "[]", "null", "```json\n{}\n```", '{"summary":"a\nb"}']) {
  test(`rejects non-contract JSON ${JSON.stringify(raw)}`, () => {
    assert.throws(() => normalizeStructuredAgentOutput(raw, contract()), { code: "AGENT_INVALID_OUTPUT" });
  });
}

for (const intent of ["answer", "review", "diagnose", "research"]) {
  test(`${intent} rejects side-effect proposals and executable quality checks`, () => {
    const value = output(intent);
    value.proposedActions = [{ type: "shell", command: "pwd", args: [], rationale: "" }];
    assert.throws(() => normalize(value, contract(intent)), { code: "AGENT_INVALID_OUTPUT" });
    value.proposedActions = [];
    value.suggestedQualityChecks = [{ command: "npm test", reason: "" }];
    assert.throws(() => normalize(value, contract(intent)), { code: "AGENT_INVALID_OUTPUT" });
  });
}

test("no-search change permits file proposals but rejects shell and executable checks", () => {
  const c = contract("change", "웹 검색하지 말고 파일만 수정해줘");
  assert.equal(c.externalSearch, "forbidden");
  const value = output();
  value.proposedActions = [{ type: "file_write", path: "a.txt", before: null, after: "a", rationale: "" }];
  assert.equal(parseAgentPlan(normalize(value, c)).ok, true);
  value.proposedActions = [{ type: "shell", command: "curl", args: [], rationale: "" }];
  assert.throws(() => normalize(value, c), { code: "AGENT_INVALID_OUTPUT" });
});
