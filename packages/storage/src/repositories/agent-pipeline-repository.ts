import {
  type AgentProfile,
  MAX_PIPELINE_STEPS,
  isAgentPipeline,
  isAgentPipelineBackflowRule,
  isAgentPipelineStep,
  type AgentPipelineBackflowRule,
  type AgentPipeline,
  type AgentPipelineStep,
  type CreateAgentPipelineInput,
  type PipelineBackflowTrigger,
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
  backflow_rules_json: string;
  created_at: string;
  updated_at: string;
}

const rowToPipeline = (row: PipelineRow): AgentPipeline => {
  let steps: unknown;
  let backflowRules: unknown;
  try {
    steps = JSON.parse(row.steps_json) as unknown;
    backflowRules = JSON.parse(row.backflow_rules_json) as unknown;
  } catch {
    throw new Error(`Invalid AgentPipeline stored (${row.id}): malformed JSON`);
  }
  const pipeline: unknown = {
    id: row.id,
    name: row.name,
    description: row.description,
    steps,
    backflowRules,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (!isAgentPipeline(pipeline)) {
    throw new Error(`Invalid AgentPipeline stored (${row.id}): malformed shape`);
  }
  validateStepTopology(pipeline.steps);
  validateBackflowRules(pipeline.steps, pipeline.backflowRules ?? []);
  return pipeline;
};

const SELECT = `SELECT id, name, description, steps_json,
    COALESCE(backflow_rules_json, '[]') AS backflow_rules_json,
    created_at, updated_at
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
    await this.validate(input.name, input.steps, input.backflowRules ?? []);
    const id = newId("agentPipeline");
    const now = nowIso();
    const pipeline: AgentPipeline = {
      ...input,
      backflowRules: input.backflowRules ?? [],
      id,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO agent_pipelines
          (id, name, description, steps_json, backflow_rules_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        pipeline.id,
        pipeline.name,
        pipeline.description,
        JSON.stringify(pipeline.steps),
        JSON.stringify(pipeline.backflowRules ?? []),
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
    this.backfillSeedFilePatchActions({ existing, updatedAt: now });
    this.backfillSeed3dAssetInstructions({ existing, updatedAt: now });
    this.reconcileKnownLegacySeedStepContracts({ existing, updatedAt: now });
    this.backfillSeedBackflowRules({ existing, updatedAt: now });
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
        backflowRules: suggestSeedBackflowRules(steps, template.backflowRules ?? []),
        createdAt: now,
        updatedAt: now,
      };
      await this.validate(pipeline.name, pipeline.steps, pipeline.backflowRules ?? []);
      this.insertRow(pipeline);
      existingIds.add(pipeline.id);
      existingNames.add(nameKey);
    }
  }

  async update(pipeline: AgentPipeline): Promise<AgentPipeline> {
    await this.validate(pipeline.name, pipeline.steps, pipeline.backflowRules ?? []);
    const updated: AgentPipeline = {
      ...pipeline,
      backflowRules: pipeline.backflowRules ?? [],
      updatedAt: nowIso(),
    };
    this.db
      .prepare(
        `UPDATE agent_pipelines
           SET name = ?, description = ?, steps_json = ?, backflow_rules_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        updated.name,
        updated.description,
        JSON.stringify(updated.steps),
        JSON.stringify(updated.backflowRules ?? []),
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
    backflowRules: readonly AgentPipelineBackflowRule[] = [],
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
    validateBackflowRules(steps, backflowRules);
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
          (id, name, description, steps_json, backflow_rules_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        pipeline.id,
        pipeline.name,
        pipeline.description,
        JSON.stringify(pipeline.steps),
        JSON.stringify(pipeline.backflowRules ?? []),
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
              SET description = ?, steps_json = ?, backflow_rules_json = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          description,
          JSON.stringify(steps),
          JSON.stringify(pipeline.backflowRules ?? []),
          input.updatedAt,
          pipeline.id,
        );
    }
  }

  private backfillSeedBackflowRules(input: {
    existing: readonly AgentPipeline[];
    updatedAt: string;
  }): void {
    const desiredById = new Map(
      pipelineSeedTemplates.map((template) => [template.id, template] as const),
    );
    for (const pipeline of input.existing) {
      const desired = desiredById.get(pipeline.id);
      if (!desired) continue;
      const backflowRules = suggestSeedBackflowRules(
        pipeline.steps,
        pipeline.backflowRules ?? [],
        new Map(desired.steps.map((step) => [step.id, step.title] as const)),
      );
      if (backflowRules.length === (pipeline.backflowRules ?? []).length) {
        continue;
      }
      validateBackflowRules(pipeline.steps, backflowRules);
      this.db
        .prepare(
          `UPDATE agent_pipelines
              SET backflow_rules_json = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(JSON.stringify(backflowRules), input.updatedAt, pipeline.id);
    }
  }

  private backfillSeedFilePatchActions(input: {
    existing: readonly AgentPipeline[];
    updatedAt: string;
  }): void {
    const desiredById = new Map(
      pipelineSeedTemplates.map((template) => [template.id, template] as const),
    );
    const selectById = this.db.prepare<[string], PipelineRow>(
      `${SELECT} WHERE id = ?`,
    );
    for (const existingPipeline of input.existing) {
      const desired = desiredById.get(existingPipeline.id);
      if (!desired) continue;
      const row = selectById.get(existingPipeline.id);
      if (!row) continue;
      const pipeline = rowToPipeline(row);
      const desiredSteps = new Map(
        desired.steps.map((step) => [step.id, step] as const),
      );
      let changed = false;
      const steps = pipeline.steps.map((step) => {
        const desiredStep = desiredSteps.get(step.id);
        const desiredActions = desiredStep?.allowedActions ?? [];
        if (!desiredActions.includes("file_patch")) return step;
        const legacyActions = desiredActions.filter(
          (action) => action !== "file_patch",
        );
        if (!sameActionList(step.allowedActions ?? [], legacyActions)) {
          return step;
        }
        changed = true;
        return { ...step, allowedActions: [...desiredActions] };
      });
      if (!changed) continue;
      this.db
        .prepare(
          `UPDATE agent_pipelines
              SET steps_json = ?, backflow_rules_json = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          JSON.stringify(steps),
          JSON.stringify(pipeline.backflowRules ?? []),
          input.updatedAt,
          pipeline.id,
        );
    }
  }

  private backfillSeed3dAssetInstructions(input: {
    existing: readonly AgentPipeline[];
    updatedAt: string;
  }): void {
    if (
      !input.existing.some(
        (pipeline) => pipeline.id === "pipe_template_3d_new_project_delivery",
      )
    ) {
      return;
    }
    const desired = pipelineSeedTemplates.find(
      (template) => template.id === "pipe_template_3d_new_project_delivery",
    );
    if (!desired) return;
    const row = this.db
      .prepare<[string], PipelineRow>(`${SELECT} WHERE id = ?`)
      .get("pipe_template_3d_new_project_delivery");
    if (!row) return;
    const pipeline = rowToPipeline(row);
    const desiredSteps = new Map(
      desired.steps.map((step) => [step.id, step] as const),
    );
    let changed = false;
    const steps = pipeline.steps.map((step) => {
      const desiredStep = desiredSteps.get(step.id);
      const legacyInstruction = LEGACY_3D_ASSET_STEP_INSTRUCTIONS[step.id];
      if (
        !desiredStep ||
        legacyInstruction === undefined ||
        step.instruction !== legacyInstruction
      ) {
        return step;
      }
      changed = true;
      return { ...step, instruction: desiredStep.instruction };
    });
    if (!changed) return;
    this.db
      .prepare(
        `UPDATE agent_pipelines
            SET steps_json = ?, backflow_rules_json = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        JSON.stringify(steps),
        JSON.stringify(pipeline.backflowRules ?? []),
        input.updatedAt,
        pipeline.id,
      );
  }

  private reconcileKnownLegacySeedStepContracts(input: {
    existing: readonly AgentPipeline[];
    updatedAt: string;
  }): void {
    const desiredById = new Map(
      pipelineSeedTemplates.map((template) => [template.id, template] as const),
    );
    const legacyByStep = new Map(
      LEGACY_SEED_STEP_CONTRACTS.map((contract) => [
        `${contract.pipelineId}/${contract.stepId}`,
        contract,
      ] as const),
    );
    const selectById = this.db.prepare<[string], PipelineRow>(
      `${SELECT} WHERE id = ?`,
    );

    for (const existingPipeline of input.existing) {
      const desired = desiredById.get(existingPipeline.id);
      if (!desired) continue;
      const row = selectById.get(existingPipeline.id);
      if (!row) continue;
      const pipeline = rowToPipeline(row);
      const desiredSteps = new Map(
        desired.steps.map((step) => [step.id, step] as const),
      );
      let changed = false;
      const steps = pipeline.steps.map((step) => {
        const desiredStep = desiredSteps.get(step.id);
        const legacy = legacyByStep.get(`${pipeline.id}/${step.id}`);
        if (!desiredStep || !legacy) return step;

        let next = step;
        const desiredActions = desiredStep.allowedActions ?? [];
        if (
          legacy.allowedActions !== undefined &&
          sameActionList(step.allowedActions ?? [], legacy.allowedActions) &&
          !sameActionList(step.allowedActions ?? [], desiredActions)
        ) {
          next = { ...next, allowedActions: [...desiredActions] };
          changed = true;
        }
        if (
          legacy.outputContractWasMissing === true &&
          step.outputContract === undefined &&
          desiredStep.outputContract !== undefined
        ) {
          next = { ...next, outputContract: desiredStep.outputContract };
          changed = true;
        }
        return next;
      });
      if (!changed) continue;
      this.db
        .prepare(
          `UPDATE agent_pipelines
              SET steps_json = ?, backflow_rules_json = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          JSON.stringify(steps),
          JSON.stringify(pipeline.backflowRules ?? []),
          input.updatedAt,
          pipeline.id,
        );
    }
  }
}

