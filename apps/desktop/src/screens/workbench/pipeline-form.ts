import { APPROVAL_ACTION_TYPES, WORKER_OUTPUT_CONTRACTS } from "@harness/core";
import type {
  AgentPipeline,
  AgentPipelineBackflowRule,
  AgentPipelineStep,
  A2ARegistryEntry,
  ArtifactKind,
  CreateAgentPipelineInput,
  ApprovalActionType,
  HarnessSettings,
  ThreadDetail,
  WorkerRole,
  WorkerOutputContract,
  PipelineBackflowTrigger,
} from "@harness/core";

/**
 * Renderer-side form state for editing AgentPipeline templates. Steps
 * carry an `agentProfileId` (chosen from the registered profiles list);
 * everything else is a plain text input. Validation runs against the
 * caller-supplied profile list so the form catches dangling references
 * before the IPC roundtrip.
 */

export interface PipelineStepDraft {
  id: string;
  agentProfileId: string;
  remoteEndpointId: string;
  title: string;
  instruction: string;
  expectedArtifactKinds: string[];
  dependsOn: string[] | null;
  allowedActions: ApprovalActionType[] | null;
  outputContract: WorkerOutputContract | "";
}

export interface PipelineDraft {
  id: string | null;
  name: string;
  description: string;
  steps: PipelineStepDraft[];
  backflowRules: AgentPipelineBackflowRule[];
}

export interface PipelineDraftError {
  field: "name" | "description" | "steps";
  message: string;
}

export interface PipelineFanOutStepPreview {
  stepId: string;
  title: string;
  index: number;
  dependencyIds: string[];
  role: WorkerRole | "documenter" | "unknown";
  remoteEndpointId: string | null;
  remoteEndpointLabel: string;
  remoteEndpointEnabled: boolean;
  remoteEndpointTrusted: boolean;
  allowedActions: ApprovalActionType[] | null;
  canRunReadOnlyParallel: boolean;
  blockers: string[];
  warnings: string[];
}

export interface PipelineFanOutWave {
  index: number;
  stepIds: string[];
  parallelizable: boolean;
  hasSideEffects: boolean;
  warnings: string[];
  steps: PipelineFanOutStepPreview[];
}

export interface PipelineFanOutPreview {
  waves: PipelineFanOutWave[];
  deterministicOrder: string[];
  warnings: string[];
}

export interface TopologyTaskRunOption {
  id: string;
  label: string;
  threadTitle: string;
  userRequest: string;
  status: string;
  createdAt: string;
}

export type PipelineIntentKey =
  | "bug_investigation"
  | "build_recovery"
  | "refactor_safety"
  | "review_hardening"
  | "docs_contract"
  | "runtime_hardening"
  | "a2a_federation"
  | "eval_release"
  | "agent_baseline"
  | "new_project_3d_delivery"
  | "new_project_delivery"
  | "product_prd"
  | "architecture_design"
  | "visual_design"
  | "supervised_delivery"
  | "none";

export interface PipelineIntentPreset {
  key: Exclude<PipelineIntentKey, "none">;
  label: string;
  requestHint: string;
  reason: string;
  keywords: readonly string[];
  pipelineKeywords: readonly string[];
  preferredPipelineIds: readonly string[];
  preferredRoles: readonly WorkerRole[];
}

export interface RankedPipeline {
  pipeline: AgentPipeline;
  score: number;
  intent: PipelineIntentKey;
  recommended: boolean;
  reason: string;
  matchedRoles: WorkerRole[];
}

export const PIPELINE_WORKER_ACTION_CHOICES: readonly ApprovalActionType[] = [
  "file_write",
  "shell",
];

export const PIPELINE_OUTPUT_CONTRACT_CHOICES = WORKER_OUTPUT_CONTRACTS;

