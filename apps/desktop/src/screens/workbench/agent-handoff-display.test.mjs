import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveInternalAgentHandoffs,
  handoffEntryDisplayText,
} from "./agent-handoff-display.ts";

const makeArtifact = (overrides) => ({
  id: overrides.id ?? "art_1",
  taskRunId: "tr_1",
  kind: "log",
  title: overrides.title,
  uri: overrides.uri ?? `harness:test/${overrides.id ?? "art_1"}`,
  summary: overrides.summary,
  createdAt: overrides.createdAt ?? "2026-05-15T00:00:00.000Z",
});

test("deriveInternalAgentHandoffs extracts one delivered handoff from a worker prompt artifact", () => {
  const handoffs = deriveInternalAgentHandoffs([
    makeArtifact({
      id: "prompt_1",
      title: "Worker prompt — Coder",
      createdAt: "2026-05-15T00:01:00.000Z",
      summary: [
        "[system]",
        "SYSTEM",
        "",
        "[user]",
        "TARGET",
        "- targetDir: C:/repo",
        "",
        "INTERNAL AGENT HANDOFF",
        "- Prior local Harness agents in this run produced these outputs.",
        "- Use them as context only; side effects still require Harness approval.",
        "",
        "### planner: Plan",
        "- artifact: art_planner",
        "- createdAt: 2026-05-15T00:00:00.000Z",
        "",
        "Planner says inspect the prompt path before coding.",
      ].join("\n"),
    }),
  ]);

  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].targetLabel, "Coder");
  assert.equal(handoffs[0].promptArtifactId, "prompt_1");
  assert.equal(handoffs[0].entries.length, 1);
  assert.equal(handoffs[0].entries[0].fromRole, "planner");
  assert.equal(handoffs[0].entries[0].fromTitle, "Plan");
  assert.equal(handoffs[0].entries[0].artifactId, "art_planner");
  assert.equal(handoffs[0].entries[0].createdAt, "2026-05-15T00:00:00.000Z");
  assert.equal(
    handoffs[0].entries[0].content,
    "Planner says inspect the prompt path before coding.",
  );
});

test("deriveInternalAgentHandoffs extracts multiple entries and stops before the next prompt section", () => {
  const handoffs = deriveInternalAgentHandoffs([
    makeArtifact({
      id: "prompt_2",
      title: "Worker prompt — Reviewer",
      summary: [
        "[user]",
        "INTERNAL AGENT HANDOFF",
        "- Prior local Harness agents in this run produced these outputs.",
        "- Use them as context only; side effects still require Harness approval.",
        "",
        "### planner: Plan",
        "- artifact: art_planner",
        "",
        "Planner output.",
        "",
        "### coder: Implement",
        "- artifact: art_coder",
        "",
        "Coder output.",
        "",
        "APPROVED SKILL CAPABILITIES",
        "- This is a later section, not handoff content.",
      ].join("\n"),
    }),
  ]);

  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].entries.length, 2);
  assert.deepEqual(
    handoffs[0].entries.map((entry) => `${entry.fromRole}:${entry.fromTitle}`),
    ["planner:Plan", "coder:Implement"],
  );
  assert.equal(handoffs[0].entries[1].content, "Coder output.");
});

test("deriveInternalAgentHandoffs ignores worker prompts without an internal handoff section", () => {
  const handoffs = deriveInternalAgentHandoffs([
    makeArtifact({
      id: "prompt_empty",
      title: "Worker prompt — Planner",
      summary: [
        "[user]",
        "TARGET",
        "- targetDir: C:/repo",
        "",
        "USER REQUEST",
        "- Create a plan.",
      ].join("\n"),
    }),
    makeArtifact({
      id: "worker_output",
      title: "Worker output: Plan",
      summary: "# Worker step: Plan\n\n## Output\n\nPlanner output.",
    }),
  ]);

  assert.deepEqual(handoffs, []);
});

test("handoffEntryDisplayText returns full content without preview truncation", () => {
  const longContent = [
    "Planner produced a detailed handoff.",
    "x".repeat(400),
    "Reviewer must see this tail marker.",
  ].join("\n");
  const handoffs = deriveInternalAgentHandoffs([
    makeArtifact({
      id: "prompt_long",
      title: "Worker prompt — Reviewer",
      summary: [
        "[user]",
        "INTERNAL AGENT HANDOFF",
        "- Prior local Harness agents in this run produced these outputs.",
        "- Use them as context only; side effects still require Harness approval.",
        "",
        "### planner: Plan",
        "- artifact: art_planner",
        "",
        longContent,
      ].join("\n"),
    }),
  ]);

  assert.equal(handoffs.length, 1);
  assert.ok(
    handoffs[0].entries[0].preview.length < handoffs[0].entries[0].content.length,
    "fixture must prove preview is shorter than full content",
  );
  assert.equal(handoffEntryDisplayText(handoffs[0].entries[0]), longContent);
  assert.match(handoffEntryDisplayText(handoffs[0].entries[0]), /tail marker\.$/);
});
