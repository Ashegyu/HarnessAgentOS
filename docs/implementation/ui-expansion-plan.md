# UI Expansion Plan

작성일: 2026-05-18
대상: Phase 1~3 안전 기능(budget gate · decision trace · cancellation cleanup)의 가치를 사용자에게 노출하고, 운영·진단·키보드 효율을 보강하는 UI 후속 작업

## 1. 배경

Phase 1~3은 정책 레이어를 강화했지만 그 가치를 사용자에게 보여주는 UI 자리가 부족하다. 구체적으로:

- **Budget gate**: Agent Profile form 안에만 노출 — 전사 / TaskRun 단위 가시성 없음.
- **Decision trace**: 개별 approval 카드 토글로만 보여짐 — 시간순 시퀀스, 사후 audit view 없음.
- **Cancellation**: TaskRun status enum에 `cancelled`가 있지만 사용자가 UI에서 무엇이 일어났는지 추적할 수 있는 timeline view 없음.

추가로 운영·디버깅 측면 공백:

- DB WAL 크기, runner queue depth, provider availability 같은 시스템 상태가 어디서도 보이지 않음.
- 자체 백업/export 수단 없음 — 로컬 전용 정책의 신뢰성과 충돌.
- 키보드 중심 사용자에게는 thread / tab 점프가 마우스 의존적.

이 문서는 11개 UI 후보를 3개 카테고리(우측 탭 / 설정 탭 / 일반)로 묶고, 각 후보의 수정 파일·데이터 소스·구현 범위·테스트·우선순위를 고정한다.

## 2. 목표

1. Phase 1~3의 가치를 즉시 가시화 (Cost · Decisions 탭).
2. 운영자 시점의 사후 감사·진단 view 추가 (Activity Log · System Diagnostics · Budget Overview).
3. 키보드 효율과 사용자 신뢰도 보강 (명령 팔레트 · 알림 트레이 · 백업).

## 3. 비목표

- 새로운 정책 enum이나 action type 추가하지 않는다.
- 외부 telemetry / cloud 백업 도입하지 않는다 (local-only 원칙 유지).
- 다국어(i18n) framework 도입하지 않는다 (현재는 한국어 기본 + 영어 코드/기술용어 혼재 정책 유지).
- 대규모 UI framework 재구성 (Mantine/MUI 도입 등) 하지 않는다.

## 4. 변경 원칙

- 모든 신규 IPC는 9-레이어 패턴 준수.
- **No polling**: renderer는 push 구독을 사용한다 (CLAUDE.md 제약). 시스템 상태 view(B3)도 main이 interval emit하는 push 채널을 통한다.
- read-only view 우선 — 쓰기 작업은 기존 approval flow를 거친다.
- 데이터는 가능한 기존 테이블(learning_traces, approvals, agent_invocations)을 재사용, 새 테이블은 필요할 때만.
- 신규 컴포넌트는 200~400 lines 이하, 800 lines 절대 초과 금지.
- 테스트 파일은 `.test.mjs` 규칙 준수.
- **localStorage 사용 정책**: SQLite WAL을 canonical state로 유지한다는 제약은 도메인 데이터(thread, taskRun, approval, learning_trace 등)에 적용된다. ephemeral UI preference(dismiss flag, expanded/collapsed 상태, last selected tab)는 localStorage 사용 허용.

## 4-A. 범위 결정 (사용자 확인 필요)

사용자 요청은 "전부 다" 11개 후보 설계서 작성이었다. 본 문서는 다음 두 항목을 우선순위 하단으로 분류하되 spec 자체는 모두 작성한다 — 사용자가 우선순위를 재조정할 수 있도록.

- **A3 Repair**: QA 탭 내 expandable 영역으로 통합 권장(우측 탭 부족 사유). 사용자가 독립 탭을 선호하면 §5 A3에 적힌 대안 옵션 채택.
- **A4 Logs**: Files / Time 탭 기존 정보와 중복 우려. 별도 독립 spec은 §5 A4 참고. 채택 시 추가 검색 UI 비용.

이 두 항목의 우선순위는 §8 표 하단으로 두었지만 모두 spec은 작성됐다.

## 5. 카테고리 A — 우측 탭 (TaskRun 단위)

현재 우측 탭은 9개 (Plan · Agent · Graph · Time · Files · QA · Caps · Inst · Orch). 신규 4개 후보를 추가/통합한다.