export const PIPELINE_INTENT_PRESETS: readonly PipelineIntentPreset[] = [
  {
    key: "bug_investigation",
    label: "Evidence-First Bug Investigation",
    requestHint: "원인 분석",
    reason: "증상 → 실제 실행 경로 → 최소 수정 → 검증",
    keywords: [
      "원인",
      "이유",
      "왜",
      "분석",
      "조사",
      "추적",
      "안되고",
      "안돼",
      "안되",
      "멈춰",
      "stuck",
      "debug",
      "diagnose",
      "root cause",
      "failure timeline",
      "실패 원인",
    ],
    pipelineKeywords: [
      "evidence",
      "bug",
      "investigation",
      "증상",
      "추적",
      "원인",
      "실행 경로",
      "최소 수정",
    ],
    preferredPipelineIds: ["pipe_template_evidence_bug_investigation"],
    preferredRoles: ["planner", "coder", "tester", "reviewer"],
  },
  {
    key: "build_recovery",
    label: "Build Recovery",
    requestHint: "빌드 에러",
    reason: "빌드/타입/lint/test 실패 복구",
    keywords: [
      "빌드",
      "build",
      "typecheck",
      "타입",
      "lint",
      "린트",
      "컴파일",
      "compile",
      "테스트 실패",
      "test fail",
      "에러",
      "error",
      "오류",
      "실패",
      "failed",
      "깨져",
      "안돼",
      "안되",
      "exception",
    ],
    pipelineKeywords: [
      "build",
      "빌드",
      "type",
      "lint",
      "test",
      "테스트",
      "복구",
      "실패",
    ],
    preferredPipelineIds: ["pipe_template_build_recovery"],
    preferredRoles: ["build-error-resolver", "tester", "reviewer"],
  },
  {
    key: "refactor_safety",
    label: "Refactor Safety",
    requestHint: "리팩터링",
    reason: "동작 보존 리팩터링",
    keywords: [
      "리팩터",
      "리팩토",
      "refactor",
      "cleanup",
      "정리",
      "중복",
      "dead code",
      "구조 개선",
      "분리",
      "추출",
      "rename",
    ],
    pipelineKeywords: [
      "refactor",
      "리팩터",
      "리팩토",
      "cleanup",
      "정리",
      "동작 보존",
    ],
    preferredPipelineIds: ["pipe_template_refactor_safety"],
    preferredRoles: [
      "planner",
      "refactor-cleaner",
      "build-error-resolver",
      "tester",
      "performance-reviewer",
      "reviewer",
    ],
  },
  {
    key: "review_hardening",
    label: "Parallel Review Hardening",
    requestHint: "보안 리뷰",
    reason: "보안/성능/정확성 병렬 검토",
    keywords: [
      "리뷰",
      "review",
      "검토",
      "보안",
      "security",
      "취약",
      "secret",
      "injection",
      "권한",
      "성능",
      "performance",
      "병목",
      "audit",
      "hardening",
      "위험",
    ],
    pipelineKeywords: [
      "review",
      "리뷰",
      "hardening",
      "보안",
      "security",
      "성능",
      "performance",
      "fan-out",
    ],
    preferredPipelineIds: ["pipe_template_review_hardening"],
    preferredRoles: [
      "planner",
      "security-reviewer",
      "performance-reviewer",
      "reviewer",
    ],
  },
  {
    key: "docs_contract",
    label: "Docs-First Contract Reconciliation",
    requestHint: "문서/계약 정합성",
    reason: "문서 확인 후 IPC/API/state 계약 drift 정리",
    keywords: [
      "문서",
      "docs",
      "contract",
      "계약",
      "정합",
      "drift",
      "ipc",
      "api",
      "preload",
      "window.harness",
      "스키마",
      "schema",
      "원본",
      "github",
      "web search",
      "웹서치",
    ],
    pipelineKeywords: [
      "docs-first",
      "contract",
      "reconciliation",
      "ipc",
      "api",
      "문서",
      "계약",
      "drift",
    ],
    preferredPipelineIds: ["pipe_template_docs_contract_reconciliation"],
    preferredRoles: ["planner", "orchestrator", "reviewer", "tester"],
  },
  {
    key: "runtime_hardening",
    label: "Runtime Approval Hardening",
    requestHint: "승인/권한 강화",
    reason: "approval policy와 runner 권한 경계 강화",
    keywords: [
      "approval",
      "승인",
      "auto approve",
      "자동 승인",
      "권한",
      "permission",
      "blockedactions",
      "policy",
      "정책",
      "runner",
      "hardening",
      "보안 강화",
      "우회",
      "bypass",
    ],
    pipelineKeywords: [
      "approval",
      "hardening",
      "policy",
      "권한",
      "승인",
      "runner",
      "security",
    ],
    preferredPipelineIds: ["pipe_template_runtime_approval_hardening"],
    preferredRoles: ["security-reviewer", "coder", "tester", "reviewer"],
  },
  {
    key: "a2a_federation",
    label: "A2A Federation Safety Review",
    requestHint: "A2A/remote agent",
    reason: "remote agent 신뢰와 delegation safety 검토",
    keywords: [
      "a2a",
      "remote agent",
      "remote worker",
      "federation",
      "원격 에이전트",
      "원격 워커",
      "trusted",
      "untrusted",
      "agent card",
      "delegation",
      "위임",
      "mcp server",
      "mcp",
    ],
    pipelineKeywords: [
      "a2a",
      "federation",
      "remote",
      "delegation",
      "trust",
      "안전",
    ],
    preferredPipelineIds: ["pipe_template_a2a_federation_safety"],
    preferredRoles: ["security-reviewer", "orchestrator", "tester", "reviewer"],
  },
  {
    key: "eval_release",
    label: "Eval-Driven Release Verification",
    requestHint: "릴리스 검증",
    reason: "eval/build/test/smoke/review 릴리스 검증",
    keywords: [
      "eval",
      "평가",
      "release",
      "릴리스",
      "smoke",
      "스모크",
      "검증",
      "verification",
      "회귀",
      "regression",
      "fixture",
      "grader",
      "전체 검증",
    ],
    pipelineKeywords: [
      "eval",
      "release",
      "verification",
      "smoke",
      "검증",
      "회귀",
      "fixture",
    ],
    preferredPipelineIds: ["pipe_template_eval_release_verification"],
    preferredRoles: [
      "tester",
      "build-error-resolver",
      "security-reviewer",
      "performance-reviewer",
      "reviewer",
    ],
  },
  {
    key: "agent_baseline",
    label: "Cross-Harness Agent Baseline",
    requestHint: "agent 설정 개선",
    reason: "참조 프로젝트 기반 AgentProfile/pipeline baseline 정리",
    keywords: [
      "agent 설정",
      "에이전트 설정",
      "agent profile",
      "agentprofile",
      "에이전트 프로필",
      "pipeline 개선",
      "파이프라인 개선",
      "skill",
      "스킬",
      "ecc",
      "ruflo",
      "agno",
      "hermes",
      "codex",
      "cross-harness",
    ],
    pipelineKeywords: [
      "cross-harness",
      "agent",
      "baseline",
      "profile",
      "pipeline",
      "skill",
      "ecc",
      "hermes",
    ],
    preferredPipelineIds: ["pipe_template_cross_harness_agent_baseline"],
    preferredRoles: ["planner", "orchestrator", "coder", "tester", "security-reviewer", "reviewer"],
  },
  {
    key: "new_project_3d_delivery",
    label: "3D New Project Delivery",
    requestHint: "3D 새 프로젝트 생성",
    reason: "PRD/아키텍처/계획/텍스처/3D 모델링/파일/클래스/구현/검증/완료",
    keywords: [
      "3d",
      "3D",
      "3d 모델",
      "3D 모델",
      "3d 모델링",
      "3D 모델링",
      "모델링",
      "텍스처",
      "텍스쳐",
      "texture",
      "textures",
      "gltf",
      "glb",
      "obj",
      "material",
      "uv",
      "파일 구성",
      "클래스 생성",
      "새 프로젝트",
      "새로운 프로젝트",
      "프로젝트 생성",
    ],
    pipelineKeywords: [
      "3d",
      "3D",
      "texture",
      "텍스처",
      "텍스쳐",
      "모델링",
      "gltf",
      "obj",
      "material",
      "파일 구성",
      "클래스",
      "실행 검증",
      "완료",
    ],
    preferredPipelineIds: ["pipe_template_3d_new_project_delivery"],
    preferredRoles: [
      "planner",
      "orchestrator",
      "coder",
      "tester",
      "reviewer",
    ],
  },
  {
    key: "new_project_delivery",
    label: "New Project Delivery",
    requestHint: "새 프로젝트 생성",
    reason: "PRD/계획/아키텍처/에셋/구현/검증/리뷰 전체 생성",
    keywords: [
      "새 프로젝트",
      "새 프로젝트 생성",
      "새로운 프로젝트",
      "새로운 프로젝트를 생성",
      "프로젝트 생성",
      "프로젝트를 생성",
      "프로젝트를 생성해줘",
      "프로젝트 만들어",
      "프로젝트를 만들어",
      "프로젝트 하나",
      "새 앱",
      "앱 만들어",
      "웹앱 만들어",
      "웹사이트 만들어",
      "사이트 만들어",
      "게임 만들어",
      "처음부터",
      "from scratch",
      "new project",
      "create project",
      "scaffold",
      "스캐폴드",
      "초기 프로젝트",
    ],
    pipelineKeywords: [
      "new project",
      "새 프로젝트",
      "새 프로젝트 생성",
      "프로젝트 생성",
      "prd",
      "이미지",
      "image",
      "에셋",
      "계획",
      "아키텍처",
      "구현",
      "검증",
      "리뷰",
    ],
    preferredPipelineIds: ["pipe_template_new_project_delivery"],
    preferredRoles: [
      "planner",
      "orchestrator",
      "coder",
      "build-error-resolver",
      "tester",
      "security-reviewer",
      "reviewer",
    ],
  },
  {
    key: "product_prd",
    label: "Product PRD Discovery",
    requestHint: "PRD 작성",
    reason: "제품 요구사항/사용자 시나리오 정리",
    keywords: [
      "prd",
      "제품 요구사항",
      "요구사항",
      "기획",
      "product",
      "user story",
      "사용자 시나리오",
      "acceptance criteria",
      "성공 지표",
      "scope",
      "스코프",
    ],
    pipelineKeywords: [
      "prd",
      "product",
      "제품",
      "요구사항",
      "기획",
      "사용자",
      "acceptance",
    ],
    preferredPipelineIds: ["pipe_template_product_prd"],
    preferredRoles: ["planner", "orchestrator", "reviewer"],
  },
  {
    key: "architecture_design",
    label: "Architecture RFC",
    requestHint: "아키텍처 설계",
    reason: "시스템/API/상태 경계 설계",
    keywords: [
      "아키텍처",
      "아키텍쳐",
      "architecture",
      "설계",
      "문서화",
      "rfc",
      "api 계약",
      "api contract",
      "schema",
      "스키마",
      "ipc",
      "데이터 모델",
      "migration",
      "마이그레이션",
    ],
    pipelineKeywords: [
      "architecture",
      "아키텍처",
      "아키텍쳐",
      "rfc",
      "api",
      "contract",
      "schema",
      "migration",
      "설계",
    ],
    preferredPipelineIds: ["pipe_template_architecture_rfc"],
    preferredRoles: [
      "orchestrator",
      "planner",
      "security-reviewer",
      "performance-reviewer",
      "reviewer",
    ],
  },
  {
    key: "visual_design",
    label: "Image Asset Prompt Flow",
    requestHint: "UI 디자인",
    reason: "UX/디자인/image 생성 프롬프트",
    keywords: [
      "디자인",
      "design",
      "ui",
      "ux",
      "이미지",
      "image",
      "asset",
      "에셋",
      "visual",
      "비주얼",
      "mockup",
      "와이어",
      "프롬프트",
      "prompt",
    ],
    pipelineKeywords: [
      "image",
      "이미지",
      "asset",
      "디자인",
      "design",
      "visual",
      "prompt",
      "ux",
      "ui",
    ],
    preferredPipelineIds: [
      "pipe_template_image_asset_prompt",
      "pipe_template_visual_design_delivery",
      "pipe_template_frontend_product_delivery",
    ],
    preferredRoles: ["planner", "coder", "tester", "reviewer"],
  },
  {
    key: "supervised_delivery",
    label: "Supervised Delivery",
    requestHint: "기능 구현",
    reason: "계획부터 구현/검증/리뷰까지 전체 전달",
    keywords: [
      "구현",
      "implement",
      "기능",
      "feature",
      "추가",
      "add",
      "수정",
      "fix",
      "패치",
      "patch",
      "개발",
      "만들",
      "연결",
      "완료",
    ],
    pipelineKeywords: [
      "supervised",
      "delivery",
      "구현",
      "계획",
      "검증",
      "리뷰",
    ],
    preferredPipelineIds: ["pipe_template_supervised_delivery"],
    preferredRoles: [
      "orchestrator",
      "planner",
      "coder",
      "build-error-resolver",
      "tester",
      "security-reviewer",
      "reviewer",
    ],
  },
] as const;

