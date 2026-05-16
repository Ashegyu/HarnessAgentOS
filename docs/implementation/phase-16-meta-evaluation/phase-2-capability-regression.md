# Phase 2 — Capability +2 · Regression 3

> **선행 조건**: Phase 1 (CaseRunner, FakeAdapter introspection, fs snapshot)
> **다음 단계**: Phase 4 (Phase 3와 병렬 가능)
> **복잡도**: Medium · **추정**: 3-4일

## 0. 목표

Phase 1에서 검증된 CaseRunner를 그대로 사용해 **5개 케이스**를 추가한다. Capability 2개 (multi-step + repair-loop), Regression 3개 (verbatim·injection·model). 케이스마다 *어떤 회귀를 잡는지* 명시한다.

## 1. 출력물

```
packages/evals/fixtures/
├── capability/
│   ├── file-write-readme.eval.json          # Phase 1 (이미 있음)
│   ├── shell-pwd-echo.eval.json             # 신규
│   └── repair-loop-convergence.eval.json    # 신규
└── regression/
    ├── pipeline-instruction-verbatim.eval.json    # 신규
    ├── capability-context-injection.eval.json     # 신규
    └── learner-model-context.eval.json            # 신규

packages/agent/src/fake-model-cli-adapter.ts       # FakeScenario 4개 추가
packages/evals/src/case-runner.ts                  # 다단계 invocation 지원
packages/evals/src/case-runner.test.mjs            # 5개 케이스 회귀 테스트
```

## 2. 케이스 명세

### 2.1 `shell-pwd-echo` (capability)

**무엇을 잡는가**: shell action 한 번이 approval → runner 실행을 통과해서 stdout이 artifact로 기록되는 전체 경로.

```json
{
  "id": "shell-pwd-echo",
  "kind": "capability",
  "title": "shell action이 approval-execute 사이클을 통과",
  "instruction": "현재 폴더 경로를 출력해라.",
  "scenario": "ok-shell-pwd",
  "attempts": 3,
  "profile": { "autoApprove": true },
  "grader": {
    "kind": "code",
    "assertion": { "type": "approval_status", "actionType": "shell", "expected": "approved" }
  },
  "thresholds": { "passAt3": 0.9 }
}
```

**FakeScenario `ok-shell-pwd`**: plan output에 `{ kind: "shell", command: "pwd" }` 하나 포함.

### 2.2 `repair-loop-convergence` (capability)

**무엇을 잡는가**: 첫 시도가 quality_failed → RepairLoopService가 두 번째 plan을 만들어 → 두 번째가 통과하는 전체 통합 경로. 단위 테스트는 컴포넌트 격리지만 이건 통합 신호 (Risk M2 대응).

```json
{
  "id": "repair-loop-convergence",
  "kind": "capability",
  "title": "첫 시도 실패 후 RepairLoop이 다음 시도를 만들어 통과",
  "instruction": "테스트가 통과하도록 src/util.ts를 수정해라.",
  "scenario": "fail-first-pass-second",
  "attempts": 3,
  "grader": {
    "kind": "code",
    "assertion": { "type": "repair_attempts_eq", "expected": 1 }
  },
  "thresholds": { "passAt3": 0.9 }
}
```

**FakeScenario `fail-first-pass-second`**: 첫 invoke는 잘못된 patch, 두 번째 invoke는 올바른 patch. CaseRunner의 다단계 처리는 §3 참조.

### 2.3 `pipeline-instruction-verbatim` (regression)

**무엇을 잡는가**: `OrchestrationPlanner.synthesizeFromPipeline`이 instruction을 120자 truncate하지 않고 worker step에 verbatim 전달하는지. 이전에 실제로 깨졌던 버그 (`docs/design/pipeline-thread-binding-next-session.md`).

```json
{
  "id": "pipeline-instruction-verbatim",
  "kind": "regression",
  "title": "pipeline instruction이 worker prompt에 verbatim 전달",
  "instruction": "(테스트 setup이 pipeline을 설정하므로 사용자 instruction은 무관)",
  "scenario": "ok-pipeline-echo",
  "attempts": 3,
  "grader": {
    "kind": "code",
    "assertion": {
      "type": "recorded_request_contains",
      "needle": "EXACT-150-CHAR-INSTRUCTION-USED-IN-SETUP-...-END"
    }
  },
  "thresholds": { "passToThe3": 1.0 }
}
```

**Setup hook**: case-runner가 이 케이스에 대해 fixture 외에 *pipeline setup callback*을 호출 — 150자짜리 instruction을 가진 pipeline을 만들고 thread.pipelineId로 바인딩. needle은 150자 instruction 전체 (truncate되었으면 매칭 실패).

### 2.4 `capability-context-injection` (regression)

