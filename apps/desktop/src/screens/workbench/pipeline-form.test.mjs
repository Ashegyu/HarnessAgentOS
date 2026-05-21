import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPipelineFanOutPreview,
  emptyPipelineDraft,
  validatePipelineDraft,
  serializePipelineDraft,
  pipelineToDraft,
  pipelineInputToDraft,
  rankPipelinesForRequest,
  settingsWithDefaultPipeline,
  topologyTaskRunOptionsFromThreadDetails,
  moveStep,
} from "./pipeline-form.ts";

const profile = (id, name = "Coder", role = "coder") => ({ id, name, role });
const remoteEntry = (id, name = "Remote Reviewer", overrides = {}) => ({
  endpoint: {
    id,
    name,
    baseUrl: "https://agents.example.com/reviewer",
    agentCardUrl: "https://agents.example.com/reviewer/.well-known/agent-card.json",
    preferredTransport: "json-rpc",
    enabled: overrides.enabled ?? true,
    trusted: overrides.trusted ?? true,
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
  },
});

const pipeline = (id, name, stepProfileIds, description = "") => ({
  id,
  name,
  description,
  steps: stepProfileIds.map((profileId, index) => ({
    id: `s${index + 1}`,
    agentProfileId: profileId,
    title: `${name} step ${index + 1}`,
    instruction: "",
    expectedArtifactKinds: ["log"],
  })),
  createdAt: "2026-05-15T00:00:00.000Z",
  updatedAt: "2026-05-15T00:00:00.000Z",
});

const recommendationProfiles = [
  profile("ap_orch", "Orchestrator", "orchestrator"),
  profile("ap_plan", "Planner", "planner"),
  profile("ap_code", "Coder", "coder"),
  profile("ap_build", "Build", "build-error-resolver"),
  profile("ap_test", "Tester", "tester"),
  profile("ap_refactor", "Refactor", "refactor-cleaner"),
  profile("ap_security", "Security", "security-reviewer"),
  profile("ap_perf", "Performance", "performance-reviewer"),
  profile("ap_review", "Reviewer", "reviewer"),
];

const seededPipelines = [
  pipeline(
    "pipe_template_product_prd",
    "Product PRD Discovery",
    ["ap_plan", "ap_plan", "ap_orch", "ap_review"],
    "PRD 제품 요구사항 기획",
  ),
  pipeline(
    "pipe_template_architecture_rfc",
    "Architecture RFC",
    ["ap_orch", "ap_plan", "ap_security", "ap_perf", "ap_review"],
    "아키텍처 RFC API 계약 설계",
  ),
  pipeline(
    "pipe_template_evidence_bug_investigation",
    "Evidence-First Bug Investigation",
    ["ap_plan", "ap_plan", "ap_code", "ap_test", "ap_review"],
    "증상 추적 원인 분석 실제 실행 경로 최소 수정",
  ),
  pipeline(
    "pipe_template_docs_contract_reconciliation",
    "Docs-First Contract Reconciliation",
    ["ap_plan", "ap_review", "ap_orch", "ap_code", "ap_test", "ap_review"],
    "문서 contract IPC API drift 정합성",
  ),
  pipeline(
    "pipe_template_runtime_approval_hardening",
    "Runtime Approval Hardening",
    ["ap_security", "ap_security", "ap_code", "ap_test", "ap_security"],
    "approval policy 권한 runner hardening 보안 강화",
  ),
  pipeline(
    "pipe_template_a2a_federation_safety",
    "A2A Federation Safety Review",
    ["ap_security", "ap_orch", "ap_orch", "ap_test", "ap_review"],
    "A2A federation remote agent delegation trust safety",
  ),
  pipeline(
    "pipe_template_eval_release_verification",
    "Eval-Driven Release Verification",
    ["ap_test", "ap_build", "ap_security", "ap_perf", "ap_review"],
    "eval release smoke regression fixture 검증",
  ),
  pipeline(
    "pipe_template_cross_harness_agent_baseline",
    "Cross-Harness Agent Baseline",
    ["ap_plan", "ap_plan", "ap_orch", "ap_code", "ap_test", "ap_security", "ap_review"],
    "agent profile pipeline skill ECC Hermes Ruflo Agno cross-harness baseline",
  ),
  pipeline(
    "pipe_template_image_asset_prompt",
    "Image Asset Prompt Flow",
    ["ap_plan", "ap_plan", "ap_review", "ap_plan"],
    "이미지 생성 프롬프트 비주얼 디자인 에셋",
  ),
  pipeline(
    "pipe_template_new_project_delivery",
    "New Project Delivery",
    [
      "ap_plan",
      "ap_plan",
      "ap_orch",
      "ap_plan",
      "ap_plan",
      "ap_code",
      "ap_build",
      "ap_test",
      "ap_review",
      "ap_security",
      "ap_review",
    ],
    "새 프로젝트 생성 PRD 이미지 생성 계획 아키텍처 구현 검증 리뷰",
  ),
  pipeline(
    "pipe_template_supervised_delivery",
    "Supervised Delivery",
    [
      "ap_orch",
      "ap_plan",
      "ap_code",
      "ap_build",
      "ap_test",
      "ap_security",
      "ap_review",
    ],
    "기본 구현 흐름",
  ),
  pipeline(
    "pipe_template_refactor_safety",
    "Refactor Safety",
    ["ap_plan", "ap_refactor", "ap_build", "ap_perf", "ap_test", "ap_review"],
    "동작 보존 리팩터링",
  ),
  pipeline(
    "pipe_template_review_hardening",
    "Parallel Review Hardening",
    ["ap_plan", "ap_security", "ap_perf", "ap_review"],
    "보안 성능 정확성 병렬 리뷰",
  ),
  pipeline(
    "pipe_template_build_recovery",
    "Build Recovery",
    ["ap_build", "ap_test", "ap_review"],
    "빌드 타입 테스트 실패 복구",
  ),
];

