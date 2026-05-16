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
