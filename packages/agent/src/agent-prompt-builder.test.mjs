import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSplitAgentPrompt, buildAgentPrompt, PROMPT_HARD_CAP_BYTES } from "./agent-prompt-builder.ts";

const baseTaskRun = {
  id: "tr-1",
  threadId: "th-1",
  targetDir: "/workspace/project",
  userRequest: "Add a README run section",
  status: "drafting",
  conversationMode: "agent",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

test("buildSplitAgentPrompt splits system and user sections", () => {
  const { systemPrompt, userPrompt } = buildSplitAgentPrompt({ taskRun: baseTaskRun });

  // System prompt must contain SYSTEM header and OUTPUT CONTRACT
  assert.ok(systemPrompt.includes("SYSTEM"), "systemPrompt must contain SYSTEM block");
  assert.ok(systemPrompt.includes("OUTPUT CONTRACT"), "systemPrompt must contain OUTPUT CONTRACT");
  assert.ok(systemPrompt.includes("harness_agent_plan"), "systemPrompt must contain harness_agent_plan tag");

  // User prompt must contain TARGET and USER REQUEST
  assert.ok(userPrompt.includes("TARGET"), "userPrompt must contain TARGET block");
  assert.ok(userPrompt.includes("USER REQUEST"), "userPrompt must contain USER REQUEST block");
  assert.ok(userPrompt.includes(baseTaskRun.targetDir), "userPrompt must include targetDir");
  assert.ok(userPrompt.includes(baseTaskRun.userRequest), "userPrompt must include userRequest");
});

test("buildSplitAgentPrompt does not duplicate OUTPUT CONTRACT in userPrompt", () => {
  const { userPrompt } = buildSplitAgentPrompt({ taskRun: baseTaskRun });
  assert.ok(!userPrompt.includes("OUTPUT CONTRACT"), "userPrompt must NOT contain OUTPUT CONTRACT");
});

test("buildSplitAgentPrompt includes instruction when provided", () => {
  const { userPrompt } = buildSplitAgentPrompt({
    taskRun: baseTaskRun,
    instruction: "Focus only on the README file",
  });
  assert.ok(userPrompt.includes("REDIRECT INSTRUCTION"), "userPrompt must contain REDIRECT INSTRUCTION");
  assert.ok(userPrompt.includes("Focus only on the README file"));
});

test("buildSplitAgentPrompt omits REDIRECT INSTRUCTION when not provided", () => {
  const { userPrompt } = buildSplitAgentPrompt({ taskRun: baseTaskRun });
  assert.ok(!userPrompt.includes("REDIRECT INSTRUCTION"), "no REDIRECT INSTRUCTION when not provided");
});

test("buildSplitAgentPrompt includes qualityRisks when provided", () => {
  const qualityRisks = {
    status: "failed",
    knownRisks: ["missing types", "no tests"],
    checkedAt: new Date().toISOString(),
  };
  const { userPrompt } = buildSplitAgentPrompt({ taskRun: baseTaskRun, qualityRisks });
  assert.ok(userPrompt.includes("QUALITY RISKS TO ADDRESS"));
  assert.ok(userPrompt.includes("missing types"));
  assert.ok(userPrompt.includes("no tests"));
});

test("buildSplitAgentPrompt includes recentArtifacts when provided", () => {
  const recentArtifacts = [
    {
      id: "art-1",
      taskRunId: "tr-1",
      stepId: "step-1",
      kind: "plan",
      title: "Previous plan",
      uri: "harness:plan/tr-1/1",
      summary: "Added README section",
      createdAt: new Date().toISOString(),
    },
  ];
  const { userPrompt } = buildSplitAgentPrompt({ taskRun: baseTaskRun, recentArtifacts });
  assert.ok(userPrompt.includes("RECENT ARTIFACTS"));
  assert.ok(userPrompt.includes("Previous plan"));
});

test("buildSplitAgentPrompt combined size stays within hard cap", () => {
  const { systemPrompt, userPrompt } = buildSplitAgentPrompt({ taskRun: baseTaskRun });
  const combined = systemPrompt + "\n\n" + userPrompt;
  assert.ok(
    Buffer.byteLength(combined, "utf8") <= PROMPT_HARD_CAP_BYTES,
    "combined prompt must stay within 80KB hard cap",
  );
});

test("buildSplitAgentPrompt truncates optional context when combined size overflows", () => {
  // qualityRisks.knownRisks has no per-item char limit, so long risk strings
  // can push the combined prompt past 80KB. The builder trims only the optional
  // middle sections, keeping TARGET + USER REQUEST intact.
  const bigRisk = "r".repeat(8 * 1024); // 8KB per risk
  const qualityRisks = {
    status: "failed",
    knownRisks: Array.from({ length: 12 }, () => bigRisk), // 12 × 8KB = ~96KB
    checkedAt: new Date().toISOString(),
  };
  const { systemPrompt, userPrompt } = buildSplitAgentPrompt({
    taskRun: baseTaskRun,
    qualityRisks,
  });
  const combined = systemPrompt + "\n\n" + userPrompt;
  assert.ok(
    Buffer.byteLength(combined, "utf8") <= PROMPT_HARD_CAP_BYTES,
    "combined prompt must stay within 80KB hard cap after truncation",
  );
  assert.ok(userPrompt.includes("[...truncated]"), "truncated prompt must include [...truncated] marker");
  // Core sections must survive truncation
  assert.ok(userPrompt.includes("TARGET"), "TARGET section must survive truncation");
  assert.ok(userPrompt.includes("USER REQUEST"), "USER REQUEST section must survive truncation");
});

test("buildSplitAgentPrompt injects persona above SYSTEM block", () => {
  const { systemPrompt } = buildSplitAgentPrompt({
    taskRun: baseTaskRun,
    persona: "You are a security-focused reviewer. Flag OWASP issues.",
  });
  // Persona must precede SYSTEM so the model reads role before rules.
  const personaIdx = systemPrompt.indexOf("security-focused reviewer");
  const systemIdx = systemPrompt.indexOf("SYSTEM");
  assert.ok(personaIdx >= 0, "persona must appear in systemPrompt");
  assert.ok(
    personaIdx < systemIdx,
    "persona must appear before SYSTEM block so role precedes rules",
  );
});

test("buildSplitAgentPrompt injects systemPromptPrefix above persona", () => {
  const { systemPrompt } = buildSplitAgentPrompt({
    taskRun: baseTaskRun,
    persona: "Reviewer persona",
    systemPromptPrefix: "GLOBAL ORG POLICY: never touch /etc.",
  });
  const prefixIdx = systemPrompt.indexOf("GLOBAL ORG POLICY");
  const personaIdx = systemPrompt.indexOf("Reviewer persona");
  assert.ok(prefixIdx >= 0);
  assert.ok(prefixIdx < personaIdx, "prefix must precede persona");
});

test("buildSplitAgentPrompt appends systemPromptSuffix at end of system block", () => {
  const { systemPrompt } = buildSplitAgentPrompt({
    taskRun: baseTaskRun,
    systemPromptSuffix: "TRAILING NOTE: always respond in Korean.",
  });
  const noteIdx = systemPrompt.indexOf("TRAILING NOTE");
  const contractIdx = systemPrompt.indexOf("OUTPUT CONTRACT");
  assert.ok(noteIdx >= 0);
  assert.ok(noteIdx > contractIdx, "suffix must appear after OUTPUT CONTRACT");
});

test("buildSplitAgentPrompt strips persona/prefix/suffix when blank", () => {
  // Empty/whitespace strings should produce no extra section — common case
  // when AgentProfile has the default empty fields.
  const { systemPrompt } = buildSplitAgentPrompt({
    taskRun: baseTaskRun,
    persona: "  ",
    systemPromptPrefix: "",
    systemPromptSuffix: "\n\n",
  });
  // SYSTEM must be the first non-whitespace block.
  assert.ok(systemPrompt.trimStart().startsWith("SYSTEM"));
});

test("buildAgentPrompt still works (backwards compat)", () => {
  const prompt = buildAgentPrompt({ taskRun: baseTaskRun });
  assert.ok(prompt.includes("SYSTEM"));
  assert.ok(prompt.includes("OUTPUT CONTRACT"));
  assert.ok(prompt.includes("TARGET"));
  assert.ok(prompt.includes("USER REQUEST"));
  assert.ok(typeof prompt === "string");
});
