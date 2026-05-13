# 다음 세션 프롬프트 — Pipeline × Thread Binding 구현

> 이 파일을 다음 세션의 첫 메시지로 사용하거나, "이 파일 읽고 시작" 으로 지시.

---

## 컨텍스트 (먼저 읽기)

다음 두 파일을 **반드시** 먼저 읽고 작업 시작:

1. `docs/design/pipeline-thread-binding-plan.html` — 두 페이즈 실행 계획 (데이터 모델, 9-layer IPC 변경 목록, 테스트 파일, 백워드 호환성)
2. `apps/desktop/src/screens/workbench/ConversationInput.tsx` — 직전 커밋에서 수정된 채팅 입력 컴포넌트
3. `apps/desktop/src/screens/workbench/WorkbenchShell.tsx` — `handleCreateThread` (line ~416), `handleCreateTask` 라우팅 진입점

## 이전 세션 결과 (커밋 4개)

| Hash | 종류 | 요약 |
|---|---|---|
| `51524e5` | docs | Pipeline × Thread Binding 실행 계획서 (HTML, 본 작업의 청사진) |
| `fbb9859` | chore | pnpm-lock.yaml |
| `82d3b84` | feat(skills) | 빌트인 스킬 4종 (git-summary / code-review / test-runner / doc-generator) |
| `060e2ff` | feat(orchestration) | Pipeline-first UI + `settings.orchestration.defaultPipelineId` |

## 현재 미해결 사항

사용자 불만: **"답변에 파이프라인 설명대로 안 하고 있어"** — 일반 채팅 답변이 선택된 파이프라인의 persona/instruction을 따르지 않는다.

원인 (코드로 확인됨):
- 일반 채팅 경로(`agent.generatePlan`)는 `settings.activeAgentProfileId` 1개 프로필만 사용. 파이프라인은 무관.
- Pipeline은 오직 `orchestration.draftPlan()` 사이드채널에서만 사용됨.
- 게다가 그 사이드채널의 worker-runner(`packages/orchestration/src/worker-runner.ts:131-149`)는 **결정적 stub** — `roleBody()` 가 role별 하드코딩 텍스트만 반환. 실제 에이전트 CLI 호출 안 함.
- `OrchestrationPlanner.synthesizeFromPipeline` (line 187) 이 `step.instruction` 을 **120자로 truncate** 해서 `WorkerStep.inputSummary` 에 저장. 원문 인스트럭션 손실.

사용자 결정: **"사용자가 원할 때만 파이프라인을 거치고, 스레드 생성할때 옵션이 같이 떠야겠지"** → 스레드 단위 파이프라인 바인딩.

## 작업 순서

### 1단계: 사용자와 정책 확인 (코딩 시작 전)

본 작업은 두 페이즈로 나뉘어 있고, Phase 2 시작 전에 사용자가 **approval 정책**을 정해야 함:

- **(a) Side-effect-free worker**: worker는 log artifact만 생성. file_write/shell 제안하면 별도 approval로 큐잉. 안전한 기본값.
- **(b) Plan approval 캐스케이드**: orchestration_plan approval 승인 시 worker가 만드는 후속 approval도 자동 승인. `settings.approval.autoApprove` 와 일관된 모델.

→ 사용자에게 (a)/(b) 중 선택 요청. 명시적 결정 없이 Phase 2 시작하지 말 것.

### 2단계: Phase 1 구현 (스레드 단위 파이프라인 바인딩)

계획서 §2 그대로:

1. `packages/core/src/types/thread.ts`: `Thread.pipelineId?: string`, `CreateThreadInput.pipelineId?`, `UpdateThreadInput.pipelineId?: string | null`
2. `packages/storage/src/schema.ts`: SCHEMA_VERSION 11 → 12, `threads` 테이블에 `pipeline_id TEXT` 컬럼
3. `packages/storage/src/migrations.ts`: `ALTER TABLE threads ADD COLUMN pipeline_id TEXT NULL`
4. `packages/storage/src/repositories/thread-repository.ts`: INSERT/UPDATE/SELECT 매핑, row mapper
5. `packages/storage/src/services/local-state-service.ts`: createThread 입력 통과
6. `apps/desktop/electron/ipc/state-ipc.ts`: 입력에 pipelineId 허용
7. `apps/desktop/electron/preload.ts`, `packages/core/src/api.ts`: 타입 갱신
8. **UI**:
   - "+ 새 스레드" 다이얼로그에 Pipeline 드롭다운 (`settings.orchestration.defaultPipelineId` 기본값)
   - `ConversationInput`의 `▸ Orchestration` 토글 **제거** — `thread.pipelineId` 가 있으면 자동 라우팅
   - 스레드 헤더에 "Pipeline: <name>" 배지
