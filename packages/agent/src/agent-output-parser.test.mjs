import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentPlan } from "./agent-output-parser.ts";

const validPlan = {
  summary: "Add README run section",
  assumptions: ["package.json has a dev script"],
  steps: [
    { title: "Edit README", rationale: "user wants run instructions", risk: "low" },
  ],
  proposedActions: [
    {
      type: "file_write",
      path: "README.md",
      after: "# Project\n\n## Run\n\nnpm run dev\n",
      rationale: "show run command",
    },
  ],
  suggestedQualityChecks: [{ command: "npm run check", reason: "tsc safety" }],
  questions: [],
};

const wrap = (json) =>
  `요약: 설명\n\n\`\`\`harness_agent_plan\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;

test("parses a well-formed agent plan", () => {
  const r = parseAgentPlan(wrap(validPlan));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.plan.summary, "Add README run section");
    assert.equal(r.plan.proposedActions.length, 1);
    assert.equal(r.plan.proposedActions[0].type, "file_write");
  }
});

test("rejects output missing the fenced block", () => {
  const r = parseAgentPlan("plain text answer with no JSON");
  assert.equal(r.ok, false);
});

test("rejects malformed JSON", () => {
  const r = parseAgentPlan("```harness_agent_plan\n{not json}\n```");
  assert.equal(r.ok, false);
});

test("rejects when proposedAction has missing required fields", () => {
  const bad = { ...validPlan, proposedActions: [{ type: "file_write", path: "x" }] };
  const r = parseAgentPlan(wrap(bad));
  assert.equal(r.ok, false);
});

test("rejects unknown action type", () => {
  const bad = {
    ...validPlan,
    proposedActions: [{ type: "rm_rf", path: "/", rationale: "no" }],
  };
  const r = parseAgentPlan(wrap(bad));
  assert.equal(r.ok, false);
});

test("rejects bad risk value", () => {
  const bad = {
    ...validPlan,
    steps: [{ title: "x", rationale: "y", risk: "catastrophic" }],
  };
  const r = parseAgentPlan(wrap(bad));
  assert.equal(r.ok, false);
});

test("accepts empty proposedActions (answer-only path)", () => {
  const answerOnly = { ...validPlan, proposedActions: [] };
  const r = parseAgentPlan(wrap(answerOnly));
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.plan.proposedActions.length, 0);
});

test("drops agent questions so runs proceed without user replies", () => {
  const withQuestions = {
    ...validPlan,
    questions: ["어떤 스타일을 원하시나요?", "추가 요구사항이 있나요?"],
  };
  const r = parseAgentPlan(wrap(withQuestions));
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.plan.questions, []);
});

test("parses shell action with args", () => {
  const withShell = {
    ...validPlan,
    proposedActions: [
      {
        type: "shell",
        command: "npm",
        args: ["test", "--silent"],
        rationale: "run tests",
      },
    ],
  };
  const r = parseAgentPlan(wrap(withShell));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.plan.proposedActions[0].type, "shell");
    assert.deepEqual(r.plan.proposedActions[0].args, ["test", "--silent"]);
  }
});