interface LegacySeedStepContract {
  pipelineId: string;
  stepId: string;
  allowedActions?: AgentPipelineStep["allowedActions"];
  outputContractWasMissing?: boolean;
}

const LEGACY_SEED_STEP_CONTRACTS: readonly LegacySeedStepContract[] = [
  {
    pipelineId: "pipe_template_supervised_delivery",
    stepId: "implement",
    allowedActions: ["file_patch", "file_write", "shell"],
    outputContractWasMissing: true,
  },
  ...["plan", "security", "performance", "correctness"].map((stepId) => ({
    pipelineId: "pipe_template_review_hardening",
    stepId,
    allowedActions: ["file_write"] as const,
  })),
  ...["project-plan", "architecture"].map((stepId) => ({
    pipelineId: "pipe_template_new_project_delivery",
    stepId,
    allowedActions: ["file_write", "file_patch", "shell"] as const,
  })),
  {
    pipelineId: "pipe_template_new_project_delivery",
    stepId: "image-assets",
    allowedActions: ["file_patch", "file_write"],
  },
  {
    pipelineId: "pipe_template_new_project_delivery",
    stepId: "implementation",
    allowedActions: ["file_write", "file_patch"],
  },
  ...["texture-generation", "modeling", "file-composition", "class-generation"].map(
    (stepId) => ({
      pipelineId: "pipe_template_3d_new_project_delivery",
      stepId,
      allowedActions: ["file_write", "file_patch", "shell"] as const,
    }),
  ),
  {
    pipelineId: "pipe_template_3d_new_project_delivery",
    stepId: "implementation",
    allowedActions: ["file_patch", "file_write", "shell"],
  },
  {
    pipelineId: "pipe_template_3d_new_project_delivery",
    stepId: "review",
    allowedActions: ["shell"],
  },
];