9. **`WorkbenchShell.handleCreateTask`**: `thread.pipelineId` 있으면 `orchestration.draftPlan({pipelineId})`, 없으면 `agent.generatePlan`
10. **테스트** (`.test.mjs` 만!):
    - `packages/storage/src/repositories/thread-repository.test.mjs`: pipelineId 라운드트립
    - `packages/storage/src/services/local-state-service.test.mjs`: createThread 시 pipelineId 저장 확인

### 3단계: 사용자 검증

Phase 1 끝나면 PR/커밋 단위로 끊고 사용자에게:
- "파이프라인 묶인 스레드 만들기 → 메시지 보내기 → orchestration_plan approval 생성되는지 확인" 요청.
- 출력은 여전히 stub임을 미리 알릴 것.

### 4단계: Phase 2 진행 (정책 결정 후)

계획서 §3 그대로:

1. `WorkerStep.instruction: string` 추가 (`packages/core/src/types/orchestration.ts`)
2. `OrchestrationPlanner.synthesizeFromPipeline` 에서 원문 보존
3. `WorkerRunner` 에 `AgentPlanningService` 주입
4. `runWorkerStepBody` 를 async 로 바꿔 실제 CLI 호출 (`profile.persona` + `step.instruction`)
5. `worker-runner.test.mjs` 의 하드코딩 단언 폐기, mock agentPlanning 으로 대체
6. `orchestration-planner.test.mjs` 에 instruction 보존 단언 추가
7. `apps/desktop/electron/main.ts` 에서 `OrchestrationService` 생성 시 agentPlanning 주입

## 프로젝트 컨벤션 (꼭 지킬 것)

- **9-layer IPC 패턴**: schema → repository → service → IPC handler → IPC register → ipc/index → preload → window.harness → renderer. 새 IPC 추가 시 모든 레이어 수정.
- **테스트 파일**: `.test.mjs` (절대 `.test.ts` / `.test.tsx` 안 됨)
- **services/core MUST NOT import @harness/storage**: `packages/core` 에서 storage 직접 import 금지. `LocalStateService` 인터페이스로만.
- **터미널 명령은 `rtk` 프리픽스**: `rtk git status`, `rtk tsc`, `rtk node --test` 등. 토큰 절약.
- **AgentPlanningService 호출 테스트**: AgentPlanningService 또는 CLI 호출 코드 테스트 시 fake/mock 사용 — 실제 CLI 호출 금지.
- **DEFAULT_HARNESS_SETTINGS**: 신규 필드 추가 시 normalize 함수도 반드시 갱신 (`packages/storage/src/repositories/settings-repository.ts`).
- **`window.harness.pipeline.list()` 는 이미 wired up 됨** — IPC 체인 검증 끝났으니 새로 의심하지 말 것.
- 한국어 UI 라벨 사용 (기존 스타일 유지).

## 백워드 호환성 체크리스트

- 레거시 thread (`pipeline_id IS NULL`) → 일반 채팅. 영향 없음.
- 레거시 orchestration plan artifact (instruction 필드 없음) → `step.instruction ?? step.inputSummary` 폴백.
- 삭제된 pipeline 을 참조하는 thread → UI에서 "(없음)" 표시, 라우팅은 일반 채팅으로 fallthrough.
- SCHEMA_VERSION bump 멱등: 재실행해도 NOOP.

## 시작 메시지 (사용자에게)

세션 시작 시 다음과 같이 응답할 것:

> 이전 세션에서 만든 `docs/design/pipeline-thread-binding-plan.html` 계획서를 읽었습니다. Phase 1(스레드 단위 파이프라인 바인딩) 부터 시작하면 되는데, 그 전에 Phase 2 의 approval 정책을 먼저 정해주셔야 합니다:
>
> - (a) Side-effect-free worker: 안전한 기본값
> - (b) Plan approval 캐스케이드: 편의성 우선
>
> 어느 쪽으로 가시겠어요? (a) 권장합니다.

답변을 받은 뒤 Phase 1 코딩 시작.
