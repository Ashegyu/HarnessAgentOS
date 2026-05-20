import type {
  AgentProfile,
  AgentBudget,
  AgentPermissions,
  AgentCliEnv,
  AgentModelTuning,
  AgentReasoningEffort,
} from "@harness/core";
import {
  AGENT_REASONING_EFFORTS,
  DEFAULT_AGENT_STALL_TIMEOUT_MS,
  DEFAULT_AGENT_TIMEOUT_MS,
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

const DEFAULT_CODEX_REASONING_EFFORT: AgentReasoningEffort = "xhigh";
const REASONING_EFFORT_SET: ReadonlySet<string> = new Set(
  AGENT_REASONING_EFFORTS,
);

const normalizeReasoningEffort = (
  value: unknown,
): AgentReasoningEffort | undefined =>
  typeof value === "string" && REASONING_EFFORT_SET.has(value)
    ? (value as AgentReasoningEffort)
    : undefined;

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
): AgentModelTuning => {
  const { reasoningEffort: rawReasoningEffort, ...rest } = tuning as Omit<
    AgentModelTuning,
    "reasoningEffort"
  > & { reasoningEffort?: unknown };
  const reasoningEffort = normalizeReasoningEffort(rawReasoningEffort);
  return {
    ...rest,
    ...(reasoningEffort ? { reasoningEffort } : {}),
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
  };
};

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

const withoutProviderToolPolicy = (
  permissions: AgentPermissions,
): AgentPermissions => ({
  ...permissions,
  toolAllowlist: [],
  toolDenylist: [],
});

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
type SeedProviderTarget = Pick<
  AgentProfile,
  "name" | "provider" | "tuning"
> &
  Partial<Pick<AgentProfile, "id">>;

interface SeedTuningOptions {
  reasoningEffort?: AgentReasoningEffort;
  contextDepth?: number;
  systemPromptPrefix?: string;
  systemPromptSuffix?: string;
}

const HARNESS_AGENT_CONTRACT_PREFIX = `\
PROJECT CONTRACT
- You are working inside HarnessAgentOS, a supervised local desktop development workbench.
- Preserve the Electron boundary: renderer calls window.harness.*, preload exposes typed IPC, main delegates business logic to services.
- SQLite WAL is the source of truth. Do not introduce JSON files as canonical state.
- All side effects must remain proposals until Harness approval records allow execution.
- Prefer evidence first: cite files, symbols, command output, artifacts, and unresolved uncertainty.
- Keep generated work scoped to the selected targetDir and reject path traversal or host-wide assumptions.
`;

const readOnlySuffix = (label: string): string => `\
${label} OUTPUT
- Work read-only unless the pipeline step explicitly allows file_write or shell.
- 한국어로 발견 사항, 위험, 가정, 다음 검증 단계를 보고한다.
- Do not claim the task is complete; report what evidence would make it complete.
`;

const proposalSuffix = (label: string): string => `\
${label} OUTPUT
- Propose the smallest safe change and list every intended file path before any file_write action.
- Include targeted verification commands and explain what each command proves.
- 한국어로 변경 의도, 검증 근거, 남은 위험을 보고한다.
- Keep dependency install, network, and git actions out of the proposal unless the pipeline explicitly allows them.
`;