**무엇을 잡는가**: 승인된 `capability_use` approval의 capability text가 *다음 invocation의 prompt에 실제로 들어가는가*. context delivery 회귀.

```json
{
  "id": "capability-context-injection",
  "kind": "regression",
  "title": "승인된 capability_use가 후속 prompt에 포함",
  "instruction": "git status 결과를 요약해라.",
  "scenario": "ok-two-invocations",
  "attempts": 3,
  "grader": {
    "kind": "code",
    "assertion": {
      "type": "recorded_request_contains",
      "needle": "[CAPABILITY:git-summary]"
    }
  },
  "thresholds": { "passToThe3": 1.0 }
}
```

**Setup**: 첫 invocation 직전에 `capability_use` approval을 미리 approved 상태로 삽입 (capability id = "git-summary"). 두 번째 invocation의 prompt에 `[CAPABILITY:git-summary]` 마커가 redacted 형태로 들어가야 함.

### 2.5 `learner-model-context` (regression)

**무엇을 잡는가**: 승인된 `model_use` approval이 후속 invocation의 `ModelCliRequest.model`에 반영되는지.

```json
{
  "id": "learner-model-context",
  "kind": "regression",
  "title": "승인된 model_use가 다음 invocation의 model 필드에 반영",
  "instruction": "Hello world",
  "scenario": "ok-two-invocations",
  "attempts": 3,
  "grader": {
    "kind": "rule",
    "rules": [{
      "description": "두 번째 invocation의 model이 'claude-opus-4-7'",
      "check": "regex",
      "target": "recorded_request[1].model",
      "pattern": "^claude-opus-4-7$"
    }]
  },
  "thresholds": { "passToThe3": 1.0 }
}
```

**Setup**: `model_use` approval을 첫 invocation 직후에 approved 상태로 삽입 (recommended model = "claude-opus-4-7"). 두 번째 invocation의 model 필드가 이 값이어야 함.

## 3. CaseRunner 확장 (`packages/evals/src/case-runner.ts`)

### 3.1 다단계 invocation 지원

```ts
export interface CaseSetupCallback {
  (ctx: {
    state: LocalStateService;
    targetDir: string;
    taskRun: TaskRun;
  }): Promise<void>;
}

export interface CaseSetupRegistry {
  readonly [caseId: string]: CaseSetupCallback;
}

// 예시 등록
const setups: CaseSetupRegistry = {
  "pipeline-instruction-verbatim": async (ctx) => {
    const longInstruction = "EXACT-150-CHAR-INSTRUCTION-USED-IN-SETUP-...".padEnd(150, "X");
    const pipeline = await ctx.state.agentPipelines.create({
      title: "echo-pipeline",
      steps: [{ title: "echo", role: "coder", instruction: longInstruction, /* ... */ }],
    });
    await ctx.state.updateThread(ctx.taskRun.threadId, { pipelineId: pipeline.id });
  },
  "capability-context-injection": async (ctx) => {
    // 첫 invocation 전에 approval을 미리 approved 상태로 삽입
    await ctx.state.createApproval({
      taskRunId: ctx.taskRun.id,
      actionType: "capability_use",
      payload: { capabilityId: "git-summary", text: "[CAPABILITY:git-summary] git diff summary" },
      status: "approved",
    });
  },
  // ...
};
```

CaseRunner는 `runAttempt()`에서 TaskRun 생성 직후 `setups[testCase.id]?.(ctx)` 호출.

### 3.2 다단계 invocation 처리

`repair-loop-convergence`처럼 invoke가 2번 일어나는 경우, CaseRunner는 *최종 상태*만 grader에 넘긴다. RepairLoopService가 자체적으로 두 번째 plan을 생성하므로 CaseRunner는 단지 `AgentPlanningService.generatePlan()` 호출 후 quality 평가까지 기다리면 된다.

```ts
private async runAttempt(testCase: EvalCase, attemptIdx: number) {
  /* ... seed setup, db, adapter ... */

  const taskRun = await state.createTaskRun({/* ... */});
  await setups[testCase.id]?.({ state, targetDir, taskRun });

  // 1차 invocation
  await agentPlanning.generatePlan({ taskRunId: taskRun.id });
  await this.processApprovals(state, taskRun.id, testCase);
  const firstGate = await this.evaluateQuality(state, taskRun.id);

  // 2차 invocation은 RepairLoopService가 트리거 (TaskRunCompletionService.markDone 호출 후 실패 시)
  if (firstGate.status === "failed") {
    const repair = new RepairLoopService({ state, completion, agentPlanning: { /* ... */ } });
    try {
      await repair.createRepairPlan({ taskRunId: taskRun.id });
      await this.processApprovals(state, taskRun.id, testCase);
    } catch {/* max attempts — 의도된 케이스도 있음 */}
  }

  /* ... grader, snapshot diff, return result ... */
}
```