### A1. Cost 탭 (우선순위 1)

**요지**: 이 TaskRun이 지금까지 소비한 예상 USD · profile budget 대비 진행률 · 누적 latency · invocation별 분해.

**데이터 소스**
- `learning_traces` 테이블의 `cost_estimate_usd`, `latency_ms`, `selected_model`을 taskRunId로 집계.
- 기존 `learning-trace-repository.ts`의 `sumCostByTaskRun(taskRunId)` 재사용.
- `agent_invocations` 테이블의 succeeded/failed 카운트를 보조 지표로.
- Active Agent Profile의 `budget` JSON에서 한도 추출.

**수정 파일**
- `packages/core/src/api.ts` — `learner.summarizeTaskRunCost({ taskRunId }): Promise<TaskRunCostSummary>` 메서드 추가.
- `packages/storage/src/repositories/learning-trace-repository.ts` — `summarizeByTaskRun(taskRunId)` 신규 (cost · latency · invocation 카운트 · model breakdown 일괄 반환). 기존 `sumCostByTaskRun`은 호환 위해 유지하고 내부에서 새 메서드를 호출.
- `packages/core/src/types/learning-trace.ts` — `TaskRunCostSummary` 타입 정의 (`totalCostUsd: number; totalLatencyMs: number; invocationCount: number; perModel: Array<{ model: string; cost: number; count: number }>`).
- `packages/learner/src/learner-advisor.ts` — read-only summary 메서드.
- `apps/desktop/electron/ipc/learner-ipc.ts` — handler.
- `apps/desktop/electron/preload.ts` + `apps/desktop/src/types/window.d.ts` — expose.
- `apps/desktop/src/screens/workbench/CostPanel.tsx` (신규) — 컴포넌트.
- `apps/desktop/src/screens/workbench/RightPanel.tsx` — 탭 추가, 11번째.
- `apps/desktop/src/screens/workbench/workbench.css` — 진행률 바 스타일.

**구현 범위**
- 상단 요약 카드: 누적 USD, 누적 latency, invocation 수.
- 중단: profile budget 대비 진행률 바 (per-invocation / per-task-run / per-day 각각).
- 하단: invocation별 표 (model · cost · latency · success · timestamp).

**테스트**
- `learning-trace-repository.summarizeByTaskRun`: 여러 trace를 모았을 때 cost/latency 합산 정확.
- `CostPanel` 단위 테스트: budget 미정의 시 진행률 바 숨김. 한도 초과 시 빨간 표시.

**추정**: Small-Medium (1.5일)

### A2. Decisions 탭 (우선순위 2)

**요지**: 이 TaskRun에서 일어난 모든 자동 승인 결정 trace를 시간순 시퀀스로. 각 항목은 결정 단계(`blocked_action` … `global_toggle`)와 사유를 보여준다.

**데이터 소스**
- `approvals.auto_approve_decision_json` (Phase 2에서 추가).
- 같은 TaskRun의 approval row를 createdAt 순.

**수정 파일**
- `apps/desktop/src/screens/workbench/DecisionsPanel.tsx` (신규).
- `RightPanel.tsx` — 탭 추가 (12번째).
- 데이터는 기존 `conversation.getTaskRunDetail`의 approval 리스트에서 파생 — IPC 추가 없음.

**구현 범위**
- 각 결정을 timeline row로: 시간 · approved/blocked badge · decidedAt 단계 · reason · approval 카드로 가는 링크.
- Filter: 단계별 토글 (`blocked_action` 만 보기 등).

**테스트**
- 단위 테스트: 결정 trace가 비어있는 approval은 row를 만들지 않음 (수동 승인).
- 필터 동작 테스트.

**추정**: Small (1일)

### A3. Repair 탭 (우선순위 4 — 조건부 채택)

**요지**: RepairLoop의 attempt별 변화 (어떤 evidence가 어떻게 달라졌고 최종 quality 결과는 무엇인지).

**조건**: RepairLoop이 실제로 자주 동작하는 사용자에게만 가치. 현재는 quality_failed 후 자동 시도가 흔치 않다면 우측 9탭에 한 칸 더 잡을 가치 의문.

**데이터 소스**
- `quality_gate_results` 테이블의 attempt 번호 + status.
- 해당 attempt의 artifact diff.

**대안**: 별도 탭이 아닌 **QA 탭 안의 expandable 영역**으로 통합.

