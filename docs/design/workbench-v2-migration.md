# Workbench v2 Migration Design

상태: Draft
대상 파일: `apps/desktop/src/screens/workbench/**`
디자인 소스: Claude handoff bundle `1QU_pf_etdHBh6luPxfgrw` ("Workbench v2")
선행 작업: 디자인 토큰 적용 완료 (`apps/desktop/src/app/global.css`), 상태바 테마 토글 완료

핵심 제약: **기능 회귀 없음.** 레이아웃 재구성은 셸 수준에서 일어나고, 기존 도메인 컴포넌트(`ApprovalPanel`, `PlanArtifactView`, `OrchestrationPanel`, `QualityPanel`, `CapabilityPanel` 등)는 props 시그니처 보존을 우선으로 한다.

---

## 1. 현재 아키텍처 분석

### 1.1 컴포넌트 트리 (v1)

```
WorkbenchShell (584줄, 모든 상태/IPC/effect 보유)
├── ThreadSidebar              [grid-area: sidebar | 180-400px 가변]
│   └── (인라인 스레드 생성 폼, 스레드 리스트, 삭제 버튼, Agents 네비)
├── (분기: viewMode === "agents")
│   ├── AgentsPanel            [캔버스+우측 패널 자리 전체를 takeover]
│   └── (else 분기 ─ 기본 작업 화면)
│       ├── ConversationWorkbench [grid-area: workbench | 1fr]
│       │   ├── ChatHeader (thread.title + targetDir)
│       │   ├── ChatTranscript (taskRuns 정렬·자동 스크롤·삭제)
│       │   └── ConversationInput
│       │       ├── 대상 폴더 오버라이드
│       │       ├── Plan mode (Template / Agent) 라디오
│       │       ├── Orchestration 사전 폼 (mode + instruction)
│       │       └── textarea + 전송
│       └── RightPanel         [grid-area: rightpanel | 280-600px 가변]
│           ├── TaskRunStateActions (pinned header: pause/resume/retry/cancel)
│           └── 7-탭 네비
│               ├── plan        → PlanArtifactView + ApprovalPanel
│               ├── agent       → AgentPanel (스트리밍 뷰 포함)
│               ├── timeline    → TaskRunTimeline
│               ├── artifacts   → ArtifactPanel (kind !== "plan")
│               ├── quality     → QualityPanel
│               ├── capabilities → CapabilityPanel + LearnerPanel
│               └── orchestration → OrchestrationPanel
├── RuntimeStatusBar           [grid-area: statusbar | 28px]
│   ├── 런타임 상태 점
│   ├── 버전 / 플랫폼 / appDataDir
│   ├── AgentProviderStatus (claude/codex available 표시)
│   ├── theme toggle
│   └── settings ⚙
└── SettingsPanel (조건부 오버레이 모달)
```

### 1.2 책임 매트릭스

| 컴포넌트 | 책임 |
|---|---|
| `WorkbenchShell` | 단일 진실 — `threadsState`, `selectedThreadId`, `detailState`, `selectedTaskRunId`, `taskRunDetail`, `providers`, `autoApprove`, `theme`, `sidebarWidth`, `rightPanelWidth`, `dragging`, `viewMode`, `settingsOpen` 보유. 모든 IPC 호출, `onTaskRunChanged`/`onAgentStreamEvent` 구독, auto-approve 루프, 모든 핸들러 함수 정의 |
| `ThreadSidebar` | 스레드 리스트 표시 + 인라인 create form + 삭제 confirm. Agents 네비 버튼 노출 |
| `ConversationWorkbench` | 스레드 상세 헤더, 트랜스크립트 렌더링, 자동 스크롤, 입력 폼 호스팅 |
| `ConversationInput` | mode 선택, orchestration 사전 폼, 대상 폴더 override, settings 사전 로드 (`orchestration.enabled`) |
| `RightPanel` | pinned `TaskRunStateActions` + 7-탭 네비게이션, taskRunDetail 분배 |
| `AgentsPanel` | 전체 takeover 폼 (orchestration 활성화/모드/워커 프로필) |
| `OrchestrationPanel` | 사후 plan 초안/실행 (per-TaskRun) |
| `SettingsPanel` | 모달 오버레이 — 에이전트/오케스트레이션/auto-approve 설정 |
| `RuntimeStatusBar` | 런타임 메타, provider, theme, settings 게이트웨이 |

### 1.3 상태 흐름

- **트리거**: 사용자 액션 (스레드 선택, 입력 전송, 승인 등) → `WorkbenchShell` 핸들러 → `window.harness.*.method()` IPC → 응답 후 `refreshThreadDetail` / `refreshTaskRunDetail` / `refreshThreads` 중 필요한 것만 호출 → 상태 업데이트 → 자식 리렌더.
- **푸시**: main → renderer 푸시 (`onTaskRunChanged`) → 활성 taskRun이 일치하면 refetch, 활성 thread도 refetch (사이드바 status pill 갱신용).
- **자동승인 루프** (`useEffect` 라인 266–309):
  1. `autoApprove === true` 이고
  2. `taskRunDetail.kind === "ready"` 이며
  3. `approvals` 중 `status === "pending"` 이고 `autoInFlightRef`에 없는 것들을 골라
  4. 순차적으로 `approve` → 분기: `orchestration_plan` 이면 `orchestration.runApproved`, 아니면 `runner.executeApproved`
  5. 완료 후 detail refetch
  - `autoInFlightRef`(Set)는 같은 approval이 `taskRunChanged` 이벤트로 인해 두 번 처리되는 것을 방지

