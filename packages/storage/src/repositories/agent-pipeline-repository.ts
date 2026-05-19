import {
  type AgentProfile,
  MAX_PIPELINE_STEPS,
  isAgentPipelineStep,
  type AgentPipeline,
  type AgentPipelineStep,
  type CreateAgentPipelineInput,
} from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { newId, nowIso } from "../id.ts";
import type { AgentProfileRepository } from "./agent-profile-repository.ts";
import type { A2ARemoteAgentRepository } from "./a2a-remote-agent-repository.ts";

/**
 * Repository for AgentPipeline templates. Steps are stored as a JSON
 * column on `agent_pipelines.steps_json`; SQLite enforces non-empty via
 * a CHECK on `json_array_length`. The cross-table integrity (each step's
 * `agentProfileId` must reference an existing AgentProfile row) is
 * enforced HERE — JSON columns can't carry FK constraints. Both create
 * and update go through `validate()` so the invariant holds at every
 * write boundary.
 */
export interface AgentPipelineRepository {
  list(): Promise<AgentPipeline[]>;
  get(id: string): Promise<AgentPipeline | null>;
  create(input: CreateAgentPipelineInput): Promise<AgentPipeline>;
  update(pipeline: AgentPipeline): Promise<AgentPipeline>;
  delete(id: string): Promise<void>;
  findByReferencedAgentProfileId(profileId: string): Promise<AgentPipeline[]>;
  ensureSeed(): Promise<void>;
}

interface PipelineRow {
  id: string;
  name: string;
  description: string;
  steps_json: string;
  created_at: string;
  updated_at: string;
}

