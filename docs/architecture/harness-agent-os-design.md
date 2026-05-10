# HarnessAgentOS 상세 설계서

> 작성일: 2026-05-10  
> 대상 프로젝트: `C:\Users\FORYOUCOM\Desktop\Code\HarnessAgentOS`  
> 기준 프로젝트: `C:\Users\FORYOUCOM\Desktop\Code\ClaudeAgentSystem`  
> 기술 방향: 서버 없는 Electron + React + Node 로컬 데스크톱 앱  
> 문서 목적: 기존 ClaudeAgentSystem의 장점은 보존하되, 사용자 개입이 어려운 자동 에이전트 구조를 Harness OS 중심 구조로 재설계한다.

---

## 1. 결론

HarnessAgentOS는 기존 ClaudeAgentSystem을 리팩터링해서 만드는 것이 아니라, 새 프로젝트로 시작한다. 기존 프로젝트는 폐기 대상이 아니라 이식 가능한 자산 저장소로 둔다. 새 시스템의 핵심은 에이전트가 아니라 Harness OS다.

기존 구조는 사용자가 한 번 목표를 넣으면 CEO, 파이프라인, 동적 에이전트 그래프가 작업을 분해하고 자동 진행하는 방식이다. 이 방식은 복잡한 자동화에는 매력적이지만, 실제 개발 작업에서 중요한 다음 요구를 만족시키기 어렵다.

- 이어서 질문하기
- 중간 결과 확인하기
- 방향이 틀렸을 때 바로 개입하기
- 파일 수정 전 승인하기
- 낮은 품질의 산출물을 즉시 교정하기
- 완료 판정을 증거 기반으로 확인하기

HarnessAgentOS는 이 문제를 해결하기 위해 작업 실행을 다음 구조로 바꾼다.

```text
사용자 대화
  -> Thread
  -> TaskRun
  -> Step
  -> Checkpoint
  -> Approval / Redirect / Reject / Resume
  -> Artifact
  -> QualityGateResult
  -> 사용자 승인 후 Done
```

에이전트, 모델, Skillify, Learner는 이 흐름을 주도하지 않는다. 이들은 Harness OS가 호출하는 실행자, 추천자, 평가자다.

---

## 2. 설계 원칙

### 2.1 사용자가 흐름을 통제한다

HarnessAgentOS의 기본 철학은 "자율 에이전트 시스템"이 아니라 "사용자 감독형 개발 워크벤치"다. 자동화는 사용자의 판단을 대체하지 않고, 사용자가 더 좋은 판단을 더 빨리 하도록 돕는다.

모든 긴 작업은 최소한 다음 지점에서 멈출 수 있어야 한다.

- 계획 생성 후
- 파일 수정 전
- shell/test/build 실행 전
- 의존성 설치 전
- 실패 발생 후
- 품질 게이트 실패 후
- 커밋 전

각 멈춤 지점은 단순 로그가 아니라 명시적인 `Checkpoint`와 `Approval` 상태로 저장된다.

### 2.2 단순하고 조합 가능한 workflow를 우선한다