test("emptyPipelineDraft starts blank with no steps", () => {
  const d = emptyPipelineDraft();
  assert.equal(d.id, null);
  assert.equal(d.name, "");
  assert.deepEqual(d.steps, []);
});

test("rankPipelinesForRequest prioritizes Build Recovery for build errors", () => {
  const ranked = rankPipelinesForRequest(
    seededPipelines,
    "현재 빌드 에러가 나는데 확인해줘",
    recommendationProfiles,
  );
  assert.equal(ranked[0].pipeline.name, "Build Recovery");
  assert.equal(ranked[0].intent, "build_recovery");
  assert.ok(ranked[0].recommended);
  assert.ok(ranked[0].matchedRoles.includes("build-error-resolver"));
});

test("rankPipelinesForRequest prioritizes evidence-first investigation for unclear failures", () => {
  const ranked = rankPipelinesForRequest(
    seededPipelines,
    "현재 실행이 안되고 실패하는데 이유와 원인을 먼저 추적해줘",
    recommendationProfiles,
  );
  assert.equal(ranked[0].pipeline.name, "Evidence-First Bug Investigation");
  assert.equal(ranked[0].intent, "bug_investigation");
  assert.ok(ranked[0].matchedRoles.includes("planner"));
});

test("rankPipelinesForRequest prioritizes Refactor Safety for refactoring", () => {
  const ranked = rankPipelinesForRequest(
    seededPipelines,
    "리팩터링하고 중복 코드를 정리해줘",
    recommendationProfiles,
  );
  assert.equal(ranked[0].pipeline.name, "Refactor Safety");
  assert.equal(ranked[0].intent, "refactor_safety");
  assert.ok(ranked[0].matchedRoles.includes("refactor-cleaner"));
});

test("rankPipelinesForRequest prioritizes review hardening for security review", () => {
  const ranked = rankPipelinesForRequest(
    seededPipelines,
    "보안 리뷰와 성능 검토를 해줘",
    recommendationProfiles,
  );
  assert.equal(ranked[0].pipeline.name, "Parallel Review Hardening");
  assert.equal(ranked[0].intent, "review_hardening");
  assert.ok(ranked[0].matchedRoles.includes("security-reviewer"));
});

