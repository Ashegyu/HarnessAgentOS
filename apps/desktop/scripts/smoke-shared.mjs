// Shared bootstrap for Phase 8 smoke scripts.
//
// Usage (smoke-agent-fake.mjs / smoke-agent-live.mjs):
//   import { bootstrap, makeAgentTask, dumpDetail, expect } from "./smoke-shared.mjs";
//
// Both smoke scripts run outside of Electron, so we open the same SQLite DB
// LocalStateService uses in production but in a temp directory. The
// `rebuild:node` script in apps/desktop/package.json must be run first
// (or `npm test` already did it for the current node version).

import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openDb,
  closeDb,
  LocalStateService,
} from "../../../packages/storage/src/index.ts";
import { ConversationService } from "../../../packages/core/src/conversation/conversation-service.ts";
import {
  AgentInvocationQueue,
  AgentPlanningService,
} from "../../../packages/agent/src/index.ts";

/**
 * Create a throwaway temp directory + open a fresh SQLite DB.
 * Returns wiring + cleanup. Callers MUST call ctx.cleanup() in a finally.
 */
export const bootstrap = ({ providers, adapter } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-smoke-"));
  const dbFile = join(dir, "smoke.db");
  const projectDir = join(dir, "project");
  mkdirSync(projectDir, { recursive: true });

  const db = openDb({ filePath: dbFile });
  const state = new LocalStateService(db);

  const conversation = new ConversationService({
    state,
    pathExists: async (p) => existsSync(p),
  });

  const queue = new AgentInvocationQueue();
  let cached = providers ?? {
    claude: { available: true, version: "fake-1.0.0", queueDepth: 0 },
    codex: { available: false, error: "not configured", queueDepth: 0 },
  };

  const agent = new AgentPlanningService({
    state,
    queue,
    getProviderStatus: () => cached,
    ...(adapter ? { adapter } : {}),
    emitStreamEvent: () => {},
    defaults: { timeoutMs: 30_000, stallTimeoutMs: 10_000 },
  });

  const refreshProviders = (next) => {
    cached = next;
  };

  return {
    dir,
    dbFile,
    projectDir,
    db,
    state,
    conversation,
    agent,
    queue,
    refreshProviders,
    cleanup: () => {
      try {
        closeDb(db);
      } catch {
        // ignore — best effort
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

/**
 * Create a thread + agent-mode TaskRun ready for `agent.generatePlan`.
 */
export const makeAgentTask = async (ctx, userRequest) => {
  const thread = await ctx.state.createThread({
    title: "smoke",
    targetDir: ctx.projectDir,
  });
  const draft = await ctx.conversation.createTask({
    threadId: thread.id,
    userRequest,
    targetDir: ctx.projectDir,
    mode: "agent",
  });
  return { thread, draft };
};

/**
 * Pretty-print a TaskRunDetail-like snapshot for smoke output.
 */
export const dumpDetail = async (ctx, taskRunId) => {
  const taskRun = await ctx.state.getTaskRun(taskRunId);
  const artifacts = await ctx.state.listArtifactsByTaskRun(taskRunId);
  const approvals = await ctx.state.listApprovalsByTaskRun(taskRunId);
  const invocations = await ctx.state.listAgentInvocationsByTaskRun(taskRunId);
  return {
    status: taskRun?.status,
    artifactKinds: artifacts.map((a) => a.kind),
    approvalCount: approvals.length,
    invocationStatuses: invocations.map((i) => i.status),
  };
};

/**
 * Tiny assertion helper so smoke scripts can stay framework-free.
 */
export const expect = (cond, label) => {
  if (cond) {
    // eslint-disable-next-line no-console
    console.log(`  PASS  ${label}`);
    return;
  }
  // eslint-disable-next-line no-console
  console.error(`  FAIL  ${label}`);
  process.exitCode = 1;
  throw new Error(`smoke assertion failed: ${label}`);
};

export const header = (title) => {
  // eslint-disable-next-line no-console
  console.log(`\n=== ${title} ===`);
};
