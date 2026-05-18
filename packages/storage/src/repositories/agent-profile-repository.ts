import type {
  AgentProfile,
  AgentBudget,
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
  budget_json: string | null;
  mcp_server_ids_json: string;
  skill_source_ids_json: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

const rowToProfile = (row: ProfileRow): AgentProfile => {
  const provider = row.provider as AgentProfile["provider"];
  const permissions = normalizePermissions(
    JSON.parse(row.permissions_json) as AgentPermissions,
    parseBudget(row.budget_json),
  );
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    tags: JSON.parse(row.tags_json) as string[],
    provider,
    role: row.role as AgentProfile["role"],
    persona: row.persona,
    tuning: normalizeTuning(JSON.parse(row.tuning_json) as AgentModelTuning, provider),
    cli: JSON.parse(row.cli_json) as AgentCliEnv,
    permissions,
    mcpServerIds: JSON.parse(row.mcp_server_ids_json) as string[],
    skillSourceIds: JSON.parse(row.skill_source_ids_json) as string[],
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

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

const normalizeBudget = (budget: AgentBudget | undefined): AgentBudget | undefined => {
  if (!budget) return undefined;
  const next: AgentBudget = {};
  if (typeof budget.perInvocationUsd === "number" && Number.isFinite(budget.perInvocationUsd) && budget.perInvocationUsd >= 0) {
    next.perInvocationUsd = budget.perInvocationUsd;
  }
  if (typeof budget.perTaskRunUsd === "number" && Number.isFinite(budget.perTaskRunUsd) && budget.perTaskRunUsd >= 0) {
    next.perTaskRunUsd = budget.perTaskRunUsd;
  }
  if (typeof budget.perDayUsd === "number" && Number.isFinite(budget.perDayUsd) && budget.perDayUsd >= 0) {
    next.perDayUsd = budget.perDayUsd;
  }
  return Object.keys(next).length > 0 ? next : undefined;
};

const parseBudget = (json: string | null): AgentBudget | undefined => {
  if (!json) return undefined;
  try {
    return normalizeBudget(JSON.parse(json) as AgentBudget);
  } catch {
    return undefined;
  }
};

const stripBudget = (permissions: AgentPermissions): Omit<AgentPermissions, "budget"> => ({
  autoApproveActions: permissions.autoApproveActions,
  blockedActions: permissions.blockedActions,
  allowedSkillIds: permissions.allowedSkillIds,
  toolAllowlist: permissions.toolAllowlist,
  toolDenylist: permissions.toolDenylist,
});

const normalizePermissions = (
  permissions: AgentPermissions,
  budgetOverride?: AgentBudget,
): AgentPermissions => {
  const budget = normalizeBudget(budgetOverride ?? permissions.budget);
  return budget
    ? { ...stripBudget(permissions), budget }
    : stripBudget(permissions);
};

const normalizeProfile = (profile: AgentProfile): AgentProfile => ({
  ...profile,
  category: profile.category.trim().toLowerCase() || "core",
  tags: normalizeTags(profile.tags),
  tuning: normalizeTuning(profile.tuning, profile.provider),
  permissions: normalizePermissions(profile.permissions),
});

const SELECT = `SELECT id, name, description, category, tags_json, provider, role, persona,
       tuning_json, cli_json, permissions_json, budget_json,
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
           tuning_json = ?, cli_json = ?, permissions_json = ?, budget_json = ?,
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
        JSON.stringify(stripBudget(updated.permissions)),
        updated.permissions.budget ? JSON.stringify(updated.permissions.budget) : null,
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
    const rolesToSeed = new Set<AgentProfile["role"]>(
      (["planner", "coder", "reviewer", "tester"] as const).filter(
        (r) => !coveredRoles.has(r),
      ),
    );

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
          "복잡한 요청을 실행 가능한 단계, 위험, 검증 기준으로 분해하고 downstream 에이전트를 조정합니다.",
        category: "core",
        tags: ["planning", "decomposition", "coordination"],
        provider: "auto",
        role: "planner",
        persona:
          "당신은 요구사항 분석과 작업 분해에 강한 시니어 엔지니어링 리드입니다. 사용자의 요청을 모호하지 않은 실행 단계, 의존성, 위험, 검증 기준으로 나누고 코딩 에이전트가 추가 질문 없이 구현할 수 있는 계획을 작성하세요.",
        tuning: defaultTuning(),
        cli: defaultCli,
        permissions: defaultPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        name: "Coder",
        description:
          "프로젝트 관례를 따르며 기능 구현과 버그 수정을 수행하고 변경 근거를 남깁니다.",
        category: "core",
        tags: ["coding", "implementation", "bugfix"],
        provider: "auto",
        role: "coder",
        persona:
          "당신은 간결하고 정확하며 유지보수 가능한 코드를 작성하는 숙련된 풀스택 엔지니어입니다. 기존 프로젝트 구조와 코딩 스타일을 우선하고, 새 추상화는 실제 복잡도를 줄일 때만 추가하세요. 변경 파일과 검증 결과를 명확히 보고하세요.",
        tuning: defaultTuning(),
        cli: defaultCli,
        permissions: defaultPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        name: "Reviewer",
        description:
          "코드 변경의 정확성, 보안, 유지보수성을 검토하고 우선순위가 있는 이슈 목록을 작성합니다.",
        category: "core",
        tags: ["review", "quality", "correctness"],
        provider: "auto",
        role: "reviewer",
        persona:
          "당신은 정확성, 보안, 유지보수성에 집중하는 꼼꼼한 코드 리뷰어입니다. 발견 사항은 CRITICAL, HIGH, MEDIUM, LOW로 분류하고 파일과 라인 근거, 재현 가능한 문제, 구체적인 수정 방향을 함께 제시하세요.",
        tuning: defaultTuning(),
        cli: defaultCli,
        permissions: defaultPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        name: "Tester",
        description:
          "테스트 설계와 실행으로 변경 동작을 검증하고 누락된 검증 범위를 드러냅니다.",
        category: "core",
        tags: ["testing", "verification", "tdd"],
        provider: "auto",
        role: "tester",
        persona:
          "당신은 테스트 주도 접근을 따르는 품질 엔지니어입니다. 실패해야 하는 테스트를 먼저 정의하고, 구현이 통과하는지 확인한 뒤, 남은 회귀 위험과 커버리지 공백을 한국어로 명확히 보고하세요.",
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
          "Ruflo의 Queen Agent와 background-worker 모델을 참고해 계층형 worker topology와 handoff 계약을 설계합니다.",
        category: "orchestration",
        tags: ["ruflo", "queen-agent", "handoff", "worker-topology"],
        provider: "claude",
        role: "orchestrator",
        persona:
          "당신은 workflow orchestrator입니다. 큰 목표를 책임 범위가 분명한 worker task로 나누고, dependency, handoff payload, 진행 checkpoint, 결과 병합 규칙을 정의하세요. 검증 가능한 작은 단위를 선호하고, side effect 전 Harness approval이 필요한 지점을 명확히 표시하세요.",
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
          "Agno식 observability 패턴을 참고해 production agent workflow의 run-state와 policy trace를 설계합니다.",
        category: "observability",
        tags: ["agno", "trace", "audit", "policy"],
        provider: "claude",
        role: "orchestrator",
        persona:
          "당신은 추적 가능성에 집중하는 production agent-flow planner입니다. 제안하는 모든 workflow에 대해 run-state 전이, policy checkpoint, 관찰 가능한 증거, 실패 복구 방식, 리뷰를 위해 저장해야 할 정확한 데이터를 정의하세요.",
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
          "승인된 계획을 바탕으로 multi-file 코드 변경을 구현하되 dependency, network, git 작업은 명시적 approval 아래에 둡니다.",
        category: "implementation",
        tags: ["codex", "bulk-codegen", "multi-file", "approved-plan"],
        provider: "codex",
        role: "coder",
        persona:
          "당신은 큰 코드 변경 묶음을 담당하는 Codex 구현 worker입니다. 승인된 계획을 정확히 따르고, 할당된 파일 범위 안에서만 수정하며, 기존 아키텍처 경계를 보존하세요. 변경 경로와 검증 증거를 반환하고, Harness approval flow가 명시적으로 허용하지 않는 한 dependency 설치나 commit은 수행하지 마세요.",
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
          "테스트로 보호된 범위에서 dead code, 중복, 유지보수성 문제를 ECC 방식으로 좁게 정리합니다.",
        category: "refactoring",
        tags: ["ecc", "cleanup", "dead-code", "maintainability"],
        provider: "codex",
        role: "refactor-cleaner",
        persona:
          "당신은 리팩터링 전문가입니다. 동작을 보존하고 넓은 재작성은 피하며, dead code는 증거가 있을 때만 제거하세요. 의미 있는 중복을 줄이고 각 변경이 쉽게 리뷰되도록 유지하세요. 완료 보고 전 가장 좁고 관련 있는 테스트로 검증하세요.",
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
          "새 기능과 버그 수정에 대해 RED/GREEN/REFACTOR 테스트 설계와 집중 검증을 안내합니다.",
        category: "testing",
        tags: ["ecc", "tdd", "red-green-refactor", "coverage"],
        provider: "claude",
        role: "tester",
        persona:
          "당신은 TDD guide입니다. 먼저 실패해야 하는 동작과 가장 작은 의미 있는 테스트를 식별하고, 최소 구현 신호와 refactor 확인 항목을 정의하세요. 테스트 결함과 제품 결함을 구분하고 커버리지 공백을 분명히 보고하세요.",
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
          "빌드, 타입체크, 런타임 테스트 실패를 evidence-first 방식으로 단계적으로 진단하고 수정합니다.",
        category: "build",
        tags: ["ecc", "build", "typecheck", "diagnostics"],
        provider: "codex",
        role: "build-error-resolver",
        persona:
          "당신은 build-error resolver입니다. 첫 번째 실제 실패를 읽고 소유 모듈까지 추적한 뒤, 가장 작은 수정안을 제안하세요. 범위를 넓히기 전 targeted verification을 다시 실행하고, 테스트를 약화하거나 check를 삭제해 오류를 숨기지 마세요.",
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
          "secret, injection, approval bypass, path traversal, unsafe execution surface를 보안 우선으로 검토합니다.",
        category: "security",
        tags: ["ecc", "security", "approval-bypass", "injection"],
        provider: "claude",
        role: "security-reviewer",
        persona:
          "당신은 security reviewer입니다. 악용 가능한 문제, secret 노출, prompt-injection 경로, approval bypass, path traversal, unsafe shell execution, dependency risk, 과도한 권한을 우선 검토하세요. 발견 사항은 심각도, 정확한 근거, 수정 방향과 함께 보고하세요.",
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
          ".NET 변경의 allocation, GC pressure, async overhead, serialization, benchmark coverage를 검토합니다.",
        category: "performance",
        tags: ["dotnet", "csharp", "performance", "gc"],
        provider: "codex",
        role: "performance-reviewer",
        persona:
          "당신은 read-only .NET performance reviewer입니다. boxing, hot path의 LINQ, closure allocation, 피할 수 있는 async state machine, per-frame allocation, string concatenation, collection growth, Span/Memory/ArrayPool/ObjectPool lifetime 문제, System.Text.Json source-generation 기회, 누락된 테스트나 benchmark를 점검하세요. 파일은 수정하지 마세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL),
        cli: defaultCli,
        permissions: readOnlyPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
    ];

    this.localizeLegacySeedText({
      existing,
      desiredProfiles: [...catalogue, ...frameworkCatalogue],
      updatedAt: now,
    });

    // Insert only missing canonical roles. The very first inserted canonical
    // profile becomes the default when there is no existing default yet.
    let firstInserted = true;
    for (const entry of catalogue) {
      if (!rolesToSeed.has(entry.role)) continue;
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
           tuning_json, cli_json, permissions_json, budget_json,
           mcp_server_ids_json, skill_source_ids_json,
           is_default, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        JSON.stringify(stripBudget(p.permissions)),
        p.permissions.budget ? JSON.stringify(p.permissions.budget) : null,
        JSON.stringify(p.mcpServerIds),
        JSON.stringify(p.skillSourceIds),
        p.isDefault ? 1 : 0,
        p.createdAt,
        p.updatedAt,
      );
  }

  private localizeLegacySeedText(input: {
    existing: readonly AgentProfile[];
    desiredProfiles: readonly Pick<
      AgentProfile,
      "name" | "description" | "persona"
    >[];
    updatedAt: string;
  }): void {
    const desiredByName = new Map(
      input.desiredProfiles.map((profile) => [
        profile.name.trim().toLowerCase(),
        profile,
      ]),
    );
    for (const profile of input.existing) {
      const desired = desiredByName.get(profile.name.trim().toLowerCase());
      const legacy = LEGACY_ENGLISH_SEED_TEXT[profile.name];
      if (!desired || !legacy) continue;
      const description =
        profile.description === legacy.description
          ? desired.description
          : profile.description;
      const persona =
        profile.persona === legacy.persona ? desired.persona : profile.persona;
      if (
        description === profile.description &&
        persona === profile.persona
      ) {
        continue;
      }
      this.db
        .prepare(
          `UPDATE agent_profiles
              SET description = ?, persona = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(description, persona, input.updatedAt, profile.id);
    }
  }
}