test("rankPipelinesForRequest prioritizes docs contract reconciliation for IPC/document drift", () => {
  const ranked = rankPipelinesForRequest(
    seededPipelines,
    "문서와 IPC 계약이 실제 구현과 맞는지 web search와 GitHub 원본을 확인해줘",
    recommendationProfiles,
  );
  assert.equal(ranked[0].pipeline.name, "Docs-First Contract Reconciliation");
  assert.equal(ranked[0].intent, "docs_contract");
});

test("rankPipelinesForRequest prioritizes runtime approval hardening for policy work", () => {
  const ranked = rankPipelinesForRequest(
    seededPipelines,
    "approval policy와 자동 승인 우회 위험을 보안 강화해줘",
    recommendationProfiles,
  );
  assert.equal(ranked[0].pipeline.name, "Runtime Approval Hardening");
  assert.equal(ranked[0].intent, "runtime_hardening");
  assert.ok(ranked[0].matchedRoles.includes("security-reviewer"));
});

test("rankPipelinesForRequest prioritizes A2A federation safety for remote agents", () => {
  const ranked = rankPipelinesForRequest(
    seededPipelines,
    "A2A remote agent delegation과 trusted endpoint 안전성을 검토해줘",
    recommendationProfiles,
  );
  assert.equal(ranked[0].pipeline.name, "A2A Federation Safety Review");
  assert.equal(ranked[0].intent, "a2a_federation");
});

test("rankPipelinesForRequest prioritizes eval release verification for smoke requests", () => {
  const ranked = rankPipelinesForRequest(
    seededPipelines,
    "release 전에 eval fixture와 smoke regression 전체 검증을 해줘",
    recommendationProfiles,
  );
  assert.equal(ranked[0].pipeline.name, "Eval-Driven Release Verification");
  assert.equal(ranked[0].intent, "eval_release");
});

test("rankPipelinesForRequest prioritizes agent baseline for agent setting improvements", () => {
  const ranked = rankPipelinesForRequest(
    seededPipelines,
    "ECC Ruflo Agno Hermes를 보고 에이전트 설정과 pipeline 개선을 해줘",
    recommendationProfiles,
  );
  assert.equal(ranked[0].pipeline.name, "Cross-Harness Agent Baseline");
  assert.equal(ranked[0].intent, "agent_baseline");
});

test("rankPipelinesForRequest prioritizes PRD discovery for product requirements", () => {
  const ranked = rankPipelinesForRequest(
    seededPipelines,
    "새 기능 PRD와 제품 요구사항을 먼저 잡아줘",
    recommendationProfiles,
  );
  assert.equal(ranked[0].pipeline.name, "Product PRD Discovery");
  assert.equal(ranked[0].intent, "product_prd");
  assert.ok(ranked[0].matchedRoles.includes("planner"));
});

test("rankPipelinesForRequest prioritizes architecture RFC for architecture requests", () => {
  const ranked = rankPipelinesForRequest(
    seededPipelines,
    "아키텍쳐 설계와 API 계약을 문서화해줘",
    recommendationProfiles,
  );
  assert.equal(ranked[0].pipeline.name, "Architecture RFC");
  assert.equal(ranked[0].intent, "architecture_design");
  assert.ok(ranked[0].matchedRoles.includes("orchestrator"));
});

test("rankPipelinesForRequest prioritizes image asset flow for visual design", () => {
  const ranked = rankPipelinesForRequest(
    seededPipelines,
    "UI 디자인과 image 생성 프롬프트를 만들어줘",
    recommendationProfiles,
  );
  assert.equal(ranked[0].pipeline.name, "Image Asset Prompt Flow");
  assert.equal(ranked[0].intent, "visual_design");
});

test("rankPipelinesForRequest prioritizes new project delivery for project creation", () => {
  const ranked = rankPipelinesForRequest(
    seededPipelines,
    "새로운 프로젝트를 생성해줘. 이미지 생성, PRD, 계획, 아키텍처, 구현, 리뷰, 검토까지 필요해",
    recommendationProfiles,
  );
  assert.equal(ranked[0].pipeline.name, "New Project Delivery");
  assert.equal(ranked[0].intent, "new_project_delivery");
  assert.ok(ranked[0].matchedRoles.includes("coder"));
  assert.ok(ranked[0].matchedRoles.includes("build-error-resolver"));
});