const rowToPipeline = (row: PipelineRow): AgentPipeline => ({
  id: row.id,
  name: row.name,
  description: row.description,
  steps: JSON.parse(row.steps_json) as AgentPipelineStep[],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const SELECT = `SELECT id, name, description, steps_json, created_at, updated_at
  FROM agent_pipelines`;

export class SqliteAgentPipelineRepository implements AgentPipelineRepository {
  private readonly db: HarnessDb;
  private readonly profiles: AgentProfileRepository;
  private readonly remoteAgents?: A2ARemoteAgentRepository;

  constructor(
    db: HarnessDb,
    profiles: AgentProfileRepository,
    remoteAgents?: A2ARemoteAgentRepository,
  ) {
    this.db = db;
    this.profiles = profiles;
    this.remoteAgents = remoteAgents;
  }

  async list(): Promise<AgentPipeline[]> {
    const rows = this.db
      .prepare<[], PipelineRow>(`${SELECT} ORDER BY created_at ASC`)
      .all();
    return rows.map(rowToPipeline);
  }

  async get(id: string): Promise<AgentPipeline | null> {
    const row = this.db
      .prepare<[string], PipelineRow>(`${SELECT} WHERE id = ?`)
      .get(id);
    return row ? rowToPipeline(row) : null;
  }

  async create(input: CreateAgentPipelineInput): Promise<AgentPipeline> {
    await this.validate(input.name, input.steps);
    const id = newId("agentPipeline");
    const now = nowIso();
    const pipeline: AgentPipeline = {
      ...input,
      id,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO agent_pipelines
          (id, name, description, steps_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(
        pipeline.id,
        pipeline.name,
        pipeline.description,
        JSON.stringify(pipeline.steps),
        pipeline.createdAt,
        pipeline.updatedAt,
      );
    return pipeline;
  }

  async ensureSeed(): Promise<void> {
    const [existing, profiles] = await Promise.all([this.list(), this.profiles.list()]);
    const existingIds = new Set(existing.map((p) => p.id));
    const existingNames = new Set(
      existing.map((p) => p.name.trim().toLowerCase()),
    );
    const profilesByName = new Map(
      profiles.map((p) => [p.name.trim().toLowerCase(), p] as const),
    );
    const profilesByRole = new Map<AgentProfile["role"], AgentProfile>();
    for (const profile of profiles) {
      if (!profilesByRole.has(profile.role)) {
        profilesByRole.set(profile.role, profile);
      }
    }

    const now = nowIso();
    this.localizeLegacySeedPipelines({ existing, updatedAt: now });
    for (const template of pipelineSeedTemplates) {
      if (existingIds.has(template.id)) continue;
      const nameKey = template.name.trim().toLowerCase();
      if (existingNames.has(nameKey)) continue;
      const steps = materializeSeedSteps({
        steps: template.steps,
        profilesByName,
        profilesByRole,
      });
      if (steps === null) continue;
      const pipeline: AgentPipeline = {
        id: template.id,
        name: template.name,
        description: template.description,
        steps,
        createdAt: now,
        updatedAt: now,
      };
      await this.validate(pipeline.name, pipeline.steps);
      this.insertRow(pipeline);
      existingIds.add(pipeline.id);
      existingNames.add(nameKey);
    }
  }

  async update(pipeline: AgentPipeline): Promise<AgentPipeline> {
    await this.validate(pipeline.name, pipeline.steps);
    const updated: AgentPipeline = { ...pipeline, updatedAt: nowIso() };
    this.db
      .prepare(
        `UPDATE agent_pipelines
           SET name = ?, description = ?, steps_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        updated.name,
        updated.description,
        JSON.stringify(updated.steps),
        updated.updatedAt,
        updated.id,
      );
    return updated;
  }

  async delete(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM agent_pipelines WHERE id = ?`).run(id);
  }

  async findByReferencedAgentProfileId(
    profileId: string,
  ): Promise<AgentPipeline[]> {
    // SQLite's json_each() lets us search inside the array without
    // pulling every row into JS.
    const rows = this.db
      .prepare<[string], PipelineRow>(
        `${SELECT}
           WHERE EXISTS (
             SELECT 1 FROM json_each(steps_json) je
              WHERE json_extract(je.value, '$.agentProfileId') = ?
           )
         ORDER BY created_at ASC`,
      )
      .all(profileId);
    return rows.map(rowToPipeline);
  }

  private async validate(
    name: string,
    steps: readonly AgentPipelineStep[],
  ): Promise<void> {
    if (name.trim().length === 0) {
      throw new Error("AgentPipeline.name must be non-empty");
    }
    if (!Array.isArray(steps) || steps.length < 1) {
      throw new Error("AgentPipeline.steps must contain at least one step");
    }
    if (steps.length > MAX_PIPELINE_STEPS) {
      throw new Error(
        `AgentPipeline.steps exceeds MAX_PIPELINE_STEPS (${MAX_PIPELINE_STEPS})`,
      );
    }
    for (const [i, step] of steps.entries()) {
      if (!isAgentPipelineStep(step)) {
        throw new Error(`AgentPipeline.steps[${i}] is malformed`);
      }
    }
    validateStepTopology(steps);
    for (const [i, step] of steps.entries()) {
      const profile = await this.profiles.get(step.agentProfileId);
      if (!profile) {
        throw new Error(
          `AgentPipeline.steps[${i}].agentProfileId references unknown profile: ${step.agentProfileId}`,
        );
      }
      if (step.remoteEndpointId !== undefined) {
        if (!this.remoteAgents) {
          throw new Error(
            `AgentPipeline.steps[${i}].remoteEndpointId validation unavailable`,
          );
        }
        const endpoint = await this.remoteAgents.getEndpoint(
          step.remoteEndpointId,
        );
        if (!endpoint) {
          throw new Error(
            `AgentPipeline.steps[${i}].remoteEndpointId references unknown remote endpoint: ${step.remoteEndpointId}`,
          );
        }
      }
    }
  }

  private insertRow(pipeline: AgentPipeline): void {
    this.db
      .prepare(
        `INSERT INTO agent_pipelines
          (id, name, description, steps_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(
        pipeline.id,
        pipeline.name,
        pipeline.description,
        JSON.stringify(pipeline.steps),
        pipeline.createdAt,
        pipeline.updatedAt,
      );
  }

  private localizeLegacySeedPipelines(input: {
    existing: readonly AgentPipeline[];
    updatedAt: string;
  }): void {
    const desiredById = new Map(
      pipelineSeedTemplates.map((template) => [template.id, template]),
    );
    for (const pipeline of input.existing) {
      const desired = desiredById.get(pipeline.id);
      const legacy = LEGACY_ENGLISH_PIPELINE_SEED_TEXT[pipeline.id];
      if (!desired || !legacy) continue;
      let changed = false;
      const description =
        pipeline.description === legacy.description
          ? desired.description
          : pipeline.description;
      if (description !== pipeline.description) changed = true;
      const desiredSteps = new Map(
        desired.steps.map((step) => [step.id, step] as const),
      );
      const legacySteps = new Map(
        legacy.steps.map((step) => [step.id, step] as const),
      );
      const steps = pipeline.steps.map((step) => {
        const desiredStep = desiredSteps.get(step.id);
        const legacyStep = legacySteps.get(step.id);
        if (!desiredStep || !legacyStep) return step;
        const title =
          step.title === legacyStep.title ? desiredStep.title : step.title;
        const instruction =
          step.instruction === legacyStep.instruction
            ? desiredStep.instruction
            : step.instruction;
        if (title !== step.title || instruction !== step.instruction) {
          changed = true;
          return { ...step, title, instruction };
        }
        return step;
      });
      if (!changed) continue;
      this.db
        .prepare(
          `UPDATE agent_pipelines
              SET description = ?, steps_json = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          description,
          JSON.stringify(steps),
          input.updatedAt,
          pipeline.id,
        );
    }
  }
}

const LEGACY_ENGLISH_PIPELINE_SEED_TEXT: Record<
  string,
  {
    description: string;
    steps: Array<{ id: string; title: string; instruction: string }>;
  }
> = {
  pipe_template_supervised_delivery: {
    description:
      "Default implementation flow: orchestrate, plan, code, recover build failures, test, review security, and complete final review.",
    steps: [
      {
        id: "topology",
        title: "Coordinate worker topology",
        instruction:
          "Define worker ownership, dependencies, handoff payloads, approval checkpoints, and completion criteria for this request.",
      },
      {
        id: "plan",
        title: "Plan scope and risks",
        instruction:
          "Convert the request into a scoped implementation plan, identify likely files or modules, and call out concrete risks.",
      },
      {
        id: "implement",
        title: "Implement approved change",
        instruction:
          "Implement the approved plan with scoped edits. Propose file writes through Harness approvals only.",
      },
      {
        id: "build",
        title: "Resolve build or type failures",
        instruction:
          "Run targeted build, typecheck, lint, or test diagnostics as approved. If failures appear, propose the smallest corrective patch.",
      },
      {
        id: "test",
        title: "Verify changed paths",
        instruction:
          "Run or design focused verification for changed paths and summarize concrete evidence.",
      },
      {
        id: "security",
        title: "Review security boundary",
        instruction:
          "Review the proposed change for secrets, injection, unsafe file or shell access, and approval bypasses.",
      },
      {
        id: "final-review",
        title: "Final correctness review",
        instruction:
          "Review behavior, maintainability, missing tests, and unresolved risks before completion.",
      },
    ],
  },
  pipe_template_refactor_safety: {
    description:
      "Behavior-preserving cleanup flow with refactor, build recovery, verification, performance review, and final review.",
    steps: [
      {
        id: "plan",
        title: "Plan safe refactor scope",
        instruction:
          "Identify behavior that must remain stable, impacted files, regression risks, and the smallest safe cleanup slice.",
      },
      {
        id: "refactor",
        title: "Apply focused cleanup",
        instruction:
          "Refactor only the approved scope, preserve behavior, and remove dead code only with evidence.",
      },
      {
        id: "build",
        title: "Check build after refactor",
        instruction:
          "Run targeted diagnostics and propose minimal fixes for any build, type, lint, or test failures.",
      },
      {
        id: "performance",
        title: "Review performance regressions",
        instruction:
          "Inspect the refactor for allocation, latency, repeated work, and resource lifetime regressions.",
      },
      {
        id: "test",
        title: "Verify behavior preservation",
        instruction:
          "Run focused regression verification for the refactored behavior and report concrete evidence.",
      },
      {
        id: "review",
        title: "Review final refactor diff",
        instruction:
          "Review the final diff for behavior drift, overbroad cleanup, missing tests, and maintainability risks.",
      },
    ],
  },
  pipe_template_review_hardening: {
    description:
      "Read-only fan-out review flow for security, performance, and correctness checks after a planning step.",
    steps: [
      {
        id: "plan",
        title: "Define review scope",
        instruction:
          "Define the review target, changed surfaces, known risks, and evidence each reviewer should inspect.",
      },
      {
        id: "security",
        title: "Security review",
        instruction:
          "Review security-sensitive surfaces, permission changes, secrets, injection paths, and approval bypass risk.",
      },
      {
        id: "performance",
        title: "Performance review",
        instruction:
          "Review latency, allocation, hot paths, repeated work, and missing measurements or benchmarks.",
      },
      {
        id: "correctness",
        title: "Correctness review",
        instruction:
          "Review behavior, maintainability, missing verification, and contract drift.",
      },
    ],
  },
  pipe_template_build_recovery: {
    description:
      "Focused failure-recovery flow for build, typecheck, lint, or test failures with verification and final review.",
    steps: [
      {
        id: "diagnose",
        title: "Diagnose first real failure",
        instruction:
          "Read the first real build, typecheck, lint, or test failure. Trace the owning module and propose the smallest corrective change.",
      },
      {
        id: "verify",
        title: "Verify recovered path",
        instruction:
          "Run the narrow verification that proves the failure is resolved and summarize remaining test gaps.",
      },
      {
        id: "review",
        title: "Review recovery patch",
        instruction:
          "Review whether the fix treats the root cause without weakening checks, deleting tests, or masking failures.",
      },
    ],
  },
};

interface SeedProfileRef {
  role: AgentProfile["role"];
  preferredNames: readonly string[];
}

interface SeedStepTemplate {
  id: string;
  profile: SeedProfileRef;
  title: string;
  instruction: string;
  expectedArtifactKinds: AgentPipelineStep["expectedArtifactKinds"];
  dependsOn?: AgentPipelineStep["dependsOn"];
  allowedActions?: AgentPipelineStep["allowedActions"];
  outputContract?: AgentPipelineStep["outputContract"];
}

interface SeedPipelineTemplate {
  id: string;
  name: string;
  description: string;
  steps: readonly SeedStepTemplate[];
}

const profileRef = (
  role: AgentProfile["role"],
  preferredNames: readonly string[],
): SeedProfileRef => ({
  role,
  preferredNames,
});

const PROFILE_REFS = {
  orchestrator: profileRef("orchestrator", [
    "Ruflo Orchestrator",
    "Agno Trace Planner",
  ]),
  product: profileRef("planner", ["Agno Product PRD Strategist", "Planner"]),
  architecture: profileRef("orchestrator", [
    "Ruflo Architecture Designer",
    "Ruflo Orchestrator",
  ]),
  api: profileRef("planner", ["Agno API Contract Architect", "Planner"]),
  skillCurator: profileRef("planner", ["Hermes Skill Curator", "Planner"]),
  image: profileRef("planner", ["Hermes Image Prompt Designer", "Planner"]),
  ux: profileRef("planner", ["ECC UX Flow Designer", "Planner"]),
  designReview: profileRef("reviewer", [
    "ECC Design QA Reviewer",
    "Reviewer",
  ]),
  frontend: profileRef("coder", [
    "Codex Frontend Implementer",
    "Codex Bulk Coder",
    "Coder",
  ]),
  documentation: profileRef("planner", [
    "ECC Documentation Writer",
    "Planner",
  ]),
  migration: profileRef("planner", [
    "ECC Data Migration Planner",
    "Planner",
  ]),
  planner: profileRef("planner", ["Planner"]),
  coder: profileRef("coder", ["Codex Bulk Coder", "Coder"]),
  refactor: profileRef("refactor-cleaner", ["ECC Refactor Cleaner"]),
  build: profileRef("build-error-resolver", ["ECC Build Error Resolver"]),
  tester: profileRef("tester", ["ECC TDD Guide", "Tester"]),
  security: profileRef("security-reviewer", ["ECC Security Reviewer"]),
  performance: profileRef("performance-reviewer", ["C# Performance Reviewer"]),
  reviewer: profileRef("reviewer", ["Reviewer"]),
} as const;

const pipelineSeedTemplates: readonly SeedPipelineTemplate[] = [
  {
    id: "pipe_template_product_prd",
    name: "Product PRD Discovery",
    description:
      "PRD, 사용자 시나리오, 성공 지표, scope/non-scope를 먼저 정리하는 제품 요구사항 흐름입니다.",
    steps: [
      {
        id: "discovery",
        profile: PROFILE_REFS.product,
        title: "제품 문제와 사용자 정의",
        instruction:
          "사용자 요청을 목표 사용자, 문제 정의, 성공 지표, scope/non-scope, open question으로 정리한 PRD 초안을 한국어로 작성하세요.",
        expectedArtifactKinds: ["plan", "log"],
        dependsOn: [],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "requirements",
        profile: PROFILE_REFS.planner,
        title: "Acceptance criteria 정리",
        instruction:
          "PRD 초안을 실행 가능한 user story, acceptance criteria, edge case, 검증 기준으로 구체화하세요.",
        expectedArtifactKinds: ["plan", "log"],
        dependsOn: ["discovery"],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "architecture-preview",
        profile: PROFILE_REFS.architecture,
        title: "아키텍처 영향 예비 검토",
        instruction:
          "요구사항이 시스템 경계, 데이터 모델, IPC/API, approval, storage, UI 상태에 미치는 영향을 read-only로 검토하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["requirements"],
        allowedActions: [],
        outputContract: "review",
      },
      {
        id: "prd-review",
        profile: PROFILE_REFS.reviewer,
        title: "PRD 완성도 리뷰",
        instruction:
          "PRD가 구현 가능한 수준인지, 모호한 범위나 빠진 검증 기준이 있는지 검토하고 우선순위별 보완점을 한국어로 보고하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["requirements", "architecture-preview"],
        allowedActions: [],
        outputContract: "review",
      },
    ],
  },
  {
    id: "pipe_template_architecture_rfc",
    name: "Architecture RFC",
    description:
      "PRD를 시스템 설계, API/IPC 계약, migration 계획, 보안/성능 리뷰까지 연결하는 아키텍처 RFC 흐름입니다.",
    steps: [
      {
        id: "system-design",
        profile: PROFILE_REFS.architecture,
        title: "시스템 아키텍처 설계",
        instruction:
          "요구사항을 모듈 책임, 데이터 흐름, IPC/API 경계, approval boundary, worker topology로 나눈 아키텍처 RFC 초안을 한국어로 작성하세요.",
        expectedArtifactKinds: ["plan", "orchestration_plan", "log"],
        dependsOn: [],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "api-contract",
        profile: PROFILE_REFS.api,
        title: "API/IPC 계약 설계",
        instruction:
          "아키텍처 초안을 바탕으로 request/response schema, error code, 권한 경계, audit evidence, backward compatibility를 정의하세요.",
        expectedArtifactKinds: ["plan", "log"],
        dependsOn: ["system-design"],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "migration-plan",
        profile: PROFILE_REFS.migration,
        title: "상태/migration 영향 검토",
        instruction:
          "SQLite/schema/state 변경이 필요한지 검토하고, idempotent migration, 기존 데이터 호환성, repository 테스트 범위를 한국어로 정리하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["system-design"],
        allowedActions: [],
        outputContract: "review",
      },
      {
        id: "security-review",
        profile: PROFILE_REFS.security,
        title: "아키텍처 보안 리뷰",
        instruction:
          "설계에서 secret, 권한 상승, approval bypass, path traversal, unsafe execution, untrusted input 위험을 read-only로 검토하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["system-design", "api-contract"],
        allowedActions: [],
        outputContract: "review",
      },
      {
        id: "performance-review",
        profile: PROFILE_REFS.performance,
        title: "아키텍처 성능 리뷰",
        instruction:
          "설계가 latency, allocation, synchronization, repeated work, DB contention, UI responsiveness에 미칠 위험을 read-only로 검토하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["system-design"],
        allowedActions: [],
        outputContract: "review",
      },
      {
        id: "rfc-final",
        profile: PROFILE_REFS.reviewer,
        title: "RFC 최종 리뷰",
        instruction:
          "아키텍처, API 계약, migration, 보안/성능 검토 결과를 합쳐 구현 전 남은 결정과 우선순위를 한국어로 정리하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: [
          "api-contract",
          "migration-plan",
          "security-review",
          "performance-review",
        ],
        allowedActions: [],
        outputContract: "review",
      },
    ],
  },
  {
    id: "pipe_template_visual_design_delivery",
    name: "Visual Design Delivery",
    description:
      "PRD를 UI/UX 흐름, visual spec, frontend 구현, 디자인 QA까지 연결하는 디자인 중심 전달 흐름입니다.",
    steps: [
      {
        id: "product-brief",
        profile: PROFILE_REFS.product,
        title: "디자인용 제품 brief",
        instruction:
          "디자인에 필요한 사용자 목표, primary workflow, must-have state, tone, 제약 조건을 PRD brief로 정리하세요.",
        expectedArtifactKinds: ["plan", "log"],
        dependsOn: [],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "ux-flow",
        profile: PROFILE_REFS.ux,
        title: "UI/UX flow 설계",
        instruction:
          "제품 brief를 화면 정보 구조, interaction state, empty/loading/error state, accessibility expectation, responsive behavior로 변환하세요.",
        expectedArtifactKinds: ["plan", "snapshot", "log"],
        dependsOn: ["product-brief"],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "image-prompts",
        profile: PROFILE_REFS.image,
        title: "이미지/에셋 프롬프트 설계",
        instruction:
          "UI/UX flow에 필요한 이미지 생성 프롬프트, style constraints, variants, 검수 기준을 작성하세요. 실제 이미지 생성 호출은 하지 마세요.",
        expectedArtifactKinds: ["file", "snapshot", "log"],
        dependsOn: ["ux-flow"],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "frontend-implementation",
        profile: PROFILE_REFS.frontend,
        title: "프론트엔드 구현 제안",
        instruction:
          "승인된 PRD/UX/image prompt 산출물을 바탕으로 기존 UI 패턴에 맞춘 최소 frontend 변경을 제안하세요. 파일 쓰기는 Harness approval로만 제안하세요.",
        expectedArtifactKinds: ["diff", "log"],
        dependsOn: ["ux-flow", "image-prompts"],
        allowedActions: ["file_write"],
        outputContract: "diff_proposal",
      },
      {
        id: "design-review",
        profile: PROFILE_REFS.designReview,
        title: "디자인 QA 리뷰",
        instruction:
          "UI 변경의 시각적 일관성, 접근성, overflow, 상태 누락, 모바일/데스크톱 레이아웃 위험을 read-only로 검토하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["frontend-implementation"],
        allowedActions: [],
        outputContract: "review",
      },
      {
        id: "verify",
        profile: PROFILE_REFS.tester,
        title: "UI 변경 검증",
        instruction:
          "변경된 UI에 대한 focused test, screenshot/manual verification 계획 또는 실행 증거를 한국어로 정리하세요.",
        expectedArtifactKinds: ["test_result", "snapshot", "log"],
        dependsOn: ["frontend-implementation"],
        allowedActions: ["shell"],
        outputContract: "test_result",
      },
      {
        id: "final-review",
        profile: PROFILE_REFS.reviewer,
        title: "디자인 전달 최종 리뷰",
        instruction:
          "구현, 디자인 QA, 검증 결과를 합쳐 release 전 남은 risk와 follow-up을 한국어로 정리하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["design-review", "verify"],
        allowedActions: [],
        outputContract: "review",
      },
    ],
  },
  {
    id: "pipe_template_image_asset_prompt",
    name: "Image Asset Prompt Flow",
    description:
      "이미지 생성 자체를 직접 실행하지 않고, 생성 프롬프트/스타일/검수 기준과 구현 handoff를 만드는 read-only 흐름입니다.",
    steps: [
      {
        id: "brief",
        profile: PROFILE_REFS.ux,
        title: "비주얼 asset brief",
        instruction:
          "요청을 이미지 용도, 사용 위치, 브랜드/제품 맥락, 크기/aspect ratio, 금지 요소, 성공 기준으로 정리하세요.",
        expectedArtifactKinds: ["plan", "log"],
        dependsOn: [],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "image-prompts",
        profile: PROFILE_REFS.image,
        title: "이미지 생성 프롬프트 작성",
        instruction:
          "생성 모델에 넘길 prompt, negative prompt, style guide, variant list, acceptance checklist를 한국어로 작성하세요. 네트워크나 외부 이미지 생성은 실행하지 마세요.",
        expectedArtifactKinds: ["file", "snapshot", "log"],
        dependsOn: ["brief"],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "design-review",
        profile: PROFILE_REFS.designReview,
        title: "프롬프트/에셋 QA",
        instruction:
          "프롬프트가 제품 맥락, 접근성, 저작권/브랜드 위험, UI 사용성, 검수 가능성을 만족하는지 read-only로 검토하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["image-prompts"],
        allowedActions: [],
        outputContract: "review",
      },
      {
        id: "handoff",
        profile: PROFILE_REFS.documentation,
        title: "에셋 handoff 문서화",
        instruction:
          "이미지 프롬프트, 생성 옵션, expected output, 적용 위치, 구현자가 확인할 QA 기준을 handoff 문서로 정리하세요.",
        expectedArtifactKinds: ["plan", "file", "log"],
        dependsOn: ["image-prompts", "design-review"],
        allowedActions: [],
        outputContract: "plan",
      },
    ],
  },
  {
    id: "pipe_template_new_project_delivery",
    name: "New Project Delivery",
    description:
      "새 프로젝트 생성을 PRD, 계획, 아키텍처, 이미지/에셋 생성 사양, 구현, 검증, 리뷰까지 연결하는 end-to-end 흐름입니다.",
    steps: [
      {
        id: "prd",
        profile: PROFILE_REFS.product,
        title: "새 프로젝트 PRD 작성",
        instruction:
          "사용자 요청을 새 프로젝트의 목표 사용자, 핵심 문제, 주요 기능, 성공 기준, scope/non-scope, acceptance criteria로 정리한 PRD로 작성하세요.",
        expectedArtifactKinds: ["plan", "log"],
        dependsOn: [],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "project-plan",
        profile: PROFILE_REFS.planner,
        title: "프로젝트 생성 계획",
        instruction:
          "PRD를 실행 가능한 생성 계획으로 분해하세요. 기술 스택, 초기 파일 구조, 단계별 구현 순서, 검증 명령, 승인 받아야 할 파일 쓰기 범위를 한국어로 명확히 정의하세요.",
        expectedArtifactKinds: ["plan", "orchestration_plan", "log"],
        dependsOn: ["prd"],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "architecture",
        profile: PROFILE_REFS.architecture,
        title: "초기 아키텍처 설계",
        instruction:
          "프로젝트 생성 계획을 바탕으로 모듈 경계, 데이터 흐름, UI/API/저장소 경계, approval/runner 경계, 확장 가능한 폴더 구조를 설계하세요.",
        expectedArtifactKinds: ["plan", "orchestration_plan", "log"],
        dependsOn: ["project-plan"],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "ux-flow",
        profile: PROFILE_REFS.ux,
        title: "초기 UX와 화면 흐름",
        instruction:
          "PRD와 아키텍처를 바탕으로 첫 화면, 핵심 사용자 흐름, empty/loading/error state, responsive/accessibility expectation, 주요 copy를 정의하세요.",
        expectedArtifactKinds: ["plan", "snapshot", "log"],
        dependsOn: ["prd", "architecture"],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "image-assets",
        profile: PROFILE_REFS.image,
        title: "이미지 생성/에셋 사양",
        instruction:
          "프로젝트에 필요한 이미지 생성 프롬프트, 스타일 제약, aspect ratio, asset variant, 검수 기준, 구현 handoff를 작성하세요. 현재 Harness에서는 실제 외부 이미지 생성 호출을 실행하지 말고 승인 가능한 사양만 산출하세요.",
        expectedArtifactKinds: ["file", "snapshot", "log"],
        dependsOn: ["ux-flow"],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "implementation",
        profile: PROFILE_REFS.coder,
        title: "프로젝트 파일 생성 제안",
        instruction:
          "승인된 PRD, 계획, 아키텍처, UX, 에셋 사양을 바탕으로 새 프로젝트 초기 파일과 코드를 생성하는 최소 diff를 제안하세요. 모든 파일 쓰기는 Harness approval을 통해서만 제안하고, JSON 파일을 canonical state로 쓰지 마세요.",
        expectedArtifactKinds: ["diff", "file", "log"],
        dependsOn: ["architecture", "ux-flow", "image-assets"],
        allowedActions: ["file_write"],
        outputContract: "diff_proposal",
      },
      {
        id: "build-recovery",
        profile: PROFILE_REFS.build,
        title: "빌드/실행 복구",
        instruction:
          "승인된 프로젝트 파일 생성 후 build, typecheck, lint, test, smoke 실행 가능성을 확인하세요. 실패하면 첫 실제 원인을 추적하고 가장 작은 수정안을 Harness approval로만 제안하세요.",
        expectedArtifactKinds: ["test_result", "diff", "log"],
        dependsOn: ["implementation"],
        allowedActions: ["shell", "file_write"],
        outputContract: "test_result",
      },
      {
        id: "verification",
        profile: PROFILE_REFS.tester,
        title: "새 프로젝트 검증",
        instruction:
          "새 프로젝트가 실제로 실행 가능한지 focused test, build, smoke 또는 수동 검증 증거를 정리하세요. 실행하지 못한 검증은 이유와 남은 위험을 한국어로 남기세요.",
        expectedArtifactKinds: ["test_result", "snapshot", "log"],
        dependsOn: ["build-recovery"],
        allowedActions: ["shell"],
        outputContract: "test_result",
      },
      {
        id: "design-review",
        profile: PROFILE_REFS.designReview,
        title: "디자인/UX 리뷰",
        instruction:
          "생성된 프로젝트의 첫 화면, UX 흐름, 이미지/에셋 사양, 접근성, 텍스트 overflow, 상태 누락을 read-only로 검토하세요.",
        expectedArtifactKinds: ["quality_report", "snapshot", "log"],
        dependsOn: ["implementation", "image-assets"],
        allowedActions: [],
        outputContract: "review",
      },
      {
        id: "security-review",
        profile: PROFILE_REFS.security,
        title: "보안/side-effect 경계 리뷰",
        instruction:
          "새 프로젝트 생성 결과에서 secret, unsafe shell/file path, approval bypass, dependency/network assumptions, untrusted input 처리 위험을 read-only로 검토하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["implementation"],
        allowedActions: [],
        outputContract: "review",
      },
      {
        id: "final-review",
        profile: PROFILE_REFS.reviewer,
        title: "출시 준비 최종 검토",
        instruction:
          "PRD, 계획, 아키텍처, 구현, 검증, 디자인/보안 리뷰 결과를 종합해 새 프로젝트가 사용자가 실행할 수 있는 상태인지 판단하고 남은 follow-up을 한국어로 정리하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["verification", "design-review", "security-review"],
        allowedActions: [],
        outputContract: "review",
      },
    ],
  },
  {
    id: "pipe_template_frontend_product_delivery",
    name: "Frontend Product Delivery",
    description:
      "PRD, 아키텍처, UX, frontend 구현, 테스트, 디자인 QA를 한 흐름으로 묶은 제품 UI 전달 pipeline입니다.",
    steps: [
      {
        id: "prd",
        profile: PROFILE_REFS.product,
        title: "제품 요구사항 정리",
        instruction:
          "기능 목표, 사용자 흐름, acceptance criteria, scope/non-scope를 구현 가능한 PRD로 정리하세요.",
        expectedArtifactKinds: ["plan", "log"],
        dependsOn: [],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "architecture",
        profile: PROFILE_REFS.architecture,
        title: "UI 아키텍처 경계 설계",
        instruction:
          "PRD를 바탕으로 renderer state, IPC/API, 저장소, approval boundary, component ownership를 설계하세요.",
        expectedArtifactKinds: ["plan", "orchestration_plan", "log"],
        dependsOn: ["prd"],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "ux",
        profile: PROFILE_REFS.ux,
        title: "화면 흐름과 interaction 설계",
        instruction:
          "PRD와 아키텍처 제약을 바탕으로 화면 흐름, 상태, copy, responsive/accessibility expectation을 정의하세요.",
        expectedArtifactKinds: ["plan", "snapshot", "log"],
        dependsOn: ["prd"],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "implement",
        profile: PROFILE_REFS.frontend,
        title: "제품 UI 구현 제안",
        instruction:
          "승인된 PRD/아키텍처/UX를 바탕으로 기존 패턴에 맞는 최소 frontend 변경을 제안하세요.",
        expectedArtifactKinds: ["diff", "log"],
        dependsOn: ["architecture", "ux"],
        allowedActions: ["file_write"],
        outputContract: "diff_proposal",
      },
      {
        id: "test",
        profile: PROFILE_REFS.tester,
        title: "제품 UI 검증",
        instruction:
          "변경된 UI 흐름에 대한 focused test 또는 screenshot/manual verification 증거를 정리하세요.",
        expectedArtifactKinds: ["test_result", "snapshot", "log"],
        dependsOn: ["implement"],
        allowedActions: ["shell"],
        outputContract: "test_result",
      },
      {
        id: "design-qa",
        profile: PROFILE_REFS.designReview,
        title: "디자인 QA",
        instruction:
          "구현 결과의 사용성, 접근성, layout, text overflow, empty/loading/error state를 read-only로 검토하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["implement"],
        allowedActions: [],
        outputContract: "review",
      },
      {
        id: "final-review",
        profile: PROFILE_REFS.reviewer,
        title: "제품 UI 최종 리뷰",
        instruction:
          "테스트와 디자인 QA 결과를 종합해 release 가능한지, 남은 리스크가 무엇인지 한국어로 판단하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["test", "design-qa"],
        allowedActions: [],
        outputContract: "review",
      },
    ],
  },
  {
    id: "pipe_template_skill_agent_expansion",
    name: "Skill and Agent Expansion",
    description:
      "Hermes/ECC 패턴을 바탕으로 skill/agent 후보를 설계하고 Harness profile/pipeline 개선으로 연결하는 흐름입니다.",
    steps: [
      {
        id: "skill-map",
        profile: PROFILE_REFS.skillCurator,
        title: "Skill/agent 후보 맵 작성",
        instruction:
          "반복 작업, 필요한 trigger, context budget, 금지 행동, 검증 기준을 분석해 skill/agent 후보 목록을 작성하세요.",
        expectedArtifactKinds: ["plan", "log"],
        dependsOn: [],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "topology",
        profile: PROFILE_REFS.orchestrator,
        title: "Agent topology 설계",
        instruction:
          "후보 skill/agent를 Harness AgentProfile과 pipeline topology로 표현하고, dependency, allowedActions, outputContract를 제안하세요.",
        expectedArtifactKinds: ["orchestration_plan", "plan", "log"],
        dependsOn: ["skill-map"],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "implement",
        profile: PROFILE_REFS.coder,
        title: "Agent/profile 변경 구현 제안",
        instruction:
          "승인된 topology만 바탕으로 profile/pipeline seed 또는 UI 변경을 최소 diff로 제안하세요.",
        expectedArtifactKinds: ["diff", "log"],
        dependsOn: ["topology"],
        allowedActions: ["file_write"],
        outputContract: "diff_proposal",
      },
      {
        id: "verify",
        profile: PROFILE_REFS.tester,
        title: "Agent/pipeline 검증",
        instruction:
          "새 profile과 pipeline이 idempotent seed, validation, 추천 랭킹, orchestration 변환을 통과하는지 검증하세요.",
        expectedArtifactKinds: ["test_result", "log"],
        dependsOn: ["implement"],
        allowedActions: ["shell"],
        outputContract: "test_result",
      },
      {
        id: "review",
        profile: PROFILE_REFS.reviewer,
        title: "Agent 확장 최종 리뷰",
        instruction:
          "새 agent/pipeline이 과도한 권한, 중복 역할, context overload, 유지보수 리스크를 만들지 않는지 검토하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["verify"],
        allowedActions: [],
        outputContract: "review",
      },
    ],
  },
  {
    id: "pipe_template_supervised_delivery",
    name: "Supervised Delivery",
    description:
      "오케스트레이션, 계획, 구현, 빌드 복구, 테스트, 보안 검토, 최종 리뷰를 연결하는 기본 구현 흐름입니다.",
    steps: [
      {
        id: "topology",
        profile: PROFILE_REFS.orchestrator,
        title: "Worker topology 조정",
        instruction:
          "이 요청에 필요한 worker 책임 범위, 의존성, handoff payload, approval checkpoint, 완료 기준을 한국어로 정의하세요.",
        expectedArtifactKinds: ["orchestration_plan", "plan", "log"],
        dependsOn: [],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "plan",
        profile: PROFILE_REFS.planner,
        title: "범위와 위험 계획",
        instruction:
          "요청을 범위가 분명한 구현 계획으로 바꾸고, 영향을 받을 가능성이 높은 파일/모듈과 구체적인 위험을 한국어로 정리하세요.",
        expectedArtifactKinds: ["plan", "log"],
        dependsOn: ["topology"],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "implement",
        profile: PROFILE_REFS.coder,
        title: "승인된 변경 구현",
        instruction:
          "승인된 계획만 좁은 범위로 구현하세요. 파일 쓰기는 Harness approval을 통해서만 제안하고, 변경 경로와 검증 근거를 한국어로 보고하세요.",
        expectedArtifactKinds: ["diff", "log"],
        dependsOn: ["plan"],
        allowedActions: ["file_write"],
        outputContract: "diff_proposal",
      },
      {
        id: "build",
        profile: PROFILE_REFS.build,
        title: "빌드/타입 실패 해결",
        instruction:
          "승인된 범위에서 build, typecheck, lint, test 진단을 실행하세요. 실패가 있으면 첫 실제 원인을 추적하고 가장 작은 수정안을 한국어로 제안하세요.",
        expectedArtifactKinds: ["test_result", "diff", "log"],
        dependsOn: ["implement"],
        allowedActions: ["shell", "file_write"],
        outputContract: "test_result",
      },
      {
        id: "test",
        profile: PROFILE_REFS.tester,
        title: "변경 경로 검증",
        instruction:
          "변경된 경로에 맞는 집중 검증을 실행하거나 설계하고, 실제 증거와 남은 검증 공백을 한국어로 요약하세요.",
        expectedArtifactKinds: ["test_result", "log"],
        dependsOn: ["build"],
        allowedActions: ["shell"],
        outputContract: "test_result",
      },
      {
        id: "security",
        profile: PROFILE_REFS.security,
        title: "보안 경계 검토",
        instruction:
          "제안된 변경에서 secret 노출, injection, unsafe file/shell access, approval bypass 가능성을 검토하고 심각도별로 한국어 보고서를 작성하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["implement"],
        allowedActions: [],
        outputContract: "review",
      },
      {
        id: "final-review",
        profile: PROFILE_REFS.reviewer,
        title: "최종 정확성 리뷰",
        instruction:
          "완료 전 동작 정확성, 유지보수성, 누락된 테스트, 미해결 위험을 검토하고 한국어로 최종 판단을 남기세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["test", "security"],
        allowedActions: [],
        outputContract: "review",
      },
    ],
  },
  {
    id: "pipe_template_refactor_safety",
    name: "Refactor Safety",
    description:
      "동작 보존 리팩터링을 계획, 정리, 빌드 복구, 검증, 성능 검토, 최종 리뷰로 안전하게 진행하는 흐름입니다.",
    steps: [
      {
        id: "plan",
        profile: PROFILE_REFS.planner,
        title: "안전한 리팩터링 범위 계획",
        instruction:
          "보존해야 할 동작, 영향 파일, 회귀 위험, 가장 작은 안전한 정리 단위를 한국어로 식별하세요.",
        expectedArtifactKinds: ["plan", "log"],
        dependsOn: [],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "refactor",
        profile: PROFILE_REFS.refactor,
        title: "집중 정리 적용",
        instruction:
          "승인된 범위만 리팩터링하고 동작을 보존하세요. dead code는 증거가 있을 때만 제거하고 변경 이유를 한국어로 남기세요.",
        expectedArtifactKinds: ["diff", "log"],
        dependsOn: ["plan"],
        allowedActions: ["file_write"],
        outputContract: "diff_proposal",
      },
      {
        id: "build",
        profile: PROFILE_REFS.build,
        title: "리팩터링 후 빌드 확인",
        instruction:
          "targeted diagnostics를 실행하고 build, type, lint, test 실패가 있으면 최소 수정안을 한국어로 제안하세요.",
        expectedArtifactKinds: ["test_result", "diff", "log"],
        dependsOn: ["refactor"],
        allowedActions: ["shell", "file_write"],
        outputContract: "test_result",
      },
      {
        id: "performance",
        profile: PROFILE_REFS.performance,
        title: "성능 회귀 검토",
        instruction:
          "리팩터링이 allocation, latency, repeated work, resource lifetime에 회귀를 만들었는지 read-only로 검토하고 한국어로 보고하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["refactor"],
        allowedActions: [],
        outputContract: "review",
      },
      {
        id: "test",
        profile: PROFILE_REFS.tester,
        title: "동작 보존 검증",
        instruction:
          "리팩터링된 동작에 대한 focused regression verification을 실행하고 구체적 증거를 한국어로 보고하세요.",
        expectedArtifactKinds: ["test_result", "log"],
        dependsOn: ["build"],
        allowedActions: ["shell"],
        outputContract: "test_result",
      },
      {
        id: "review",
        profile: PROFILE_REFS.reviewer,
        title: "최종 리팩터링 diff 리뷰",
        instruction:
          "최종 diff에서 behavior drift, 과도한 정리, 누락된 테스트, 유지보수성 위험을 검토하고 한국어로 정리하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["test", "performance"],
        allowedActions: [],
        outputContract: "review",
      },
    ],
  },
  {
    id: "pipe_template_review_hardening",
    name: "Parallel Review Hardening",
    description:
      "계획 step 이후 보안, 성능, 정확성 검토를 read-only fan-out으로 병렬 진행하는 흐름입니다.",
    steps: [
      {
        id: "plan",
        profile: PROFILE_REFS.planner,
        title: "리뷰 범위 정의",
        instruction:
          "리뷰 대상, 변경 surface, 알려진 위험, 각 reviewer가 확인해야 할 증거를 한국어로 정의하세요.",
        expectedArtifactKinds: ["plan", "log"],
        dependsOn: [],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "security",
        profile: PROFILE_REFS.security,
        title: "보안 리뷰",
        instruction:
          "보안 민감 surface, 권한 변경, secret, injection path, approval bypass 위험을 read-only로 검토하고 한국어로 보고하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["plan"],
        allowedActions: [],
        outputContract: "review",
      },
      {
        id: "performance",
        profile: PROFILE_REFS.performance,
        title: "성능 리뷰",
        instruction:
          "latency, allocation, hot path, repeated work, 누락된 measurement/benchmark를 read-only로 검토하고 한국어로 보고하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["plan"],
        allowedActions: [],
        outputContract: "review",
      },
      {
        id: "correctness",
        profile: PROFILE_REFS.reviewer,
        title: "정확성 리뷰",
        instruction:
          "동작 정확성, 유지보수성, 누락된 검증, contract drift를 read-only로 검토하고 한국어로 보고하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["plan"],
        allowedActions: [],
        outputContract: "review",
      },
    ],
  },
  {
    id: "pipe_template_build_recovery",
    name: "Build Recovery",
    description:
      "build, typecheck, lint, test 실패를 진단하고 검증과 최종 리뷰까지 연결하는 집중 복구 흐름입니다.",
    steps: [
      {
        id: "diagnose",
        profile: PROFILE_REFS.build,
        title: "첫 실제 실패 진단",
        instruction:
          "build, typecheck, lint, test 로그에서 첫 실제 실패를 읽고 소유 모듈까지 추적하세요. 가장 작은 수정안을 한국어로 제안하세요.",
        expectedArtifactKinds: ["test_result", "diff", "log"],
        dependsOn: [],
        allowedActions: ["shell", "file_write"],
        outputContract: "test_result",
      },
      {
        id: "verify",
        profile: PROFILE_REFS.tester,
        title: "복구 경로 검증",
        instruction:
          "실패가 해결되었음을 증명하는 가장 좁은 검증을 실행하고 남은 테스트 공백을 한국어로 요약하세요.",
        expectedArtifactKinds: ["test_result", "log"],
        dependsOn: ["diagnose"],
        allowedActions: ["shell"],
        outputContract: "test_result",
      },
      {
        id: "review",
        profile: PROFILE_REFS.reviewer,
        title: "복구 패치 리뷰",
        instruction:
          "수정이 check 약화, 테스트 삭제, 실패 은폐 없이 root cause를 해결했는지 검토하고 한국어로 보고하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["verify"],
        allowedActions: [],
        outputContract: "review",
      },
    ],
  },
];

const materializeSeedSteps = (input: {
  steps: readonly SeedStepTemplate[];
  profilesByName: ReadonlyMap<string, AgentProfile>;
  profilesByRole: ReadonlyMap<AgentProfile["role"], AgentProfile>;
}): AgentPipelineStep[] | null => {
  const steps: AgentPipelineStep[] = [];
  for (const template of input.steps) {
    const profile = resolveSeedProfile({
      ref: template.profile,
      profilesByName: input.profilesByName,
      profilesByRole: input.profilesByRole,
    });
    if (!profile) return null;
    steps.push({
      id: template.id,
      agentProfileId: profile.id,
      title: template.title,
      instruction: template.instruction,
      expectedArtifactKinds: template.expectedArtifactKinds,
      ...(template.dependsOn !== undefined ? { dependsOn: template.dependsOn } : {}),
      ...(template.allowedActions !== undefined
        ? { allowedActions: template.allowedActions }
        : {}),
      ...(template.outputContract !== undefined
        ? { outputContract: template.outputContract }
        : {}),
    });
  }
  return steps;
};

const resolveSeedProfile = (input: {
  ref: SeedProfileRef;
  profilesByName: ReadonlyMap<string, AgentProfile>;
  profilesByRole: ReadonlyMap<AgentProfile["role"], AgentProfile>;
}): AgentProfile | null => {
  for (const name of input.ref.preferredNames) {
    const profile = input.profilesByName.get(name.trim().toLowerCase());
    if (profile) return profile;
  }
  return input.profilesByRole.get(input.ref.role) ?? null;
};

const validateStepTopology = (steps: readonly AgentPipelineStep[]): void => {
  const byId = new Map<string, AgentPipelineStep>();
  for (const [i, step] of steps.entries()) {
    if (byId.has(step.id)) {
      throw new Error(
        `AgentPipeline.steps[${i}].id duplicates another step: ${step.id}`,
      );
    }
    byId.set(step.id, step);
  }

  for (const [i, step] of steps.entries()) {
    for (const depId of step.dependsOn ?? []) {
      if (depId === step.id) {
        throw new Error(
          `AgentPipeline.steps[${i}].dependsOn cannot reference itself: ${depId}`,
        );
      }
      if (!byId.has(depId)) {
        throw new Error(
          `AgentPipeline.steps[${i}].dependsOn references unknown step: ${depId}`,
        );
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (step: AgentPipelineStep): void => {
    if (visited.has(step.id)) return;
    if (visiting.has(step.id)) {
      throw new Error(`AgentPipeline.steps contains a dependsOn cycle at ${step.id}`);
    }
    visiting.add(step.id);
    for (const depId of step.dependsOn ?? []) {
      const dep = byId.get(depId);
      if (dep) visit(dep);
    }
    visiting.delete(step.id);
    visited.add(step.id);
  };
  for (const step of steps) visit(step);
};
