import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IPC_CHANNELS,
  ALLOWED_IPC_CHANNELS,
  isAllowedChannel,
} from "./index.ts";

test("declared namespaces match the phases shipped so far", () => {
  // Phase-by-phase additions per docs/contracts/ipc-contracts.md.
  // Phase 0: app, Phase 1: state, Phase 2: conversation, Phase 3: runner,
  // Phase 4: quality, Phase 5: capability, Phase 6: learner,
  // Phase 7: orchestration, Phase 8: agent.
  assert.deepEqual(Object.keys(IPC_CHANNELS).sort(), [
    "agent",
    "app",
    "capability",
    "conversation",
    "events",
    "learner",
    "orchestration",
    "quality",
    "runner",
    "state",
  ]);
});

test("events namespace exposes id-only + scoped chunk push channels", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.events).sort(), [
    "agentStreamEvent",
    "taskRunChanged",
  ]);
  assert.equal(isAllowedChannel("events:taskRunChanged"), true);
  assert.equal(isAllowedChannel("events:agentStreamEvent"), true);
});

test("agent namespace exposes Phase 8 verbs", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.agent).sort(), [
    "cancelInvocation",
    "checkProviders",
    "generatePlan",
    "retryInvocation",
    "useTemplateFallback",
  ]);
});

test("app namespace exposes runtime + selectDirectory + selectFile", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.app).sort(), [
    "getRuntimeInfo",
    "getVersion",
    "selectDirectory",
    "selectFile",
  ]);
});

test("state namespace exposes Phase 1 verbs only", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.state).sort(), [
    "createThread",
    "getThread",
    "listThreads",
  ]);
});

test("conversation namespace exposes Phase 2/3 + state-action verbs", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.conversation).sort(), [
    "approve",
    "cancelTask",
    "createTask",
    "getTaskRunDetail",
    "pauseTask",
    "redirectTask",
    "rejectApproval",
    "resumeTask",
    "setProposedAction",
  ]);
});

test("runner namespace exposes Phase 3 + retry verbs", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.runner).sort(), [
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
    "proposeScriptRun",
    "readSkill",
    "refresh",
    "suggest",
  ]);
});

test("learner namespace exposes Phase 6 verbs", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.learner).sort(), [
    "getTrace",
    "recommend",
    "recordDecision",
    "recordOutcome",
    "recordSelection",
  ]);
});

test("orchestration namespace exposes Phase 7 verbs", () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS.orchestration).sort(), [
    "draftPlan",
    "getPlan",
    "runApproved",
  ]);
});

test("channel strings use namespace:verb format", () => {
  for (const channel of ALLOWED_IPC_CHANNELS) {
    assert.match(
      channel,
      /^[a-z]+:[a-zA-Z]+$/,
      `channel "${channel}" violates namespace:verb format`,
    );
  }
});

test("isAllowedChannel accepts declared channels", () => {
  assert.equal(isAllowedChannel("app:getVersion"), true);
  assert.equal(isAllowedChannel("conversation:createTask"), true);
  assert.equal(isAllowedChannel("runner:executeApproved"), true);
});

test("isAllowedChannel rejects undeclared channels", () => {
  assert.equal(isAllowedChannel("fs:readFile"), false);
  assert.equal(isAllowedChannel("orchestration:noSuchVerb"), false);
  assert.equal(isAllowedChannel(""), false);
  assert.equal(isAllowedChannel("app:getRuntimeInfo "), false);
});