const ACTION_SET: ReadonlySet<string> = new Set(APPROVAL_ACTION_TYPES);
const OUTPUT_CONTRACT_SET: ReadonlySet<string> = new Set(
  WORKER_OUTPUT_CONTRACTS,
);
const BACKFLOW_TRIGGER_SET: ReadonlySet<string> = new Set([
  "step_failed",
  "quality_failed",
] satisfies PipelineBackflowTrigger[]);

export const emptyPipelineDraft = (): PipelineDraft => ({
  id: null,
  name: "",
  description: "",
  steps: [],
  backflowRules: [],
});

export const pipelineToDraft = (p: AgentPipeline): PipelineDraft => ({
  id: p.id,
  name: p.name,
  description: p.description,
  steps: p.steps.map((s) => ({
    id: s.id,
    agentProfileId: s.agentProfileId,
    remoteEndpointId: s.remoteEndpointId ?? "",
    title: s.title,
    instruction: s.instruction,
    expectedArtifactKinds: [...s.expectedArtifactKinds],
    dependsOn: s.dependsOn !== undefined ? [...s.dependsOn] : null,
    allowedActions:
      s.allowedActions !== undefined ? [...s.allowedActions] : null,
    outputContract: s.outputContract ?? "",
  })),
  backflowRules: (p.backflowRules ?? []).map((rule) => ({ ...rule })),
});