**추정**: Small (0.5-1일, QA 탭 통합 시) / Medium (1.5일, 독립 탭 시)

**권장**: QA 탭 통합으로 진행.

### A4. Logs 탭 (우선순위 11 — 채택 시 spec)

**요지**: 이 TaskRun에 도착한 push event(`events:taskRunChanged` · `events:agentStream` 등) + log artifact의 stdout/stderr를 단일 화면에 시간순으로 합치고 전역 검색 제공.

**알려진 중복 우려**: Files 탭이 이미 log artifact 개별 view를 보여주고, Time 탭이 step/checkpoint timeline을 보여줌. Logs 탭의 차별 가치는 *cross-artifact full-text grep* 과 *push event 시퀀스 가시화* 두 가지로 한정.

**데이터 소스**
- 기존 artifact 중 `kind === "log"`인 row의 본문.
- Renderer 측에서 받은 push event 버퍼 (in-memory ring buffer, 마지막 200개).

**수정 파일**
- `apps/desktop/src/screens/workbench/LogsPanel.tsx` (신규).
- `apps/desktop/src/screens/workbench/RightPanel.tsx` — 탭 추가 (12+번째). 11탭 이상이면 overflow menu 도입 검토 (§10 위험표).
- `apps/desktop/src/screens/workbench/event-buffer.ts` (신규) — push event ring buffer + subscribe hook.
- `apps/desktop/src/screens/workbench/event-buffer.test.mjs`.
- `apps/desktop/src/screens/workbench/workbench.css` — 검색 입력 / monospace 출력 스타일.

**구현 범위**
- 상단: 검색 input + 종류 toggle (log artifact / push event / both).
- 중단: 시간순 row list. 각 row는 timestamp · source(artifact id 또는 event channel) · 일행 미리보기 + expand.
- 검색은 client-side substring (대량 데이터는 page-level pagination, 가상 스크롤은 비목표).
- ring buffer 최대 200개; overflow 시 oldest drop + UI에 "older events dropped" notice.

**테스트**
- `event-buffer`: push 누적, overflow drop, subscribe handler 호출 정확.
- `LogsPanel`: 빈 상태, 검색 필터 적용, expand toggle.

**추정**: Medium (1.5-2일)

**채택 권장 여부**: 우선순위 표 가장 하단. 사용자가 push event 시퀀스 추적 / cross-artifact grep을 자주 필요로 한다고 판단할 때 채택. 그렇지 않으면 Files 탭에 검색 박스 1개 추가하는 더 작은 개선을 먼저 시도.

## 6. 카테고리 B — 설정 탭 (시스템 단위)

현재 설정 9탭. 신규 4개 후보를 추가한다.

### B1. Budget Overview 탭 (우선순위 1)

**요지**: profile별 / 일별 USD 사용량 추세 + 한도 대비 % + top consumer model.

**데이터 소스**
- `learning_traces` 전체 row를 profile / 일자로 집계 (기존 `sumCostByDay`는 단일 (profile, date) 합산만 제공; 시계열은 신규 메서드 필요).
- 모든 `agent_profiles.budget_json` 한도.

**수정 파일**
- `packages/core/src/api.ts` — `learner.summarizeBudgetUsage({ days?: number; profileId?: string }): Promise<BudgetUsageSummary>` 추가.
- `packages/storage/src/repositories/learning-trace-repository.ts` — `aggregateByProfileAndDay({ sinceIso, untilIso }): Promise<Array<{ profileId: string; dateIso: string; totalCostUsd: number; count: number }>>` 신규. 기존 `sumCostByDay` 재사용 가능한 SQL 구조 (GROUP BY agent_profile_id, DATE(created_at)).
- `packages/learner/src/learner-advisor.ts`.
- `apps/desktop/electron/ipc/learner-ipc.ts`.
- preload / window.d.ts.
- `apps/desktop/src/screens/workbench/BudgetOverviewTab.tsx` (신규).
- `SettingsPanel.tsx` — 탭 추가 (10번째), TABS array에 `{ id: "budget", label: "Budget" }`.
- `feature-help.ts` — 새 entry 추가 (`budget`).

**구현 범위**
- 상단: 오늘 누적 USD · 7일 평균 · 각 profile별 차트.
- 중단: profile-by-profile 표 (한도 / 오늘 사용 / 7일 사용).
- 하단: top consumer model 5개.