test("rankPipelinesForRequest keeps seed order when request is empty", () => {
  const ranked = rankPipelinesForRequest(
    seededPipelines,
    "   ",
    recommendationProfiles,
  );
  assert.deepEqual(
    ranked.map((entry) => entry.pipeline.name),
    seededPipelines.map((entry) => entry.name),
  );
  assert.equal(ranked[0].recommended, false);
});

test("validatePipelineDraft requires name", () => {
  const d = { ...emptyPipelineDraft(), steps: [{ id: "s1", agentProfileId: "ap_a", title: "t", instruction: "", expectedArtifactKinds: ["plan"] }] };
  const errs = validatePipelineDraft(d, [profile("ap_a")]);
  assert.ok(errs.some((e) => e.field === "name"));
});

test("validatePipelineDraft requires at least one step", () => {
  const d = { ...emptyPipelineDraft(), name: "X" };
  const errs = validatePipelineDraft(d, []);
  assert.ok(errs.some((e) => e.field === "steps"));
});

test("validatePipelineDraft flags steps with empty title", () => {
  const d = {
    ...emptyPipelineDraft(),
    name: "X",
    steps: [{ id: "s1", agentProfileId: "ap_a", title: "  ", instruction: "", expectedArtifactKinds: ["plan"] }],
  };
  const errs = validatePipelineDraft(d, [profile("ap_a")]);
  assert.ok(errs.some((e) => e.field === "steps" && /title/i.test(e.message)));
});

test("validatePipelineDraft flags steps referencing unknown profile", () => {
  const d = {
    ...emptyPipelineDraft(),
    name: "X",
    steps: [{ id: "s1", agentProfileId: "ap_ghost", title: "t", instruction: "", expectedArtifactKinds: ["plan"] }],
  };
  const errs = validatePipelineDraft(d, [profile("ap_a")]);
  assert.ok(errs.some((e) => /profile/i.test(e.message)));
});

test("validatePipelineDraft accepts a well-formed draft", () => {
  const d = {
    ...emptyPipelineDraft(),
    name: "Backend Flow",
    steps: [
      { id: "s1", agentProfileId: "ap_a", title: "Plan", instruction: "", expectedArtifactKinds: ["plan"] },
      { id: "s2", agentProfileId: "ap_b", title: "Code", instruction: "", expectedArtifactKinds: ["diff"] },
    ],
  };
  assert.deepEqual(validatePipelineDraft(d, [profile("ap_a"), profile("ap_b")]), []);
});

test("validatePipelineDraft accepts explicit dependencies and metadata", () => {
  const d = {
    ...emptyPipelineDraft(),
    name: "Topology Flow",
    steps: [
      {
        id: "s1",
        agentProfileId: "ap_a",
        title: "Plan",
        instruction: "",
        expectedArtifactKinds: ["plan"],
        dependsOn: [],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "s2",
        agentProfileId: "ap_b",
        title: "Code",
        instruction: "",
        expectedArtifactKinds: ["diff"],
        dependsOn: ["s1"],
        allowedActions: ["file_write"],
        outputContract: "diff_proposal",
      },
    ],
  };
  assert.deepEqual(
    validatePipelineDraft(d, [profile("ap_a"), profile("ap_b")]),
    [],
  );
});

test("validatePipelineDraft accepts and serializes backflow rules", () => {
  const d = {
    ...emptyPipelineDraft(),
    name: "Backflow Flow",
    steps: [
      {
        id: "plan",
        agentProfileId: "ap_a",
        title: "Plan",
        instruction: "",
        expectedArtifactKinds: ["plan"],
        dependsOn: [],
      },
      {
        id: "code",
        agentProfileId: "ap_b",
        title: "Code",
        instruction: "",
        expectedArtifactKinds: ["diff"],
        dependsOn: ["plan"],
      },
    ],
    backflowRules: [
      {
        id: "bf_code",
        trigger: "step_failed",
        targetStepId: "plan",
        retryStepId: "code",
        maxAttempts: 2,
        instruction: "Revise plan before retry.",
      },
    ],
  };

  assert.deepEqual(
    validatePipelineDraft(d, [profile("ap_a"), profile("ap_b")]),
    [],
  );
  const out = serializePipelineDraft(d);
  assert.deepEqual(out.backflowRules, d.backflowRules);
});