export const pipelineInputToDraft = (
  input: CreateAgentPipelineInput,
): PipelineDraft => ({
  id: null,
  name: input.name,
  description: input.description,
  steps: input.steps.map((s) => ({
    id: s.id,
    agentProfileId: s.agentProfileId,
    remoteEndpointId: s.remoteEndpointId ?? "",
    title: s.title,
    instruction: s.instruction,
    expectedArtifactKinds: [...s.expectedArtifactKinds],
    dependsOn: s.dependsOn !== undefined ? [...s.dependsOn] : null,
    allowedActions:
      s.allowedActions !== undefined ? [...s.allowedActions] : null,
    outputContract: s.outputContract ?? "",
  })),
  backflowRules: (input.backflowRules ?? []).map((rule) => ({ ...rule })),
});

export const topologyTaskRunOptionsFromThreadDetails = (
  details: ReadonlyArray<ThreadDetail | null>,
  limit = 50,
): TopologyTaskRunOption[] =>
  details
    .flatMap((detail) =>
      detail
        ? detail.taskRuns.map((taskRun) => ({
            id: taskRun.id,
            label: `${detail.thread.title} · ${taskRun.userRequest}`,
            threadTitle: detail.thread.title,
            userRequest: taskRun.userRequest,
            status: taskRun.status,
            createdAt: taskRun.createdAt,
          }))
        : [],
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);

