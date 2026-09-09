import {
  isHarnessDefinition,
  type ApprovalActionType,
  type HarnessDefinition,
  type HarnessSourceFormat,
  type HarnessValidationStatus,
  type WorkerOutputContract,
} from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { nowIso } from "../id.ts";
import { isDeepStrictEqual } from "node:util";
import { additionalStarterDefinitions, upgradeLegacyStarter } from "./harness-starter-catalog.ts";

export interface HarnessPackageRepository {
  list(): Promise<HarnessDefinition[]>;
  get(id: string): Promise<HarnessDefinition | null>;
  save(definition: HarnessDefinition): Promise<HarnessDefinition>;
  remove(id: string): Promise<void>;
  ensureSeed(): Promise<void>;
}

interface HarnessSeedTemplate {
  id: string;
  name: string;
  legacyName: string;
  summary: string;
  agentRef: string;
  agentName: string;
  roleHint: string;
  instruction: string;
  outputContract: WorkerOutputContract;
  allowedActions: readonly ApprovalActionType[];
  triggerTerms: readonly string[];
}

const HARNESS_SEEDS: readonly HarnessSeedTemplate[] = [
  { id: "harness_seed_feature_delivery", legacyName: "Feature Delivery Harness", name: "기능 개발 하네스", summary: "제품 기능을 계획하고 구현한 뒤 검증합니다.", agentRef: "feature-builder", agentName: "기능 개발자", roleHint: "coder", instruction: "요청 동작을 추적하고 최소 구현을 제안한 뒤 검증된 변경안을 반환하세요.", outputContract: "diff_proposal", allowedActions: ["file_patch", "shell"], triggerTerms: ["기능", "구현", "개발"] },
  { id: "harness_seed_bug_investigation", legacyName: "Bug Investigation Harness", name: "버그 조사 하네스", summary: "결함을 재현하고 원인을 분리하여 회귀에 안전한 수정안을 준비합니다.", agentRef: "bug-investigator", agentName: "버그 조사자", roleHint: "coder", instruction: "재현 절차를 확립하고 근본 원인을 찾은 뒤 회귀 검증이 포함된 최소 수정안을 반환하세요.", outputContract: "diff_proposal", allowedActions: ["file_patch", "shell"], triggerTerms: ["버그", "수정", "회귀"] },
  { id: "harness_seed_code_review", legacyName: "Code Review Harness", name: "코드 리뷰 하네스", summary: "변경 사항의 정확성, 유지보수성, 회귀 위험을 검토합니다.", agentRef: "code-reviewer", agentName: "코드 리뷰어", roleHint: "reviewer", instruction: "변경 사항을 살펴보고 정확한 위치와 근거가 있는 검토 결과만 우선순위대로 보고하세요.", outputContract: "review", allowedActions: [], triggerTerms: ["리뷰", "변경", "품질"] },
  { id: "harness_seed_security", legacyName: "Security Hardening Harness", name: "보안 강화 하네스", summary: "신뢰 경계를 감사하고 실용적인 보안 강화 방안을 제안합니다.", agentRef: "security-reviewer", agentName: "보안 리뷰어", roleHint: "security-reviewer", instruction: "신뢰할 수 없는 입력, 권한, 보안정보와 부수효과를 추적하고 악용 가능한 위험과 완화책을 보고하세요.", outputContract: "review", allowedActions: [], triggerTerms: ["보안", "위협", "감사"] },
  { id: "harness_seed_performance", legacyName: "Performance Optimization Harness", name: "성능 최적화 하네스", summary: "병목 구간을 측정한 뒤 목표가 분명한 성능 변경을 제안합니다.", agentRef: "performance-reviewer", agentName: "성능 리뷰어", roleHint: "performance-reviewer", instruction: "기준값을 측정하고 주요 CPU·메모리·지연 비용을 찾아 측정 가능한 최적화를 제안하세요.", outputContract: "review", allowedActions: ["shell"], triggerTerms: ["성능", "지연", "벤치마크"] },
  { id: "harness_seed_test_automation", legacyName: "Test Automation Harness", name: "테스트 자동화 하네스", summary: "중요한 사용자 및 서비스 흐름에 집중된 자동화 테스트를 만듭니다.", agentRef: "test-engineer", agentName: "테스트 엔지니어", roleHint: "tester", instruction: "독립적인 테스트를 설계하고 관련 테스트만 실행하여 재현 가능한 성공 또는 실패 근거를 반환하세요.", outputContract: "test_result", allowedActions: ["file_patch", "shell"], triggerTerms: ["테스트", "커버리지", "E2E"] },
  { id: "harness_seed_documentation", legacyName: "Documentation Harness", name: "문서화 하네스", summary: "실제 구현을 바탕으로 정확한 개발자·운영자 문서를 작성합니다.", agentRef: "documenter", agentName: "문서 작성자", roleHint: "documenter", instruction: "구현된 동작을 추적하고 명령, 제약 사항과 예제를 포함한 간결한 문서를 준비하세요.", outputContract: "diff_proposal", allowedActions: ["file_patch"], triggerTerms: ["문서", "안내서", "README"] },
  { id: "harness_seed_database_migration", legacyName: "Database Migration Harness", name: "데이터베이스 마이그레이션 하네스", summary: "롤백 근거가 있는 안전하고 멱등적인 스키마·데이터 마이그레이션을 계획합니다.", agentRef: "database-engineer", agentName: "데이터베이스 엔지니어", roleHint: "coder", instruction: "저장 경계를 조사하고 멱등적인 마이그레이션을 설계하여 호환성과 롤백 검증을 문서화하세요.", outputContract: "plan", allowedActions: ["file_patch", "shell"], triggerTerms: ["데이터베이스", "마이그레이션", "스키마"] },
  { id: "harness_seed_release_readiness", legacyName: "Release Readiness Harness", name: "릴리스 준비 하네스", summary: "빌드, 패키징, 릴리스 노트와 롤백 준비 상태를 검증합니다.", agentRef: "release-manager", agentName: "릴리스 관리자", roleHint: "reviewer", instruction: "릴리스 후보를 감사하고 빌드 및 패키징 근거가 있는 출시 가능 여부 검토를 반환하세요.", outputContract: "review", allowedActions: ["shell", "git_commit"], triggerTerms: ["릴리스", "패키징", "배포"] },
  { id: "harness_seed_ui_polish", legacyName: "UI UX Polish Harness", name: "UI/UX 개선 하네스", summary: "시각적 일관성, 접근성, 반응형 동작과 상호작용 품질을 검토합니다.", agentRef: "ui-reviewer", agentName: "UI 리뷰어", roleHint: "reviewer", instruction: "렌더링된 화면을 점검하고 접근성 근거가 있는 집중된 UI 개선안을 제안하세요.", outputContract: "diff_proposal", allowedActions: ["file_patch", "shell"], triggerTerms: ["UI", "UX", "접근성"] },
];