### 1.4 IPC / 이벤트 구독 매트릭스

| 컴포넌트 | 호출 IPC | 이벤트 구독 |
|---|---|---|
| WorkbenchShell | `state.listThreads/getThread/createThread/deleteThread`, `conversation.getTaskRunDetail/createTask/deleteTask/approve/rejectApproval/redirectTask/setProposedAction`, `runner.executeApproved`, `agent.checkProviders/generatePlan/retryInvocation/cancelInvocation/useTemplateFallback`, `orchestration.runApproved/draftPlan`, `settings.get` | `events.onAgentStreamEvent` (provider refresh 트리거), `events.onTaskRunChanged` |
| ConversationInput | `settings.get` (orch defaults), `app.selectDirectory` | — |
| ThreadSidebar | `app.selectDirectory` | — |
| AgentsPanel / SettingsPanel | `settings.get/update` | — |
| OrchestrationPanel | `settings.get`, `orchestration.getPlan/draftPlan/runApproved` | — |
| RuntimeStatusBar | `app.getRuntimeInfo` | — |
| AgentProviderStatus | `agent.checkProviders` | `events.onAgentStreamEvent` |
| AgentStreamView | — | `events.onAgentStreamEvent` |
| TaskRunStateActions | `conversation.pauseTask/resumeTask/cancelTask`, `runner.retryApproval` | — |
| Quality/Capability/Learner/Artifact 패널들 | 각자 도메인 IPC | — |

핵심 인사이트: **이벤트 구독은 셸 + 3개 leaf 컴포넌트에만 있다**. v2에서도 이 분포를 유지한다(셸 레벨 fan-out + 자체 스트림이 필요한 leaf만 자체 구독).

### 1.5 localStorage 키 (v1)

- `workbench-theme` ("dark" | "light")
- `workbench-sidebar-width` (number, 180–400)
- `workbench-right-width` (number, 280–600)

---

## 2. v2 타깃 아키텍처

### 2.1 컴포넌트 트리 (v2)

```
WorkbenchShell (셸 유지 — 상태/IPC/effect 모두 보존)
├── SlimRail                         [고정 64px, 좌측]
│   ├── BrandMark (HarnessAgentOS 로고)
│   ├── ThreadsRailButton (count badge + 클릭 시 ThreadDrawer 토글)
│   ├── AgentsRailButton (현재 viewMode === "agents" indicator)
│   ├── (spacer)
│   ├── ProviderStatusDot (AgentProviderStatus 컴팩트 버전)
│   ├── ThemeToggleButton
│   ├── SettingsRailButton
│   └── NewThreadFAB (하단 + 버튼 → ThreadDrawer 열고 인라인 폼 활성)
├── ThreadDrawer                     [슬라이드-인 좌측, rail 옆 | 280-400px | 토글식]
│   └── (현재 ThreadSidebar의 list + create form 재사용 — 헤더/네비 제거)
├── MainStage                        [중앙 가변 | rail+drawer 옆 | composer 위 여백]
│   ├── (분기: viewMode === "agents")
│   │   ├── AgentsPanel                  [기존 — 단, 헤더/back 버튼은 SlimRail 토글로 대체]
│   │   └── (else 분기 ─ 기본 워크벤치)
│   │       ├── ChatHeader (thread.title + targetDir + ContextDrawer 토글 버튼)
│   │       ├── ChatTranscript           [가운데 정렬, max-width 760px]
│   │       │   ├── HeroEmpty            (taskRuns.length === 0 일 때)
│   │       │   │   ├── h1 + 설명
│   │       │   │   └── SuggestionChips  (예: "이 코드를 리팩토링", "테스트 추가", ...)
│   │       │   └── ChatTurn[]           (inline approval card 포함 가능 — §2.4)
│   │       └── (transcript 하단 여백 = composer 높이 + 16px)
│   └── FloatingComposer             [캔버스 하단 floating, transcript 위에 떠 있음]
│       └── ConversationInput (시각 스타일만 floating으로 변경)
├── ContextDrawer                    [슬라이드-인 우측 | 360-600px | 토글식]
│   ├── DrawerHeader (selected TaskRun ID + 닫기)
│   ├── ContextDrawerPinned (TaskRunStateActions)
│   └── ContextDrawerTabs (vertical or scrollable horizontal — §2.6 결정)
│       ├── plan / agent / timeline / artifacts / quality / capabilities / orchestration
│       └── (각 탭 본문 = v1 동일 컴포넌트 그대로)
├── RuntimeStatusBar                 [유지 | 그리드 하단 28px]
└── SettingsPanel                    [유지 | 조건부 모달 오버레이]
```

### 2.2 새 컴포넌트 명세