export const settingsWithDefaultPipeline = (
  settings: HarnessSettings,
  pipelineId: string,
): HarnessSettings => ({
  ...settings,
  orchestration: {
    ...settings.orchestration,
    enabled: true,
    defaultPipelineId: pipelineId,
  },
});

interface ProfileLite {
  id: string;
  name: string;
  role?: WorkerRole | "documenter";
}

const READ_ONLY_PARALLEL_ROLES = new Set<string>([
  "planner",
  "orchestrator",
  "reviewer",
  "security-reviewer",
  "performance-reviewer",
  "documenter",
]);

const normalizeIntentText = (value: string): string =>
  value.trim().toLocaleLowerCase("ko-KR");

const countKeywordHits = (
  text: string,
  keywords: readonly string[],
): number =>
  keywords.reduce(
    (count, keyword) =>
      text.includes(keyword.toLocaleLowerCase("ko-KR")) ? count + 1 : count,
    0,
  );

const pipelineSearchText = (pipeline: AgentPipeline): string =>
  normalizeIntentText(
    [
      pipeline.name,
      pipeline.description,
      ...pipeline.steps.flatMap((step) => [step.title, step.instruction]),
    ].join(" "),
  );

export const inferPipelineIntent = (request: string): PipelineIntentKey => {
  const text = normalizeIntentText(request);
  if (text.length === 0) return "none";

  const ranked = PIPELINE_INTENT_PRESETS.map((preset, index) => ({
    preset,
    index,
    hits: countKeywordHits(text, preset.keywords),
  }))
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.index - b.index);

  return ranked[0]?.preset.key ?? "supervised_delivery";
};

export const rankPipelinesForRequest = (
  pipelines: readonly AgentPipeline[],
  request: string,
  profiles: readonly ProfileLite[] = [],
): RankedPipeline[] => {
  const intent = inferPipelineIntent(request);
  if (intent === "none") {
    return pipelines.map((pipeline) => ({
      pipeline,
      score: 0,
      intent,
      recommended: false,
      reason: "",
      matchedRoles: [],
    }));
  }

  const preset =
    PIPELINE_INTENT_PRESETS.find((entry) => entry.key === intent) ??
    PIPELINE_INTENT_PRESETS[PIPELINE_INTENT_PRESETS.length - 1]!;
  const roleByProfileId = new Map(
    profiles.map((profile) => [profile.id, profile.role] as const),
  );

  return pipelines
    .map((pipeline, index) => {
      const text = pipelineSearchText(pipeline);
      const roles = new Set(
        pipeline.steps
          .map((step) => roleByProfileId.get(step.agentProfileId))
          .filter((role): role is WorkerRole => role !== undefined),
      );
      const matchedRoles = preset.preferredRoles.filter((role) =>
        roles.has(role),
      );
      const explicitTemplate = preset.preferredPipelineIds.includes(
        pipeline.id,
      );
      const pipelineKeywordHits = countKeywordHits(
        text,
        preset.pipelineKeywords,
      );
      const score =
        (explicitTemplate ? 120 : 0) +
        pipelineKeywordHits * 12 +
        matchedRoles.length * 8;

      return {
        pipeline,
        score,
        intent,
        recommended: score > 0,
        reason: preset.reason,
        matchedRoles,
        originalIndex: index,
      };
    })
    .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex)
    .map(({ originalIndex: _originalIndex, ...entry }) => entry);
};