interface HarnessPackageRow {
  id: string;
  name: string;
  source_format: string;
  root_dir: string;
  validation_status: string;
  definition_json: string;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT id, name, source_format, root_dir, validation_status,
       definition_json, created_at, updated_at
  FROM harness_packages`;

export class SqliteHarnessPackageRepository
  implements HarnessPackageRepository
{
  private readonly db: HarnessDb;

  constructor(db: HarnessDb) {
    this.db = db;
  }

  async list(): Promise<HarnessDefinition[]> {
    const rows = this.db
      .prepare<[], HarnessPackageRow>(`${SELECT} ORDER BY updated_at DESC, id DESC`)
      .all();
    return rows.map(rowToDefinition);
  }

  async get(id: string): Promise<HarnessDefinition | null> {
    const row = this.db
      .prepare<[string], HarnessPackageRow>(`${SELECT} WHERE id = ?`)
      .get(id);
    return row ? rowToDefinition(row) : null;
  }

  async ensureSeed(): Promise<void> {
    const existing = await this.list();
    const existingNames = new Set(
      existing.map((definition) => definition.name.trim().toLowerCase()),
    );
    const now = nowIso();

    for (const definition of buildStarterCatalog(now)) {
      const stored = existing.find(item => item.id === definition.id);
      if (stored) {
        const current = buildStarterCatalog(stored.source.importedAt).find(item => item.id === stored.id)!;
        const seed = HARNESS_SEEDS.find(item => item.id === stored.id);
        const legacy = seed ? buildSeedDefinition(seed, stored.source.importedAt) : undefined;
        const englishName = current.skills[0]?.rawFrontmatter.harnessLocalization as { en?: { name?: string } } | undefined;
        const comparable = stored.name === englishName?.en?.name ? { ...stored, name: current.name } : stored;
        // A matching name/root alone is not proof of an unmodified template.
        if ((isDeepStrictEqual(comparable, current) || isDeepStrictEqual(comparable, legacy)) &&
          !isDeepStrictEqual(stored, current)) await this.save(current);
        continue;
      }
      if (existingNames.has(definition.name.toLowerCase())) continue;
      await this.save(definition);
      existingNames.add(definition.name.toLowerCase());
    }
  }

  async save(definition: HarnessDefinition): Promise<HarnessDefinition> {
    if (!isHarnessDefinition(definition)) {
      throw new Error("Invalid HarnessDefinition");
    }
    const now = nowIso();
    const existing = this.db
      .prepare<[string], { created_at: string }>(
        `SELECT created_at FROM harness_packages WHERE id = ?`,
      )
      .get(definition.id);
    const createdAt = existing?.created_at ?? now;
    const definitionJson = JSON.stringify(definition);
    this.db
      .prepare(
        `INSERT INTO harness_packages
          (id, name, source_format, root_dir, validation_status,
           definition_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           source_format = excluded.source_format,
           root_dir = excluded.root_dir,
           validation_status = excluded.validation_status,
           definition_json = excluded.definition_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        definition.id,
        definition.name,
        definition.source.format,
        definition.source.rootDir,
        definition.validation.status,
        definitionJson,
        createdAt,
        now,
      );
    return definition;
  }

  async remove(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM harness_packages WHERE id = ?`).run(id);
  }
}

const buildStarterCatalog = (at: string): HarnessDefinition[] => [
  ...HARNESS_SEEDS.map(seed => upgradeLegacyStarter(buildSeedDefinition(seed, at))),
  ...additionalStarterDefinitions(buildSeedDefinition(HARNESS_SEEDS[0]!, at)),
];

export const isUnmodifiedStarterDefinition = (definition: HarnessDefinition): boolean =>
  isDeepStrictEqual(definition, buildStarterCatalog(definition.source.importedAt)
    .find(item => item.id === definition.id));

const rowToDefinition = (row: HarnessPackageRow): HarnessDefinition => {
  const parsed = JSON.parse(row.definition_json) as unknown;
  if (!isHarnessDefinition(parsed)) {
    throw new Error(`Invalid HarnessDefinition stored for ${row.id}`);
  }
  if (parsed.id !== row.id) {
    throw new Error(`HarnessDefinition id mismatch for ${row.id}`);
  }
  if (parsed.name !== row.name) {
    throw new Error(`HarnessDefinition name mismatch for ${row.id}`);
  }
  if (parsed.source.format !== (row.source_format as HarnessSourceFormat)) {
    throw new Error(`HarnessDefinition source format mismatch for ${row.id}`);
  }
  if (parsed.source.rootDir !== row.root_dir) {
    throw new Error(`HarnessDefinition rootDir mismatch for ${row.id}`);
  }
  if (
    parsed.validation.status !==
    (row.validation_status as HarnessValidationStatus)
  ) {
    throw new Error(`HarnessDefinition validation status mismatch for ${row.id}`);
  }
  return parsed;
};

const buildSeedDefinition = (
  seed: HarnessSeedTemplate,
  importedAt: string,
): HarnessDefinition => {
  const sourceFile = `builtin/${seed.id}/harness.json`;
  const workflowId = `${seed.id}_workflow`;
  const skillId = `${seed.id}_skill`;
  const stepId = `${seed.id}_step`;
  const displayName = seed.name.replace(/ (?:Harness|하네스)$/, "");
  return {
    id: seed.id,
    name: seed.name,
    version: "1.0.0",
    source: {
      format: "harness-native",
      rootDir: `harness://starter/${seed.id}`,
      importedAt,
      files: [
        {
          relativePath: sourceFile,
          kind: "manifest",
          sha256: `builtin-${seed.id}-v1`,
          parserVersion: "harness-starter-catalog-v1",
        },
      ],
    },
    overview: {
      title: seed.name,
      summary: seed.summary,
      usage: "내장 시작 템플릿입니다. 파이프라인을 만들기 전에 에이전트를 연결하세요.",
      outputPolicy: "모든 부수효과는 승인 절차를 거쳐야 합니다.",
    },
    agents: [
      {
        id: seed.agentRef,
        name: seed.agentName,
        description: seed.summary,
        roleHint: seed.roleHint,
        sourceFile,
        persona: `${seed.name}의 ${seed.agentName} 역할을 수행합니다.`,
        responsibilities: [seed.instruction],
        providerHint: "auto",
        requiredCapabilities: [],
      },
    ],
    skills: [
      {
        id: skillId,
        name: displayName,
        description: seed.summary,
        triggerTerms: [...seed.triggerTerms],
        negativeTriggerTerms: [],
        sourceFile,
        workflowRefs: [workflowId],
        relatedSkillRefs: [],
        rawFrontmatter: {
          generatedBy: "harness-starter-catalog-v1",
          harnessLocalization: {
            key: builtInLocalizationKey("harness", seed.id, "harness_seed_"),
            en: { name: seed.legacyName },
            ko: { name: seed.name },
          },
        },
      },
    ],
    workflows: [
      {
        id: workflowId,
        skillId,
        name: displayName,
        mode: "sequential",
        description: seed.summary,
        sourceFile,
        phases: [
          {
            id: "execution",
            title: "실행",
            owner: "agent",
            summary: seed.instruction,
          },
        ],
        steps: [
          {
            id: stepId,
            title: displayName,
            agentRef: seed.agentRef,
            roleHint: seed.roleHint,
            phaseId: "execution",
            instruction: seed.instruction,
            dependsOn: [],
            artifactContracts: [],
            allowedActions: [...seed.allowedActions],
            outputContract: seed.outputContract,
            sourceRef: { relativePath: sourceFile },
          },
        ],
        handoffPolicy: {
          mode: "structured_handoff",
          routes: [],
          requiredPayload: "harness_worker_handoff_v1",
          fallback: "pause_for_review",
        },
        failurePolicy: {
          defaultMode: "pause_for_review",
          maxAttempts: 1,
          rules: [],
        },
        testScenarios: [],
        parseConfidence: "high",
      },
    ],
    capabilities: [],
    validation: {
      status: "valid",
      issues: [],
      importedAt,
      adapterVersion: "harness-starter-catalog-v1",
    },
  };
};

const builtInLocalizationKey = (
  domain: string,
  id: string,
  prefix: string,
): string => {
  const words = id.slice(prefix.length).split("_");
  const suffix = words
    .map((word, index) =>
      index === 0 ? word : `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`,
    )
    .join("");
  return `builtin.${domain}.${suffix}`;
};