#### `SlimRail` (신규)
- **props**: `{ threadCount: number; agentsActive: boolean; theme: "dark"|"light"; onToggleTheme(); onOpenSettings(); onToggleThreadDrawer(); onToggleAgents(); onNewThread(); providerStatus: AgentProviderStatusMap | null; }`
- **상태**: 없음 (stateless)
- **접근성**: 각 버튼에 `aria-label`, 활성 버튼 `aria-pressed`. 키보드 포커스 순서: brand → threads → agents → provider → theme → settings → new.

#### `ThreadDrawer` (신규 셸 — 본문은 v1 ThreadSidebar의 body 재사용)
- **props**: `{ open: boolean; state: ThreadsState; selectedThreadId; onSelectThread; onCreateThread; onDeleteThread; onRetry; onRequestClose(); }`
- **동작**: `open === false` 일 때 `transform: translateX(-100%)` (애니메이션은 Phase 3). 외부 클릭/Esc로 닫힘. 현재 `ThreadSidebar`의 header(`Threads` + `+새 작업`)와 sidebar-nav(Agents 버튼)는 제거 — SlimRail이 그 역할.
- **재사용**: 인라인 create form, list, delete 로직은 그대로 가져온다. props 시그니처는 동일.

#### `FloatingComposer` (신규 셸 — 본문은 v1 ConversationInput 재사용)
- **props**: 기존 `ConversationInputProps`와 동일
- **시각 스타일**: position absolute (transcript 컨테이너 기준 bottom: 16px), 좌우 max-width 760px 중앙 정렬, drop shadow, rounded.
- **주의**: `ChatTranscript` 스크롤 컨테이너의 `padding-bottom`을 composer 실제 높이(=ResizeObserver로 측정 또는 고정값) + 16px만큼 확보해야 마지막 메시지가 가려지지 않는다. 자동 스크롤 effect는 그대로 보존.

#### `ContextDrawer` (신규 셸 — 본문은 v1 RightPanel 내부 재사용)
- **props**: `{ open: boolean; tab: RightPanelTab; onTabChange; onRequestClose; ...(v1 RightPanelProps 전체) }`
- **본문**: TaskRunStateActions(pinned) + 탭 본문은 v1 그대로. **탭 네비게이션 형태는 vertical sidebar 탭 채택** — 7개 탭을 좁은 드로어에 horizontal로 욱여넣으면 깨진다. 좌측 narrow tab strip(아이콘 + 라벨, 56px) + 우측 본문 구조.
- **상태**: `selectedTaskRunId === null` 일 때 빈 상태 표시(현재와 동일). drawer가 닫혀도 활성 TaskRun이 있으면 ChatHeader에 "Approval N pending" 같은 배지로 환기.

#### `HeroEmpty` (신규)
- **props**: `{ onSuggest(text: string): void; }`
- **렌더**: 스레드를 막 만들었지만 taskRuns가 0개일 때 transcript 자리에 표시. v1의 `conversation-workbench__greeting` 패턴을 확장 — h1 + 1-2줄 설명 + 3-5개의 `SuggestionChip` (각 chip을 클릭하면 composer textarea를 해당 텍스트로 채움).
- 스레드가 0개일 때(`threadsState.threads.length === 0`)는 별도 HeroEmpty — MainStage 중앙에 "스레드를 만들어 시작하세요" + ThreadDrawer 열기 버튼.

#### `SuggestionChip` (신규, 작은 보조 컴포넌트)
- props: `{ label: string; onPick: () => void; }` — 단순 버튼.

#### `InlineApprovalCard` (옵션, Phase 2/3)
- **목적**: 활성 TaskRun의 pending approval이 있을 때 transcript의 agent bubble 하단에 인라인으로 카드 노출 (드로어를 열지 않아도 즉시 승인 가능).
- **props**: 단일 `Approval` + 핸들러 4개 (`onApprove/onReject/onRedirect/onExecute`). 본문은 `ApprovalPanel`의 단일-아이템 렌더링 부분을 추출하거나 wrapper로 한 항목만 노출.
- **데이터 일관성**: ContextDrawer의 Approvals 섹션과 *동일 상태*를 공유 — 양쪽 모두 `taskRunDetail.detail.approvals`에서 파생.

### 2.3 기존 컴포넌트 분류