export const validatePipelineDraft = (
  draft: PipelineDraft,
  profiles: readonly ProfileLite[],
  remoteEntries: readonly A2ARegistryEntry[] = [],
): PipelineDraftError[] => {
  const errors: PipelineDraftError[] = [];
  if (draft.name.trim().length === 0) {
    errors.push({ field: "name", message: "이름은 필수입니다" });
  }
  if (draft.steps.length < 1) {
    errors.push({ field: "steps", message: "최소 1개의 step이 필요합니다" });
  }
  const validProfileIds = new Set(profiles.map((p) => p.id));
  const validRemoteEndpointIds = new Set(
    remoteEntries
      .filter((entry) => entry.endpoint.enabled && entry.endpoint.trusted)
      .map((entry) => entry.endpoint.id),
  );
  const stepIds = new Set<string>();
  for (const [i, step] of draft.steps.entries()) {
    if (stepIds.has(step.id)) {
      errors.push({
        field: "steps",
        message: `step ${i + 1}: 중복된 step id (${step.id})`,
      });
    }
    stepIds.add(step.id);
  }
  draft.steps.forEach((step, i) => {
    const remoteEndpointId = step.remoteEndpointId ?? "";
    if (step.title.trim().length === 0) {
      errors.push({
        field: "steps",
        message: `step ${i + 1}: title이 비어있습니다`,
      });
    }
    if (!validProfileIds.has(step.agentProfileId)) {
      errors.push({
        field: "steps",
        message: `step ${i + 1}: 알 수 없는 profile (${step.agentProfileId})`,
      });
    }
    if (
      remoteEndpointId.length > 0 &&
      !validRemoteEndpointIds.has(remoteEndpointId)
    ) {
      errors.push({
        field: "steps",
        message: `step ${i + 1}: unknown remote endpoint (${remoteEndpointId})`,
      });
    }
    const dependsOn = effectiveDependsOn(draft.steps, i);
    for (const depId of dependsOn) {
      if (depId === step.id) {
        errors.push({
          field: "steps",
          message: `step ${i + 1}: 자기 자신을 dependency로 지정할 수 없습니다`,
        });
      } else if (!stepIds.has(depId)) {
        errors.push({
          field: "steps",
          message: `step ${i + 1}: unknown dependency (${depId})`,
        });
      }
    }
    if (
      step.allowedActions !== null &&
      step.allowedActions !== undefined &&
      !step.allowedActions.every((action) => ACTION_SET.has(action))
    ) {
      errors.push({
        field: "steps",
        message: `step ${i + 1}: unknown allowed action`,
      });
    }
    if (
      step.outputContract !== "" &&
      step.outputContract !== undefined &&
      !OUTPUT_CONTRACT_SET.has(step.outputContract)
    ) {
      errors.push({
        field: "steps",
        message: `step ${i + 1}: unknown output contract`,
      });
    }
  });
  const cycleAt = firstCycleStepId(draft.steps);
  if (cycleAt !== null) {
    errors.push({
      field: "steps",
      message: `dependency cycle detected at ${cycleAt}`,
    });
  }
  errors.push(...validateBackflowRules(draft));
  return errors;
};

