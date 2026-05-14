import {
  DEFAULT_HARNESS_SETTINGS,
  type ApprovalSettings,
  type HarnessSettings,
  type OrchestrationSettings,
} from "@harness/core";
import type { HarnessDb } from "../db.ts";

const SETTINGS_KEY = "harness_settings";

export interface SettingsRepository {
  get(): Promise<HarnessSettings>;
  update(settings: HarnessSettings): Promise<HarnessSettings>;
}

export class SqliteSettingsRepository implements SettingsRepository {
  private readonly db: HarnessDb;
  constructor(db: HarnessDb) {
    this.db = db;
  }

  async get(): Promise<HarnessSettings> {
    const row = this.db
      .prepare<[string], { value: string }>(
        "SELECT value FROM settings WHERE key = ?",
      )
      .get(SETTINGS_KEY);

    if (!row) return structuredClone(DEFAULT_HARNESS_SETTINGS);

    try {
      return normalizeSettings(JSON.parse(row.value) as HarnessSettings);
    } catch {
      return structuredClone(DEFAULT_HARNESS_SETTINGS);
    }
  }

  async update(settings: HarnessSettings): Promise<HarnessSettings> {
    this.db
      .prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(SETTINGS_KEY, JSON.stringify(settings));

    return settings;
  }
}

/**
 * Promote legacy timeout values to the current defaults so existing DB
 * rows benefit from streaming-aware budgets without requiring a user-
 * visible migration step. The historical defaults (120s total / 30s
 * stall) were unworkable with the non-streaming Claude CLI invocation —
 * any pre-existing row carrying those exact numbers gets bumped up.
 */
const normalizeSettings = (s: HarnessSettings): HarnessSettings => {
  const d = DEFAULT_HARNESS_SETTINGS.agent;
  const agent = { ...s.agent };
  if (!agent.timeoutMs || agent.timeoutMs < d.timeoutMs) {
    agent.timeoutMs = d.timeoutMs;
  }
  if (!agent.stallTimeoutMs || agent.stallTimeoutMs < d.stallTimeoutMs) {
    agent.stallTimeoutMs = d.stallTimeoutMs;
  }
  const so = s.orchestration as Partial<OrchestrationSettings> | null | undefined;
  const od = DEFAULT_HARNESS_SETTINGS.orchestration;
  const orchestration: OrchestrationSettings = {
    enabled: typeof so?.enabled === "boolean" ? so.enabled : false,
    defaultMode: so?.defaultMode ?? od.defaultMode,
    defaultInstructions: so?.defaultInstructions ?? "",
    workerProfiles: Array.isArray(so?.workerProfiles) ? so.workerProfiles : [],
    defaultPipelineId:
      typeof so?.defaultPipelineId === "string" ? so.defaultPipelineId : "",
  };
  const ap = s.approval as Partial<ApprovalSettings> | null | undefined;
  const approval: ApprovalSettings = {
    autoApprove: typeof ap?.autoApprove === "boolean" ? ap.autoApprove : false,
    autoExecuteWorkerFileActions:
      typeof ap?.autoExecuteWorkerFileActions === "boolean"
        ? ap.autoExecuteWorkerFileActions
        : false,
  };
  return { ...s, agent, orchestration, approval };
};