Anthropic의 [Building effective agents](https://www.anthropic.com/research/building-effective-agents)는 성공적인 agent 구현이 복잡한 프레임워크보다 단순하고 조합 가능한 패턴에서 나온다고 설명한다. HarnessAgentOS는 이 관점을 따른다.

따라서 MVP는 거대한 CEO 오케스트레이터나 77종 에이전트 그래프를 기본 경로로 두지 않는다. 먼저 다음 workflow만 안정적으로 만든다.

```text
대화 입력
  -> 계획 초안
  -> 사용자 승인
  -> 제한된 실행
  -> diff/artifact 표시
  -> 테스트/검증
  -> 품질 판정
  -> 다음 대화로 이어서 수정
```

### 2.3 실행은 중단 가능하고 재개 가능해야 한다

OpenAI Agents SDK의 [Human-in-the-loop](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)는 승인 필요한 tool call에서 run을 pause하고, approval/rejection 이후 같은 run state에서 resume하는 패턴을 제공한다. LangGraph의 [Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts), [Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence), [Durable execution](https://docs.langchain.com/oss/javascript/langgraph/durable-execution)도 checkpoint, thread, resume 개념을 중심으로 human-in-the-loop와 장기 실행을 다룬다.

HarnessAgentOS는 외부 프레임워크를 MVP 의존성으로 채택하지 않지만, 다음 원칙을 직접 구현한다.

- 모든 `TaskRun`은 안정적인 `threadId`를 가진다.
- 모든 중요한 실행 단계는 `Checkpoint`로 저장된다.
- side effect가 있는 작업은 approval 없이 실행하지 않는다.
- resume은 이전 성공 단계부터 재실행하지 않아야 한다.
- 재개 가능한 상태는 DB에 저장되어 앱 재시작 후에도 복원된다.

### 2.4 Local-first가 기본이다

Ink & Switch의 [Local-first software](https://www.inkandswitch.com/essay/local-first/) 원칙에 따라, HarnessAgentOS의 canonical data는 사용자의 로컬 장치에 있다. 서버는 MVP에 없다. 클라우드 동기화가 나중에 추가되더라도 보조 기능이어야 한다.

이 결정은 제품 경험을 단순하게 만든다.

- 포트 충돌이 없다.
- localhost 서버 실행이 필요 없다.
- 오프라인에서도 기존 실행 기록과 산출물을 볼 수 있다.
- 사용자가 자신의 작업 데이터와 trace를 소유한다.
- 백엔드 서버가 내려가도 앱은 로컬에서 동작한다.

### 2.5 Skill은 실행 주체가 아니라 capability다

Anthropic의 [Agent Skills](https://docs.claude.com/en/docs/agents-and-tools/agent-skills)는 Skill을 폴더 기반의 재사용 가능한 전문성 패키지로 설명한다. HarnessAgentOS는 이 개념을 Skillify 재설계의 기준으로 삼는다.

기존 Skillify는 runtime hook이나 pipeline 주변에서 자동 개입할 수 있었다. 새 구조에서는 Skillify를 다음 역할로 제한한다.

- 관련 capability 추천
- 필요한 지식, 절차, script, template 제공
- 실행 전 사용자에게 어떤 skill이 왜 선택됐는지 표시
- 실행 결과를 trace와 learner에 연결

Skillify가 사용자가 모르는 사이에 전체 흐름을 short-circuit하거나, 숨겨진 실행자로 동작하면 안 된다.

### 2.6 완료는 자기 보고가 아니라 증거 기반이다

OpenAI의 [Agent evals](https://platform.openai.com/docs/guides/agent-evals)와 [OpenAI Evals](https://github.com/openai/evals)는 agent 품질을 재현 가능한 평가와 trace 기반으로 측정하는 방향을 제시한다. HarnessAgentOS의 완료 판정도 agent의 "완료했습니다"가 아니라 증거를 기준으로 한다.

완료 조건은 작업 유형에 따라 다르지만, 개발 작업의 기본 완료 조건은 다음이다.

- 변경 파일 목록이 명확함
- diff가 사용자에게 표시됨
- 관련 테스트 또는 build가 실행됨
- 실패 또는 미실행 항목이 숨겨지지 않음
- smoke 확인이 필요한 앱 목표는 smoke evidence가 있음
- 알려진 리스크가 기록됨
- 사용자가 최종 승인함

---

## 3. 기존 ClaudeAgentSystem 평가

### 3.1 유지할 문제의식

현재 프로젝트가 실패라고만 볼 수는 없다. 중요한 실험과 자산이 이미 있다.

- Skillify runtime과 capability 개념
- Learner trace, reward, latency, cost, model-selection feedback
- final quality evaluator
- targetDir 처리
- conversation context와 direct answer 경로
- runner abstraction
- 품질 게이트와 smoke evidence 강화 경험
- message/polling/state ownership에 대한 많은 감사 문서

문제는 이 자산들이 사용자를 중심에 두는 제품 구조가 아니라 자동 에이전트 시스템 안에 묶여 있다는 점이다.

### 3.2 실패 원인

#### 대화 연속성이 약하다

한 번 질문한 뒤 후속 질문으로 자연스럽게 이어가기 어렵다. 사용자는 "방금 만든 것 수정", "이전 실패 원인만 다시 봐", "그 폴더에서 이어서 해" 같은 흐름을 기대하지만, 기존 구조는 direct/CEO/pipeline/targetDir/context 경로가 분리되어 있어 이어서 작업하기가 불안정하다.

#### 중간 개입이 어렵다

에이전트가 계획을 세우고 실행하고 완료를 보고하는 동안 사용자가 안전하게 끼어드는 모델이 약하다. 중간 산출물은 존재하더라도 사용자의 의사결정 지점으로 승격되어 있지 않다.

#### 진행 과정이 불투명하다

멀티 에이전트, 메시지 큐, pipeline, CEO, learner, skillify가 함께 얽히면 현재 어떤 근거로 어떤 작업이 실행되는지 사용자가 이해하기 어렵다.

#### 자동화가 품질보다 앞선다

자동 진행이 우선되면 낮은 품질의 산출물도 뒤늦게 발견된다. final-quality-evaluator 같은 게이트는 필요하지만, 사후 게이트만으로는 "잘못된 방향으로 오래 진행"하는 문제를 막기 어렵다.

#### 에이전트 종류가 많고 기본 UX를 흐린다

77종 에이전트와 동적 그래프는 실험적으로는 흥미롭지만, 기본 개발 UX에서는 사용자가 이해해야 할 개념을 너무 많이 만든다.

### 3.3 버릴 것

다음은 HarnessAgentOS MVP에 가져오지 않는다.

- CEO가 Todo를 임의로 뽑아 진행하는 구조
- 숨겨진 에이전트 간 메시지 흐름
- 기본 파이프라인 강제
- 77종 에이전트 중심 UX
- 완료 판정을 agent 자기 보고에 의존하는 흐름
- 서버 기반 localhost API 구조
- JSON 파일을 canonical state로 사용하는 방식
- 사용자 승인 없이 파일 수정, shell 실행, dependency 설치, git commit을 진행하는 방식

### 3.4 살릴 것

다음은 이식 후보로 유지한다.

- Skillify runtime/concepts
- Skill/capability registry
- Learner trace와 reward 계산
- cost/latency/model-selection feedback
- final quality evaluator
- targetDir resolution
- conversation continuity
- runner abstraction
- smoke/build/test evidence 개념
- policy mirror와 learner visibility 개념

---

## 4. 제품 목표

### 4.1 핵심 사용자 경험

사용자는 앱을 열면 대화창을 중심으로 작업한다. 하지만 일반 챗봇처럼 답변만 받는 것이 아니라, 모든 개발 작업이 추적 가능한 `TaskRun`으로 전환된다.

예상 흐름은 다음과 같다.

```text
사용자: 이 프로젝트에서 로그인 버그 고쳐줘

HarnessOS:
1. 대상 폴더 확인
2. 관련 파일 탐색
3. 계획 초안 생성
4. 사용자 승인 대기

사용자: 이 방향으로 진행해

HarnessOS:
5. 파일 수정 전 diff preview 또는 수정 계획 표시
6. 승인 후 파일 수정
7. 테스트 실행 전 승인 또는 정책 기반 실행
8. 테스트 결과 표시
9. 품질 게이트 통과/실패 표시
10. 다음 질문으로 이어서 수정 가능
```

### 4.2 첫 화면

첫 화면은 landing page가 아니어야 한다. 바로 작업 가능한 워크벤치여야 한다.

기본 화면 구성:

- 좌측: Thread 목록과 작업공간 선택
- 중앙: 대화 + 현재 TaskRun 타임라인
- 우측: 체크포인트, artifacts, diff, 품질 상태
- 하단 또는 floating bar: approve/reject/redirect/pause/resume controls

### 4.3 사용자가 기대하는 조작

- 현재 작업 멈추기
- 이전 체크포인트 보기
- 특정 단계부터 다시 실행하기
- 계획 수정 요청하기
- 파일 수정 전 diff 확인하기
- 테스트만 다시 실행하기
- 실패 로그를 바탕으로 재시도하기
- 결과가 마음에 안 들면 reject하고 이유를 남기기
- 같은 thread에서 이어서 질문하기
- 산출물과 품질 상태를 나중에 다시 열기

---

## 5. 시스템 아키텍처

### 5.1 전체 구조

```text
Electron App

Renderer Process
  React UI
  - Conversation Workbench
  - TaskRun Timeline
  - Checkpoint Panel
  - Artifact/Diff Viewer
  - Quality Gate Panel
  - Capability/Learner Recommendations

Preload
  - Typed IPC bridge
  - Strict argument validation
  - No raw ipcRenderer exposure

Main Process
  Harness Core
  - TaskRun service
  - Checkpoint service
  - Approval service
  - Artifact service
  - Runner service
  - Quality service
  - Capability service
  - Learner advisor

Local Store
  SQLite WAL DB
  Workspace files
  Artifact files
  Debug snapshots

External/Local Executors
  Codex CLI
  Claude CLI
  Git
  npm/test/build commands
  Skill scripts
```

### 5.2 서버 없음

MVP는 Express, localhost API, WebSocket server를 사용하지 않는다. UI와 core는 Electron IPC로 통신한다.

```text
기존 방식:
React UI -> HTTP API -> Express handler -> local command

새 방식:
React UI -> preload IPC API -> Electron main service -> local command
```

### 5.3 Electron 보안 기준

Electron 공식 [Security](https://www.electronjs.org/docs/latest/tutorial/security)와 [Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)을 따른다.

필수 정책:

- renderer에서 `nodeIntegration` 비활성화
- `contextIsolation` 활성화
- preload에서 `contextBridge`로 제한된 API만 노출
- raw `ipcRenderer` 노출 금지
- IPC channel별 입력 검증
- renderer는 파일 경로를 직접 실행하지 못함
- shell command는 main process의 approval policy를 통과해야 함
- remote content 로드 금지
- `shell.openExternal`은 신뢰된 URL만 허용

### 5.4 저장소 구조

로컬 canonical store는 SQLite다. SQLite는 WAL 모드로 설정한다. SQLite 공식 [Write-Ahead Logging](https://www.sqlite.org/wal.html)을 참고해, crash recovery와 읽기/쓰기 동시성을 고려한다.

예상 위치:

```text
%APPDATA%/HarnessAgentOS/app.db
%APPDATA%/HarnessAgentOS/artifacts/
%APPDATA%/HarnessAgentOS/logs/
%APPDATA%/HarnessAgentOS/snapshots/
```

프로젝트 루트에는 소스와 문서만 둔다.

```text
HarnessAgentOS/
  apps/desktop/
  packages/core/
  packages/runners/
  packages/skillify-adapter/
  packages/learner/
  packages/quality/
  docs/architecture/
```

---

## 6. 핵심 도메인 모델

### 6.1 Thread

사용자와 Harness OS 간의 대화 단위다. 하나의 Thread에는 여러 TaskRun이 포함될 수 있다.

필드:

```ts
interface Thread {
  id: string;
  title: string;
  targetDir?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}
```

### 6.2 TaskRun

사용자 요청 하나를 실행 가능한 작업 단위로 감싼다.

```ts
type TaskRunStatus =
  | "drafting"
  | "waiting_for_approval"
  | "running"
  | "paused"
  | "blocked"
  | "quality_failed"
  | "ready_for_review"
  | "done"
  | "cancelled";

interface TaskRun {
  id: string;
  threadId: string;
  userRequest: string;
  targetDir: string;
  status: TaskRunStatus;
  currentStepId?: string;
  createdAt: string;
  updatedAt: string;
}
```

### 6.3 Step

TaskRun을 구성하는 실행 단계다.

```ts
type StepKind =
  | "inspect"
  | "plan"
  | "approval"
  | "edit"
  | "shell"
  | "test"
  | "quality_gate"
  | "summarize";

interface Step {
  id: string;
  taskRunId: string;
  index: number;
  kind: StepKind;
  title: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  inputSummary?: string;
  outputSummary?: string;
  startedAt?: string;
  finishedAt?: string;
}
```

### 6.4 Checkpoint

재개와 사용자 검토의 기준점이다.

```ts
interface Checkpoint {
  id: string;
  taskRunId: string;
  stepId: string;
  reason: "before_edit" | "before_shell" | "after_failure" | "before_commit" | "manual";
  stateRef: string;
  summary: string;
  createdAt: string;
}
```

### 6.5 Approval

side effect를 가진 action에 대한 사용자 결정이다.

```ts
type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "always_approved_for_run";

type ApprovalScope = "once" | "run_action_class";

type ApprovalActionType =
  | "file_write"
  | "shell"
  | "dependency_install"
  | "git_commit"
  | "network"
  | "skill_script"
  | "orchestration_plan";

type ArtifactKind =
  | "plan"
  | "diff"
  | "log"
  | "test_result"
  | "quality_report"
  | "orchestration_plan"
  | "file"
  | "snapshot";

interface Approval {
  id: string;
  taskRunId: string;
  checkpointId: string;
  actionType: ApprovalActionType;
  actionSummary: string;
  status: ApprovalStatus;
  decisionMessage?: string;
  decidedAt?: string;
}
```

### 6.6 Artifact

계획, diff, 로그, 테스트 결과, 생성 파일, 품질 리포트 같은 중간 산출물이다.

```ts
interface Artifact {
  id: string;
  taskRunId: string;
  stepId?: string;
  kind: ArtifactKind;
  title: string;
  uri: string;
  summary?: string;
  createdAt: string;
}
```

### 6.7 QualityGateResult

완료 판정에 필요한 증거다.

```ts
interface QualityGateResult {
  id: string;
  taskRunId: string;
  status: "passed" | "failed" | "warning" | "not_run";
  buildPassed?: boolean;
  testsPassed?: boolean;
  smokePassed?: boolean;
  changedFilesReviewed?: boolean;
  knownRisks: string[];
  evidenceArtifactIds: string[];
  createdAt: string;
}
```

### 6.8 Capability

Skillify나 내장 도구가 제공하는 재사용 가능한 능력이다.

```ts
interface Capability {
  id: string;
  source: "builtin" | "skillify" | "imported_skill";
  name: string;
  description: string;
  triggerTerms: string[];
  riskLevel: "low" | "medium" | "high";
  requiresApproval: boolean;
}
```

### 6.9 LearningTrace

Learner가 추천과 사후 분석에 사용하는 실행 기록이다.

```ts
interface LearningTrace {
  id: string;
  taskRunId: string;
  selectedModel?: string;
  selectedCapabilities: string[];
  reward?: number;
  costEstimate?: number;
  latencyMs?: number;
  success?: boolean;
  failureReason?: string;
  createdAt: string;
}
```

---

## 7. IPC 인터페이스

Renderer는 main process의 제한된 API만 호출한다. 모든 IPC는 입력 schema validation과 권한 정책을 통과해야 한다. Public IPC method 이름의 단일 source of truth는 `docs/contracts/ipc-contracts.md`이며, 모든 문서는 `window.harness.namespace.method()` dot notation을 따른다.

### 7.1 TaskRun / Conversation API

```ts
window.harness.conversation.createTask(input: {
  threadId?: string;
  userRequest: string;
  targetDir?: string;
}): Promise<ConversationTaskDraft>;

window.harness.conversation.redirectTask(input: { taskRunId: string; instruction: string }): Promise<ConversationTaskDraft>;
window.harness.conversation.approve(input: { approvalId: string; message?: string; scope?: ApprovalScope }): Promise<Approval>;
window.harness.conversation.rejectApproval(input: { approvalId: string; message: string }): Promise<Approval>;
```

### 7.2 Runner / Artifact API

```ts
window.harness.runner.executeApproved(input: { approvalId: string }): Promise<RunnerResult>;
window.harness.runner.listArtifacts(input: { taskRunId: string }): Promise<Artifact[]>;
window.harness.runner.readArtifact(input: { artifactId: string }): Promise<{ artifact: Artifact; content: string }>;
```

### 7.3 Quality API

단일 소스는 `docs/contracts/ipc-contracts.md`이며 아래는 요약이다.

```ts
window.harness.quality.evaluate(input: QualityGateInput): Promise<QualityGateResult>;
window.harness.quality.getLatest(input: { taskRunId: string }): Promise<QualityGateResult | null>;
window.harness.quality.approveKnownRisks(input: { taskRunId: string; message: string }): Promise<TaskRun>;
window.harness.quality.createRepairPlan(input: { taskRunId: string; instruction?: string }): Promise<RepairPlanDraft>;
window.harness.quality.markReadyForReview(input: { taskRunId: string }): Promise<TaskRun>;
window.harness.quality.markDone(input: { taskRunId: string }): Promise<TaskRun>;
```

`markDone`은 TaskRun을 `done`으로 옮기는 유일한 경로이며 — passed 게이트, 또는 warning 게이트 + 명시적 known-risk 승인 아티팩트(`quality_report` kind, URI suffix `/<gate.id>`)가 있을 때만 허용된다.

### 7.4 Capability / Learner API

```ts
window.harness.capability.suggest(input: { taskRunId: string; prompt: string }): Promise<CapabilitySuggestion[]>;

interface LearnerRecommendation {
  id: string;
  recommendedModel?: string;
  recommendedCapabilities: CapabilitySuggestion[];
  rationale: string;
  costHint?: string;
  latencyHint?: string;
  confidence: number;
}

window.harness.learner.recommend(input: { taskRunId: string }): Promise<LearnerRecommendation>;
window.harness.learner.recordDecision(input: {
  taskRunId: string;
  recommendationId: string; // LearnerRecommendation.id
  decision: "accepted" | "rejected";
  reason?: string;
}): Promise<void>;
```

### 7.5 Events (단방향 main → renderer push)

```ts
window.harness.events.onTaskRunChanged(
  listener: (payload: { taskRunId: string }) => void,
): () => void;
```

state-changing IPC 핸들러가 성공 직후 발행하는 유일한 push 채널이다. renderer는 페이로드를 받아 `getTaskRunDetail`을 다시 호출해 fresh 상태를 가져온다. 임의 데이터/상태를 broadcast하지 않으며, 새 push 채널은 `docs/contracts/ipc-contracts.md`를 먼저 갱신해야 한다.

---

## 8. 실행 정책

### 8.1 기본 실행 흐름

```text
1. 사용자가 대화 입력
2. Harness Core가 Thread/TaskRun 생성
3. targetDir 확인
4. 관련 context 탐색
5. Skillify/Learner 추천 수집
6. 계획 artifact 생성
7. before_edit checkpoint 생성
8. 사용자 승인 대기
9. 승인 후 runner 실행
10. diff/log/test artifact 저장
11. quality gate 실행
12. ready_for_review 상태 전환
13. 사용자 최종 승인 후 done
```

### 8.2 승인 필요한 action

다음 action은 기본적으로 approval이 필요하다.

- 파일 쓰기
- 파일 삭제
- shell command 실행
- dependency 설치
- git commit
- git push
- 외부 네트워크 호출
- workspace 밖 경로 접근
- Skill script 실행

작업 run 내부에서 사용자가 `always_approved_for_run`을 선택하면 같은 action class에 한해 반복 승인 없이 진행할 수 있다. 단, dependency 설치, git push, workspace 밖 쓰기는 항상 개별 승인을 유지한다.

### 8.3 실패 처리

실패는 숨기지 않고 `blocked` 또는 `quality_failed`로 전환한다.

실패 시 UI는 다음을 표시한다.

- 실패 단계
- 실행 명령 또는 action summary
- stderr/stdout 요약
- 관련 artifact
- 가능한 다음 선택지

가능한 다음 선택지:

- retry
- redirect with instruction
- inspect only
- rollback to checkpoint
- cancel task

---

## 9. UI 설계

### 9.1 Conversation Workbench

중앙 화면은 대화와 실행 타임라인을 함께 보여준다. 사용자는 일반 대화처럼 입력하지만, 실행 가능한 요청은 자동으로 TaskRun이 된다.

표시 요소:

- 사용자 요청
- Harness의 계획 요약
- 현재 상태
- 승인 대기 action
- 최근 artifact
- 다음 가능한 조작

### 9.2 Timeline

TaskRun의 Step을 시간순으로 표시한다.

상태 예시:

```text
[done] Inspect project
[done] Draft plan
[pending approval] Write files
[pending] Run tests
[pending] Quality gate
```

### 9.3 Checkpoint Panel

Checkpoint Panel은 사용자가 중간 상태를 이해하고 개입하는 핵심 화면이다.

기능:

- checkpoint 목록
- checkpoint summary
- 연결된 artifact
- resume/retry/rollback action
- approval history

### 9.4 Artifact/Diff Viewer

모든 중간 결과물은 artifact로 보존된다.

필수 artifact:

- 계획
- 파일 변경 diff
- shell log
- test result
- quality report
- final summary

### 9.5 Quality Panel

완료 전 품질 상태를 명확히 보여준다.

표시 항목:

- build 상태
- test 상태
- smoke 상태
- changed files 검토 여부
- known risks
- missing evidence
- final approval 가능 여부

### 9.6 Capability/Learner Panel

Skillify와 Learner는 사용자가 볼 수 있는 추천 근거로 표시된다.

예시:

```text
추천 capability:
- react-debugging: 관련도 높음, risk low
- node-test-runner: 테스트 실행 추천, risk medium

추천 모델:
- GPT-5.5 xhigh: 코딩 변경 성공률 높음, 예상 비용 높음
- Claude Opus 4.7 max: 복잡한 설계 검토에 적합
```

---

## 10. Skillify 이식 전략

### 10.1 목표

Skillify를 숨겨진 pre-tool hook이 아니라 capability registry/advisor로 바꾼다.

기존 Skillify의 장점:

- skill discovery
- deterministic/hybrid/latent skill 구분
- shadow/eval/report 흐름
- embedding 기반 matching
- judge/cache/ledger 개념

새 구조에서의 역할:

```text
TaskRun context
  -> CapabilityService.suggest()
  -> 관련 skill 후보 표시
  -> 사용자 또는 policy가 선택
  -> 필요한 경우 approval 후 skill script 실행
  -> 결과를 artifact와 LearningTrace에 기록
```

### 10.2 Skill 형식

Skill은 filesystem 기반으로 둔다.

```text
skills/
  react-debugging/
    SKILL.md
    scripts/
    templates/
    examples/
```

`SKILL.md`는 최소한 다음 metadata를 가진다.

```yaml
name: react-debugging
description: React UI 상태, effect, hook 관련 버그를 분석하고 수정할 때 사용
risk: medium
allowed_actions:
  - inspect
  - suggest_patch
  - run_tests
```

### 10.3 실행 제한

- skill metadata는 항상 읽을 수 있다.
- skill instruction은 관련 skill로 선택된 경우에만 load한다.
- skill script는 approval 없이는 실행하지 않는다.
- 외부 네트워크를 사용하는 skill은 high risk로 표시한다.
- untrusted skill은 기본 비활성화한다.

---

## 11. Learner 이식 전략

### 11.1 목표

Learner는 자동 적용자가 아니라 추천 근거 제공자다.

기존 Learner의 유지 가치:

- trace 기반 reward
- 성공률/실패율
- latency/cost metric
- model selection feedback
- capability ranking
- policy mirror

새 역할:

```text
LearningTrace 수집
  -> reward/cost/latency 계산
  -> capability/model 추천
  -> 추천 근거 UI 표시
  -> 사용자가 채택/거절
```

### 11.2 금지할 자동화

- prompt promotion 자동 적용 금지
- pipeline activation 자동 적용 금지
- agent type promotion 자동 적용 금지
- high risk action 자동 승인 금지
- 사용자가 보지 못하는 route 변경 금지

### 11.3 추천 예시

Learner는 다음 형태로 추천한다.

```json
{
  "recommendedModel": "gpt-5.5",
  "effort": "xhigh",
  "reason": "최근 유사 TypeScript 수정 작업에서 테스트 통과율이 높고 재시도 횟수가 낮음",
  "costHint": "high",
  "latencyHint": "medium",
  "recommendedCapabilities": ["typescript-debugging", "node-test-runner"]
}
```

---

## 12. Quality Gate 설계

### 12.1 기본 원칙

Quality Gate는 `done` 직전의 필수 관문이다. Harness OS는 quality evidence가 부족하면 작업을 완료로 표시하지 않는다.

### 12.2 개발 작업 기본 게이트

- 변경 파일이 존재하거나, 변경 없음의 이유가 명확해야 함
- diff artifact가 존재해야 함
- 관련 테스트 또는 build가 실행되어야 함
- 실패한 테스트는 숨기지 않아야 함
- 앱 실행 가능성이 목표인 경우 smoke evidence가 있어야 함
- known risks가 비어 있거나 명시적으로 승인되어야 함
- 사용자 final approval이 있어야 함

### 12.3 실패 시 상태

Quality Gate 실패 시 `quality_failed`로 전환한다. Harness OS는 자동으로 완료 처리하지 않는다.

사용자가 선택할 수 있는 조치:

- 실패 원인 설명 요청
- repair plan 생성
- 특정 테스트만 재실행
- 파일 수정 재시도
- known risk를 승인하고 종료
- 작업 취소

---

## 13. Runner 설계

### 13.1 Runner 종류

MVP에서 필요한 runner:

- `ModelRunner`: Codex/Claude/OpenAI CLI 또는 API 호출
- `ShellRunner`: 승인된 shell command 실행
- `GitRunner`: status/diff/commit 등 git 작업
- `TestRunner`: npm/node/test/build 명령 실행
- `FileRunner`: 승인된 파일 쓰기/삭제/patch 적용

### 13.2 Runner 결과

모든 runner는 표준 결과를 반환한다.

```ts
interface RunnerResult {
  id: string;
  taskRunId: string;
  stepId: string;
  commandSummary: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  changedFiles?: string[];
  artifactIds: string[];
  startedAt: string;
  finishedAt: string;
}
```

### 13.3 Policy

Runner 실행 전 Harness Core는 다음을 확인한다.

- targetDir가 허용된 workspace인지
- action type이 approval을 요구하는지
- command가 destructive인지
- dependency install 또는 network 호출인지
- 이전 checkpoint가 존재하는지
- 결과 artifact를 저장할 수 있는지

---

## 14. Local SQLite Schema 초안

MVP schema는 작게 시작한다.

```sql
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  target_dir TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  user_request TEXT NOT NULL,
  target_dir TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('drafting','waiting_for_approval','running','paused','blocked','quality_failed','ready_for_review','done','cancelled')),
  current_step_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(thread_id) REFERENCES threads(id)
);

CREATE TABLE steps (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','skipped')),
  input_summary TEXT,
  output_summary TEXT,
  started_at TEXT,
  finished_at TEXT,
  FOREIGN KEY(task_run_id) REFERENCES task_runs(id)
);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  state_ref TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_run_id) REFERENCES task_runs(id),
  FOREIGN KEY(step_id) REFERENCES steps(id)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK(action_type IN ('file_write','shell','dependency_install','git_commit','network','skill_script','orchestration_plan')),
  action_summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','always_approved_for_run')),
  decision_message TEXT,
  decided_at TEXT,
  FOREIGN KEY(task_run_id) REFERENCES task_runs(id),
  FOREIGN KEY(checkpoint_id) REFERENCES checkpoints(id)
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL,
  step_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  uri TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_run_id) REFERENCES task_runs(id),
  FOREIGN KEY(step_id) REFERENCES steps(id)
);

CREATE TABLE quality_gate_results (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('passed','failed','warning','not_run')),
  build_passed INTEGER,
  tests_passed INTEGER,
  smoke_passed INTEGER,
  changed_files_reviewed INTEGER,
  known_risks_json TEXT NOT NULL,
  evidence_artifact_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_run_id) REFERENCES task_runs(id)
);

CREATE TABLE capabilities (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  trigger_terms_json TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  requires_approval INTEGER NOT NULL
);

CREATE TABLE learning_traces (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL,
  selected_model TEXT,
  selected_capabilities_json TEXT NOT NULL,
  reward REAL,
  cost_estimate REAL,
  latency_ms INTEGER,
  success INTEGER,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_run_id) REFERENCES task_runs(id)
);
```

초기화 시 다음 pragma를 적용한다.

```sql
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
```

---

## 15. MVP 범위

### 15.1 포함

- Electron 앱 scaffold
- React workbench UI
- SQLite 기반 Thread/TaskRun/Step/Checkpoint/Artifact 저장
- targetDir 선택과 검증
- 계획 생성 artifact
- 사용자 approval/reject/resume
- 파일 수정 전 approval
- shell/test 실행 전 approval
- diff/log/test artifact 표시
- quality gate 기본판
- Skillify capability metadata import
- Learner recommendation placeholder

### 15.2 제외

- 기존 CEO 자동 오케스트레이션
- 기존 pipeline 기본 실행
- 77종 agent UX
- MCP 서버
- inter-agent message queue
- remote collaboration
- cloud sync
- 자동 prompt promotion
- 자동 pipeline activation
- 앱 패키징/배포 자동화

---

## 16. 단계별 구현 로드맵

상세 구현 기준은 `docs/implementation/README.md`와 각 phase 문서를 단일 source of truth로 둔다. 이 섹션은 상위 로드맵 요약이다.

### Phase 0: 프로젝트 뼈대와 검증 기준

목표:

- `HarnessAgentOS` monorepo 생성
- Electron + React + Node 기본 앱 실행
- preload `contextBridge` 기반 IPC 경계 생성
- renderer Node 권한 비활성화
- 공통 check/test/build 명령 이름 고정

완료 기준:

- 앱이 서버 없이 실행됨
- Workbench shell이 렌더링됨
- `window.harness.app.getRuntimeInfo()`가 동작함
- raw `ipcRenderer`가 노출되지 않음

### Phase 1: 로컬 상태 모델

목표:

- SQLite WAL store 초기화
- Thread/TaskRun/Step/Checkpoint/Approval/Artifact 기본 schema 생성
- repository/service 경계 구현
- 앱 재시작 후 상태 복원

완료 기준:

- 새 Thread 생성 가능
- TaskRun 생성 가능
- DB 파일이 로컬 app data에 생성됨
- 앱 재시작 후 Thread/TaskRun이 복원됨

### Phase 2: 대화 입력에서 승인 대기까지

목표:

- 대화 입력을 TaskRun으로 변환
- 간단한 inspect/plan step 생성
- 계획 artifact 저장
- before_edit checkpoint 생성
- approval pending 상태 표시

완료 기준:

- 사용자가 요청을 입력하면 계획이 생성됨
- 실행 전 승인 대기 상태가 UI에 표시됨
- reject 시 사용자의 이유가 기록됨
- redirect 시 계획이 새 지시로 갱신됨

### Phase 3: Runner와 Artifact 표시

목표:

- 승인된 파일 수정 실행
- shell/test runner 실행
- git diff artifact 저장
- stdout/stderr log artifact 저장

완료 기준:

- 파일 수정 전 approval이 필요함
- 수정 후 changed files가 표시됨
- test command 결과가 artifact로 남음
- 실패해도 로그가 보존됨

### Phase 4: Quality Gate 통합

목표:

- build/test/smoke evidence 기반 품질 판정
- final approval 전 gate 결과 표시
- 실패 시 `quality_failed` 상태 전환

완료 기준:

- 테스트 미실행 상태를 passed로 처리하지 않음
- known risks가 UI에 표시됨
- 사용자가 risk를 승인하거나 repair를 요청할 수 있음

### Phase 5: Skillify capability registry 연결

목표:

- 기존 Skillify skill metadata import
- capability suggestion API 구현
- 추천 skill과 이유 표시
- skill script 실행은 approval 뒤에만 허용

완료 기준:

- 관련 skill 후보가 표시됨
- skill instruction은 선택된 경우에만 load됨
- script 실행 전 approval이 필요함

### Phase 6: Learner 추천 연결

목표:

- LearningTrace 저장
- model/capability 추천 placeholder 구현
- reward/cost/latency 표시
- 추천 채택/거절 기록

완료 기준:

- 완료된 TaskRun이 trace로 남음
- 추천 근거가 UI에 표시됨
- 추천이 자동 적용되지 않음

### Phase 7: 선택적 agent orchestration

목표:

- 기존 CEO/pipeline 아이디어를 기본 경로가 아닌 고급 옵션으로 재검토
- orchestrated run도 Harness checkpoint/approval/quality gate를 반드시 통과

완료 기준:

- agent orchestration이 켜져도 사용자가 중간에 개입 가능
- hidden message flow가 기본 UX를 우회하지 않음
- 완료 판정은 Harness quality gate가 담당

---
## 17. 기존 프로젝트 이식 매트릭스

| 기존 자산 | 새 위치 | 이식 방식 | MVP 포함 |
|---|---|---|---|
| Skillify runtime | `packages/skillify-adapter` | capability metadata와 resolver 개념만 우선 이식 | 부분 |
| Skillify scripts/templates | `skills/` 또는 app data | trusted skill만 import | 부분 |
| Learner trace | `packages/learner` | LearningTrace schema로 재구성 | 부분 |
| policy mirror | `packages/learner` | 추천 근거 summary로 축소 | 이후 |
| final-quality-evaluator | `packages/quality` | Harness QualityGateResult로 재작성 | 포함 |
| target-dir.mjs | `packages/core` | path validation helper로 이식 | 포함 |
| conversation context | `packages/core` | Thread memory/context builder로 재작성 | 포함 |
| runner abstraction | `packages/runners` | Electron main process service로 재작성 | 포함 |
| CEO agent | 없음 | 기본 경로 제외, Phase 7에서 재검토 | 제외 |
| pipeline graph | 없음 | 기본 경로 제외, Phase 7에서 재검토 | 제외 |
| MCP message queue | 없음 | MVP 제외 | 제외 |
| 77 agent types | 없음 | capability metadata로 필요한 것만 흡수 | 제외 |

---

## 18. Acceptance Criteria

HarnessAgentOS MVP는 다음 조건을 만족해야 한다.

1. 서버 없이 앱이 실행된다.
2. 사용자는 대화창에서 작업을 시작할 수 있다.
3. 모든 작업은 TaskRun으로 기록된다.
4. 파일 수정 전 approval이 필요하다.
5. shell/test 실행 전 approval이 필요하다.
6. 중간 산출물은 artifact로 남는다.
7. 실패 로그는 숨겨지지 않는다.
8. 품질 게이트가 완료 전 실행된다.
9. 테스트 미실행 또는 smoke evidence 부족은 명확히 표시된다.
10. 사용자는 reject/redirect/resume을 할 수 있다.
11. 앱 재시작 후 이전 Thread와 TaskRun을 볼 수 있다.
12. Skillify와 Learner 추천은 표시되지만 자동 적용되지 않는다.
13. 기존 CEO/pipeline 자동 진행은 기본 경로에 없다.

---

## 19. 구현 시 주의사항

- 처음부터 거대한 agent framework를 만들지 않는다.
- LangGraph, Temporal, OpenAI Agents SDK는 설계 참고 자료이지 MVP 의존성이 아니다.
- 데이터 모델을 과도하게 일반화하지 않는다.
- UI에 agent 종류를 많이 노출하지 않는다.
- 사용자가 이해할 수 있는 action 중심으로 표시한다.
- 모든 destructive action은 approval을 거친다.
- renderer에 Node 권한을 주지 않는다.
- 기존 ClaudeAgentSystem을 직접 고치면서 새 구조를 만들지 않는다.
- 기존 코드는 복사보다 개념 이식을 우선한다.

---

## 20. 다음 실행 프롬프트

다음 세션에서 구현을 시작할 때 사용할 프롬프트:

```text
C:\Users\FORYOUCOM\Desktop\Code\HarnessAgentOS\docs\architecture\harness-agent-os-design.md와 docs\implementation\README.md를 먼저 읽고, Phase 0부터 구현해줘.

조건:
- 서버 없는 Electron + React + Node 앱으로 시작한다.
- Express/localhost 서버는 만들지 않는다.
- SQLite WAL 기반 local store를 사용한다.
- Phase 0에서는 Electron scaffold와 IPC 보안 경계를 먼저 만들고, Phase 1에서 Thread, TaskRun, Step, Checkpoint, Artifact의 최소 CRUD를 만든다.
- 기존 ClaudeAgentSystem은 직접 수정하지 말고 참조만 한다.
- 구현 후 앱 실행 방법과 검증 명령을 문서화해줘.
```

---

## 21. 최종 판단

HarnessAgentOS는 ClaudeAgentSystem의 반대편에 있는 프로젝트가 아니다. ClaudeAgentSystem이 쌓아온 Skillify, Learner, quality gate, runner 경험을 사용자 중심 구조로 다시 배치하는 새 제품이다.

핵심 전환은 다음 한 문장으로 요약된다.

```text
에이전트가 작업을 소유하는 시스템에서, 사용자가 Harness OS를 통해 작업을 소유하고 에이전트를 실행자로 부리는 시스템으로 전환한다.
```

이 전환이 성공하려면 첫 구현부터 사용자의 개입, 체크포인트, 산출물 가시성, 품질 증거를 중심에 둬야 한다. 자동화는 그 다음이다.