test("validatePipelineDraft flags invalid backflow rules without treating them as dependency cycles", () => {
  const d = {
    ...emptyPipelineDraft(),
    name: "Backflow Flow",
    steps: [
      {
        id: "plan",
        agentProfileId: "ap_a",
        title: "Plan",
        instruction: "",
        expectedArtifactKinds: ["plan"],
        dependsOn: [],
      },
      {
        id: "code",
        agentProfileId: "ap_b",
        title: "Code",
        instruction: "",
        expectedArtifactKinds: ["diff"],
        dependsOn: ["plan"],
      },
    ],
    backflowRules: [
      {
        id: "bf_forward",
        trigger: "quality_failed",
        targetStepId: "code",
        retryStepId: "plan",
        maxAttempts: 2,
      },
    ],
  };

  const errs = validatePipelineDraft(d, [profile("ap_a"), profile("ap_b")]);
  assert.ok(errs.some((e) => /backflow/i.test(e.message)));
  assert.equal(errs.some((e) => /cycle/i.test(e.message)), false);
});

test("validatePipelineDraft rejects backflow targets outside the retry dependency path", () => {
  const d = {
    ...emptyPipelineDraft(),
    name: "Backflow Flow",
    steps: [
      {
        id: "plan",
        agentProfileId: "ap_a",
        title: "Plan",
        instruction: "",
        expectedArtifactKinds: ["plan"],
        dependsOn: [],
      },
      {
        id: "research",
        agentProfileId: "ap_b",
        title: "Research",
        instruction: "",
        expectedArtifactKinds: ["log"],
        dependsOn: [],
      },
      {
        id: "code",
        agentProfileId: "ap_c",
        title: "Code",
        instruction: "",
        expectedArtifactKinds: ["diff"],
        dependsOn: ["plan"],
      },
    ],
    backflowRules: [
      {
        id: "bf_code",
        trigger: "step_failed",
        targetStepId: "research",
        retryStepId: "code",
        maxAttempts: 2,
      },
    ],
  };

  const errs = validatePipelineDraft(d, [
    profile("ap_a"),
    profile("ap_b"),
    profile("ap_c"),
  ]);
  assert.ok(errs.some((e) => /dependency path|의존/i.test(e.message)));
});

test("validatePipelineDraft flags dependency cycles", () => {
  const d = {
    ...emptyPipelineDraft(),
    name: "Cyclic Flow",
    steps: [
      {
        id: "s1",
        agentProfileId: "ap_a",
        title: "A",
        instruction: "",
        expectedArtifactKinds: ["plan"],
        dependsOn: ["s2"],
      },
      {
        id: "s2",
        agentProfileId: "ap_b",
        title: "B",
        instruction: "",
        expectedArtifactKinds: ["log"],
        dependsOn: ["s1"],
      },
    ],
  };
  const errs = validatePipelineDraft(d, [profile("ap_a"), profile("ap_b")]);
  assert.ok(errs.some((e) => /cycle/i.test(e.message)));
});

test("validatePipelineDraft accepts a known remote endpoint override", () => {
  const d = {
    ...emptyPipelineDraft(),
    name: "Remote Flow",
    steps: [
      {
        id: "s1",
        agentProfileId: "ap_a",
        remoteEndpointId: "a2a_remote",
        title: "Review",
        instruction: "",
        expectedArtifactKinds: ["log"],
      },
    ],
  };
  assert.deepEqual(
    validatePipelineDraft(d, [profile("ap_a")], [remoteEntry("a2a_remote")]),
    [],
  );
});

test("validatePipelineDraft flags an unknown remote endpoint override", () => {
  const d = {
    ...emptyPipelineDraft(),
    name: "Remote Flow",
    steps: [
      {
        id: "s1",
        agentProfileId: "ap_a",
        remoteEndpointId: "a2a_missing",
        title: "Review",
        instruction: "",
        expectedArtifactKinds: ["log"],
      },
    ],
  };
  const errs = validatePipelineDraft(d, [profile("ap_a")], []);
  assert.ok(errs.some((e) => /remote endpoint/i.test(e.message)));
});