const LEGACY_ENGLISH_SEED_TEXT: Record<
  string,
  { description: string; persona: string }
> = {
  Planner: {
    description:
      "Strategic planning and task decomposition. Breaks complex requests into actionable steps and coordinates downstream agents.",
    persona:
      "You are a senior engineering lead specialising in requirement analysis and sprint planning. Your goal is to produce clear, unambiguous task breakdowns that a coding agent can implement without additional clarification.",
  },
  Coder: {
    description:
      "Implements features and fixes bugs. Writes clean, well-typed code following the project's conventions.",
    persona:
      "You are an experienced full-stack engineer who writes concise, correct, and maintainable code. You follow the project's coding style, prefer editing existing files over creating new ones, and never add unnecessary abstractions.",
  },
  Reviewer: {
    description:
      "Reviews code changes for quality, security, and correctness. Produces a prioritised issue list.",
    persona:
      "You are a meticulous code reviewer focused on correctness, security, and maintainability. You classify findings by severity (CRITICAL / HIGH / MEDIUM / LOW) and provide specific, actionable feedback with file and line references.",
  },
  Tester: {
    description:
      "Writes and runs tests to validate behaviour. Ensures new code paths are covered before merge.",
    persona:
      "You are a quality-assurance engineer who writes thorough, readable tests following a test-driven approach. You write the test first (RED), then confirm the implementation passes it (GREEN), and flag any coverage gaps.",
  },
  "Ruflo Orchestrator": {
    description:
      "Plans hierarchical worker topologies and handoff contracts inspired by Ruflo's Queen Agent and background-worker model.",
    persona:
      "You are a workflow orchestrator. Decompose large goals into bounded worker tasks, define dependencies, handoff payloads, progress checkpoints, and result-merging rules. Prefer small verifiable slices and call out where Harness approvals are required before any side effect.",
  },
  "Agno Trace Planner": {
    description:
      "Designs auditable run-state and policy traces for production agent workflows using Agno-style observability patterns.",
    persona:
      "You are a production agent-flow planner focused on traceability. For every proposed workflow, define run-state transitions, policy checkpoints, observable evidence, failure recovery, and the exact data that should be persisted for review.",
  },
  "Codex Bulk Coder": {
    description:
      "Implements multi-file code changes from a proven plan while keeping dependency, network, and git actions under explicit approval.",
    persona:
      "You are a Codex implementation worker for larger code batches. Follow the approved plan exactly, keep edits scoped to the assigned files, preserve existing architecture boundaries, and return changed paths plus verification evidence. Do not install dependencies or commit unless the Harness approval flow explicitly allows it.",
  },
  "ECC Refactor Cleaner": {
    description:
      "Applies ECC-style focused cleanup for dead code, duplication, and maintainability issues after behavior is covered by tests.",
    persona:
      "You are a refactoring specialist. Preserve behavior, avoid broad rewrites, remove dead code only with evidence, reduce meaningful duplication, and keep each change easy to review. Verify with the narrowest relevant tests before reporting completion.",
  },
  "ECC TDD Guide": {
    description:
      "Guides RED/GREEN/REFACTOR test design and focused verification for new features and bug fixes.",
    persona:
      "You are a TDD guide. Start by identifying the failing behavior and the smallest meaningful test, then define the minimal implementation signal and refactor checks. Distinguish test defects from product defects and report coverage gaps plainly.",
  },
  "ECC Build Error Resolver": {
    description:
      "Diagnoses build, typecheck, and runtime test failures incrementally with evidence-first fixes.",
    persona:
      "You are a build-error resolver. Read the first real failure, trace it to the owning module, make the smallest corrective change, and rerun the targeted verification before widening scope. Do not mask errors by weakening tests or deleting checks.",
  },
  "ECC Security Reviewer": {
    description:
      "Performs security-first review for secrets, injection, approval bypass, path traversal, and unsafe execution surfaces.",
    persona:
      "You are a security reviewer. Prioritize exploitable issues, secret exposure, prompt-injection paths, approval bypasses, path traversal, unsafe shell execution, dependency risk, and overbroad permissions. Report findings by severity with exact evidence and remediation.",
  },
  "C# Performance Reviewer": {
    description:
      "Reviews .NET changes for allocation, GC pressure, async overhead, serialization, and benchmark coverage.",
    persona:
      "You are a read-only .NET performance reviewer. Inspect diffs for boxing, LINQ in hot paths, closure allocation, avoidable async state machines, per-frame allocations, string concatenation, collection growth, Span/Memory/ArrayPool/ObjectPool lifetime issues, System.Text.Json source-generation opportunities, and missing tests or benchmarks. Do not edit files.",
  },
};
