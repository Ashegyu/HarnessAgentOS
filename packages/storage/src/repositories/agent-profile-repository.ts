import type {
  AgentProfile,
  AgentPermissions,
  AgentCliEnv,
  AgentModelTuning,
} from "@harness/core";
import {
  DEFAULT_AGENT_STALL_TIMEOUT_MS,
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
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
  /** Idempotent: seeds missing canonical profiles and curated framework profiles. */
  ensureSeed(): Promise<void>;
}

interface ProfileRow {
  id: string;
  name: string;
  description: string;
  category: string;
  tags_json: string;
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
  category: row.category,
  tags: JSON.parse(row.tags_json) as string[],
  provider: row.provider as AgentProfile["provider"],
  role: row.role as AgentProfile["role"],
  persona: row.persona,
  tuning: normalizeTuning(
    JSON.parse(row.tuning_json) as AgentModelTuning,
    row.provider as AgentProfile["provider"],
  ),
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
const normalizeTuning = (
  tuning: AgentModelTuning,
  provider: AgentProfile["provider"],
): AgentModelTuning => ({
  ...tuning,
  model:
    provider === "codex" && tuning.model.trim().toLowerCase() === "gpt-5"
      ? DEFAULT_CODEX_MODEL
      : tuning.model,
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

const normalizeTags = (tags: readonly string[]): string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of tags) {
    const value = tag.trim().toLowerCase();
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
};

const normalizeProfile = (profile: AgentProfile): AgentProfile => ({
  ...profile,
  category: profile.category.trim().toLowerCase() || "core",
  tags: normalizeTags(profile.tags),
  tuning: normalizeTuning(profile.tuning, profile.provider),
});

const SELECT = `SELECT id, name, description, category, tags_json, provider, role, persona,
       tuning_json, cli_json, permissions_json,
       mcp_server_ids_json, skill_source_ids_json,
       is_default, created_at, updated_at
  FROM agent_profiles`;

type SeedAgentProfile = Omit<AgentProfile, "createdAt" | "updatedAt" | "isDefault">;

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
           name = ?, description = ?, category = ?, tags_json = ?, provider = ?, role = ?, persona = ?,
           tuning_json = ?, cli_json = ?, permissions_json = ?,
           mcp_server_ids_json = ?, skill_source_ids_json = ?,
           is_default = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        updated.name,
        updated.description,
        updated.category,
        JSON.stringify(updated.tags),
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
    // that already has profiles (e.g. migrated from legacy settings); the
    // framework catalogue below is deduped by stable id/name independently.
    const coveredRoles = new Set(existing.map((p) => p.role));
    const rolesToSeed = (
      ["planner", "coder", "reviewer", "tester"] as const
    ).filter((r) => !coveredRoles.has(r));

    const now = nowIso();
    const hasExistingDefault = existing.some((p) => p.isDefault);
    const knownIds = new Set(existing.map((p) => p.id));
    const knownNames = new Set(existing.map((p) => p.name.trim().toLowerCase()));

    const defaultTuning = (model = ""): AgentModelTuning => ({
      model,
      timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
      stallTimeoutMs: DEFAULT_AGENT_STALL_TIMEOUT_MS,
      contextDepth: 10,
      systemPromptPrefix: "",
      systemPromptSuffix: "",
    });
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
    const readOnlyPermissions: AgentPermissions = {
      autoApproveActions: [],
      blockedActions: [
        "file_write",
        "shell",
        "dependency_install",
        "git_commit",
        "network",
        "skill_script",
      ],
      allowedSkillIds: [],
      toolAllowlist: [],
      toolDenylist: [],
    };
    const codeProposalPermissions: AgentPermissions = {
      autoApproveActions: [],
      blockedActions: [
        "dependency_install",
        "git_commit",
        "network",
        "skill_script",
      ],
      allowedSkillIds: [],
      toolAllowlist: [],
      toolDenylist: [],
    };
    const testRunnerPermissions: AgentPermissions = {
      autoApproveActions: [],
      blockedActions: [
        "file_write",
        "dependency_install",
        "git_commit",
        "network",
        "skill_script",
      ],
      allowedSkillIds: [],
      toolAllowlist: [],
      toolDenylist: [],
    };

    // Full catalogue of canonical seed profiles (all 4 roles). Only entries
    // whose role appears in `rolesToSeed` will actually be inserted.
    const catalogue: Omit<SeedAgentProfile, "id">[] = [
      {
        name: "Planner",
        description:
          "Strategic planning and task decomposition. Breaks complex requests into actionable steps and coordinates downstream agents.",
        category: "core",
        tags: ["planning", "decomposition", "coordination"],
        provider: "auto",
        role: "planner",
        persona:
          "You are a senior engineering lead specialising in requirement analysis and sprint planning. Your goal is to produce clear, unambiguous task breakdowns that a coding agent can implement without additional clarification.",
        tuning: defaultTuning(),
        cli: defaultCli,
        permissions: defaultPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        name: "Coder",
        description:
          "Implements features and fixes bugs. Writes clean, well-typed code following the project's conventions.",
        category: "core",
        tags: ["coding", "implementation", "bugfix"],
        provider: "auto",
        role: "coder",
        persona:
          "You are an experienced full-stack engineer who writes concise, correct, and maintainable code. You follow the project's coding style, prefer editing existing files over creating new ones, and never add unnecessary abstractions.",
        tuning: defaultTuning(),
        cli: defaultCli,
        permissions: defaultPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        name: "Reviewer",
        description:
          "Reviews code changes for quality, security, and correctness. Produces a prioritised issue list.",
        category: "core",
        tags: ["review", "quality", "correctness"],
        provider: "auto",
        role: "reviewer",
        persona:
          "You are a meticulous code reviewer focused on correctness, security, and maintainability. You classify findings by severity (CRITICAL / HIGH / MEDIUM / LOW) and provide specific, actionable feedback with file and line references.",
        tuning: defaultTuning(),
        cli: defaultCli,
        permissions: defaultPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        name: "Tester",
        description:
          "Writes and runs tests to validate behaviour. Ensures new code paths are covered before merge.",
        category: "core",
        tags: ["testing", "verification", "tdd"],
        provider: "auto",
        role: "tester",
        persona:
          "You are a quality-assurance engineer who writes thorough, readable tests following a test-driven approach. You write the test first (RED), then confirm the implementation passes it (GREEN), and flag any coverage gaps.",
        tuning: defaultTuning(),
        cli: defaultCli,
        permissions: defaultPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
    ];

    const frameworkCatalogue: SeedAgentProfile[] = [
      {
        id: "ap_framework_ruflo_orchestrator",
        name: "Ruflo Orchestrator",
        description:
          "Plans hierarchical worker topologies and handoff contracts inspired by Ruflo's Queen Agent and background-worker model.",
        category: "orchestration",
        tags: ["ruflo", "queen-agent", "handoff", "worker-topology"],
        provider: "claude",
        role: "planner",
        persona:
          "You are a workflow orchestrator. Decompose large goals into bounded worker tasks, define dependencies, handoff payloads, progress checkpoints, and result-merging rules. Prefer small verifiable slices and call out where Harness approvals are required before any side effect.",
        tuning: defaultTuning(DEFAULT_CLAUDE_MODEL),
        cli: defaultCli,
        permissions: readOnlyPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_agno_trace_planner",
        name: "Agno Trace Planner",
        description:
          "Designs auditable run-state and policy traces for production agent workflows using Agno-style observability patterns.",
        category: "observability",
        tags: ["agno", "trace", "audit", "policy"],
        provider: "claude",
        role: "planner",
        persona:
          "You are a production agent-flow planner focused on traceability. For every proposed workflow, define run-state transitions, policy checkpoints, observable evidence, failure recovery, and the exact data that should be persisted for review.",
        tuning: defaultTuning(DEFAULT_CLAUDE_MODEL),
        cli: defaultCli,
        permissions: readOnlyPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_codex_bulk_coder",
        name: "Codex Bulk Coder",
        description:
          "Implements multi-file code changes from a proven plan while keeping dependency, network, and git actions under explicit approval.",
        category: "implementation",
        tags: ["codex", "bulk-codegen", "multi-file", "approved-plan"],
        provider: "codex",
        role: "coder",
        persona:
          "You are a Codex implementation worker for larger code batches. Follow the approved plan exactly, keep edits scoped to the assigned files, preserve existing architecture boundaries, and return changed paths plus verification evidence. Do not install dependencies or commit unless the Harness approval flow explicitly allows it.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL),
        cli: defaultCli,
        permissions: codeProposalPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_ecc_refactor_cleaner",
        name: "ECC Refactor Cleaner",
        description:
          "Applies ECC-style focused cleanup for dead code, duplication, and maintainability issues after behavior is covered by tests.",
        category: "refactoring",
        tags: ["ecc", "cleanup", "dead-code", "maintainability"],
        provider: "codex",
        role: "coder",
        persona:
          "You are a refactoring specialist. Preserve behavior, avoid broad rewrites, remove dead code only with evidence, reduce meaningful duplication, and keep each change easy to review. Verify with the narrowest relevant tests before reporting completion.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL),
        cli: defaultCli,
        permissions: codeProposalPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_ecc_tdd_guide",
        name: "ECC TDD Guide",
        description:
          "Guides RED/GREEN/REFACTOR test design and focused verification for new features and bug fixes.",
        category: "testing",
        tags: ["ecc", "tdd", "red-green-refactor", "coverage"],
        provider: "claude",
        role: "tester",
        persona:
          "You are a TDD guide. Start by identifying the failing behavior and the smallest meaningful test, then define the minimal implementation signal and refactor checks. Distinguish test defects from product defects and report coverage gaps plainly.",
        tuning: defaultTuning(DEFAULT_CLAUDE_MODEL),
        cli: defaultCli,
        permissions: testRunnerPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_ecc_build_resolver",
        name: "ECC Build Error Resolver",
        description:
          "Diagnoses build, typecheck, and runtime test failures incrementally with evidence-first fixes.",
        category: "build",
        tags: ["ecc", "build", "typecheck", "diagnostics"],
        provider: "codex",
        role: "tester",
        persona:
          "You are a build-error resolver. Read the first real failure, trace it to the owning module, make the smallest corrective change, and rerun the targeted verification before widening scope. Do not mask errors by weakening tests or deleting checks.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL),
        cli: defaultCli,
        permissions: testRunnerPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_ecc_security_reviewer",
        name: "ECC Security Reviewer",
        description:
          "Performs security-first review for secrets, injection, approval bypass, path traversal, and unsafe execution surfaces.",
        category: "security",
        tags: ["ecc", "security", "approval-bypass", "injection"],
        provider: "claude",
        role: "reviewer",
        persona:
          "You are a security reviewer. Prioritize exploitable issues, secret exposure, prompt-injection paths, approval bypasses, path traversal, unsafe shell execution, dependency risk, and overbroad permissions. Report findings by severity with exact evidence and remediation.",
        tuning: defaultTuning(DEFAULT_CLAUDE_MODEL),
        cli: defaultCli,
        permissions: readOnlyPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_dotnet_performance_reviewer",
        name: "C# Performance Reviewer",
        description:
          "Reviews .NET changes for allocation, GC pressure, async overhead, serialization, and benchmark coverage.",
        category: "performance",
        tags: ["dotnet", "csharp", "performance", "gc"],
        provider: "codex",
        role: "reviewer",
        persona:
          "You are a read-only .NET performance reviewer. Inspect diffs for boxing, LINQ in hot paths, closure allocation, avoidable async state machines, per-frame allocations, string concatenation, collection growth, Span/Memory/ArrayPool/ObjectPool lifetime issues, System.Text.Json source-generation opportunities, and missing tests or benchmarks. Do not edit files.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL),
        cli: defaultCli,
        permissions: readOnlyPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
    ];

    // Insert only missing canonical roles. The very first inserted canonical
    // profile becomes the default when there is no existing default yet.
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
      knownIds.add(profile.id);
      knownNames.add(profile.name.trim().toLowerCase());
      firstInserted = false;
    }

    for (const entry of frameworkCatalogue) {
      const nameKey = entry.name.trim().toLowerCase();
      if (knownIds.has(entry.id) || knownNames.has(nameKey)) continue;
      const profile: AgentProfile = {
        ...entry,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      };
      this.insertRow(profile);
      knownIds.add(profile.id);
      knownNames.add(nameKey);
    }
  }

  private insertRow(p: AgentProfile): void {
    this.db
      .prepare(
        `INSERT INTO agent_profiles
          (id, name, description, category, tags_json, provider, role, persona,
           tuning_json, cli_json, permissions_json,
           mcp_server_ids_json, skill_source_ids_json,
           is_default, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        p.id,
        p.name,
        p.description,
        p.category,
        JSON.stringify(p.tags),
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