export const buildPipelineFanOutPreview = (
  draft: PipelineDraft,
  profiles: readonly ProfileLite[],
  remoteEntries: readonly A2ARegistryEntry[] = [],
): PipelineFanOutPreview => {
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const remoteById = new Map(
    remoteEntries.map((entry) => [entry.endpoint.id, entry] as const),
  );
  const stepIdSet = new Set(draft.steps.map((step) => step.id));
  const dependencyById = new Map(
    draft.steps.map(
      (step, index) => [step.id, effectiveDependsOn(draft.steps, index)] as const,
    ),
  );
  const steps = draft.steps.map((step, index): PipelineFanOutStepPreview => {
    const profile = profileById.get(step.agentProfileId);
    const role = profile?.role ?? "unknown";
    const dependencyIds = dependencyById.get(step.id) ?? [];
    const blockers: string[] = [];
    const warnings: string[] = [];
    const allowedActions =
      step.allowedActions !== null && step.allowedActions !== undefined
        ? [...step.allowedActions]
        : null;

    if (allowedActions === null) {
      blockers.push("Allowed Actions가 Default라 읽기 전용 병렬 대상이 아닙니다");
      warnings.push("side-effect proposal 범위가 명시되지 않았습니다");
    } else if (allowedActions.length > 0) {
      blockers.push(
        `side-effect proposal(${allowedActions.join(", ")})이 허용되어 병렬 대상이 아닙니다`,
      );
    }
    if (!READ_ONLY_PARALLEL_ROLES.has(role)) {
      blockers.push(`${role} role은 읽기 전용 병렬 대상이 아닙니다`);
    }
    for (const depId of dependencyIds) {
      if (!stepIdSet.has(depId)) {
        blockers.push(`unknown dependency (${depId})`);
      }
    }

    const remoteEndpointId = step.remoteEndpointId?.trim() || null;
    const remoteEntry =
      remoteEndpointId !== null ? remoteById.get(remoteEndpointId) : undefined;
    let remoteEndpointLabel = "Local CLI";
    let remoteEndpointEnabled = true;
    let remoteEndpointTrusted = true;
    if (remoteEndpointId !== null) {
      remoteEndpointLabel =
        remoteEntry?.endpoint.name ?? `(missing remote: ${remoteEndpointId})`;
      remoteEndpointEnabled = remoteEntry?.endpoint.enabled ?? false;
      remoteEndpointTrusted = remoteEntry?.endpoint.trusted ?? false;
      if (remoteEntry === undefined) {
        blockers.push(`remote endpoint를 찾을 수 없습니다 (${remoteEndpointId})`);
      } else {
        if (!remoteEntry.endpoint.enabled) {
          blockers.push("remote endpoint가 disabled 상태입니다");
        }
        if (!remoteEntry.endpoint.trusted) {
          blockers.push("remote endpoint가 trusted 상태가 아닙니다");
        }
      }
    }

    return {
      stepId: step.id,
      title: step.title.trim() || step.id,
      index,
      dependencyIds,
      role,
      remoteEndpointId,
      remoteEndpointLabel,
      remoteEndpointEnabled,
      remoteEndpointTrusted,
      allowedActions,
      canRunReadOnlyParallel: blockers.length === 0,
      blockers,
      warnings,
    };
  });
  const stepPreviewById = new Map(
    steps.map((step) => [step.stepId, step] as const),
  );
  const scheduled = new Set<string>();
  const remaining = new Set(steps.map((step) => step.stepId));
  const waves: PipelineFanOutWave[] = [];
  const previewWarnings: string[] = [];

  while (remaining.size > 0) {
    const ready = steps
      .filter(
        (step) =>
          remaining.has(step.stepId) &&
          step.dependencyIds.every((depId) => {
            if (!stepPreviewById.has(depId)) return true;
            return scheduled.has(depId);
          }),
      )
      .sort((a, b) => a.index - b.index);

    if (ready.length === 0) {
      const blocked = steps
        .filter((step) => remaining.has(step.stepId))
        .sort((a, b) => a.index - b.index)
        .map((step) => ({
          ...step,
          blockers: [
            ...step.blockers,
            "dependency cycle 또는 미해결 dependency 때문에 wave를 확정할 수 없습니다",
          ],
          canRunReadOnlyParallel: false,
        }));
      previewWarnings.push("dependency cycle 또는 미해결 dependency가 있습니다");
      waves.push(buildFanOutWave(waves.length, blocked));
      break;
    }

    for (const step of ready) {
      scheduled.add(step.stepId);
      remaining.delete(step.stepId);
    }
    waves.push(buildFanOutWave(waves.length, ready));
  }

  return {
    waves,
    deterministicOrder: steps.map((step) => step.stepId),
    warnings: previewWarnings,
  };
};

const buildFanOutWave = (
  index: number,
  steps: PipelineFanOutStepPreview[],
): PipelineFanOutWave => {
  const hasSideEffects = steps.some(
    (step) => step.allowedActions !== null && step.allowedActions.length > 0,
  );
  const hasDefaultActions = steps.some((step) => step.allowedActions === null);
  const parallelizable =
    steps.length > 1 && steps.every((step) => step.canRunReadOnlyParallel);
  const warnings: string[] = [];
  if (hasSideEffects) {
    warnings.push("side-effect proposal이 포함되어 실행 시 approval이 필요합니다");
  }
  if (hasDefaultActions) {
    warnings.push("Default action scope가 있어 읽기 전용 병렬 대상에서 제외됩니다");
  }
  if (steps.length > 1 && !parallelizable) {
    warnings.push("동일 wave이지만 보수 정책상 순차 preview입니다");
  }
  return {
    index,
    stepIds: steps.map((step) => step.stepId),
    parallelizable,
    hasSideEffects,
    warnings,
    steps,
  };
};

export const serializePipelineDraft = (
  draft: PipelineDraft,
): CreateAgentPipelineInput | AgentPipeline => {
  const steps: AgentPipelineStep[] = draft.steps.map((s) => {
    const remoteEndpointId = s.remoteEndpointId?.trim() ?? "";
    const dependsOn = s.dependsOn ?? null;
    const allowedActions = s.allowedActions ?? null;
    const outputContract = s.outputContract ?? "";
    return {
      id: s.id,
      agentProfileId: s.agentProfileId,
      ...(remoteEndpointId.length > 0 ? { remoteEndpointId } : {}),
      title: s.title.trim(),
      instruction: s.instruction,
      expectedArtifactKinds: [...s.expectedArtifactKinds] as ArtifactKind[],
      ...(dependsOn !== null ? { dependsOn: [...dependsOn] } : {}),
      ...(allowedActions !== null
        ? { allowedActions: [...allowedActions] }
        : {}),
      ...(outputContract !== "" ? { outputContract } : {}),
    };
  });
  const base = {
    name: draft.name.trim(),
    description: draft.description,
    steps,
    backflowRules: (draft.backflowRules ?? []).map((rule) => ({
      ...rule,
      ...(rule.instruction !== undefined
        ? { instruction: rule.instruction }
        : {}),
    })),
  };
  if (draft.id !== null) {
    // Update — caller layers `createdAt/updatedAt` on top before sending.
    return { ...base, id: draft.id } as unknown as AgentPipeline;
  }
  return base as CreateAgentPipelineInput;
};

