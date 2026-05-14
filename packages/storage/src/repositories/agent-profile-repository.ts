import type {
  AgentProfile,
  AgentPermissions,
  AgentCliEnv,
  AgentModelTuning,
} from "@harness/core";
import {
  DEFAULT_AGENT_STALL_TIMEOUT_MS,
  DEFAULT_AGENT_TIMEOUT_MS,
} from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { newId, nowIso } from "../id.ts";

/**
 * CRUD for AgentProfile rows — see docs/design/agent-detailed-settings.md §4.1.
 *
 * Nested objects (tuning/cli/permissions/mcpServerIds/skillSourceIds) are
 * stored as JSON columns. The repository serializes on the way in and
 * parses on the way out; callers see plain JS objects.
 */
export type CreateAgentProfileInput = Omit<
  AgentProfile,
  "id" | "createdAt" | "updatedAt"
>;

export interface AgentProfileRepository {
  list(): Promise<AgentProfile[]>;
  get(id: string): Promise<AgentProfile | null>;
  create(input: CreateAgentProfileInput): Promise<AgentProfile>;
  update(profile: AgentProfile): Promise<AgentProfile>;
  delete(id: string): Promise<void>;
  setDefault(id: string): Promise<AgentProfile>;
  /** Idempotent: seeds 4 example profiles if the table is empty. */
  ensureSeed(): Promise<void>;
}