const LEGACY_3D_ASSET_STEP_INSTRUCTIONS: Record<string, string> = {
  "texture-generation":
    "3D 모델링에 씌울 텍스처를 생성하세요. 현재 runner는 텍스트 파일 쓰기만 지원하므로 SVG, CSS, JSON, procedural texture script 같은 텍스트 기반 산출물로 제안하고, material/UV/해상도/검수 기준을 함께 남기세요.",
  modeling:
    "텍스처 산출물을 실제 material로 참조하는 3D 모델을 생성하세요. 가능한 경우 텍스트 기반 .gltf, .obj/.mtl, Three.js geometry/module 코드로 제안하고 scale, origin, asset path, fallback을 명확히 하세요.",
  "file-composition":
    "PRD, 아키텍처, 계획, 텍스처, 3D 모델 산출물을 바탕으로 새 프로젝트의 폴더와 초기 파일을 구성하세요. source/assets/tests/docs/config 경계를 분리하고 targetDir 밖으로 쓰지 마세요.",
  "class-generation":
    "파일 구성과 아키텍처를 바탕으로 핵심 class/component skeleton을 생성하세요. 3D asset loader, scene/controller, texture/model registry, UI 또는 runtime entry class의 책임과 public contract를 명확히 하세요.",
  implementation:
    "생성된 3D 모델과 텍스처를 실제 프로젝트 기능에서 반드시 사용하도록 세부 구현하세요. 모델/텍스처 asset path, loading state, fallback, runtime integration, 테스트 가능한 경계를 포함하고, 기존 파일 부분 수정은 file_patch, 새 파일이나 전체 본문 교체는 file_write approval로 제안하세요.",
  "execution-validation":
    "새 프로젝트가 실제로 실행 가능한지 build/test/smoke 또는 가장 좁은 검증 명령을 실행하거나 증거를 정리하세요. 3D 모델과 텍스처 로딩 경로 검증을 포함하고, 실행하지 못한 검증은 이유와 남은 위험을 분리하세요.",
};

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
  backflowRules?: readonly AgentPipelineBackflowRule[];
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
    "Hermes Delegation Coordinator",
    "Ruflo Orchestrator",
    "Agno Runtime Service Architect",
    "Agno Trace Planner",
  ]),
  explorer: profileRef("planner", ["ECC Codebase Explorer", "Planner"]),
  docsResearcher: profileRef("planner", ["ECC Docs Researcher", "Planner"]),
  runtimeArchitect: profileRef("orchestrator", [
    "Agno Runtime Service Architect",
    "Agno Trace Planner",
    "Ruflo Orchestrator",
  ]),
  approvalPolicy: profileRef("security-reviewer", [
    "Agno Approval Policy Designer",
    "ECC Security Reviewer",
  ]),
  federation: profileRef("security-reviewer", [
    "Ruflo Federation Auditor",
    "ECC Security Reviewer",
  ]),
  delegation: profileRef("orchestrator", [
    "Hermes Delegation Coordinator",
    "Ruflo Orchestrator",
  ]),
  memoryCurator: profileRef("planner", [
    "Hermes Memory Lifecycle Curator",
    "Hermes Skill Curator",
    "Planner",
  ]),
  evalHarness: profileRef("tester", ["ECC Eval Harness Designer", "ECC TDD Guide", "Tester"]),
  ipcGuardian: profileRef("reviewer", [
    "Harness IPC Contract Guardian",
    "Reviewer",
  ]),
  storageSteward: profileRef("planner", [
    "Harness Storage Migration Steward",
    "ECC Data Migration Planner",
    "Planner",
  ]),
  product: profileRef("planner", ["Agno Product PRD Strategist", "Planner"]),
  projectPrd: profileRef("planner", [
    "Project PRD Agent",
    "Agno Product PRD Strategist",
    "Planner",
  ]),
  projectArchitecture: profileRef("orchestrator", [
    "Project Architecture Agent",
    "Ruflo Architecture Designer",
    "Agno Runtime Service Architect",
    "Ruflo Orchestrator",
  ]),
  projectPlan: profileRef("planner", [
    "Project Plan Agent",
    "Planner",
  ]),
  texture3d: profileRef("coder", [
    "3D Texture Asset Generator",
    "Codex Bulk Coder",
    "Coder",
  ]),
  model3d: profileRef("coder", [
    "3D Model Builder",
    "Codex Bulk Coder",
    "Coder",
  ]),
  fileComposer: profileRef("coder", [
    "Project File Composer",
    "Codex Bulk Coder",
    "Coder",
  ]),
  classSkeleton: profileRef("coder", [
    "Class Skeleton Builder",
    "Codex Bulk Coder",
    "Coder",
  ]),
  integration3d: profileRef("coder", [
    "3D Integration Implementer",
    "Codex Bulk Coder",
    "Coder",
  ]),
  projectReview: profileRef("reviewer", [
    "Project Review Agent",
    "Reviewer",
  ]),
  executionVerification: profileRef("tester", [
    "Execution Verification Agent",
    "ECC Eval Harness Designer",
    "ECC TDD Guide",
    "Tester",
  ]),
  projectExplanation: profileRef("planner", [
    "Project Explanation Agent",
    "ECC Documentation Writer",
    "Planner",
  ]),
  completionGate: profileRef("reviewer", [
    "Completion Gate Reviewer",
    "Reviewer",
  ]),
  architecture: profileRef("orchestrator", [
    "Agno Runtime Service Architect",
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
    "Harness Storage Migration Steward",
    "ECC Data Migration Planner",
    "Planner",
  ]),
  planner: profileRef("planner", ["Planner"]),
  coder: profileRef("coder", ["Codex Bulk Coder", "Coder"]),
  refactor: profileRef("refactor-cleaner", ["ECC Refactor Cleaner"]),
  build: profileRef("build-error-resolver", ["ECC Build Error Resolver"]),
  tester: profileRef("tester", ["ECC Eval Harness Designer", "ECC TDD Guide", "Tester"]),
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
          "사용자 요청을 목표 사용자, 문제 정의, 성공 지표, scope/non-scope, 가정과 미확정 위험으로 정리한 PRD 초안을 한국어로 작성하세요. 사용자에게 질문하지 말고 필요한 기본값을 정해 계속 진행하세요.",
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
    id: "pipe_template_evidence_bug_investigation",
    name: "Evidence-First Bug Investigation",
    description:
      "증상 보고를 코드 추적, 실패 원인 후보, 최소 수정, 검증, 리뷰로 이어가는 evidence-first debugging 흐름입니다.",
    steps: [
      {
        id: "trace",
        profile: PROFILE_REFS.explorer,
        title: "실제 실행 경로 추적",
        instruction:
          "사용자가 보고한 증상을 기준으로 실제 코드 경로, IPC/service/repository 호출, 상태 전이, 관련 테스트를 read-only로 추적하고 사실/추론/미확인을 분리해 한국어로 보고하세요.",
        expectedArtifactKinds: ["plan", "log"],
        dependsOn: [],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "hypothesis",
        profile: PROFILE_REFS.planner,
        title: "원인 후보와 수정 범위 계획",
        instruction:
          "추적 결과를 바탕으로 가능성 높은 원인 후보, 배제된 후보, 최소 수정 범위, 검증 명령을 계획하세요.",
        expectedArtifactKinds: ["plan", "log"],
        dependsOn: ["trace"],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "patch",
        profile: PROFILE_REFS.coder,
        title: "최소 수정 제안",
        instruction:
          "승인된 원인 후보와 범위만 바탕으로 최소 diff를 제안하세요. 기존 파일 부분 수정은 file_patch, 새 파일이나 전체 본문 교체는 file_write approval로 제안하고, unrelated cleanup은 피하세요.",
        expectedArtifactKinds: ["diff", "log"],
        dependsOn: ["hypothesis"],
        allowedActions: ["file_patch", "file_write"],
        outputContract: "diff_proposal",
      },
      {
        id: "verify",
        profile: PROFILE_REFS.tester,
        title: "증상 회귀 검증",
        instruction:
          "보고된 증상이 해결되었음을 보여주는 가장 좁은 test/check/smoke를 실행하거나 설계하고 증거를 한국어로 정리하세요.",
        expectedArtifactKinds: ["test_result", "log"],
        dependsOn: ["patch"],
        allowedActions: ["shell"],
        outputContract: "test_result",
      },
      {
        id: "review",
        profile: PROFILE_REFS.reviewer,
        title: "원인-수정 일치성 리뷰",
        instruction:
          "수정이 실제 원인을 해결하는지, 새 회귀나 누락된 검증이 있는지 read-only로 검토하고 남은 위험을 한국어로 보고하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["verify"],
        allowedActions: [],
        outputContract: "review",
      },
    ],
  },
  {
    id: "pipe_template_docs_contract_reconciliation",
    name: "Docs-First Contract Reconciliation",
    description:
      "외부/내부 문서 확인 후 IPC/API/state 계약과 실제 구현 drift를 맞추는 docs-first 흐름입니다.",
    steps: [
      {
        id: "source-check",
        profile: PROFILE_REFS.docsResearcher,
        title: "primary source와 기존 문서 확인",
        instruction:
          "요청과 관련된 공식 문서, GitHub 원본, repo docs/contracts를 확인하고 변경에 필요한 사실과 불확실성을 출처별로 정리하세요.",
        expectedArtifactKinds: ["plan", "log"],
        dependsOn: [],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "contract-audit",
        profile: PROFILE_REFS.ipcGuardian,
        title: "IPC/API 계약 drift 감사",
        instruction:
          "core api/types, Electron IPC, preload, renderer types, docs/contracts가 같은 계약을 유지하는지 read-only로 검토하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["source-check"],
        allowedActions: [],
        outputContract: "review",
      },
      {
        id: "runtime-design",
        profile: PROFILE_REFS.runtimeArchitect,
        title: "runtime/service 경계 설계",
        instruction:
          "문서와 계약 감사 결과를 바탕으로 service, repository, runner, approval, diagnostics 경계를 설계하고 구현 순서를 제안하세요.",
        expectedArtifactKinds: ["plan", "orchestration_plan", "log"],
        dependsOn: ["source-check", "contract-audit"],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "implement",
        profile: PROFILE_REFS.coder,
        title: "계약 정렬 diff 제안",
        instruction:
          "승인된 계약 정렬 범위만 최소 diff로 제안하세요. 기존 파일 부분 수정은 file_patch, 새 파일이나 전체 본문 교체는 file_write approval로 제안하고 docs/code/test가 서로 같은 계약을 말하도록 유지하세요.",
        expectedArtifactKinds: ["diff", "log"],
        dependsOn: ["runtime-design"],
        allowedActions: ["file_patch", "file_write"],
        outputContract: "diff_proposal",
      },
      {
        id: "verify",
        profile: PROFILE_REFS.tester,
        title: "계약 회귀 검증",
        instruction:
          "IPC/API/state 계약 변경이 round-trip, typecheck, repository/service tests를 통과하는지 검증하거나 필요한 테스트를 제안하세요.",
        expectedArtifactKinds: ["test_result", "log"],
        dependsOn: ["implement"],
        allowedActions: ["shell"],
        outputContract: "test_result",
      },
      {
        id: "review",
        profile: PROFILE_REFS.reviewer,
        title: "문서-구현 정합성 최종 리뷰",
        instruction:
          "문서, 구현, 테스트가 같은 계약을 유지하는지 최종 검토하고 남은 drift나 follow-up을 한국어로 보고하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["verify"],
        allowedActions: [],
        outputContract: "review",
      },
    ],
  },
  {
    id: "pipe_template_runtime_approval_hardening",
    name: "Runtime Approval Hardening",
    description:
      "approval policy, runner 권한, 보안 경계, 테스트를 함께 강화하는 runtime hardening 흐름입니다.",
    steps: [
      {
        id: "policy",
        profile: PROFILE_REFS.approvalPolicy,
        title: "승인 정책과 권한 경계 검토",
        instruction:
          "action type, auto approval, profile blockedActions, pipeline-pick consent, runner proposal validation이 우회 없이 적용되는지 검토하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: [],
        allowedActions: [],
        outputContract: "review",
      },
      {
        id: "security",
        profile: PROFILE_REFS.security,
        title: "runtime 보안 리뷰",
        instruction:
          "secret, path traversal, unsafe shell, network/dependency install, prompt injection, error leakage 위험을 read-only로 검토하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["policy"],
        allowedActions: [],
        outputContract: "review",
      },
      {
        id: "patch",
        profile: PROFILE_REFS.coder,
        title: "hardening 변경 제안",
        instruction:
          "승인된 hardening 범위만 최소 diff로 제안하세요. 기존 파일 부분 수정은 file_patch, 새 파일이나 전체 본문 교체는 file_write approval로 제안하고, user-supervised workflow를 자동 실행/자동 저장으로 바꾸지 마세요.",
        expectedArtifactKinds: ["diff", "log"],
        dependsOn: ["policy", "security"],
        allowedActions: ["file_patch", "file_write"],
        outputContract: "diff_proposal",
      },
      {
        id: "verify",
        profile: PROFILE_REFS.tester,
        title: "policy 회귀 검증",
        instruction:
          "승인 우회 차단, blocklist 우선순위, 위험 action rejection을 검증하는 focused test를 실행하거나 제안하세요.",
        expectedArtifactKinds: ["test_result", "log"],
        dependsOn: ["patch"],
        allowedActions: ["shell"],
        outputContract: "test_result",
      },
      {
        id: "review",
        profile: PROFILE_REFS.security,
        title: "hardening 최종 보안 리뷰",
        instruction:
          "변경이 새로운 권한 상승이나 운영 차단을 만들지 않는지 보안 우선으로 최종 검토하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["verify"],
        allowedActions: [],
        outputContract: "review",
      },
    ],
  },
  {
    id: "pipe_template_a2a_federation_safety",
    name: "A2A Federation Safety Review",
    description:
      "remote agent/A2A/federation 작업을 trust, delegation, trace, security, eval 관점으로 검토하는 흐름입니다.",
    steps: [
      {
        id: "federation-risk",
        profile: PROFILE_REFS.federation,
        title: "remote trust와 federation risk 검토",
        instruction:
          "A2A endpoint, remote worker, MCP server, shared workspace의 trust/enablement/PII/prompt-injection/audit 위험을 read-only로 검토하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: [],
        allowedActions: [],
        outputContract: "review",
      },
      {
        id: "delegation-plan",
        profile: PROFILE_REFS.delegation,
        title: "delegation/toolset 경계 설계",
        instruction:
          "local vs remote worker, toolset, handoff payload, timeout, retry, heartbeat, fallback 정책을 설계하세요.",
        expectedArtifactKinds: ["orchestration_plan", "plan", "log"],
        dependsOn: ["federation-risk"],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "trace-plan",
        profile: PROFILE_REFS.runtimeArchitect,
        title: "trace/audit 저장 설계",
        instruction:
          "remote invocation trace, policy evaluation, endpoint status, failure recovery, operator-visible diagnostics 저장 지점을 설계하세요.",
        expectedArtifactKinds: ["plan", "log"],
        dependsOn: ["delegation-plan"],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "verify",
        profile: PROFILE_REFS.evalHarness,
        title: "remote safety eval 설계",
        instruction:
          "remote endpoint disabled/untrusted/missing, prompt injection, approval blocklist, timeout/failure fallback을 검증하는 테스트/eval 시나리오를 제안하세요.",
        expectedArtifactKinds: ["test_result", "log"],
        dependsOn: ["trace-plan"],
        allowedActions: ["shell"],
        outputContract: "test_result",
      },
      {
        id: "review",
        profile: PROFILE_REFS.reviewer,
        title: "A2A safety 최종 리뷰",
        instruction:
          "federation risk, delegation design, trace/eval 계획이 user-supervised Harness 원칙을 지키는지 최종 검토하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["verify"],
        allowedActions: [],
        outputContract: "review",
      },
    ],
  },
  {
    id: "pipe_template_eval_release_verification",
    name: "Eval-Driven Release Verification",
    description:
      "릴리스 전 eval fixture, build/test/smoke, 보안/성능 리뷰를 묶어 실행 가능성을 검증하는 흐름입니다.",
    steps: [
      {
        id: "eval-plan",
        profile: PROFILE_REFS.evalHarness,
        title: "eval과 smoke 검증 계획",
        instruction:
          "변경된 기능에 필요한 regression fixture, grader, threshold, real CLI smoke, 비용/시간 위험을 설계하세요.",
        expectedArtifactKinds: ["plan", "test_result", "log"],
        dependsOn: [],
        allowedActions: [],
        outputContract: "test_result",
      },
      {
        id: "build",
        profile: PROFILE_REFS.build,
        title: "release check 실행/복구",
        instruction:
          "승인된 범위에서 check/test/build/smoke를 실행하고 첫 실제 실패가 있으면 기존 파일 부분 수정은 file_patch, 새 파일이나 전체 본문 교체는 file_write approval로 최소 수정안을 제안하세요.",
        expectedArtifactKinds: ["test_result", "diff", "log"],
        dependsOn: ["eval-plan"],
        allowedActions: ["shell", "file_patch", "file_write"],
        outputContract: "test_result",
      },
      {
        id: "security",
        profile: PROFILE_REFS.security,
        title: "release 보안 리뷰",
        instruction:
          "릴리스 후보에서 secret, dependency, unsafe runner, approval bypass, remote tool 위험을 read-only로 검토하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["build"],
        allowedActions: [],
        outputContract: "review",
      },
      {
        id: "performance",
        profile: PROFILE_REFS.performance,
        title: "release 성능 리뷰",
        instruction:
          "hot path, DB contention, UI responsiveness, allocation, repeated work, missing benchmark 위험을 read-only로 검토하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["build"],
        allowedActions: [],
        outputContract: "review",
      },
      {
        id: "final",
        profile: PROFILE_REFS.reviewer,
        title: "release readiness 판단",
        instruction:
          "eval/build/test/smoke와 보안/성능 리뷰 결과를 종합해 release 가능한지, 막는 이슈가 무엇인지 한국어로 판단하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["security", "performance"],
        allowedActions: [],
        outputContract: "review",
      },
    ],
  },
  {
    id: "pipe_template_cross_harness_agent_baseline",
    name: "Cross-Harness Agent Baseline",
    description:
      "ECC/Hermes/Ruflo/Agno 참조를 Harness AgentProfile, skill source, pipeline seed 개선으로 변환하는 agent-baseline 흐름입니다.",
    steps: [
      {
        id: "sources",
        profile: PROFILE_REFS.docsResearcher,
        title: "참조 프로젝트 source 확인",
        instruction:
          "ECC, Hermes, Ruflo, Agno 또는 사용자가 지정한 참조의 GitHub/공식 문서를 확인하고 Harness에 적용 가능한 agent 설정 패턴만 정리하세요.",
        expectedArtifactKinds: ["plan", "log"],
        dependsOn: [],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "skill-memory",
        profile: PROFILE_REFS.memoryCurator,
        title: "skill/memory 후보 정리",
        instruction:
          "반복 사용될 skill, memory, docs 승격 후보와 trigger/context budget/금지 행동을 정리하세요.",
        expectedArtifactKinds: ["plan", "log"],
        dependsOn: ["sources"],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "topology",
        profile: PROFILE_REFS.delegation,
        title: "agent topology와 pipeline 설계",
        instruction:
          "참조 패턴을 Harness AgentProfile, role, dependency, allowedActions, outputContract, fallback pipeline으로 변환하세요.",
        expectedArtifactKinds: ["orchestration_plan", "plan", "log"],
        dependsOn: ["sources", "skill-memory"],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "implement",
        profile: PROFILE_REFS.coder,
        title: "baseline seed 구현 제안",
        instruction:
          "승인된 topology만 바탕으로 profile/pipeline seed, 추천 키워드, docs 변경을 최소 diff로 제안하세요. 기존 파일 부분 수정은 file_patch, 새 파일이나 전체 본문 교체는 file_write approval을 사용하세요.",
        expectedArtifactKinds: ["diff", "log"],
        dependsOn: ["topology"],
        allowedActions: ["file_patch", "file_write"],
        outputContract: "diff_proposal",
      },
      {
        id: "verify",
        profile: PROFILE_REFS.evalHarness,
        title: "agent baseline 회귀 검증",
        instruction:
          "seed idempotency, role mapping, pipeline validation, recommendation ranking, prompt contract를 검증하는 test/eval을 실행하거나 제안하세요.",
        expectedArtifactKinds: ["test_result", "log"],
        dependsOn: ["implement"],
        allowedActions: ["shell"],
        outputContract: "test_result",
      },
      {
        id: "security",
        profile: PROFILE_REFS.approvalPolicy,
        title: "baseline 권한 리뷰",
        instruction:
          "새 agent/pipeline이 과도한 권한, auto approval bypass, tool overload, context pollution, remote trust risk를 만들지 않는지 검토하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["implement"],
        allowedActions: [],
        outputContract: "review",
      },
      {
        id: "review",
        profile: PROFILE_REFS.reviewer,
        title: "agent baseline 최종 리뷰",
        instruction:
          "검증과 보안 리뷰 결과를 종합해 HarnessAgentOS에 맞는 curated baseline인지 한국어로 판단하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["verify", "security"],
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
          "승인된 PRD/UX/image prompt 산출물을 바탕으로 기존 UI 패턴에 맞춘 최소 frontend 변경을 제안하세요. 기존 파일 부분 수정은 file_patch, 새 파일이나 전체 본문 교체는 file_write approval로만 제안하세요.",
        expectedArtifactKinds: ["diff", "log"],
        dependsOn: ["ux-flow", "image-prompts"],
        allowedActions: ["file_patch", "file_write"],
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
    id: "pipe_template_3d_new_project_delivery",
    name: "3D New Project Delivery",
    description:
      "새 프로젝트 생성을 PRD, 아키텍처, 계획, 텍스처 생성, 3D 모델링, 파일 구성, 클래스 생성, 세부 구현, 검토, 실행 검증, 설명, 완료까지 연결하는 3D asset 중심 흐름입니다.",
    steps: [
      {
        id: "prd",
        profile: PROFILE_REFS.projectPrd,
        title: "PRD 작성",
        instruction:
          "사용자 요청을 새 3D 프로젝트의 목표 사용자, 핵심 문제, 주요 기능, 3D 모델/텍스처 요구사항, 성공 기준, scope/non-scope, acceptance criteria로 정리하세요.",
        expectedArtifactKinds: ["plan", "log"],
        dependsOn: [],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "architecture",
        profile: PROFILE_REFS.projectArchitecture,
        title: "아키텍처 설계",
        instruction:
          "PRD를 바탕으로 프로젝트 모듈 경계, 렌더링 흐름, 3D asset pipeline, 텍스처와 모델 파일 계약, 클래스 책임, 검증 가능한 handoff를 설계하세요.",
        expectedArtifactKinds: ["plan", "orchestration_plan", "log"],
        dependsOn: ["prd"],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "plan",
        profile: PROFILE_REFS.projectPlan,
        title: "프로젝트 생성 플랜",
        instruction:
          "PRD와 아키텍처를 텍스처 생성, 3D 모델링, 파일 구성, 클래스 생성, 세부 구현, 검토, 실행 검증, 설명, 완료 단계로 나누고 각 단계의 입력/출력과 승인 필요한 파일 쓰기 범위를 정의하세요.",
        expectedArtifactKinds: ["plan", "orchestration_plan", "log"],
        dependsOn: ["architecture"],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "texture-generation",
        profile: PROFILE_REFS.texture3d,
        title: "이미지 생성: 3D 텍스처",
        instruction:
          "3D 모델링에 씌울 텍스처 파일을 생성하세요. 현재 runner는 텍스트 파일 쓰기만 지원하므로 SVG, CSS, JSON, procedural texture script 중 하나 이상을 실제 파일 본문으로 만들고, 반드시 proposedActions에 file_write를 포함하세요. file_write.after에는 자연어 설명이 아니라 완전한 파일 내용을 넣고 material/UV/해상도/검수 기준은 주석 또는 별도 문서 파일로 남기세요.",
        expectedArtifactKinds: ["file", "snapshot", "log"],
        dependsOn: ["plan"],
        allowedActions: ["file_write"],
        outputContract: "diff_proposal",
      },
      {
        id: "modeling",
        profile: PROFILE_REFS.model3d,
        title: "3D 모델링",
        instruction:
          "텍스처 산출물을 실제 material로 참조하는 3D 모델 파일을 생성하세요. 텍스트 기반 .gltf, .obj/.mtl, 또는 Three.js geometry/module 코드 중 하나 이상을 실제 파일 본문으로 만들고 반드시 proposedActions에 file_write를 포함하세요. 모델 파일은 texture-generation 단계의 파일 경로를 참조해야 하며 scale, origin, asset path, fallback을 파일 내용 또는 인접 문서에 명확히 남기세요.",
        expectedArtifactKinds: ["file", "diff", "log"],
        dependsOn: ["texture-generation"],
        allowedActions: ["file_write"],
        outputContract: "diff_proposal",
      },
      {
        id: "file-composition",
        profile: PROFILE_REFS.fileComposer,
        title: "파일 구성",
        instruction:
          "PRD, 아키텍처, 계획, 텍스처, 3D 모델 산출물을 바탕으로 새 프로젝트의 폴더와 초기 파일을 구성하세요. source/assets/tests/docs/config 경계를 분리하고 targetDir 밖으로 쓰지 마세요. 말로만 구조를 설명하지 말고 package/config/source/docs/tests 초기 파일을 반드시 proposedActions의 file_write로 제안하세요.",
        expectedArtifactKinds: ["diff", "file", "log"],
        dependsOn: ["modeling"],
        allowedActions: ["file_write"],
        outputContract: "diff_proposal",
      },
      {
        id: "class-generation",
        profile: PROFILE_REFS.classSkeleton,
        title: "클래스 생성",
        instruction:
          "파일 구성과 아키텍처를 바탕으로 핵심 class/component skeleton 파일을 생성하세요. 3D asset loader, scene/controller, texture/model registry, UI 또는 runtime entry class를 실제 source 파일 본문으로 만들고 반드시 proposedActions에 file_write를 포함하세요. public contract와 책임은 코드 주석 또는 문서 파일로 남기세요.",
        expectedArtifactKinds: ["diff", "file", "log"],
        dependsOn: ["file-composition"],
        allowedActions: ["file_write"],
        outputContract: "diff_proposal",
      },
      {
        id: "implementation",
        profile: PROFILE_REFS.integration3d,
        title: "세부 구현",
        instruction:
          "생성된 3D 모델과 텍스처를 실제 프로젝트 기능에서 반드시 사용하도록 세부 구현하세요. 모델/텍스처 asset path, loading state, fallback, runtime integration, 테스트 가능한 경계를 포함하고, 기존 파일 부분 수정은 file_patch, 새 파일이나 전체 본문 교체는 file_write approval로 제안하세요. proposedActions에는 최소 하나 이상의 file_patch 또는 file_write가 있어야 하며 산출된 3D asset을 import/load하지 않는 구현은 실패로 보고하세요.",
        expectedArtifactKinds: ["diff", "file", "log"],
        dependsOn: ["class-generation"],
        allowedActions: ["file_patch", "file_write"],
        outputContract: "diff_proposal",
      },
      {
        id: "review",
        profile: PROFILE_REFS.projectReview,
        title: "검토",
        instruction:
          "PRD, 아키텍처, 계획, 텍스처, 3D 모델, 파일 구성, 클래스, 세부 구현 산출물이 서로 일관되는지 read-only로 검토하세요. 구현이 생성된 3D 모델을 실제로 사용하는지 우선 확인하세요.",
        expectedArtifactKinds: ["quality_report", "snapshot", "log"],
        dependsOn: ["implementation"],
        allowedActions: [],
        outputContract: "review",
      },
      {
        id: "execution-validation",
        profile: PROFILE_REFS.executionVerification,
        title: "실행 검증",
        instruction:
          "새 프로젝트가 실제로 실행 가능한지 build/test/smoke 또는 가장 좁은 검증 명령을 실행하도록 반드시 proposedActions에 shell proposedAction을 포함하세요. 명령은 3D 모델과 텍스처 로딩 경로를 확인해야 하며, 실행할 수 있는 명령을 만들 수 없으면 성공으로 보고하지 말고 차단 이유와 남은 위험을 분리하세요.",
        expectedArtifactKinds: ["test_result", "snapshot", "log"],
        dependsOn: ["review"],
        allowedActions: ["shell"],
        outputContract: "test_result",
      },
      {
        id: "explanation",
        profile: PROFILE_REFS.projectExplanation,
        title: "설명",
        instruction:
          "생성된 프로젝트의 구조, 실행 방법, 주요 class/module, 3D 모델/텍스처 asset 흐름, 검증 결과, 알려진 제한 사항을 사용자 설명으로 한국어 정리하세요.",
        expectedArtifactKinds: ["plan", "file", "log"],
        dependsOn: ["execution-validation"],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "completion",
        profile: PROFILE_REFS.completionGate,
        title: "완료",
        instruction:
          "PRD부터 설명까지 모든 산출물과 실행 검증 증거를 종합해 완료 가능 여부를 판단하세요. 실행 가능한 상태가 아니면 완료로 판단하지 말고 막는 이슈와 되돌아갈 backflow 단계를 명확히 보고하세요.",
        expectedArtifactKinds: ["quality_report", "log"],
        dependsOn: ["explanation"],
        allowedActions: [],
        outputContract: "review",
      },
    ],
    backflowRules: [
      {
        id: "bf_architecture_from_prd",
        trigger: "step_failed",
        targetStepId: "prd",
        retryStepId: "architecture",
        maxAttempts: 2,
        instruction:
          "아키텍처가 실패하면 PRD 산출물부터 요구사항/제약을 보강한 뒤 아키텍처를 다시 작성하세요.",
      },
      {
        id: "bf_plan_from_architecture",
        trigger: "step_failed",
        targetStepId: "architecture",
        retryStepId: "plan",
        maxAttempts: 2,
        instruction:
          "계획이 실패하면 아키텍처 산출물을 먼저 보강하고 생성 순서와 검증 기준을 다시 정리하세요.",
      },
      {
        id: "bf_texture_from_plan",
        trigger: "step_failed",
        targetStepId: "plan",
        retryStepId: "texture-generation",
        maxAttempts: 2,
        instruction:
          "텍스처 생성이 실패하면 계획 단계로 돌아가 텍스처 용도, 해상도, 파일 형식, 검수 기준을 보강하세요.",
      },
      {
        id: "bf_model_from_texture",
        trigger: "step_failed",
        targetStepId: "texture-generation",
        retryStepId: "modeling",
        maxAttempts: 2,
        instruction:
          "3D 모델링이 실패하면 텍스처 산출물과 매핑 요구사항을 재작성한 뒤 모델을 다시 생성하세요.",
      },
      {
        id: "bf_implementation_from_model",
        trigger: "step_failed",
        targetStepId: "modeling",
        retryStepId: "implementation",
        maxAttempts: 2,
        instruction:
          "세부 구현이 생성된 3D 모델을 사용하지 못하면 모델링 산출물부터 되돌아가 asset path와 import 계약을 보강하세요.",
      },
      {
        id: "bf_validation_from_implementation",
        trigger: "step_failed",
        targetStepId: "implementation",
        retryStepId: "execution-validation",
        maxAttempts: 2,
        instruction:
          "실행 검증이 실패하면 구현 단계부터 재시도하고 검증 명령이 실제 산출물을 확인하도록 수정하세요.",
      },
      {
        id: "bf_completion_quality_from_implementation",
        trigger: "quality_failed",
        targetStepId: "implementation",
        retryStepId: "completion",
        maxAttempts: 1,
        instruction:
          "최종 품질 게이트가 실패하면 구현 이후 리뷰, 실행 검증, 설명, 완료 판단을 다시 수행하세요.",
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
          "승인된 프로젝트 파일 생성 후 build, typecheck, lint, test, smoke 실행 가능성을 확인하세요. 실패하면 첫 실제 원인을 추적하고 기존 파일 부분 수정은 file_patch, 새 파일이나 전체 본문 교체는 file_write approval로 가장 작은 수정안을 제안하세요.",
        expectedArtifactKinds: ["test_result", "diff", "log"],
        dependsOn: ["implementation"],
        allowedActions: ["shell", "file_patch", "file_write"],
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
          "승인된 PRD/아키텍처/UX를 바탕으로 기존 패턴에 맞는 최소 frontend 변경을 제안하세요. 기존 파일 부분 수정은 file_patch, 새 파일이나 전체 본문 교체는 file_write approval을 사용하세요.",
        expectedArtifactKinds: ["diff", "log"],
        dependsOn: ["architecture", "ux"],
        allowedActions: ["file_patch", "file_write"],
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
          "승인된 topology만 바탕으로 profile/pipeline seed 또는 UI 변경을 최소 diff로 제안하세요. 기존 파일 부분 수정은 file_patch, 새 파일이나 전체 본문 교체는 file_write approval을 사용하세요.",
        expectedArtifactKinds: ["diff", "log"],
        dependsOn: ["topology"],
        allowedActions: ["file_patch", "file_write"],
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
        allowedActions: ["file_patch", "file_write"],
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
        allowedActions: ["shell", "file_patch", "file_write"],
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
          "승인된 범위만 리팩터링하고 동작을 보존하세요. 기존 파일 부분 수정은 file_patch, 새 파일이나 전체 본문 교체는 file_write approval로 제안하고, dead code는 증거가 있을 때만 제거하세요.",
        expectedArtifactKinds: ["diff", "log"],
        dependsOn: ["plan"],
        allowedActions: ["file_patch", "file_write"],
        outputContract: "diff_proposal",
      },
      {
        id: "build",
        profile: PROFILE_REFS.build,
        title: "리팩터링 후 빌드 확인",
        instruction:
          "targeted diagnostics를 실행하고 build, type, lint, test 실패가 있으면 기존 파일 부분 수정은 file_patch, 새 파일이나 전체 본문 교체는 file_write approval로 최소 수정안을 한국어로 제안하세요.",
        expectedArtifactKinds: ["test_result", "diff", "log"],
        dependsOn: ["refactor"],
        allowedActions: ["shell", "file_patch", "file_write"],
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
          "build, typecheck, lint, test 로그에서 첫 실제 실패를 읽고 소유 모듈까지 추적하세요. 기존 파일 부분 수정은 file_patch, 새 파일이나 전체 본문 교체는 file_write approval로 가장 작은 수정안을 한국어로 제안하세요.",
        expectedArtifactKinds: ["test_result", "diff", "log"],
        dependsOn: [],
        allowedActions: ["shell", "file_patch", "file_write"],
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

const sameActionList = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((action, index) => action === right[index]);

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

const suggestSeedBackflowRules = (
  steps: readonly AgentPipelineStep[],
  existingRules: readonly AgentPipelineBackflowRule[] = [],
  titleById: ReadonlyMap<string, string> = new Map(
    steps.map((step) => [step.id, step.title] as const),
  ),
): AgentPipelineBackflowRule[] => {
  const rules: AgentPipelineBackflowRule[] = [...existingRules];
  const existingKeys = new Set(
    rules.map((rule) =>
      rule.trigger === "quality_failed"
        ? `${rule.trigger}:*`
        : `${rule.trigger}:${rule.retryStepId}`,
    ),
  );
  const existingIds = new Set(rules.map((rule) => rule.id));
  const pushRule = (
    trigger: PipelineBackflowTrigger,
    targetStepId: string,
    retryStepId: string,
    maxAttempts: number,
  ): void => {
    const key =
      trigger === "quality_failed"
        ? `${trigger}:*`
        : `${trigger}:${retryStepId}`;
    if (existingKeys.has(key)) return;
    const id = seedBackflowId(retryStepId, targetStepId, trigger);
    if (existingIds.has(id)) return;
    rules.push({
      id,
      trigger,
      targetStepId,
      retryStepId,
      maxAttempts,
      instruction: seedBackflowInstruction(
        steps,
        titleById,
        targetStepId,
        retryStepId,
        trigger,
      ),
    });
    existingKeys.add(key);
    existingIds.add(id);
  };

  for (const step of steps) {
    const target = seedBackflowTargetCandidates(steps, step.id).at(-1);
    if (!target) continue;
    pushRule("step_failed", target.id, step.id, 2);
  }

  const retryStep = steps.at(-1);
  if (retryStep) {
    const target = chooseSeedQualityBackflowTarget(steps, retryStep.id);
    if (target) {
      pushRule("quality_failed", target.id, retryStep.id, 1);
    }
  }

  return rules;
};

const seedBackflowInstruction = (
  steps: readonly AgentPipelineStep[],
  titleById: ReadonlyMap<string, string>,
  targetStepId: string,
  retryStepId: string,
  trigger: PipelineBackflowTrigger,
): string => {
  const target = steps.find((step) => step.id === targetStepId);
  const retry = steps.find((step) => step.id === retryStepId);
  const targetTitle = titleById.get(targetStepId) ?? target?.title ?? targetStepId;
  const retryTitle = titleById.get(retryStepId) ?? retry?.title ?? retryStepId;
  return trigger === "quality_failed"
    ? `최종 품질 게이트가 실패하면 ${targetTitle} 단계부터 산출물을 보강하고 ${retryTitle}까지 다시 검증하세요.`
    : `${retryTitle} 단계가 실패하면 ${targetTitle} 단계 산출물부터 보강한 뒤 ${retryTitle}를 다시 수행하세요.`;
};

const seedBackflowId = (
  retryStepId: string,
  targetStepId: string,
  trigger: PipelineBackflowTrigger,
): string =>
  `bf_${safeSeedBackflowIdPart(retryStepId)}_from_${safeSeedBackflowIdPart(
    targetStepId,
  )}_${trigger}`;

const safeSeedBackflowIdPart = (value: string): string =>
  value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "step";

const chooseSeedQualityBackflowTarget = (
  steps: readonly AgentPipelineStep[],
  retryStepId: string,
): AgentPipelineStep | null => {
  const candidates = seedBackflowTargetCandidates(steps, retryStepId);
  if (candidates.length === 0) return null;
  const firstSideEffectCandidate = candidates.find(
    (step) => (step.allowedActions ?? []).length > 0,
  );
  return firstSideEffectCandidate ?? candidates.at(-1) ?? null;
};

const seedBackflowTargetCandidates = (
  steps: readonly AgentPipelineStep[],
  retryStepId: string,
): AgentPipelineStep[] => {
  const retryIndex = steps.findIndex((step) => step.id === retryStepId);
  if (retryIndex <= 0) return [];
  return steps
    .slice(0, retryIndex)
    .filter((step) => hasBackflowDependencyPath(steps, step.id, retryStepId));
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

const validateBackflowRules = (
  steps: readonly AgentPipelineStep[],
  rules: readonly AgentPipelineBackflowRule[],
): void => {
  const stepIndexById = new Map(
    steps.map((step, index) => [step.id, index] as const),
  );
  const ruleIds = new Set<string>();
  for (const [i, rule] of rules.entries()) {
    if (!isAgentPipelineBackflowRule(rule)) {
      if (hasInvalidBackflowMaxAttempts(rule)) {
        throw new Error(
          `AgentPipeline.backflowRules[${i}].maxAttempts must be an integer from 1 to 5`,
        );
      }
      throw new Error(`AgentPipeline.backflowRules[${i}] is malformed`);
    }
    if (ruleIds.has(rule.id)) {
      throw new Error(
        `AgentPipeline.backflowRules[${i}].id duplicates another rule: ${rule.id}`,
      );
    }
    ruleIds.add(rule.id);
    const targetIndex = stepIndexById.get(rule.targetStepId);
    const retryIndex = stepIndexById.get(rule.retryStepId);
    if (targetIndex === undefined) {
      throw new Error(
        `AgentPipeline.backflowRules[${i}].targetStepId references unknown step: ${rule.targetStepId}`,
      );
    }
    if (retryIndex === undefined) {
      throw new Error(
        `AgentPipeline.backflowRules[${i}].retryStepId references unknown step: ${rule.retryStepId}`,
      );
    }
    if (rule.targetStepId === rule.retryStepId) {
      throw new Error(
        `AgentPipeline.backflowRules[${i}] targetStepId cannot equal retryStepId: ${rule.targetStepId}`,
      );
    }
    if (targetIndex >= retryIndex) {
      throw new Error(
        `AgentPipeline.backflowRules[${i}].targetStepId must be earlier than retryStepId`,
      );
    }
    if (
      !hasBackflowDependencyPath(steps, rule.targetStepId, rule.retryStepId)
    ) {
      throw new Error(
        `AgentPipeline.backflowRules[${i}].targetStepId must be on the dependency path to retryStepId`,
      );
    }
    if (
      !Number.isInteger(rule.maxAttempts) ||
      rule.maxAttempts < 1 ||
      rule.maxAttempts > 5
    ) {
      throw new Error(
        `AgentPipeline.backflowRules[${i}].maxAttempts must be an integer from 1 to 5`,
      );
    }
  }
};

const hasBackflowDependencyPath = (
  steps: readonly AgentPipelineStep[],
  targetStepId: string,
  retryStepId: string,
): boolean => {
  const stepIndexById = new Map(
    steps.map((step, index) => [step.id, index] as const),
  );
  const visited = new Set<string>();
  const visit = (stepId: string): boolean => {
    if (stepId === targetStepId) return true;
    if (visited.has(stepId)) return false;
    visited.add(stepId);
    const index = stepIndexById.get(stepId);
    if (index === undefined) return false;
    const step = steps[index]!;
    const dependencyIds =
      step.dependsOn !== undefined
        ? step.dependsOn
        : index > 0
          ? [steps[index - 1]!.id]
          : [];
    return dependencyIds.some((depId) => visit(depId));
  };
  return visit(retryStepId);
};

const hasInvalidBackflowMaxAttempts = (rule: unknown): boolean => {
  if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
    return false;
  }
  const value = (rule as { maxAttempts?: unknown }).maxAttempts;
  return (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 5
  );
};