**차트 라이브러리**: 외부 의존성 추가하지 않고 SVG 직접 그리기 (app-flow-visualization.html과 동일 접근).

**테스트**
- `aggregateByProfileAndDay`: 빈 결과, 단일 row, 여러 profile 케이스.
- `BudgetOverviewTab` 단위 테스트: 빈 데이터 시 placeholder 렌더링.

**추정**: Medium (2일)

### B2. Activity Log 탭 (우선순위 2)

**요지**: 모든 approval 결정의 시간순 audit log. filter by decidedAt step · profile · time range.

**데이터 소스**
- `approvals` 전체 row의 `auto_approve_decision_json` + `decided_at`.
- pagination 필수 (수천 row 가능).

**Migration (확정)**
- `packages/storage/src/migrations.ts`에 다음 추가:
  ```sql
  CREATE INDEX IF NOT EXISTS idx_approvals_decided_at ON approvals(decided_at DESC);
  ```
- 대량 row scan 성능을 위해 필수. SCHEMA_VERSION 25 (현재 24, 별도 migration이 선행하지 않을 시).

**수정 파일**
- `packages/storage/src/schema.ts` — SCHEMA_VERSION 증가.
- `packages/storage/src/migrations.ts` — 위 인덱스 DDL 추가.
- `packages/core/src/api.ts` — `conversation.listDecisions({ limit, offset, filter? }): Promise<DecisionLogPage>`.
- `packages/storage/src/repositories/approval-repository.ts` — `listAllWithDecisionTrace({ limit, offset, decidedAtSteps?, actionTypes?, sinceIso?, untilIso? }): Promise<{ rows: ApprovalDecisionRow[]; total: number }>`.
- `packages/core/src/conversation/conversation-service.ts`.
- `apps/desktop/electron/ipc/conversation-ipc.ts`.
- preload / window.d.ts.
- `apps/desktop/src/screens/workbench/ActivityLogTab.tsx` (신규).
- `SettingsPanel.tsx` — 탭 추가 (11번째).
- `feature-help.ts` — 새 entry (`activityLog`).

**구현 범위**
- 표: 시간 · action_type · approved/blocked · decidedAt 단계 · reason · thread/taskRun으로 점프.
- Filter UI: 단계 multi-select, action_type multi-select, 일자 range.
- Pagination: 50 rows/page, prev/next.

**테스트**
- `listAllWithDecisionTrace` filter / pagination 정확성.
- 빈 결과 placeholder.

**추정**: Medium (2-2.5일)

### B3. System Diagnostics 탭 (우선순위 3)

**요지**: DB WAL 크기 · approval queue 상태 · agent provider availability · runner inflight 카운트 · child process count (가능 시).

**의존성**: 없음. Phase 3.5(commit `22c2d39`)에서 `RunnerService.inflight` Map이 추가되어 (runner-service.ts:66) 데이터 소스 준비 완료.

**데이터 소스**
- DB: `PRAGMA wal_checkpoint`, file size from fs.
- AgentInvocationQueue: `getDepth("claude")`, `getDepth("codex")` (agent-invocation-queue.ts:112).
- RunnerService: `inflight.size` (runner-service.ts:66).
- Provider probe: 기존 `provider-detection.ts` 재사용.

**Push 채널 (no polling)**
- Renderer polling 금지 규칙 준수. Main에서 push.
- 새 IPC event: `events:diagnosticsHeartbeat` — main이 10초 interval(`setInterval`)로 `getDiagnostics()` 결과를 emit. 추가로 다음 시점에 즉시 emit: TaskRun status 변화, agent invocation 시작/종료, runner cancelExecution 호출.
- `apps/desktop/electron/main.ts` (또는 동등 entry)에서 interval 등록 + app shutdown 시 cleanup.
- Renderer는 `window.harness.events.onDiagnosticsChanged(...)` 구독으로만 갱신. `useEffect`에서 setInterval 사용 금지.