interface ProfileRow {
  id: string;
  name: string;
  description: string;
  provider: string;
  role: string;
  persona: string;
  tuning_json: string;
  cli_json: string;
  permissions_json: string;
  mcp_server_ids_json: string;
  skill_source_ids_json: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

const rowToProfile = (row: ProfileRow): AgentProfile => ({
  id: row.id,
  name: row.name,
  description: row.description,
  provider: row.provider as AgentProfile["provider"],
  role: row.role as AgentProfile["role"],
  persona: row.persona,
  tuning: normalizeTuning(JSON.parse(row.tuning_json) as AgentModelTuning),
  cli: JSON.parse(row.cli_json) as AgentCliEnv,
  permissions: JSON.parse(row.permissions_json) as AgentPermissions,
  mcpServerIds: JSON.parse(row.mcp_server_ids_json) as string[],
  skillSourceIds: JSON.parse(row.skill_source_ids_json) as string[],
  isDefault: row.is_default === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Existing installations can carry historical profile-level timeouts
 * (120s hard / 30s stall). Profiles win over global settings during
 * invocation, so normalize them at the repository boundary too.
 */
const normalizeTuning = (tuning: AgentModelTuning): AgentModelTuning => ({
  ...tuning,
  timeoutMs:
    !tuning.timeoutMs || tuning.timeoutMs < DEFAULT_AGENT_TIMEOUT_MS
      ? DEFAULT_AGENT_TIMEOUT_MS
      : tuning.timeoutMs,
  stallTimeoutMs:
    !tuning.stallTimeoutMs ||
    tuning.stallTimeoutMs < DEFAULT_AGENT_STALL_TIMEOUT_MS
      ? DEFAULT_AGENT_STALL_TIMEOUT_MS
      : tuning.stallTimeoutMs,
});

const normalizeProfile = (profile: AgentProfile): AgentProfile => ({
  ...profile,
  tuning: normalizeTuning(profile.tuning),
});

const SELECT = `SELECT id, name, description, provider, role, persona,
       tuning_json, cli_json, permissions_json,
       mcp_server_ids_json, skill_source_ids_json,
       is_default, created_at, updated_at
  FROM agent_profiles`;

export class SqliteAgentProfileRepository implements AgentProfileRepository {
  private readonly db: HarnessDb;
  constructor(db: HarnessDb) {
    this.db = db;
  }

  async list(): Promise<AgentProfile[]> {
    const rows = this.db
      .prepare<[], ProfileRow>(`${SELECT} ORDER BY created_at ASC`)
      .all();
    return rows.map(rowToProfile);
  }

  async get(id: string): Promise<AgentProfile | null> {
    const row = this.db
      .prepare<[string], ProfileRow>(`${SELECT} WHERE id = ?`)
      .get(id);
    return row ? rowToProfile(row) : null;
  }

  async create(input: CreateAgentProfileInput): Promise<AgentProfile> {
    const id = newId("agentProfile");
    const now = nowIso();
    const profile: AgentProfile = {
      ...input,
      id,
      createdAt: now,
      updatedAt: now,
    };
    const normalized = normalizeProfile(profile);
    this.insertRow(normalized);
    return normalized;
  }

  async update(profile: AgentProfile): Promise<AgentProfile> {
    const updated: AgentProfile = normalizeProfile({
      ...profile,
      updatedAt: nowIso(),
    });
    this.db
      .prepare(
        `UPDATE agent_profiles SET
           name = ?, description = ?, provider = ?, role = ?, persona = ?,
           tuning_json = ?, cli_json = ?, permissions_json = ?,
           mcp_server_ids_json = ?, skill_source_ids_json = ?,
           is_default = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        updated.name,
        updated.description,
        updated.provider,
        updated.role,
        updated.persona,
        JSON.stringify(updated.tuning),
        JSON.stringify(updated.cli),
        JSON.stringify(updated.permissions),
        JSON.stringify(updated.mcpServerIds),
        JSON.stringify(updated.skillSourceIds),
        updated.isDefault ? 1 : 0,
        updated.updatedAt,
        updated.id,
      );
    return updated;
  }

  async delete(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM agent_profiles WHERE id = ?`).run(id);
  }

  /**
   * Atomic promotion. The partial unique index on is_default=1 means we
   * must demote the prior default before flipping the new one within the
   * same transaction; otherwise the unique constraint fires mid-update.
   */
  async setDefault(id: string): Promise<AgentProfile> {
    const txn = this.db.transaction((targetId: string) => {
      this.db.prepare(`UPDATE agent_profiles SET is_default = 0`).run();
      this.db
        .prepare(
          `UPDATE agent_profiles SET is_default = 1, updated_at = ? WHERE id = ?`,
        )
        .run(nowIso(), targetId);
    });
    txn(id);
    const refreshed = await this.get(id);
    if (!refreshed) {
      throw new Error(`AgentProfile not found after setDefault: ${id}`);
    }
    return refreshed;
  }

  async ensureSeed(): Promise<void> {
    const existing = await this.list();

    // Determine which of the 4 canonical roles are already covered so we
    // only insert what is actually missing. This is safe to call on a DB
    // that already has profiles (e.g. migrated from legacy settings) — we
    // never overwrite or duplicate an existing role entry.
    const coveredRoles = new Set(existing.map((p) => p.role));
    const rolesToSeed = (
      ["planner", "coder", "reviewer", "tester"] as const
    ).filter((r) => !coveredRoles.has(r));

    if (rolesToSeed.length === 0) return;

    const now = nowIso();
    const hasExistingDefault = existing.some((p) => p.isDefault);

    const defaultTuning: AgentModelTuning = {
      model: "",
      timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
      stallTimeoutMs: DEFAULT_AGENT_STALL_TIMEOUT_MS,
      contextDepth: 10,
      systemPromptPrefix: "",
      systemPromptSuffix: "",
    };
    const defaultCli: AgentCliEnv = {
      cliPathOverride: "",
      env: {},
      envSecretRefs: {},
    };
    const defaultPermissions: AgentPermissions = {
      autoApproveActions: [],
      blockedActions: [],
      allowedSkillIds: [],
      toolAllowlist: [],
      toolDenylist: [],
    };

    // Full catalogue of seed profiles (all 4 roles). Only entries whose
    // role appears in `rolesToSeed` will actually be inserted.
    const catalogue: Omit<AgentProfile, "id" | "createdAt" | "updatedAt" | "isDefault">[] = [
      {
        name: "Planner",
        description:
          "Strategic planning and task decomposition. Breaks complex requests into actionable steps and coordinates downstream agents.",
        provider: "auto",
        role: "planner",
        persona:
          "You are a senior engineering lead specialising in requirement analysis and sprint planning. Your goal is to produce clear, unambiguous task breakdowns that a coding agent can implement without additional clarification.",
        tuning: defaultTuning,
        cli: defaultCli,
        permissions: defaultPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        name: "Coder",
        description:
          "Implements features and fixes bugs. Writes clean, well-typed code following the project's conventions.",
        provider: "auto",
        role: "coder",
        persona:
          "You are an experienced full-stack engineer who writes concise, correct, and maintainable code. You follow the project's coding style, prefer editing existing files over creating new ones, and never add unnecessary abstractions.",
        tuning: defaultTuning,
        cli: defaultCli,
        permissions: defaultPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        name: "Reviewer",
        description:
          "Reviews code changes for quality, security, and correctness. Produces a prioritised issue list.",
        provider: "auto",
        role: "reviewer",
        persona:
          "You are a meticulous code reviewer focused on correctness, security, and maintainability. You classify findings by severity (CRITICAL / HIGH / MEDIUM / LOW) and provide specific, actionable feedback with file and line references.",
        tuning: defaultTuning,
        cli: defaultCli,
        permissions: defaultPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        name: "Tester",
        description:
          "Writes and runs tests to validate behaviour. Ensures new code paths are covered before merge.",
        provider: "auto",
        role: "tester",
        persona:
          "You are a quality-assurance engineer who writes thorough, readable tests following a test-driven approach. You write the test first (RED), then confirm the implementation passes it (GREEN), and flag any coverage gaps.",
        tuning: defaultTuning,
        cli: defaultCli,
        permissions: defaultPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
    ];

    // Insert only missing roles. The very first inserted profile becomes the
    // default when there is no existing default yet.
    let firstInserted = true;
    for (const entry of catalogue) {
      if (!rolesToSeed.includes(entry.role as AgentProfile["role"])) continue;
      const profile: AgentProfile = {
        ...entry,
        id: newId("agentProfile"),
        isDefault: !hasExistingDefault && firstInserted,
        createdAt: now,
        updatedAt: now,
      };
      this.insertRow(profile);
      firstInserted = false;
    }
  }

  private insertRow(p: AgentProfile): void {
    this.db
      .prepare(
        `INSERT INTO agent_profiles
          (id, name, description, provider, role, persona,
           tuning_json, cli_json, permissions_json,
           mcp_server_ids_json, skill_source_ids_json,
           is_default, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        p.id,
        p.name,
        p.description,
        p.provider,
        p.role,
        p.persona,
        JSON.stringify(p.tuning),
        JSON.stringify(p.cli),
        JSON.stringify(p.permissions),
        JSON.stringify(p.mcpServerIds),
        JSON.stringify(p.skillSourceIds),
        p.isDefault ? 1 : 0,
        p.createdAt,
        p.updatedAt,
      );
  }
}
