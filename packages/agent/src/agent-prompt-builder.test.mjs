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

test("buildSplitAgentPrompt forbids user-blocking questions", () => {
  const { systemPrompt } = buildSplitAgentPrompt({ taskRun: baseTaskRun });
  assert.match(systemPrompt, /Do not ask follow-up questions/i);
  assert.match(systemPrompt, /questions:\s*\[\]/);
});

test("buildSplitAgentPrompt tells agents to propose approvals instead of refusing direct edits", () => {
  const { systemPrompt } = buildSplitAgentPrompt({ taskRun: baseTaskRun });
  assert.match(systemPrompt, /Do NOT modify files directly/i);
  assert.match(systemPrompt, /read-only provider sandbox/i);
  assert.match(systemPrompt, /does not block you from proposing file_patch\/file_write/i);
  assert.match(systemPrompt, /Do not answer that you cannot modify files directly/i);
  assert.match(systemPrompt, /produce proposedActions/i);
});

test("buildSplitAgentPrompt allows direct edits when workspace-write is enabled", () => {
  const { systemPrompt } = buildSplitAgentPrompt({
    taskRun: baseTaskRun,
    directFileEdits: true,
  });
  assert.match(systemPrompt, /workspace-write sandbox/i);
  assert.match(systemPrompt, /You may modify files directly inside targetDir/i);
  assert.match(systemPrompt, /set proposedActions to \[\]/i);
  assert.doesNotMatch(systemPrompt, /Do NOT modify files directly/i);
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

test("buildSplitAgentPrompt includes previous thread task context", () => {
  const { userPrompt } = buildSplitAgentPrompt({
    taskRun: baseTaskRun,
    threadContext: [
      {
        ordinal: 1,
        taskRunId: "tr-prev",
        userRequest: "이전 구현을 점검해줘",
        status: "ready_for_review",
        answerSummary: "연결 그래프 구현이 완료되었습니다.",
      },
    ],
  });

  assert.ok(userPrompt.includes("THREAD CONTEXT"));
  assert.ok(userPrompt.includes("Task 1"));
  assert.ok(userPrompt.includes("이전 구현을 점검해줘"));
  assert.ok(userPrompt.includes("연결 그래프 구현이 완료되었습니다"));
});

test("buildSplitAgentPrompt emphasizes the explicit follow-up anchor", () => {
  const { userPrompt } = buildSplitAgentPrompt({
    taskRun: {
      ...baseTaskRun,
      userRequest: "방금 답변 기준으로 더 고쳐줘",
      followUpTaskRunId: "tr-anchor",
    },
    threadContext: [
      {
        ordinal: 2,
        taskRunId: "tr-anchor",
        userRequest: "파이프라인 그래프 연결선을 고쳐줘",
        status: "ready_for_review",
        answerSummary: "포트 중심 기준으로 연결선을 보정했습니다.",
        isFollowUpAnchor: true,
      },
    ],
  });

  assert.ok(userPrompt.includes("FOLLOW-UP ANCHOR"));
  assert.ok(userPrompt.includes("continuation of this specific previous TaskRun"));
  assert.ok(userPrompt.includes("방금"));
  assert.ok(userPrompt.includes("tr-anchor"));
  assert.ok(userPrompt.includes("포트 중심 기준으로 연결선을 보정했습니다."));
  assert.ok(userPrompt.indexOf("FOLLOW-UP ANCHOR") < userPrompt.indexOf("USER REQUEST"));
});

test("buildSplitAgentPrompt includes internal handoff messages when provided", () => {
  const { userPrompt } = buildSplitAgentPrompt({
    taskRun: baseTaskRun,
    handoffMessages: [
      {
        fromRole: "planner",
        fromTitle: "Plan",
        content: "Planner says inspect the worker prompt path before coding.",
        artifactId: "art_handoff_1",
        createdAt: "2026-05-15T00:00:00.000Z",
      },
    ],
  });
  assert.ok(userPrompt.includes("INTERNAL AGENT HANDOFF"));
  assert.ok(userPrompt.includes("planner: Plan"));
  assert.ok(userPrompt.includes("art_handoff_1"));
  assert.ok(userPrompt.includes("Planner says inspect the worker prompt path before coding."));
});

test("buildSplitAgentPrompt includes approved capability context", () => {
  const { userPrompt } = buildSplitAgentPrompt({
    taskRun: baseTaskRun,
    capabilityContexts: [
      {
        capability: {
          id: "cap_refactor",
          source: "skillify:project",
          name: "Refactor",
          description: "Refactor code safely",
          triggerTerms: ["refactor"],
          riskLevel: "low",
          requiresApproval: false,
        },
        reason: "Matched trigger terms: refactor",
        instructions: "# Refactor\n\nKeep edits small.",
      },
    ],
  });
  assert.ok(userPrompt.includes("APPROVED SKILL CAPABILITIES"));
  assert.ok(userPrompt.includes("Refactor"));
  assert.ok(userPrompt.includes("Keep edits small."));
});

test("buildSplitAgentPrompt includes packed repository context", () => {
  const { userPrompt } = buildSplitAgentPrompt({
    taskRun: baseTaskRun,
    repoContext: {
      section: "REPOSITORY CONTEXT\n- selected files: 1\n\n### src/App.tsx\n- summary: App shell",
      selectedFiles: ["src/App.tsx"],
      indexedFileCount: 4,
    },
  });
  assert.ok(userPrompt.includes("REPOSITORY CONTEXT"));
  assert.ok(userPrompt.includes("src/App.tsx"));
});

test("buildSplitAgentPrompt omits capability context before approval", () => {
  const { userPrompt } = buildSplitAgentPrompt({ taskRun: baseTaskRun });
  assert.ok(!userPrompt.includes("APPROVED SKILL CAPABILITIES"));
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

test("buildSplitAgentPrompt keeps oversized handoff context within hard cap", () => {
  const { systemPrompt, userPrompt } = buildSplitAgentPrompt({
    taskRun: baseTaskRun,
    handoffMessages: Array.from({ length: 8 }, (_, index) => ({
      fromRole: "planner",
      fromTitle: `Plan ${index}`,
      content: `handoff-${index} ` + "x".repeat(16 * 1024),
      artifactId: `art_handoff_${index}`,
    })),
  });
  const combined = systemPrompt + "\n\n" + userPrompt;
  assert.ok(
    Buffer.byteLength(combined, "utf8") <= PROMPT_HARD_CAP_BYTES,
    "combined prompt must stay within 80KB hard cap with handoff context",
  );
  assert.ok(userPrompt.includes("INTERNAL AGENT HANDOFF"));
  assert.ok(userPrompt.includes("planner: Plan 7"));
  assert.ok(!userPrompt.includes("planner: Plan 0"));
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

test("buildSplitAgentPrompt injects profile metadata above persona", () => {
  const { systemPrompt } = buildSplitAgentPrompt({
    taskRun: baseTaskRun,
    persona: "Reviewer persona",
    profileMetadata: {
      name: "ECC Security Reviewer",
      role: "reviewer",
      category: "security",
      tags: ["ecc", "security"],
    },
  });
  const profileIdx = systemPrompt.indexOf("PROFILE SELECTION");
  const personaIdx = systemPrompt.indexOf("Reviewer persona");
  assert.ok(profileIdx >= 0);
  assert.ok(systemPrompt.includes("category: security"));
  assert.ok(systemPrompt.includes("tags: ecc, security"));
  assert.ok(profileIdx < personaIdx, "profile metadata must precede persona");
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

test("buildSplitAgentPrompt places systemPromptSuffix before final policy", () => {
  const { systemPrompt } = buildSplitAgentPrompt({
    taskRun: baseTaskRun,
    systemPromptSuffix: "TRAILING NOTE: always respond in Korean.",
  });
  const noteIdx = systemPrompt.indexOf("TRAILING NOTE");
  const contractIdx = systemPrompt.indexOf("OUTPUT CONTRACT");
  const finalPolicyIdx = systemPrompt.indexOf("FINAL NON-INTERACTIVE POLICY");
  assert.ok(noteIdx >= 0);
  assert.ok(noteIdx > contractIdx, "suffix must appear after OUTPUT CONTRACT");
  assert.ok(
    finalPolicyIdx > noteIdx,
    "non-interactive policy must be the final system instruction for every agent",
  );
});

test("buildSplitAgentPrompt final policy overrides custom profile questions", () => {
  const { systemPrompt } = buildSplitAgentPrompt({
    taskRun: baseTaskRun,
    persona: "Ask the user which file to inspect before proceeding.",
    systemPromptSuffix: "Ask a clarification question if anything is missing.",
  });
  const askIdx = systemPrompt.lastIndexOf("Ask a clarification question");
  const finalPolicyIdx = systemPrompt.lastIndexOf("FINAL NON-INTERACTIVE POLICY");
  assert.ok(askIdx >= 0);
  assert.ok(finalPolicyIdx > askIdx);
  assert.match(systemPrompt.slice(finalPolicyIdx), /Do not ask the user follow-up questions/);
  assert.match(systemPrompt.slice(finalPolicyIdx), /questions:\s*\[\]/);
});

test("buildSplitAgentPrompt final policy requires file_write after to be complete file content", () => {
  const { systemPrompt } = buildSplitAgentPrompt({
    taskRun: baseTaskRun,
    systemPromptSuffix:
      "If changing files, describe what should be added to the file.",
  });
  const suffixIdx = systemPrompt.indexOf("describe what should be added");
  const finalPolicyIdx = systemPrompt.lastIndexOf("FINAL NON-INTERACTIVE POLICY");

  assert.ok(suffixIdx >= 0);
  assert.ok(finalPolicyIdx > suffixIdx);
  const finalPolicy = systemPrompt.slice(finalPolicyIdx);
  assert.match(finalPolicy, /file_write\.after/);
  assert.match(finalPolicy, /complete file content/i);
  assert.match(finalPolicy, /replaces the whole file/i);
  assert.match(finalPolicy, /Do not put instructions/i);
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
  assert.ok(prompt.includes("FINAL NON-INTERACTIVE POLICY"));
  assert.ok(prompt.includes("TARGET"));
  assert.ok(prompt.includes("USER REQUEST"));
  assert.ok(typeof prompt === "string");
});