test("serializePipelineDraft strips renderer-only id when null (create mode)", () => {
  const d = {
    id: null,
    name: "Flow",
    description: "",
    steps: [{ id: "s1", agentProfileId: "ap_a", title: "T", instruction: "", expectedArtifactKinds: ["plan"] }],
  };
  const out = serializePipelineDraft(d);
  assert.ok(!("id" in out));
  assert.equal(out.name, "Flow");
  assert.equal(out.steps.length, 1);
});

test("serializePipelineDraft preserves remoteEndpointId when selected", () => {
  const d = {
    id: null,
    name: "Remote Flow",
    description: "",
    steps: [
      {
        id: "s1",
        agentProfileId: "ap_a",
        remoteEndpointId: "a2a_remote",
        title: "T",
        instruction: "",
        expectedArtifactKinds: ["log"],
      },
    ],
  };
  const out = serializePipelineDraft(d);
  assert.equal(out.steps[0].remoteEndpointId, "a2a_remote");
});

test("serializePipelineDraft preserves topology metadata when selected", () => {
  const d = {
    id: null,
    name: "Topology Flow",
    description: "",
    steps: [
      {
        id: "s1",
        agentProfileId: "ap_a",
        title: "T",
        instruction: "",
        expectedArtifactKinds: ["plan"],
        dependsOn: ["s0"],
        allowedActions: ["file_write"],
        outputContract: "diff_proposal",
      },
    ],
  };
  const out = serializePipelineDraft(d);
  assert.deepEqual(out.steps[0].dependsOn, ["s0"]);
  assert.deepEqual(out.steps[0].allowedActions, ["file_write"]);
  assert.equal(out.steps[0].outputContract, "diff_proposal");
});

test("serializePipelineDraft preserves id in update mode", () => {
  const d = {
    id: "pipe_1",
    name: "Flow",
    description: "",
    steps: [{ id: "s1", agentProfileId: "ap_a", title: "T", instruction: "", expectedArtifactKinds: ["plan"] }],
  };
  const out = serializePipelineDraft(d);
  assert.equal(out.id, "pipe_1");
});

