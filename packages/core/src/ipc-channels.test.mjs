import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IPC_CHANNELS,
  ALLOWED_IPC_CHANNELS,
  isAllowedChannel,
} from "./ipc-channels.ts";

test("declared namespaces match the phases shipped so far", () => {
  // Phase-by-phase additions per docs/contracts/ipc-contracts.md.
  // Phase 0: app, Phase 1: state, Phase 2: conversation, Phase 3: runner,
  // Phase 4: quality, Phase 5: capability, Phase 6: learner,
  // Phase 7: orchestration, Phase 8: agent.
  // Agent Framework adoption: instinct, topology.
  // Detailed-settings: agents, mcp, skillSource, secret, pipeline.
  // A2A Phase B: remoteAgents registry.
  assert.deepEqual(Object.keys(IPC_CHANNELS).sort(), [
    "agent",
    "agents",
    "app",
    "capability",
    "conversation",
    "evals",
    "events",
    "instinct",
    "learner",
    "mcp",
    "orchestration",
    "pipeline",
    "quality",
    "remoteAgents",
    "runner",
    "secret",
    "settings",
    "shadow",
    "skillSource",
    "state",
    "topology",
  ]);
});

test("evals namespace exposes read-only viewer verbs", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.evals).sort(), [
    "getCostTrend",
    "getRun",
    "getRuntimeLatencySummary",
    "listRuns",
  ]);
  assert.equal(isAllowedChannel("evals:listRuns"), true);
  assert.equal(isAllowedChannel("evals:getRun"), true);
  assert.equal(isAllowedChannel("evals:getCostTrend"), true);
  assert.equal(isAllowedChannel("evals:getRuntimeLatencySummary"), true);
  assert.equal(isAllowedChannel("evals:deleteRun"), false);
});

test("shadow namespace exposes preview-only verbs", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.shadow).sort(), [
    "createPreview",
  ]);
  assert.equal(isAllowedChannel("shadow:createPreview"), true);
  assert.equal(isAllowedChannel("shadow:promote"), false);
});

test("topology namespace exposes recommendation and feedback verbs", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.topology).sort(), [
    "recommend",
    "recordFeedback",
  ]);
  assert.equal(isAllowedChannel("topology:recommend"), true);
  assert.equal(isAllowedChannel("topology:recordFeedback"), true);
  assert.equal(isAllowedChannel("topology:create"), false);
});

test("remoteAgents namespace exposes registry verbs only", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.remoteAgents).sort(), [
    "delete",
    "get",
    "list",
    "toggle",
    "upsertCardSnapshot",
    "upsertEndpoint",
  ]);
  assert.equal(isAllowedChannel("remoteAgents:list"), true);
  assert.equal(isAllowedChannel("remoteAgents:invoke"), false);
});

test("pipeline namespace exposes CRUD verbs", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.pipeline).sort(), [
    "create",
    "delete",
    "get",
    "list",
    "update",
  ]);
  assert.equal(isAllowedChannel("pipeline:list"), true);
  assert.equal(isAllowedChannel("pipeline:create"), true);
  assert.equal(isAllowedChannel("pipeline:run"), false);
});

test("agents namespace exposes profile CRUD verbs", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.agents).sort(), [
    "create",
    "delete",
    "get",
    "list",
    "setActive",
    "setDefault",
    "update",
  ]);
  assert.equal(isAllowedChannel("agents:list"), true);
  assert.equal(isAllowedChannel("agents:setDefault"), true);
});

test("mcp namespace exposes server management verbs", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.mcp).sort(), [
    "applyProfileBindingProposal",
    "delete",
    "generateProfileBindingProposal",
    "generateServerDraft",
    "generateServerScaffoldDraft",
    "healthCheck",
    "list",
    "proposeServerScaffold",
    "toggle",
    "upsert",
  ]);
  assert.equal(isAllowedChannel("mcp:generateServerDraft"), true);
  assert.equal(isAllowedChannel("mcp:generateServerScaffoldDraft"), true);
  assert.equal(isAllowedChannel("mcp:proposeServerScaffold"), true);
  assert.equal(isAllowedChannel("mcp:generateProfileBindingProposal"), true);
  assert.equal(isAllowedChannel("mcp:applyProfileBindingProposal"), true);
  assert.equal(isAllowedChannel("mcp:healthCheck"), true);
  assert.equal(isAllowedChannel("mcp:upsert"), true);
});

test("skillSource namespace exposes registration verbs", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.skillSource).sort(), [
    "add",
    "applyProfileBindingProposal",
    "generateProfileBindingProposal",
    "generateSkillDraft",
    "list",
    "previewSkillDraft",
    "proposeSkillFile",
    "refresh",
    "remove",
    "update",
  ]);
  assert.equal(isAllowedChannel("skillSource:add"), true);
  assert.equal(isAllowedChannel("skillSource:generateSkillDraft"), true);
  assert.equal(
    isAllowedChannel("skillSource:generateProfileBindingProposal"),
    true,
  );
  assert.equal(
    isAllowedChannel("skillSource:applyProfileBindingProposal"),
    true,
  );
  assert.equal(isAllowedChannel("skillSource:previewSkillDraft"), true);
});

