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