| 컴포넌트 | 분류 | 비고 |
|---|---|---|
| WorkbenchShell | **리팩토링** | 그리드 템플릿/드로어 토글 상태 추가. 핸들러·effect·IPC 로직은 보존 |
| ThreadSidebar | **리팩토링** → `ThreadDrawer` 내부 | header / sidebar-nav 제거, body 재사용 |
| ConversationWorkbench | **리팩토링** | greeting을 `HeroEmpty`로 교체, ChatHeader에 ContextDrawer 토글 추가 |
| ConversationInput | **재사용** | 시각 스타일만 floating으로 — 로직 변경 없음 |
| RightPanel | **리팩토링** → `ContextDrawer` 내부 | tab strip을 horizontal에서 vertical로, 드로어 셸로 감쌈 |
| RuntimeStatusBar | **재사용** | 단, theme toggle / settings 버튼은 SlimRail에도 동일 동작으로 노출 → **둘 중 하나는 제거** 검토 (Open Q #4) |
| AgentProviderStatus | **재사용** (status bar) + **컴팩트 변형** (rail dot) |
| AgentsPanel | **재사용** | back 버튼은 SlimRail의 Agents 토글이 대체 → AgentsPanel 내부 back 버튼 제거 또는 onClose만 호출 |
| OrchestrationPanel | **재사용** | ContextDrawer의 orchestration 탭 본문 |
| SettingsPanel | **재사용** | 오버레이 모달 그대로 |
| 모든 도메인 패널 (Approval/Plan/Timeline/Artifact/Quality/Capability/Learner/AgentPanel) | **재사용** | props 시그니처 보존 |
| 폐기 후보 | — | `workbench-resizer` (양쪽 column resizer) — 드로어는 width fixed 또는 별도 drawer resizer로 대체 (Open Q #3) |

### 2.4 새 UI 상태

| 상태 | 위치 | 초기값 | 영속 |
|---|---|---|---|
| `threadDrawerOpen` | WorkbenchShell | localStorage 복원, 기본 `true` (데스크톱 가시성 우선) | localStorage `workbench-thread-drawer-open` |
| `contextDrawerOpen` | WorkbenchShell | localStorage 복원, 기본 `selectedTaskRunId !== null` ? true : false | localStorage `workbench-context-drawer-open` |
| `contextDrawerTab` | WorkbenchShell (또는 ContextDrawer 내부) | "plan" | localStorage `workbench-context-drawer-tab` |
| `threadDrawerWidth` (옵션, Phase 4) | WorkbenchShell | 320 | localStorage `workbench-thread-drawer-width` |
| `contextDrawerWidth` (옵션, Phase 4) | WorkbenchShell | 400 | localStorage `workbench-context-drawer-width` |
| `viewMode` | (유지) | "workbench" | (현재와 동일, 미저장) |
| `autoInFlightRef` (Ref) | (유지 그대로) | Set | — |

설계 결정: **탭 활성 상태는 WorkbenchShell이 보유** — selectedTaskRun이 바뀌어도 사용자가 직전에 보던 탭을 유지하기 위함.

### 2.5 ContextDrawer 탭 네비게이션 결정

좁은 드로어에 7개 horizontal 탭은 깨진다. 결정:

1. **레이아웃**: `ContextDrawer` 내부를 좌(56px tab rail) / 우(가변 본문)로 분할.
2. **탭 표현**: 각 탭 = 아이콘 + 1-2단어 라벨 (Plan/Agent/Time/File/QA/Cap/Orch). `aria-orientation="vertical"`.
3. **Pinned 액션**: `TaskRunStateActions`는 드로어 헤더 바로 아래에 sticky로 유지 (탭 전환과 무관하게 항상 보임).
4. **모바일/좁은 폭 대비**: 드로어 폭이 360px 미만이면 본문 위에 horizontal scroll tab strip으로 fallback (Phase 3 enhancement).
5. **탭 우선순위**: plan / agent / timeline 이 자주 쓰이므로 위쪽 3개에 배치, capabilities / orchestration은 하단.

### 2.6 SlimRail 64px 수용 가능성

64px 폭에 들어가는 것: brand · threads(badge) · agents · spacer · provider-dot · theme · settings · NewThread. 8개. 32px 아이콘 + 8px 패딩 → 세로로 충분히 수용. RuntimeStatusBar의 theme/settings 버튼은 rail로 이전하고, status bar는 메타 정보(런타임/버전/플랫폼/appDataDir)만 남기는 안을 권장 (중복 제거). Open Q #4 참조.

---

## 3. 기능 매핑 매트릭스 (필수 14개)

| # | 기능 | v1 위치 | v2 위치 | 마이그레이션 노트 |
|---|---|---|---|---|
| 1 | **스레드 CRUD (생성/선택/삭제)** | ThreadSidebar 헤더 `+ 새 작업` + 인라인 폼 + 리스트 + 삭제 × 버튼 | `ThreadDrawer` 내부 동일 폼/리스트. 생성 진입점은 (a) SlimRail 하단 `NewThreadFAB`(드로어 열고 폼 활성) (b) 드로어 헤더 `+` 버튼 — 둘 다 같은 핸들러 호출 | 드로어 닫혀 있을 때 `NewThreadFAB` 클릭 → `setThreadDrawerOpen(true)` + `creating=true`. `selectedThreadId` 변경 후에는 드로어를 그대로 둘지 자동 닫을지 — **유지** (선택 후 다른 스레드로 빠르게 전환 가능하도록). Open Q #5 |
| 2 | **TaskRun 생성/선택/삭제** | ConversationInput 전송 → handleCreateTask(WorkbenchShell). 선택은 ChatTurn 클릭. 삭제는 ChatTurn 내 × 버튼 | 동일 흐름. `FloatingComposer` 전송 → 동일 핸들러. 선택/삭제도 ChatTurn 그대로 | 자동 스크롤 effect 보존 필수. composer 높이 변화 시 scroll padding 재계산 |
| 3 | **Approval 승인/거부** | RightPanel의 plan 탭 내 `ApprovalPanel` | (a) `ContextDrawer` plan 탭에 동일 `ApprovalPanel` (b) 옵션: transcript agent bubble 하단 `InlineApprovalCard` (Phase 3) | 두 위치는 *동일 상태*를 본다 (`taskRunDetail.detail.approvals`). 인라인 카드 도입은 옵션 — Phase 1-2에서는 드로어만, Phase 3에서 추가 |
| 4 | **Approval 재지시(redirect)** | ApprovalPanel 내 redirect 액션 → `handleRedirect` | ContextDrawer plan 탭 내 동일 | 변경 없음 |
| 5 | **Approval 자동승인 + 자동실행** | `WorkbenchShell` useEffect(autoApprove + taskRunDetail 의존) + `autoInFlightRef` Set | **동일 위치(WorkbenchShell)에 그대로 보존** — 절대 다른 컴포넌트로 이동시키지 말 것 | 셸 remount 시 `autoInFlightRef` 초기화되어 race 발생 가능. v2에서도 셸은 한 번만 마운트되도록 보장. 분기(`orchestration_plan` vs default)는 그대로 유지 |
| 6 | **Orchestration 사전 폼 (전송 전, ConversationInput)** | ConversationInput 내 토글 → mode select + instruction input | `FloatingComposer` 내 동일 — 단, floating 공간 제약으로 토글 열면 composer 높이 증가(transcript padding 재계산 필요) | 사후 OrchestrationPanel과 **별개** 기능. 폐기하지 말 것 |
| 7 | **Orchestration 패널 (사후, per-TaskRun)** | RightPanel orchestration 탭 → `OrchestrationPanel` | ContextDrawer orchestration 탭에 동일 컴포넌트 | 변경 없음. `runApproved` 호출 후 `onRefreshTaskRun`도 그대로 |
| 8 | **Agent provider 상태** | RuntimeStatusBar의 `AgentProviderStatus` | SlimRail의 `ProviderStatusDot` (컴팩트, 마우스오버 시 자세히) + status bar에는 유지 또는 제거 (Open Q #4) | `agentAvailable` 계산은 `WorkbenchShell` 그대로. `onAgentStreamEvent` 구독은 셸 + leaf 컴포넌트에서만 |
| 9 | **Settings 패널** | RuntimeStatusBar 우측 ⚙ → SettingsPanel 모달 | SlimRail 하단 ⚙ → 동일 SettingsPanel 모달 | onClose 후 `refreshAutoApprove` 호출 보존 |
| 10 | **Agents 패널 (viewMode === "agents")** | ThreadSidebar 하단 `⚙ Agents` 버튼 → 캔버스+우측 전체 takeover | SlimRail Agents 버튼 → MainStage 전체 takeover (drawer는 그대로 노출) | takeover 유지(option a). AgentsPanel의 `onClose`로 back, header back 버튼은 제거(rail 토글이 역할 대체) |
| 11 | **사이드바/우측 패널 리사이저** | column resizer 2개 (sidebar-width, right-width) | v2는 드로어 모델. 결정: (a) 드로어는 고정 폭 (b) 각 드로어의 inner edge에 resizer | **Phase 1: 고정 폭** (단순) → Phase 4에서 drawer 옆 edge resizer 추가. localStorage 키 마이그레이션은 §4 |
| 12 | **Runtime 상태바** | grid statusbar 영역 | 그대로 유지. 단, theme/settings 버튼은 rail로 이관 (중복 제거) | provider status만 rail로 이전한 후 상태바엔 메타만 남김 |
| 13 | **테마 토글** | RuntimeStatusBar 우측 ☀/☾ | SlimRail로 이관. 핸들러/상태는 WorkbenchShell 그대로 (`workbench-theme` localStorage 키 유지) | 변경 없음 (위치만 이동) |
| 14 | **히어로 빈 상태** | ConversationWorkbench의 `idle` 상태 = "스레드 미선택" 그리팅 | (a) 스레드 0개 → MainStage 중앙 HeroEmpty "스레드를 만들어 시작" + `NewThread` CTA (b) 스레드 선택했지만 taskRuns 0개 → transcript 자리에 HeroEmpty + SuggestionChips | chip 클릭 → composer textarea에 텍스트 주입. 클릭만으로 자동 전송하지는 않음 (사용자 확인 여지) |

---

## 4. 상태 관리 변경사항

### 4.1 새로 추가

| 키 | 타입 | 초기값 | localStorage 키 |
|---|---|---|---|
| `threadDrawerOpen` | boolean | true | `workbench-thread-drawer-open` |
| `contextDrawerOpen` | boolean | false (단, selectedTaskRun 있으면 true) | `workbench-context-drawer-open` |
| `contextDrawerTab` | RightPanelTab | "plan" | `workbench-context-drawer-tab` |
| `threadDrawerWidth` (옵션, Phase 4) | number | 320 | `workbench-thread-drawer-width` |
| `contextDrawerWidth` (옵션, Phase 4) | number | 400 | `workbench-context-drawer-width` |

### 4.2 변경/제거

| v1 키 | v2 처리 |
|---|---|
| `workbench-sidebar-width` | **drop on next read** — v1 키가 있으면 무시하고 `threadDrawerWidth` 기본값 사용. 굳이 마이그레이트하지 않음(시각 모델이 다름) |
| `workbench-right-width` | **drop** — 동일 |
| `workbench-theme` | **유지** (의미·도메인 동일) |

### 4.3 상태 위치 결정 원칙

- **셸이 보유**: 도메인 상태(threads/detail/taskRunDetail/providers/autoApprove), 핸들러, 모든 IPC 호출, 자동승인 effect.
- **셸이 보유 (신규)**: 드로어 open/tab/width — 자식 컴포넌트가 다 같은 정보를 필요로 하므로(예: ChatHeader 토글 버튼이 contextDrawerOpen을 알아야 함) 셸에 둔다.
- **자식이 보유**: 자체 폼 상태(SettingsPanel draft, ConversationInput 입력 텍스트, ApprovalPanel 다이얼로그 상태 등) — 변경 없음.

---

## 5. 마이그레이션 페이즈 계획

원칙: **각 Phase 종료 시 빌드 통과 + 기능 회귀 없음**. Phase 1은 "skeleton만"이 아니라 "v2 셸 + v1 본문 어댑터" — 항상 동작.

### Phase 1: v2 셸 구조 도입 (UI shift, behavior preserved)
- 추가: `SlimRail`, `ThreadDrawer`(셸), `FloatingComposer`(셸), `ContextDrawer`(셸), `HeroEmpty`, `SuggestionChip`
- WorkbenchShell의 grid template을 `64px [drawer] 1fr [drawer]` 로 교체
- v1 `ThreadSidebar` 본문은 `ThreadDrawer` 안으로 이동 (props 그대로 forward)
- v1 `RightPanel` 본문은 `ContextDrawer` 안으로 이동
- v1 `ConversationInput`은 `FloatingComposer` 안으로 이동 (스타일만 floating)
- 드로어 toggle 상태 추가 + localStorage 영속
- 새 키 사용 / 옛 width 키 무시
- **검증**: 모든 13개 기능 수동 회귀 (체크리스트 §6.2)

### Phase 2: 본문 정합성 / 어댑터 정리
- `RightPanel` → `ContextDrawer` 탭을 horizontal에서 vertical tab strip으로 변경 (`right-panel__tabs` CSS 분기)
- `TaskRunStateActions`를 드로어 헤더 sticky로 재배치
- `ConversationWorkbench` greeting → `HeroEmpty` + SuggestionChips
- ChatHeader에 ContextDrawer 토글 버튼 추가 + pending approval 배지
- RuntimeStatusBar에서 theme/settings 버튼 제거 (rail로 이전됨)
- ThreadSidebar 내부 `sidebar-nav` 제거 (rail로 이전됨)
- AgentsPanel 내부 back 버튼 → rail 토글이 대체, onClose는 유지
- **검증**: 자동 스크롤, autoApprove 루프, 사전/사후 orchestration 모두 동작

### Phase 3: 슬라이드 애니메이션 + 인라인 카드
- ThreadDrawer/ContextDrawer translateX 트랜지션 (200ms ease-out)
- 드로어 닫힘 시 transcript max-width 760px 중앙 정렬 유지
- 외부 클릭 / Esc로 닫힘 (focus trap 검토)
- `InlineApprovalCard` 추가 (transcript 내 활성 turn의 pending approval 표시)
- 키보드 단축키 (Cmd/Ctrl+B, Cmd/Ctrl+J, Esc)
- **검증**: 애니메이션 중 스크롤 정합성, 빈 상태 ↔ 입력 상태 전환

### Phase 4: 잔재 제거 + 폴리시
- v1 `.workbench-resizer` CSS / 핸들러 제거
- v1 `workbench-sidebar-width`/`workbench-right-width` localStorage 키는 마이그레이션 코드에서 자동 정리 (한 번 읽어서 제거)
- 옵션: 드로어 inner edge resizer 도입
- AgentProviderStatus 컴팩트 변형(`ProviderStatusDot`) 마무리
- 접근성 패스: aria-* 보강, 포커스 순서, role/tablist 정합
- **검증**: 전체 E2E

---

## 6. 리스크와 회귀 방지

### 6.1 고위험 영역

| 리스크 | 원인 | 완화 |
|---|---|---|
| **autoApprove 루프 회귀** | `autoInFlightRef`는 셸 컴포넌트 인스턴스에 묶임. 셸이 remount되면 처리 중인 approval ID 정보 소실 → 같은 approval에 두 번 `approve`+`execute` | Phase 1에서 셸을 *리팩토링만* (재마운트 유발 변경 금지). 그리드 변경은 셸 내부 jsx 변경이므로 안전. 정상 동작 검증: autoApprove ON 상태에서 빠른 연속 task 3개 생성 후 각 approval이 정확히 한 번씩만 실행되는지 |
| **사전/사후 orchestration 혼동** | 둘 다 "orchestration" 단어 + 동일 mode select → 통합 충동 발생 | `ConversationInput`(전송 *전*에 plan 사전 작성용 옵션)과 `OrchestrationPanel`(전송 *후*에 plan 초안/실행)은 별개 기능. 분리 유지 |
| **AgentsPanel takeover 위치** | rail + drawer가 도입되면 takeover 범위가 모호 | 결정: takeover는 *MainStage*만 — rail/drawers/status bar는 그대로 노출. AgentsPanel의 onClose는 `setViewMode("workbench")`만 (back 버튼 제거) |
| **ChatTranscript 자동 스크롤 깨짐** | FloatingComposer가 transcript 위에 떠 있으면 마지막 메시지가 가려짐 | transcript scroll container의 `padding-bottom`을 composer 높이만큼 동적으로 설정 (`ResizeObserver`). 자동 스크롤 effect는 그대로 유지하되 `scrollTop = scrollHeight` 호출은 padding 변화 *이후*에 일어나도록 보장 (effect 의존성에 composer 높이 추가 검토) |
| **agentAvailable 모드 자동 강등** | ConversationInput 라인 61–63: 렌더 중 `setMode("template")` 호출 (anti-pattern이지만 동작 중) | 코드 손대지 말 것 — v2에서도 동일 동작. (개선은 별도 PR) |
| **이벤트 구독 중복** | 셸과 leaf가 모두 `onAgentStreamEvent` 구독 — v2에서 rail에 추가 구독 컴포넌트 생기면 중복 fan-out | `ProviderStatusDot`은 `AgentProviderStatus`를 그대로 재사용(기존 구독). 새 구독 신설 금지 |
| **드로어 닫힘 시 긴급 approval 못 봄** | 사용자가 드로어를 닫아둔 채 long-running task 진행 → pending approval 발생 | ChatHeader에 "Approvals: N pending" 배지 + 클릭 시 ContextDrawer 자동 open. Phase 3: 토스트 알림(옵션) |
| **localStorage 키 충돌** | v1 키 잔존 + v2 키 신설 | Phase 4 정리. Phase 1-3 동안은 키 읽기 시 `||` 폴백, 쓰기는 새 키로만 |

### 6.2 회귀 체크리스트 (Phase 종료 시마다)

- [ ] 스레드 생성 (rail + drawer 두 진입점 모두)
- [ ] 스레드 선택 / 삭제 confirm
- [ ] TaskRun 생성: template 모드 / agent 모드 / autoApprove ON+OFF
- [ ] Orchestration 사전 폼: enabled=false에서 hidden, enabled=true에서 전송 시 draftPlan 호출
- [ ] Approval approve/reject/redirect/configure/execute 각 1회
- [ ] autoApprove ON: pending → approved+executed (각 approval 한 번씩만)
- [ ] orchestration_plan approval은 `runApproved`로, 다른 actionType은 `executeApproved`로 분기
- [ ] OrchestrationPanel (사후): draftPlan + runApproved
- [ ] AgentsPanel takeover open/close + Settings 저장
- [ ] Theme toggle 다크↔라이트
- [ ] RuntimeStatusBar 정보 표시
- [ ] AgentProviderStatus rail/statusbar 갱신 (stream event 후)
- [ ] ChatTranscript 자동 스크롤: 새 메시지 시 / TaskRun 전환 시
- [ ] FloatingComposer 위로 마지막 메시지 안 가려짐
- [ ] taskRunChanged 이벤트로 sidebar+drawer 자동 갱신
- [ ] Settings → autoApprove 토글 → 모달 닫힘 후 즉시 반영

---

## 7. 빈 상태 / 키보드 단축키 / 접근성

### 7.1 빈 상태

| 상황 | 표시 |
|---|---|
| 스레드 0개 | MainStage 중앙 `HeroEmpty`: "HarnessAgentOS — 스레드를 만들어 시작하세요" + 큰 "+새 스레드" 버튼 (ThreadDrawer 열고 인라인 폼 활성) |
| 스레드 선택 됐지만 taskRuns 0개 | transcript 자리 `HeroEmpty`: "무엇을 해볼까요?" + 3-5 `SuggestionChip` ("이 폴더 리팩토링", "테스트 추가", "버그 분석", "문서 보강", "의존성 업그레이드 검토"). chip 클릭 → composer textarea 채움(전송은 사용자 클릭) |
| 스레드 선택 안 함 (selectedThreadId === null) | MainStage 중앙: "왼쪽에서 스레드를 선택하세요" + (drawer 닫혀 있으면) "열기" 버튼 |
| TaskRun 선택 안 됨 + 드로어 열림 | 현재 `right-panel__placeholder`와 동일 "TaskRun 선택 시 표시" |

### 7.2 키보드 단축키

| 키 | 동작 |
|---|---|
| `Cmd/Ctrl + B` | ThreadDrawer 토글 |
| `Cmd/Ctrl + J` | ContextDrawer 토글 |
| `Esc` | 활성 모달/드로어/오버레이 닫기 (우선순위: SettingsPanel > AgentsPanel takeover 종료 > 가장 최근 토글된 drawer) |
| `Cmd/Ctrl + Enter` | composer 전송 (현재 Enter도 전송 — 충돌 검토: 유지 또는 변경) |
| `Cmd/Ctrl + N` | 새 스레드 (ThreadDrawer 열고 create form 활성) |
| `Cmd/Ctrl + ,` | SettingsPanel 열기 |

전체 단축키 확정 전 Open Q #6 참조.

### 7.3 접근성

- SlimRail: `<nav aria-label="App navigation">`, 각 버튼 `aria-label` + 활성 상태 `aria-pressed`
- ThreadDrawer: `<aside aria-label="Threads">` + `aria-hidden={!open}` (시각적으로 숨겨질 때 보조 트리에서 제거)
- ContextDrawer: `<aside aria-label="Context">` + 내부 tab strip은 `role="tablist" aria-orientation="vertical"`, 각 탭 `role="tab" aria-selected`, 본문 `role="tabpanel" aria-labelledby`
- 모달 (SettingsPanel): `role="dialog" aria-modal` (현재 구현 유지) + focus trap
- FloatingComposer: `<form>` 또는 `<div role="form" aria-label="Message composer">`
- HeroEmpty 내 SuggestionChip: `<button>` (네이티브). chip 그룹은 `<div role="group" aria-label="Suggestions">`
- 색상에 의존하지 않는 status 표시: 상태 점에 항상 텍스트 라벨 동반 (현재 RuntimeStatusBar 패턴 유지)

---

## 8. Open Questions

1. **인라인 approval 카드의 우선순위**: Phase 3에 두는 것이 합리적인지, 아니면 Phase 1부터 도입할지? (드로어 닫힌 사용자 워크플로우를 얼마나 자주 쓰는지에 따라 다름)
2. **드로어 폭 영속 vs 고정**: Phase 1에서 고정 폭으로 가도 충분한가? 사용자가 어떤 폭을 선호하는지 미지수.
3. **드로어 resizer 위치**: v1처럼 두 column 사이가 아니라, 각 드로어의 inner edge(메인 스테이지 쪽 가장자리)에 하나씩. 또는 fixed-width로 시작.
4. **theme/settings 버튼 위치 단일화**: rail로 이전 후 status bar에서 제거할지, 둘 다 노출할지? (중복은 혼란을 일으킬 수 있지만, "찾기 쉬움" 측면에선 유리)
5. **스레드 선택 후 ThreadDrawer 자동 닫힘 여부**: 모바일은 닫힘이 자연스럽지만 데스크톱은 열림 유지가 빠른 전환에 유리. 기본값 결정 필요.
6. **Cmd/Ctrl+Enter vs Enter 전송 정책**: 현재 Enter=전송, Shift+Enter=줄바꿈. 일부 사용자는 줄바꿈 위주라 Cmd+Enter 선호. settings로 노출할지?
7. **AgentsPanel takeover 시 ContextDrawer 표시 정책**: takeover 동안 드로어를 강제로 닫을지, 사용자 선택을 유지할지?
8. **HeroEmpty의 suggestion chips 텍스트 결정**: 고정 문구 vs 최근 LearnerPanel/Capability 데이터 기반 동적 생성? Phase 1은 고정, Phase 후속에서 동적 검토.
9. **NewThreadFAB 디자인**: rail 하단 + 버튼인지, 별도 큰 floating FAB인지? 64px 폭 안에서 표현 가능한지 시각 검증 필요.
10. **`onAgentStreamEvent` 셸 구독 유지**: 현재 셸이 이 이벤트로 provider refresh를 트리거. rail에 ProviderStatusDot이 자체 구독하면 셸의 구독을 제거해도 되는지? — 다른 컴포넌트 의존성이 없다면 정리 가능.

---

## 부록 A: 파일 변경 영향 범위 (Phase 1 기준)

| 파일 | 변경 |
|---|---|
| `apps/desktop/src/screens/workbench/WorkbenchShell.tsx` | grid template 변경, 드로어 상태 신설, 새 자식 컴포넌트 마운트 |
| `apps/desktop/src/screens/workbench/workbench.css` | grid 변경, 드로어 클래스, floating composer 위치, hero empty 스타일 |
| `apps/desktop/src/screens/workbench/SlimRail.tsx` (신규) | — |
| `apps/desktop/src/screens/workbench/ThreadDrawer.tsx` (신규 셸) | ThreadSidebar body 호스팅 |
| `apps/desktop/src/screens/workbench/ContextDrawer.tsx` (신규 셸) | RightPanel body 호스팅 |
| `apps/desktop/src/screens/workbench/FloatingComposer.tsx` (신규 셸) | ConversationInput 호스팅 |
| `apps/desktop/src/screens/workbench/HeroEmpty.tsx` (신규) | suggestion chips 포함 |
| `apps/desktop/src/screens/workbench/ThreadSidebar.tsx` | header/sidebar-nav 제거 (Phase 2) |
| `apps/desktop/src/screens/workbench/RightPanel.tsx` | tabs vertical 전환 (Phase 2) |
| `apps/desktop/src/screens/workbench/ConversationWorkbench.tsx` | greeting → HeroEmpty 교체, ChatHeader에 drawer 토글 추가 (Phase 2) |
| `apps/desktop/src/screens/workbench/RuntimeStatusBar.tsx` | theme/settings 버튼 제거 (Phase 2) |
| `apps/desktop/src/screens/workbench/AgentsPanel.tsx` | back 버튼 제거 (Phase 2) |
| `apps/desktop/src/app/global.css` | (변경 없음 — 토큰 그대로 사용) |