test("secret namespace exposes write/clear/listKeys only (no read)", () => {
  // The renderer must never receive plaintext secrets, so the read verb
  // is deliberately absent. Decryption lives in the main process only.
  assert.deepEqual(Object.keys(IPC_CHANNELS.secret).sort(), [
    "clear",
    "listKeys",
    "write",
  ]);
  assert.equal(isAllowedChannel("secret:write"), true);
  assert.equal(isAllowedChannel("secret:read"), false);
});

test("events namespace exposes id-only + scoped chunk push channels", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.events).sort(), [
    "agentStreamEvent",
    "diagnosticsHeartbeat",
    "taskRunChanged",
  ]);
  assert.equal(isAllowedChannel("events:taskRunChanged"), true);
  assert.equal(isAllowedChannel("events:agentStreamEvent"), true);
  assert.equal(isAllowedChannel("events:diagnosticsHeartbeat"), true);
});

test("agent namespace exposes Phase 8 verbs", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.agent).sort(), [
    "cancelInvocation",
    "checkProviders",
    "generatePlan",
    "requestRefinement",
    "retryInvocation",
    "useTemplateFallback",
  ]);
});

test("app namespace exposes runtime + selectDirectory + selectFile", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.app).sort(), [
    "getDiagnostics",
    "getRuntimeInfo",
    "getVersion",
    "selectDirectory",
    "selectFile",
  ]);
});

test("state namespace exposes Phase 1 verbs only", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.state).sort(), [
    "createThread",
    "deleteThread",
    "exportDbSnapshot",
    "exportThreadMarkdown",
    "getThread",
    "listThreads",
  ]);
});

test("conversation namespace exposes Phase 2/3 + state-action verbs", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.conversation).sort(), [
    "approve",
    "cancelTask",
    "createTask",
    "deleteTask",
    "getTaskRunDetail",
    "listDecisions",
    "pauseTask",
    "redirectTask",
    "rejectApproval",
    "resumeTask",
    "setProposedAction",
  ]);
});

test("runner namespace exposes Phase 3 + retry verbs", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.runner).sort(), [
    "cancelExecution",
    "executeApproved",
    "listArtifacts",
    "readArtifact",
    "retryApproval",
  ]);
});

test("quality namespace exposes Phase 4 verbs", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.quality).sort(), [
    "approveKnownRisks",
    "createRepairPlan",
    "evaluate",
    "getLatest",
    "markDone",
    "markReadyForReview",
  ]);
});

test("capability namespace exposes Phase 5 verbs", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.capability).sort(), [
    "list",
    "proposeCandidates",
    "proposeScriptRun",
    "readSkill",
    "refresh",
    "suggest",
  ]);
});

test("learner namespace exposes Phase 6 verbs", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.learner).sort(), [
    "getTrace",
    "proposeRecommendation",
    "recommend",
    "recordDecision",
    "recordOutcome",
    "recordSelection",
    "summarizeBudgetUsage",
    "summarizeTaskRunCost",
  ]);
});

test("instinct namespace exposes candidate review verbs only", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.instinct).sort(), [
    "approveCandidate",
    "disable",
    "list",
    "listCandidates",
    "rejectCandidate",
  ]);
  assert.equal(isAllowedChannel("instinct:listCandidates"), true);
  assert.equal(isAllowedChannel("instinct:recordObservation"), false);
});

test("orchestration namespace exposes Phase 7 verbs", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.orchestration).sort(), [
    "draftPlan",
    "getPlan",
    "runApproved",
  ]);
});

test("settings namespace exposes get + update verbs", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.settings).sort(), [
    "get",
    "update",
  ]);
  assert.equal(isAllowedChannel("settings:get"), true);
  assert.equal(isAllowedChannel("settings:update"), true);
});

test("channel strings use namespace:verb format", () => {
  for (const channel of ALLOWED_IPC_CHANNELS) {
    assert.match(
      channel,
      /^[a-zA-Z]+:[a-zA-Z]+$/,
      `channel "${channel}" violates namespace:verb format`,
    );
  }
});

test("isAllowedChannel accepts declared channels", () => {
  assert.equal(isAllowedChannel("app:getVersion"), true);
  assert.equal(isAllowedChannel("app:getDiagnostics"), true);
  assert.equal(isAllowedChannel("conversation:createTask"), true);
  assert.equal(isAllowedChannel("runner:executeApproved"), true);
  assert.equal(isAllowedChannel("runner:cancelExecution"), true);
});

test("isAllowedChannel rejects undeclared channels", () => {
  assert.equal(isAllowedChannel("fs:readFile"), false);
  assert.equal(isAllowedChannel("orchestration:noSuchVerb"), false);
  assert.equal(isAllowedChannel(""), false);
  assert.equal(isAllowedChannel("app:getRuntimeInfo "), false);
});