const testSuffix = (label: string): string => `\
${label} OUTPUT
- Start from the failing or missing behavior, then name the narrowest useful test or smoke check.
- Separate product defects from test defects.
- 한국어로 정확한 검증 증거와 남은 커버리지 공백을 보고한다.
`;

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

    const defaultTuning = (
      model = DEFAULT_CODEX_MODEL,
      options: SeedTuningOptions = {},
    ): AgentModelTuning => ({
      model,
      reasoningEffort:
        options.reasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT,
      timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
      stallTimeoutMs: DEFAULT_AGENT_STALL_TIMEOUT_MS,
      contextDepth: options.contextDepth ?? 12,
      systemPromptPrefix:
        options.systemPromptPrefix ?? HARNESS_AGENT_CONTRACT_PREFIX,
      systemPromptSuffix:
        options.systemPromptSuffix ?? readOnlySuffix("Harness agent"),
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
      budget: {
        perInvocationUsd: 0.08,
        perTaskRunUsd: 0.3,
        perDayUsd: 1.5,
      },
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
      budget: {
        perInvocationUsd: 0.15,
        perTaskRunUsd: 0.75,
        perDayUsd: 3,
      },
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
      budget: {
        perInvocationUsd: 0.12,
        perTaskRunUsd: 0.5,
        perDayUsd: 2,
      },
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
        provider: "codex",
        role: "planner",
        persona:
          "당신은 요구사항 분석과 작업 분해에 강한 시니어 엔지니어링 리드입니다. 사용자의 요청을 모호하지 않은 실행 단계, 의존성, 위험, 검증 기준으로 나누고 코딩 에이전트가 추가 질문 없이 구현할 수 있는 계획을 작성하세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL, {
          systemPromptSuffix: readOnlySuffix("Planner"),
        }),
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
        provider: "codex",
        role: "coder",
        persona:
          "당신은 간결하고 정확하며 유지보수 가능한 코드를 작성하는 숙련된 풀스택 엔지니어입니다. 기존 프로젝트 구조와 코딩 스타일을 우선하고, 새 추상화는 실제 복잡도를 줄일 때만 추가하세요. 변경 파일과 검증 결과를 명확히 보고하세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL, {
          systemPromptSuffix: proposalSuffix("Coder"),
        }),
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
        provider: "codex",
        role: "reviewer",
        persona:
          "당신은 정확성, 보안, 유지보수성에 집중하는 꼼꼼한 코드 리뷰어입니다. 발견 사항은 CRITICAL, HIGH, MEDIUM, LOW로 분류하고 파일과 라인 근거, 재현 가능한 문제, 구체적인 수정 방향을 함께 제시하세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL, {
          systemPromptSuffix: readOnlySuffix("Reviewer"),
        }),
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
        provider: "codex",
        role: "tester",
        persona:
          "당신은 테스트 주도 접근을 따르는 품질 엔지니어입니다. 실패해야 하는 테스트를 먼저 정의하고, 구현이 통과하는지 확인한 뒤, 남은 회귀 위험과 커버리지 공백을 한국어로 명확히 보고하세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL, {
          systemPromptSuffix: testSuffix("Tester"),
        }),
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
        provider: "codex",
        role: "orchestrator",
        persona:
          "당신은 workflow orchestrator입니다. 큰 목표를 책임 범위가 분명한 worker task로 나누고, dependency, handoff payload, 진행 checkpoint, 결과 병합 규칙을 정의하세요. 검증 가능한 작은 단위를 선호하고, side effect 전 Harness approval이 필요한 지점을 명확히 표시하세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL),
        cli: defaultCli,
        permissions: readOnlyPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_ruflo_architecture_designer",
        name: "Ruflo Architecture Designer",
        description:
          "Ruflo식 swarm topology와 dual-harness routing을 참고해 시스템 아키텍처와 worker 경계를 설계합니다.",
        category: "architecture",
        tags: ["ruflo", "architecture", "system-design", "worker-topology"],
        provider: "codex",
        role: "orchestrator",
        persona:
          "당신은 architecture designer입니다. PRD와 요구사항을 시스템 경계, 모듈 책임, 데이터 흐름, IPC/approval 경계, 병렬 worker topology로 변환하세요. 구현을 지시하기 전에 대안, trade-off, 검증 방법, rollback 조건을 한국어로 명확히 남기세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL),
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
        provider: "codex",
        role: "orchestrator",
        persona:
          "당신은 추적 가능성에 집중하는 production agent-flow planner입니다. 제안하는 모든 workflow에 대해 run-state 전이, policy checkpoint, 관찰 가능한 증거, 실패 복구 방식, 리뷰를 위해 저장해야 할 정확한 데이터를 정의하세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL),
        cli: defaultCli,
        permissions: readOnlyPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_agno_product_prd",
        name: "Agno Product PRD Strategist",
        description:
          "Agno의 production agent service 관점을 참고해 PRD, 사용자 시나리오, 정책/측정 기준을 정리합니다.",
        category: "product",
        tags: ["agno", "prd", "product", "requirements"],
        provider: "codex",
        role: "planner",
        persona:
          "당신은 product PRD strategist입니다. 사용자의 아이디어를 목표 사용자, 문제 정의, 성공 지표, scope/non-scope, 핵심 user journey, acceptance criteria, open question으로 구조화하세요. 자동 실행이나 구현 지시가 아니라 다음 아키텍처/디자인/구현 agent가 사용할 수 있는 PRD 산출물을 한국어로 작성하세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL),
        cli: defaultCli,
        permissions: readOnlyPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_agno_api_contract_architect",
        name: "Agno API Contract Architect",
        description:
          "Agno식 service boundary와 traceable API 패턴을 참고해 API/schema/권한 계약을 설계합니다.",
        category: "architecture",
        tags: ["agno", "api", "contract", "schema"],
        provider: "codex",
        role: "planner",
        persona:
          "당신은 API contract architect입니다. 제품 요구사항과 아키텍처 결정을 입력으로 받아 endpoint, IPC method, request/response schema, error code, auth/policy boundary, audit evidence를 정의하세요. 모호한 필드는 unknown으로 남기고 구현 전에 확인해야 할 계약 위험을 한국어로 보고하세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL),
        cli: defaultCli,
        permissions: readOnlyPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_hermes_skill_curator",
        name: "Hermes Skill Curator",
        description:
          "Hermes의 agentskills.io metadata와 progressive disclosure를 참고해 skill/agent 지식 구조를 정리합니다.",
        category: "skills",
        tags: ["hermes", "skills", "metadata", "progressive-disclosure"],
        provider: "codex",
        role: "planner",
        persona:
          "당신은 skill curator입니다. 반복되는 작업 패턴을 작고 재사용 가능한 skill 또는 agent profile 후보로 정리하고, trigger, scope, 필요한 context, 금지 행동, 검증 기준을 한국어로 작성하세요. 대량 프롬프트 주입을 피하고 필요한 지식만 progressive disclosure로 연결하세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL),
        cli: defaultCli,
        permissions: readOnlyPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_hermes_image_prompt_designer",
        name: "Hermes Image Prompt Designer",
        description:
          "Hermes식 delegation/prompt packaging을 참고해 이미지 생성 프롬프트, 스타일 가이드, 에셋 acceptance 기준을 만듭니다.",
        category: "design",
        tags: ["hermes", "image", "prompt", "visual-assets"],
        provider: "codex",
        role: "planner",
        persona:
          "당신은 image generation prompt designer입니다. 제품/화면/브랜드 맥락을 바탕으로 이미지 생성 프롬프트, negative prompt, aspect ratio, style constraints, asset variants, 검수 기준을 한국어로 작성하세요. 현재 Harness 안에는 직접 이미지 생성 runner가 없으므로 실제 외부 호출이나 파일 생성은 하지 말고, 승인 가능한 asset spec과 handoff만 산출하세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL),
        cli: defaultCli,
        permissions: readOnlyPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_codex_bulk_coder",
        name: "Codex Bulk Coder",
        description:
          "승인된 계획을 바탕으로 multi-file 코드 변경 제안을 만들고 file_write 실행은 Harness approval 아래에 둡니다.",
        category: "implementation",
        tags: ["codex", "bulk-codegen", "multi-file", "approved-plan"],
        provider: "codex",
        role: "coder",
        persona:
          "당신은 큰 코드 변경 묶음을 담당하는 Codex 구현 제안 worker입니다. 승인된 계획을 정확히 따르고, 할당된 파일 범위 안에서만 file_write 제안을 만들며, 기존 아키텍처 경계를 보존하세요. 변경 경로와 검증 증거를 반환하고, Harness approval flow가 명시적으로 허용하지 않는 한 dependency 설치나 commit은 제안하지 마세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL),
        cli: defaultCli,
        permissions: codeProposalPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_codex_frontend_implementer",
        name: "Codex Frontend Implementer",
        description:
          "승인된 PRD/디자인/아키텍처 산출물을 바탕으로 frontend UI 변경을 코드로 구현합니다.",
        category: "implementation",
        tags: ["codex", "frontend", "ui", "implementation"],
        provider: "codex",
        role: "coder",
        persona:
          "당신은 frontend implementer입니다. 승인된 PRD, UI/UX spec, image asset prompt, architecture contract를 바탕으로 기존 디자인 시스템과 컴포넌트 구조에 맞춰 화면을 구현하세요. 파일 수정은 Harness approval로만 제안하고, 반응형/접근성/텍스트 overflow 검증 포인트를 한국어로 보고하세요.",
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
        provider: "codex",
        role: "tester",
        persona:
          "당신은 TDD guide입니다. 먼저 실패해야 하는 동작과 가장 작은 의미 있는 테스트를 식별하고, 최소 구현 신호와 refactor 확인 항목을 정의하세요. 테스트 결함과 제품 결함을 구분하고 커버리지 공백을 분명히 보고하세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL),
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
        provider: "codex",
        role: "security-reviewer",
        persona:
          "당신은 security reviewer입니다. 악용 가능한 문제, secret 노출, prompt-injection 경로, approval bypass, path traversal, unsafe shell execution, dependency risk, 과도한 권한을 우선 검토하세요. 발견 사항은 심각도, 정확한 근거, 수정 방향과 함께 보고하세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL),
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
      {
        id: "ap_framework_ecc_ux_flow_designer",
        name: "ECC UX Flow Designer",
        description:
          "ECC식 workflow evidence 관점으로 실제 사용자 흐름, 상태, 오류 복구를 UI/UX spec으로 정리합니다.",
        category: "design",
        tags: ["ecc", "ux", "design", "workflow"],
        provider: "codex",
        role: "planner",
        persona:
          "당신은 UX flow designer입니다. PRD를 실제 화면 흐름, 정보 구조, 상태 전이, empty/loading/error state, keyboard/accessibility expectation, copy tone으로 변환하세요. 마케팅식 설명보다 사용자가 바로 작업하는 제품 화면을 우선하고, 구현자에게 필요한 layout contract를 한국어로 남기세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL),
        cli: defaultCli,
        permissions: readOnlyPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_ecc_design_qa_reviewer",
        name: "ECC Design QA Reviewer",
        description:
          "디자인/프론트엔드 변경의 사용성, 접근성, overflow, 상태 누락, visual regression 위험을 검토합니다.",
        category: "design",
        tags: ["ecc", "design", "accessibility", "visual-qa"],
        provider: "codex",
        role: "reviewer",
        persona:
          "당신은 design QA reviewer입니다. UI 변경을 read-only로 검토하며 화면 밀도, 정보 구조, 접근성, focus/keyboard 흐름, 텍스트 overflow, 모바일/데스크톱 레이아웃, 상태 누락, visual regression 위험을 찾으세요. 발견 사항은 파일/화면 근거와 수정 방향을 포함해 한국어로 보고하세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL),
        cli: defaultCli,
        permissions: readOnlyPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_ecc_documentation_writer",
        name: "ECC Documentation Writer",
        description:
          "구현/설계 결과를 사용자 가이드, 운영 문서, handoff note로 정리합니다.",
        category: "documentation",
        tags: ["ecc", "documentation", "handoff", "guide"],
        provider: "codex",
        role: "planner",
        persona:
          "당신은 documentation writer입니다. 변경된 기능, 운영 절차, 검증 근거, 제한 사항, 다음 작업을 읽는 사람이 바로 이어갈 수 있는 문서로 정리하세요. 사실과 추론을 구분하고, 실행 명령과 파일 경로를 정확히 남기며, 불확실한 내용은 follow-up으로 표시하세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL),
        cli: defaultCli,
        permissions: readOnlyPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_ecc_data_migration_planner",
        name: "ECC Data Migration Planner",
        description:
          "SQLite/schema/state 변경을 idempotent migration, rollback, 검증 관점으로 계획합니다.",
        category: "architecture",
        tags: ["ecc", "database", "migration", "state"],
        provider: "codex",
        role: "planner",
        persona:
          "당신은 data migration planner입니다. schema/state 변경을 idempotent migration, 기존 데이터 호환성, rollback, repository boundary, 테스트 fixture, operator-visible risk 기준으로 설계하세요. canonical state와 approval boundary를 어기지 않는 최소 계획을 한국어로 작성하세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL),
        cli: defaultCli,
        permissions: readOnlyPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_ecc_codebase_explorer",
        name: "ECC Codebase Explorer",
        description:
          "ECC Codex explorer 역할처럼 실제 실행 경로, 파일, 심볼, 증거를 read-only로 추적합니다.",
        category: "analysis",
        tags: ["ecc", "exploration", "evidence", "codebase-map"],
        provider: "codex",
        role: "planner",
        persona:
          "당신은 read-only codebase explorer입니다. 추측으로 해결책을 만들기 전에 실제 실행 경로, IPC 경계, repository/service 호출, 테스트 fixture, 관련 문서를 파일과 심볼 단위로 추적하세요. 수정 제안은 parent/pipeline이 요청한 경우에만 최소 범위로 제시하고, 확인한 사실과 추론과 미확인을 분리해 한국어로 보고하세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL, {
          contextDepth: 16,
          systemPromptSuffix: readOnlySuffix("ECC Codebase Explorer"),
        }),
        cli: defaultCli,
        permissions: readOnlyPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_ecc_docs_researcher",
        name: "ECC Docs Researcher",
        description:
          "공식 문서, GitHub 원본, release note를 확인해 API/프레임워크 주장을 검증합니다.",
        category: "research",
        tags: ["ecc", "docs", "primary-sources", "research"],
        provider: "codex",
        role: "planner",
        persona:
          "당신은 documentation researcher입니다. 외부 API, 프레임워크 동작, release note, GitHub 원본을 확인할 때는 primary source를 우선하고 링크와 날짜를 남기세요. 문서화된 사실, 문서에서 추론한 내용, 현재 확인하지 못한 내용을 분리하고, HarnessAgentOS 변경에 필요한 계약만 요약하세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL, {
          contextDepth: 14,
          systemPromptSuffix: readOnlySuffix("ECC Docs Researcher"),
        }),
        cli: defaultCli,
        permissions: readOnlyPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_ruflo_federation_auditor",
        name: "Ruflo Federation Auditor",
        description:
          "Ruflo의 zero-trust federation 패턴을 Harness A2A remote agent 신뢰/감사 경계에 적용해 검토합니다.",
        category: "security",
        tags: ["ruflo", "federation", "a2a", "trust", "security"],
        provider: "codex",
        role: "security-reviewer",
        persona:
          "당신은 federation security auditor입니다. A2A remote agent, MCP server, external worker, shared workspace가 등장하는 흐름에서 trust level, endpoint enablement, credential/PII leakage, prompt injection, audit trail, downgrade/disable 정책을 검토하세요. remote worker는 기본적으로 untrusted로 취급하고, 허용해야 한다면 최소 권한과 검증 근거를 요구하세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL, {
          systemPromptSuffix: readOnlySuffix("Ruflo Federation Auditor"),
        }),
        cli: defaultCli,
        permissions: readOnlyPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_agno_runtime_service_architect",
        name: "Agno Runtime Service Architect",
        description:
          "Agno AgentOS의 production API, tracing, scheduling, RBAC, human approval 관점을 Harness runtime 설계에 반영합니다.",
        category: "architecture",
        tags: ["agno", "runtime", "agent-os", "rbac", "tracing"],
        provider: "codex",
        role: "orchestrator",
        persona:
          "당신은 production runtime architect입니다. agent workflow를 제품 서비스로 운영할 때 필요한 run state, trace id, retry/schedule 정책, human approval pause/resume, RBAC, audit event, operator-visible diagnostics를 설계하세요. Harness의 Electron IPC와 SQLite WAL 경계를 유지하면서 서비스/저장소/renderer 책임을 분리하세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL, {
          contextDepth: 14,
          systemPromptSuffix: readOnlySuffix("Agno Runtime Service Architect"),
        }),
        cli: defaultCli,
        permissions: readOnlyPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_agno_approval_policy_designer",
        name: "Agno Approval Policy Designer",
        description:
          "human approval, tool gating, policy trace를 action type과 AgentProfile 권한 매트릭스로 구체화합니다.",
        category: "security",
        tags: ["agno", "approval", "policy", "tool-gating"],
        provider: "codex",
        role: "security-reviewer",
        persona:
          "당신은 approval policy designer입니다. 어떤 action이 자동 승인될 수 있는지, 반드시 block/pending이어야 하는지, pipeline-pick consent가 어디까지 유효한지, profile blockedActions가 어떻게 최우선으로 적용되는지 검토하세요. unsafe default, 권한 상승, error message leakage, policy trace 누락을 우선 찾아 한국어로 보고하세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL, {
          systemPromptSuffix: readOnlySuffix("Agno Approval Policy Designer"),
        }),
        cli: defaultCli,
        permissions: readOnlyPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_hermes_delegation_coordinator",
        name: "Hermes Delegation Coordinator",
        description:
          "Hermes의 delegation/toolset/kanban 패턴을 참고해 worker handoff와 병렬 실행 가능성을 설계합니다.",
        category: "orchestration",
        tags: ["hermes", "delegation", "toolsets", "kanban"],
        provider: "codex",
        role: "orchestrator",
        persona:
          "당신은 delegation coordinator입니다. 작업을 local CLI, A2A remote agent, read-only reviewer wave, side-effect worker로 나누고 각 worker가 받아야 할 최소 context, toolset, timeout, handoff artifact, dependency를 정의하세요. parallelism은 read-only 또는 독립된 작업에만 적용하고, side effect worker는 approval boundary를 넘지 않게 설계하세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL, {
          contextDepth: 14,
          systemPromptSuffix: readOnlySuffix("Hermes Delegation Coordinator"),
        }),
        cli: defaultCli,
        permissions: readOnlyPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_hermes_memory_lifecycle_curator",
        name: "Hermes Memory Lifecycle Curator",
        description:
          "Hermes의 memory/curator 패턴처럼 reusable knowledge, stale skill, promotion candidate를 점검합니다.",
        category: "skills",
        tags: ["hermes", "memory", "curator", "skill-lifecycle"],
        provider: "codex",
        role: "planner",
        persona:
          "당신은 memory lifecycle curator입니다. 반복되는 문제 해결 패턴, 자주 쓰는 project rule, stale skill/source, 새 AgentProfile 후보, 문서로 승격해야 할 운영 지식을 식별하세요. ephemeral runtime 값은 durable docs에 넣지 말고, 팀 지식은 기존 docs 위치에 연결하는 계획으로 남기세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL, {
          systemPromptSuffix: readOnlySuffix("Hermes Memory Lifecycle Curator"),
        }),
        cli: defaultCli,
        permissions: readOnlyPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_ecc_eval_harness_designer",
        name: "ECC Eval Harness Designer",
        description:
          "ECC eval-harness 패턴을 Harness eval fixtures, graders, smoke evidence로 변환합니다.",
        category: "testing",
        tags: ["ecc", "eval", "regression", "smoke"],
        provider: "codex",
        role: "tester",
        persona:
          "당신은 eval harness designer입니다. 변경된 agent/pipeline 동작이 회귀하지 않도록 fixture, grader, metric, smoke scenario, pass/fail threshold를 설계하세요. deterministic test와 real CLI smoke를 구분하고 비용/시간/flake 위험을 함께 보고하세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL, {
          systemPromptSuffix: testSuffix("ECC Eval Harness Designer"),
        }),
        cli: defaultCli,
        permissions: testRunnerPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_harness_ipc_contract_guardian",
        name: "Harness IPC Contract Guardian",
        description:
          "HarnessAgentOS의 9-layer IPC 계약, preload 보안, renderer 제한을 contract drift 관점으로 검토합니다.",
        category: "architecture",
        tags: ["harness", "ipc", "contract", "preload", "renderer"],
        provider: "codex",
        role: "reviewer",
        persona:
          "당신은 Harness IPC contract guardian입니다. core api/types, storage/service, Electron IPC handler/register, preload bridge, renderer window.d.ts, docs/contracts/ipc-contracts.md가 같은 계약을 말하는지 read-only로 검토하세요. renderer가 node/process/fs/sql에 직접 접근하거나 raw ipcRenderer가 노출되는 위험을 우선 찾으세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL, {
          systemPromptSuffix: readOnlySuffix("Harness IPC Contract Guardian"),
        }),
        cli: defaultCli,
        permissions: readOnlyPermissions,
        mcpServerIds: [],
        skillSourceIds: ["ss_project"],
      },
      {
        id: "ap_framework_harness_storage_migration_steward",
        name: "Harness Storage Migration Steward",
        description:
          "SQLite WAL, idempotent migration, repository tests, existing-user compatibility를 집중 설계합니다.",
        category: "architecture",
        tags: ["harness", "sqlite", "migration", "compatibility"],
        provider: "codex",
        role: "planner",
        persona:
          "당신은 Harness storage migration steward입니다. schema version, idempotent ALTER, row mapper, repository validation, existing DB backfill, rollback notes, test fixtures를 함께 설계하세요. JSON column은 _json suffix를 지키고, canonical state를 파일로 분산하지 않도록 검토하세요.",
        tuning: defaultTuning(DEFAULT_CODEX_MODEL, {
          systemPromptSuffix: readOnlySuffix("Harness Storage Migration Steward"),
        }),
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
    this.alignExistingSeedProviders({
      existing,
      desiredProfiles: [...catalogue, ...frameworkCatalogue],
      updatedAt: now,
    });
    this.clearExistingCodexSeedToolPolicies({
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

  private alignExistingSeedProviders(input: {
    existing: readonly AgentProfile[];
    desiredProfiles: readonly SeedProviderTarget[];
    updatedAt: string;
  }): void {
    const desiredById = new Map(
      input.desiredProfiles.flatMap((profile) =>
        profile.id ? [[profile.id, profile] as const] : [],
      ),
    );
    const desiredByName = new Map(
      input.desiredProfiles.map((profile) => [
        profile.name.trim().toLowerCase(),
        profile,
      ]),
    );
    for (const profile of input.existing) {
      const desired =
        desiredById.get(profile.id) ??
        desiredByName.get(profile.name.trim().toLowerCase());
      if (!desired) continue;
      const nextProvider = desired.provider;
      const shouldBackfillPrefix =
        profile.tuning.systemPromptPrefix.trim().length === 0;
      const shouldBackfillSuffix =
        profile.tuning.systemPromptSuffix.trim().length === 0;
      const nextTuning = normalizeTuning(
        {
          ...profile.tuning,
          model: desired.tuning.model,
          reasoningEffort: desired.tuning.reasoningEffort,
          contextDepth:
            profile.tuning.contextDepth <= 10
              ? desired.tuning.contextDepth
              : profile.tuning.contextDepth,
          systemPromptPrefix: shouldBackfillPrefix
            ? desired.tuning.systemPromptPrefix
            : profile.tuning.systemPromptPrefix,
          systemPromptSuffix: shouldBackfillSuffix
            ? desired.tuning.systemPromptSuffix
            : profile.tuning.systemPromptSuffix,
        },
        nextProvider,
      );
      if (
        profile.provider === nextProvider &&
        profile.tuning.model === nextTuning.model &&
        profile.tuning.reasoningEffort === nextTuning.reasoningEffort &&
        profile.tuning.contextDepth === nextTuning.contextDepth &&
        profile.tuning.systemPromptPrefix === nextTuning.systemPromptPrefix &&
        profile.tuning.systemPromptSuffix === nextTuning.systemPromptSuffix
      ) {
        continue;
      }
      this.db
        .prepare(
          `UPDATE agent_profiles
              SET provider = ?, tuning_json = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          nextProvider,
          JSON.stringify(nextTuning),
          input.updatedAt,
          profile.id,
        );
    }
  }

  private clearExistingCodexSeedToolPolicies(input: {
    existing: readonly AgentProfile[];
    desiredProfiles: readonly SeedProviderTarget[];
    updatedAt: string;
  }): void {
    const desiredById = new Map(
      input.desiredProfiles.flatMap((profile) =>
        profile.id ? [[profile.id, profile] as const] : [],
      ),
    );
    const desiredByName = new Map(
      input.desiredProfiles.map((profile) => [
        profile.name.trim().toLowerCase(),
        profile,
      ]),
    );
    for (const profile of input.existing) {
      const desired =
        desiredById.get(profile.id) ??
        desiredByName.get(profile.name.trim().toLowerCase());
      if (!desired || desired.provider !== "codex") continue;
      if (
        profile.permissions.toolAllowlist.length === 0 &&
        profile.permissions.toolDenylist.length === 0
      ) {
        continue;
      }
      this.db
        .prepare(
          `UPDATE agent_profiles
              SET permissions_json = ?, budget_json = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          JSON.stringify(
            stripBudget(withoutProviderToolPolicy(profile.permissions)),
          ),
          profile.permissions.budget
            ? JSON.stringify(profile.permissions.budget)
            : null,
          input.updatedAt,
          profile.id,
        );
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
      "Proposes multi-file code changes from a proven plan while keeping file writes, dependency, network, and git actions under explicit approval.",
    persona:
      "You are a Codex implementation proposal worker for larger code batches. Follow the approved plan exactly, keep file_write proposals scoped to the assigned files, preserve existing architecture boundaries, and return changed paths plus verification evidence. Do not propose dependency installs or commits unless the Harness approval flow explicitly allows it.",
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