test("pipelineToDraft round-trips an existing pipeline", () => {
  const pipeline = {
    id: "pipe_1",
    name: "Flow",
    description: "x",
    steps: [
      { id: "s1", agentProfileId: "ap_a", title: "T", instruction: "Hi", expectedArtifactKinds: ["plan"] },
    ],
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
  const draft = pipelineToDraft(pipeline);
  assert.equal(draft.id, "pipe_1");
  assert.equal(draft.steps[0].instruction, "Hi");
});

test("pipelineToDraft round-trips a remoteEndpointId", () => {
  const pipeline = {
    id: "pipe_1",
    name: "Remote Flow",
    description: "",
    steps: [
      {
        id: "s1",
        agentProfileId: "ap_a",
        remoteEndpointId: "a2a_remote",
        title: "Remote",
        instruction: "Hi",
        expectedArtifactKinds: ["log"],
      },
    ],
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
  const draft = pipelineToDraft(pipeline);
  assert.equal(draft.steps[0].remoteEndpointId, "a2a_remote");
});

test("pipelineToDraft round-trips topology metadata", () => {
  const pipeline = {
    id: "pipe_1",
    name: "Topology Flow",
    description: "",
    steps: [
      {
        id: "s1",
        agentProfileId: "ap_a",
        title: "Code",
        instruction: "Hi",
        expectedArtifactKinds: ["diff"],
        dependsOn: ["s0"],
        allowedActions: ["file_write"],
        outputContract: "diff_proposal",
      },
    ],
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
  const draft = pipelineToDraft(pipeline);
  assert.deepEqual(draft.steps[0].dependsOn, ["s0"]);
  assert.deepEqual(draft.steps[0].allowedActions, ["file_write"]);
  assert.equal(draft.steps[0].outputContract, "diff_proposal");
});

test("pipelineInputToDraft converts a recommendation into a new draft", () => {
  const draft = pipelineInputToDraft({
    name: "Recommended",
    description: "d",
    steps: [
      {
        id: "s1",
        agentProfileId: "ap_a",
        title: "Plan",
        instruction: "Hi",
        expectedArtifactKinds: ["plan"],
        dependsOn: [],
        allowedActions: [],
        outputContract: "plan",
      },
      {
        id: "s2",
        agentProfileId: "ap_b",
        title: "Code",
        instruction: "Patch",
        expectedArtifactKinds: ["diff"],
        dependsOn: ["s1"],
        allowedActions: ["file_write"],
        outputContract: "diff_proposal",
      },
    ],
  });
  assert.equal(draft.id, null);
  assert.equal(draft.name, "Recommended");
  assert.deepEqual(draft.steps[1].dependsOn, ["s1"]);
  assert.deepEqual(draft.steps[1].allowedActions, ["file_write"]);
});

test("topologyTaskRunOptionsFromThreadDetails flattens recent task runs", () => {
  const options = topologyTaskRunOptionsFromThreadDetails(
    [
      {
        thread: {
          id: "thr_1",
          title: "Thread A",
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:00:00.000Z",
        },
        taskRuns: [
          {
            id: "tsk_old",
            threadId: "thr_1",
            userRequest: "old request",
            targetDir: "/tmp/proj",
            status: "drafting",
            createdAt: "2026-05-01T00:00:00.000Z",
            updatedAt: "2026-05-01T00:00:00.000Z",
          },
        ],
        agentAnswers: {},
      },
      {
        thread: {
          id: "thr_2",
          title: "Thread B",
          createdAt: "2026-05-02T00:00:00.000Z",
          updatedAt: "2026-05-02T00:00:00.000Z",
        },
        taskRuns: [
          {
            id: "tsk_new",
            threadId: "thr_2",
            userRequest: "new request",
            targetDir: "/tmp/proj",
            status: "running",
            createdAt: "2026-05-02T00:00:00.000Z",
            updatedAt: "2026-05-02T00:00:00.000Z",
          },
        ],
        agentAnswers: {},
      },
      null,
    ],
    1,
  );
  assert.equal(options.length, 1);
  assert.equal(options[0].id, "tsk_new");
  assert.equal(options[0].threadTitle, "Thread B");
  assert.match(options[0].label, /new request/);
});

test("settingsWithDefaultPipeline enables orchestration and stores the pipeline id", () => {
  const settings = {
    agent: {
      provider: "auto",
      model: "",
      timeoutMs: 120000,
      stallTimeoutMs: 30000,
      contextDepth: 3,
    },
    approval: {
      autoApprove: false,
      autoExecuteWorkerFileActions: false,
    },
    orchestration: {
      enabled: false,
      defaultMode: "single_worker",
      defaultInstructions: "",
      defaultPipelineId: "",
    },
  };

  const next = settingsWithDefaultPipeline(settings, "pipe_1");

  assert.equal(next.orchestration.enabled, true);
  assert.equal(next.orchestration.defaultPipelineId, "pipe_1");
  assert.equal(next.orchestration.defaultMode, "single_worker");
  assert.equal(next.agent.provider, "auto");
});

test("moveStep shifts a step up by one position", () => {
  const steps = [
    { id: "a" }, { id: "b" }, { id: "c" },
  ];
  assert.deepEqual(moveStep(steps, 2, -1).map((s) => s.id), ["a", "c", "b"]);
});

test("moveStep shifts a step down by one position", () => {
  const steps = [
    { id: "a" }, { id: "b" }, { id: "c" },
  ];
  assert.deepEqual(moveStep(steps, 0, 1).map((s) => s.id), ["b", "a", "c"]);
});

test("moveStep is a no-op when target index is out of range", () => {
  const steps = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(moveStep(steps, 0, -1).map((s) => s.id), ["a", "b"]);
  assert.deepEqual(moveStep(steps, 1, 1).map((s) => s.id), ["a", "b"]);
});

test("buildPipelineFanOutPreview groups independent read-only planning and review steps", () => {
  const d = {
    ...emptyPipelineDraft(),
    name: "Read-only Flow",
    steps: [
      {
        id: "plan",
        agentProfileId: "ap_plan",
        title: "Plan",
        instruction: "",
        expectedArtifactKinds: ["plan"],
        dependsOn: [],
        allowedActions: [],
      },
      {
        id: "review",
        agentProfileId: "ap_review",
        title: "Review",
        instruction: "",
        expectedArtifactKinds: ["review"],
        dependsOn: [],
        allowedActions: [],
      },
      {
        id: "security",
        agentProfileId: "ap_security",
        title: "Security",
        instruction: "",
        expectedArtifactKinds: ["review"],
        dependsOn: [],
        allowedActions: [],
      },
      {
        id: "perf",
        agentProfileId: "ap_perf",
        title: "Performance",
        instruction: "",
        expectedArtifactKinds: ["review"],
        dependsOn: [],
        allowedActions: [],
      },
      {
        id: "topology",
        agentProfileId: "ap_topology",
        title: "Topology",
        instruction: "",
        expectedArtifactKinds: ["plan"],
        dependsOn: [],
        allowedActions: [],
      },
    ],
  };

  const preview = buildPipelineFanOutPreview(d, [
    profile("ap_plan", "Planner", "planner"),
    profile("ap_review", "Reviewer", "reviewer"),
    profile("ap_security", "Security", "security-reviewer"),
    profile("ap_perf", "Performance", "performance-reviewer"),
    profile("ap_topology", "Topology", "orchestrator"),
  ]);

  assert.equal(preview.waves.length, 1);
  assert.deepEqual(preview.waves[0].stepIds, [
    "plan",
    "review",
    "security",
    "perf",
    "topology",
  ]);
  assert.equal(preview.waves[0].parallelizable, true);
  assert.deepEqual(preview.deterministicOrder, [
    "plan",
    "review",
    "security",
    "perf",
    "topology",
  ]);
});

test("buildPipelineFanOutPreview exposes blockers for side effects, role, and remote trust", () => {
  const d = {
    ...emptyPipelineDraft(),
    name: "Blocked Flow",
    steps: [
      {
        id: "code",
        agentProfileId: "ap_code",
        remoteEndpointId: "a2a_remote",
        title: "Code",
        instruction: "",
        expectedArtifactKinds: ["diff"],
        dependsOn: [],
        allowedActions: ["file_write"],
      },
    ],
  };

  const preview = buildPipelineFanOutPreview(
    d,
    [profile("ap_code", "Coder", "coder")],
    [remoteEntry("a2a_remote", "Remote Coder", { trusted: false })],
  );

  const step = preview.waves[0].steps[0];
  assert.equal(step.canRunReadOnlyParallel, false);
  assert.equal(step.remoteEndpointTrusted, false);
  assert.ok(step.blockers.some((blocker) => /side-effect/.test(blocker)));
  assert.ok(step.blockers.some((blocker) => /coder role/.test(blocker)));
  assert.ok(step.blockers.some((blocker) => /trusted/.test(blocker)));
  assert.equal(preview.waves[0].hasSideEffects, true);
});

test("buildPipelineFanOutPreview keeps dependency waves and output order deterministic", () => {
  const d = {
    ...emptyPipelineDraft(),
    name: "Wave Flow",
    steps: [
      {
        id: "plan",
        agentProfileId: "ap_plan",
        title: "Plan",
        instruction: "",
        expectedArtifactKinds: ["plan"],
        dependsOn: [],
        allowedActions: [],
      },
      {
        id: "review",
        agentProfileId: "ap_review",
        title: "Review",
        instruction: "",
        expectedArtifactKinds: ["review"],
        dependsOn: ["plan"],
        allowedActions: [],
      },
      {
        id: "docs",
        agentProfileId: "ap_docs",
        title: "Docs",
        instruction: "",
        expectedArtifactKinds: ["log"],
        dependsOn: ["plan"],
        allowedActions: [],
      },
    ],
  };

  const preview = buildPipelineFanOutPreview(d, [
    profile("ap_plan", "Planner", "planner"),
    profile("ap_review", "Reviewer", "reviewer"),
    profile("ap_docs", "Documenter", "documenter"),
  ]);

  assert.deepEqual(preview.waves.map((wave) => wave.stepIds), [
    ["plan"],
    ["review", "docs"],
  ]);
  assert.equal(preview.waves[1].parallelizable, true);
  assert.deepEqual(preview.deterministicOrder, ["plan", "review", "docs"]);
});