/**
 * Move the step at `index` by `delta` positions (-1 = up, +1 = down).
 * Returns a new array; the original is left untouched. No-op if the
 * resulting index would fall outside the array.
 */
export const moveStep = <T>(
  steps: readonly T[],
  index: number,
  delta: number,
): T[] => {
  const target = index + delta;
  if (target < 0 || target >= steps.length) return [...steps];
  const next = [...steps];
  const tmp = next[index] as T;
  next[index] = next[target] as T;
  next[target] = tmp;
  return next;
};

const effectiveDependsOn = (
  steps: readonly PipelineStepDraft[],
  index: number,
): string[] => {
  const step = steps[index];
  if (!step) return [];
  if (step.dependsOn !== null && step.dependsOn !== undefined) {
    return [...step.dependsOn];
  }
  return index > 0 ? [steps[index - 1]!.id] : [];
};

const validateBackflowRules = (
  draft: PipelineDraft,
): PipelineDraftError[] => {
  const errors: PipelineDraftError[] = [];
  const stepIndexById = new Map(
    draft.steps.map((step, index) => [step.id, index] as const),
  );
  const ruleIds = new Set<string>();
  for (const [i, rule] of (draft.backflowRules ?? []).entries()) {
    const label = `backflow rule ${i + 1}`;
    if (typeof rule.id !== "string" || rule.id.trim().length === 0) {
      errors.push({ field: "steps", message: `${label}: id가 비어있습니다` });
      continue;
    }
    if (ruleIds.has(rule.id)) {
      errors.push({
        field: "steps",
        message: `${label}: 중복된 backflow id (${rule.id})`,
      });
    }
    ruleIds.add(rule.id);
    if (!BACKFLOW_TRIGGER_SET.has(rule.trigger)) {
      errors.push({
        field: "steps",
        message: `${label}: unknown backflow trigger (${rule.trigger})`,
      });
    }
    const targetIndex = stepIndexById.get(rule.targetStepId);
    const retryIndex = stepIndexById.get(rule.retryStepId);
    if (targetIndex === undefined) {
      errors.push({
        field: "steps",
        message: `${label}: backflow target step을 찾을 수 없습니다 (${rule.targetStepId})`,
      });
    }
    if (retryIndex === undefined) {
      errors.push({
        field: "steps",
        message: `${label}: backflow retry step을 찾을 수 없습니다 (${rule.retryStepId})`,
      });
    }
    if (
      targetIndex !== undefined &&
      retryIndex !== undefined &&
      targetIndex >= retryIndex
    ) {
      errors.push({
        field: "steps",
        message: `${label}: backflow target은 retry step보다 앞서야 합니다`,
      });
    }
    if (
      targetIndex !== undefined &&
      retryIndex !== undefined &&
      targetIndex < retryIndex &&
      !hasBackflowDependencyPath(draft.steps, rule.targetStepId, rule.retryStepId)
    ) {
      errors.push({
        field: "steps",
        message: `${label}: backflow target은 retry step의 dependency path에 있어야 합니다`,
      });
    }
    if (
      !Number.isInteger(rule.maxAttempts) ||
      rule.maxAttempts < 1 ||
      rule.maxAttempts > 5
    ) {
      errors.push({
        field: "steps",
        message: `${label}: maxAttempts는 1에서 5 사이여야 합니다`,
      });
    }
  }
  return errors;
};

const hasBackflowDependencyPath = (
  steps: readonly PipelineStepDraft[],
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
    return effectiveDependsOn(steps, index).some((depId) => visit(depId));
  };
  return visit(retryStepId);
};

const firstCycleStepId = (steps: readonly PipelineStepDraft[]): string | null => {
  const byId = new Map(steps.map((step, i) => [step.id, { step, i }] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): string | null => {
    if (visited.has(id)) return null;
    if (visiting.has(id)) return id;
    const entry = byId.get(id);
    if (!entry) return null;
    visiting.add(id);
    for (const depId of effectiveDependsOn(steps, entry.i)) {
      const cycleAt = visit(depId);
      if (cycleAt !== null) return cycleAt;
    }
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const step of steps) {
    const cycleAt = visit(step.id);
    if (cycleAt !== null) return cycleAt;
  }
  return null;
};