**수정 파일**
- `packages/core/src/api.ts` — `app.getDiagnostics(): Promise<SystemDiagnostics>` (initial fetch용) + `events.onDiagnosticsChanged(handler)` 구독 API.
- `packages/core/src/ipc-channels.ts` — `events:diagnosticsHeartbeat` 채널 정의 + ipc-channels.test.mjs.
- `packages/core/src/types/diagnostics.ts` (신규) — `SystemDiagnostics` 타입.
- `packages/storage/src/services/local-state-service.ts` — DB size / WAL size 조회 메서드.
- `packages/agent/src/agent-planning-service.ts` — queue depth getter expose.
- `packages/runners/src/runner-service.ts` — `getInflightCount(): number` getter expose.
- `apps/desktop/electron/ipc/app-ipc.ts` — `getDiagnostics` handler + interval emitter 등록.
- `apps/desktop/electron/preload.ts` + `apps/desktop/src/types/window.d.ts`.
- `apps/desktop/src/screens/workbench/SystemDiagnosticsTab.tsx` (신규).
- `SettingsPanel.tsx` — 탭 추가.
- `feature-help.ts` + `docs/contracts/ipc-contracts.md`.

**구현 범위**
- 4-card 그리드: DB, Queue, Providers, Runner.
- 임계값: DB > 100MB warn, queue depth > 5 warn (각 임계값은 코드 상수로 시작; 추후 settings 노출 검토는 후속).
- 마지막 heartbeat 시각 footer 표시.

**테스트**
- `getDiagnostics`가 모든 필드를 반환하는지 (mock backends).
- 임계값 색상 전환 단위 테스트.
- Push 채널 round-trip: emit 시 renderer가 새 값으로 re-render되는지 ipc-channels.test.mjs로 contract 검증.
- App shutdown 시 interval cleanup 확인.

**추정**: Medium (2일, push 채널 비용 포함)

### B4. Backup / Export 탭 (우선순위 4)

**요지**: DB snapshot 저장 + thread→markdown export.

**문제**
- DB snapshot은 큰 파일 쓰기 — approval flow 통과 설계 필요.
- Snapshot 복원은 위험 — restore는 별도 phase로 미루고 export만 구현.

**수정 파일**
- `packages/core/src/api.ts` — `state.exportDbSnapshot({ targetPath })`, `state.exportThreadMarkdown({ threadId, targetPath })`.
- `packages/storage/src/services/local-state-service.ts` — VACUUM INTO 사용.
- IPC, preload, window.d.ts.
- `apps/desktop/src/screens/workbench/BackupExportTab.tsx` (신규).

**구현 범위**
- DB snapshot: `VACUUM INTO ?` (SQLite 표준). 사용자가 path 선택 → file_write approval 생성 → 승인 후 실행.
- Thread markdown: thread + taskRuns + approvals + artifact references를 단일 .md로 직렬화.

**테스트**
- `VACUUM INTO`가 임시 DB 생성하는지.
- Markdown serializer가 모든 thread를 빠짐없이 직렬화하는지.

**추정**: Medium (2일)

### B5. Keyboard Shortcuts 탭 (우선순위 5 — 명령 팔레트 후속)

**요지**: 단축키 일람.

**의존**: 명령 팔레트(C1)가 먼저 들어가야 단축키 자체가 존재. 그 다음에 일람 페이지.

**추정**: Small (0.5일, C1 머지 후)

## 7. 카테고리 C — 일반 (전역 UX)

### C1. 명령 팔레트 (Cmd/Ctrl+K) (우선순위 1)

**요지**: 모든 탭·thread·action을 단축키 1번으로 점프.

**수정 파일**
- `apps/desktop/src/screens/workbench/CommandPalette.tsx` (신규).
- `apps/desktop/src/screens/workbench/WorkbenchShell.tsx` — keydown listener, modal mount.
- `apps/desktop/src/screens/workbench/workbench.css` — overlay 스타일.
- 외부 라이브러리 추가 없음 — 자체 fuzzy filter (작은 함수).

**구현 범위**
- Cmd/Ctrl+K → 화면 중앙 overlay.
- Input + 결과 리스트 (max 8개).
- 결과 카테고리: Tabs · Threads · Settings · Recent TaskRuns.
- Enter로 이동, Esc로 닫기, ↑↓로 선택.

**Action 정의**
- 정적 list (탭 점프) + 동적 list (thread / taskRun, 최근 10개).

**테스트**
- Fuzzy filter 함수: 빈 query, exact match, partial match.
- Keyboard navigation: enter/esc/arrow keys.

**추정**: Medium (2일)

### C2. 글로벌 알림 트레이 (우선순위 2)

**요지**: 자동 승인 차단 · repair 실패 · budget 경고를 화면 우상단 배지로 누적. 클릭으로 상세 panel 펼침.