## 4. FakeScenario 확장 (`packages/agent/src/fake-model-cli-adapter.ts`)

기존 scenarios 배열에 4개 추가:

```ts
const scenarios: FakeScenario[] = [
  /* ... 기존 ... */
  {
    name: "ok-shell-pwd",
    matches: (req) => req.prompt.includes("폴더 경로"),
    response: () => fakePlanResponse({
      summary: "Run pwd",
      actions: [{ kind: "shell", command: "pwd" }],
    }),
  },
  {
    name: "fail-first-pass-second",
    matches: (req, history) => true,
    response: (req, history) => history.length === 0
      ? fakePlanResponse({ summary: "wrong patch", actions: [{ kind: "file_write", path: "src/util.ts", content: "// wrong" }] })
      : fakePlanResponse({ summary: "fix", actions: [{ kind: "file_write", path: "src/util.ts", content: "// correct" }] }),
  },
  {
    name: "ok-pipeline-echo",
    matches: (req) => req.prompt.includes("EXACT-150-CHAR"),
    response: () => fakePlanResponse({ summary: "ok", actions: [] }),
  },
  {
    name: "ok-two-invocations",
    matches: () => true,
    response: () => fakePlanResponse({ summary: "ok", actions: [] }),
  },
];
```

`matches` 함수가 history(이전 invocations)에 접근 가능하도록 fake adapter 시그니처 약간 확장.

## 5. 단위 테스트 (`case-runner.test.mjs` 확장)

```js
test("shell-pwd-echo: approval flows to runner and shell stdout is recorded", async () => {
  const result = await runner.run(loadCase("capability/shell-pwd-echo.eval.json"));
  assert.equal(result.passAt3, 1);
  assert.equal(result.outcome, "passed");
});

test("repair-loop-convergence: 2nd invocation passes after 1st failure", async () => {
  const result = await runner.run(loadCase("capability/repair-loop-convergence.eval.json"));
  assert.equal(result.passToThe3, 1);
  // 각 attempt마다 repair_attempts == 1 (단 하나의 repair만 발생)
  const repairCounts = await Promise.all(/* ... */);
  assert.deepEqual(repairCounts, [1, 1, 1]);
});

test("pipeline-instruction-verbatim: 150-char instruction reaches worker prompt", async () => {
  const result = await runner.run(loadCase("regression/pipeline-instruction-verbatim.eval.json"));
  assert.equal(result.passToThe3, 1);
});

test("capability-context-injection: approved capability text appears in 2nd prompt", async () => {
  const result = await runner.run(loadCase("regression/capability-context-injection.eval.json"));
  assert.equal(result.passToThe3, 1);
});

test("learner-model-context: approved model_use changes next invocation's model field", async () => {
  const result = await runner.run(loadCase("regression/learner-model-context.eval.json"));
  assert.equal(result.passToThe3, 1);
});
```

## 6. DoD

- [ ] 5개 fixture JSON 생성, `evalCaseSchema.parse()` 통과
- [ ] FakeScenario 4개 추가, 기존 fake-model-cli-adapter 테스트 회귀 0건
- [ ] CaseRunner 다단계 invocation 처리 가능
- [ ] CaseSetupRegistry 패턴 도입, 각 케이스가 자기 setup을 격리
- [ ] 5개 케이스 모두 `pass^3 = 1.0` 또는 `passAt3 >= 0.9`
- [ ] `node scripts/eval/run.mjs --suite=capability` → 3/3
- [ ] `node scripts/eval/run.mjs --suite=regression` → 3/3
- [ ] `npm run check` + `npm run test` 통과

## 7. 이 phase에서 *하지 않을* 일

- ❌ Safety 케이스 (Phase 3)
- ❌ DB 영속화 (Phase 4)
- ❌ md reporter (Phase 4)
- ❌ CLI entry (Phase 5)
- ❌ Provider 비교 (Phase 6)

## 8. 위험 + 완화

| 등급 | 위험 | 완화 |
|-----|------|------|
| MEDIUM | RepairLoop 케이스가 기존 단위 테스트와 신호 중복 | fixture description에 "통합 경로 검증"임을 명시. 단위 테스트는 격리, eval은 *full path* 통과 신호 |
| MEDIUM | Fake scenario `matches` 충돌 (한 prompt가 여러 scenario에 매치) | scenarios 배열 순서 = 우선순위. 더 구체적인 매칭을 먼저 |
| LOW | CaseSetupRegistry가 점점 비대해짐 | Phase 3까지는 OK. v2에서 setup 파일 분리 검토 |
| LOW | Pipeline setup에 agentProfile 의존 | seed default profiles 사용 (`ensureSeed` 패턴) |