**수정 파일**
- `apps/desktop/src/screens/workbench/NotificationTray.tsx` (신규).
- `WorkbenchShell.tsx` — events subscribe 통합 지점.
- 데이터: 기존 `events:taskRunChanged` push에서 파생 (approval status 변화 감지).
- localStorage에 dismiss 상태 보관.

**구현 범위**
- 우상단 종 아이콘 + unread count badge.
- 클릭 시 dropdown: 최근 10개 알림 (time · type · message · 점프 링크).
- 알림 종류: `budget_blocked` · `repair_failed` · `quality_failed` · `taskrun_cancelled`.

**테스트**
- 알림 추가/dismiss 동작.
- localStorage persist 단위 테스트.

**추정**: Medium (1.5-2일)

## 8. 우선순위 종합

| # | Feature | 카테고리 | 추정 | 의존 |
|---|---------|---------|------|------|
| 1 | A1 Cost 탭 | 우측 | 1.5일 | — |
| 2 | B1 Budget Overview | 설정 | 2일 | — |
| 3 | A2 Decisions 탭 | 우측 | 1일 | — |
| 4 | B2 Activity Log | 설정 | 2-2.5일 | — |
| 5 | C1 명령 팔레트 | 일반 | 2일 | — |
| 6 | C2 알림 트레이 | 일반 | 1.5-2일 | — |
| 7 | B3 System Diagnostics | 설정 | 2일 | — (Phase 3.5는 22c2d39로 머지됨) |
| 8 | A3 Repair (QA 탭 통합) | 우측 | 0.5-1일 | — |
| 9 | B4 Backup / Export | 설정 | 2일 | — |
| 10 | B5 Keyboard Shortcuts | 설정 | 0.5일 | C1 머지 후 |
| 11 | A4 Logs (보류) | — | — | 재평가 필요 |

**총 추정**: 15.5~18.5일 (full 진행 시, B3 push 채널 비용 반영).

**최소 묶음 (Phase 1~3 가치 가시화 우선)**:
- A1 Cost + A2 Decisions + B1 Budget Overview + B2 Activity Log = 6.5~7일

## 9. 의존성 그래프

```
A1 (Cost 탭) ──┐
A2 (Decisions) ─┼─ 독립 (병렬 가능)
B1 (Budget Overview) ──┘

B3 (Diagnostics) ── 독립 (Phase 3.5 머지됨)
B2 (Activity Log) ── 독립 (인덱스 migration 포함)
B4 (Backup) ── 독립
C1 (Cmd Palette) → B5 (Shortcuts)
C2 (Notification) ── 독립
```

## 10. 위험 요소

| 위험 | 완화 |
|------|------|
| 우측 탭 11개 → 12+개로 늘면 화면이 좁아짐 | 아이콘 압축, Repair는 QA 통합, Logs 보류, 필요 시 overflow menu |
| 설정 탭 13개로 늘어남 | 설정 탭은 vertical list라 12+개도 수용 가능. Guide를 첫번째 유지 |
| 차트 라이브러리 추가 유혹 | 명시적 배제 — SVG 직접 그리기로 외부 의존성 0 유지 |
| Activity Log 대량 row pagination 성능 | §6 B2에 명시된 `idx_approvals_decided_at(decided_at DESC)` 인덱스 migration 포함 |
| B3 heartbeat interval이 main process를 깨워 idle 전력 증가 | 10초 간격은 보수적; idle 시 emit 생략 또는 backoff 추가 검토는 후속 |
| 명령 팔레트와 OS 단축키 충돌 (Cmd+K는 일부 IDE 점유) | Settings에서 binding 변경 옵션 추후 추가 |
| 알림 트레이가 noise화 | dismiss 일괄, 임계값 user-tunable |

## 11. 통합 검증

각 feature 완료 후:
- `npm run check` 통과
- `npm run test` 통과
- 신규 컴포넌트 수동 확인 (해당 탭 진입 → 빈 상태 / 데이터 있음 / 에러 상태 3가지)
- 우측 탭 / 설정 탭 추가 후 다른 탭 동작에 회귀 없는지 클릭 점검

## 12. 후속 작업 (이 plan 범위 밖)

- 차트 라이브러리 도입 검토 (현재는 SVG 직접 — 복잡한 차트 필요 시 재평가)
- DB snapshot restore 흐름 (현재는 export only)
- i18n framework 도입
- 명령 팔레트의 외부 plugin 확장
- 알림 트레이의 OS native notification 통합
