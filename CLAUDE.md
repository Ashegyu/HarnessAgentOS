# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# 개발 서버 (Electron + React hot-reload)
npm run dev

# 타입 체크 (전체 워크스페이스)
npm run check

# 테스트 실행 (rebuild:node 포함)
npm run test

# 단일 테스트 파일 실행
node --import tsx --test --test-force-exit packages/storage/src/repositories/thread-repository.test.mjs

# 전체 검증 (check + test + build)
npm run verify

# Electron native 모듈 재빌드
npm run rebuild:node
npm run rebuild:electron
```

## 핵심 제약 사항

**절대 위반 금지:**

1. `packages/core`는 `@harness/storage`를 import해서는 안 된다 — core는 순수 타입/인터페이스만 포함
2. 테스트 파일은 반드시 `.test.mjs`로 끝나야 한다 (`.test.ts`, `.test.tsx` 금지)
3. renderer에서 `nodeIntegration` 비활성화 유지 — `window.harness.*`만 호출 가능
4. Express/localhost/WebSocket 서버 추가 금지 — UI↔Core 통신은 Electron IPC만 사용
5. JSON을 canonical state로 사용 금지 — SQLite WAL이 유일한 source of truth
6. approval 없이 side effect(파일 쓰기, shell, git commit 등) 실행 금지

## 아키텍처 개요

HarnessAgentOS는 "사용자 감독형 개발 워크벤치"다. 에이전트가 아니라 사용자가 흐름을 통제한다.

### 레이어 구조

```
Renderer (React)          → window.harness.* 만 호출, SQL·파일·process 접근 금지
Preload (contextBridge)   → typed IPC bridge, raw ipcRenderer 노출 금지
Main (Electron)           → IPC handler는 얇게, 비즈니스 로직은 서비스에 위임
```

### 패키지 역할

| 패키지 | 역할 |
|--------|------|
| `packages/core` | 공유 타입, 순수 정책, 서비스 인터페이스 (`HarnessDesktopApi` 포함) |
| `packages/storage` | SQLite WAL, migration, repository, `LocalStateService` |
| `packages/runners` | 파일/shell/git/test runner (`RunnerService`) |
| `packages/quality` | evidence 기반 품질 게이트 (`QualityEvaluator`) |
| `packages/skillify-adapter` | skill metadata, capability registry/suggestion |
| `packages/learner` | LearningTrace, model/capability 추천 (`LearnerAdvisor`) |
| `packages/orchestration` | Phase 7 agent pipeline 플래너 (`OrchestrationPlanner`) |
| `packages/agent` | Phase 8 CLI agent 호출 (`AgentPlanningService`) |
| `apps/desktop` | Electron 메인 앱 (main, preload, renderer) |

### 실행 흐름 (핵심 도메인)

```
사용자 입력 → Thread → TaskRun → Step → Checkpoint → Approval → Runner → Artifact → QualityGate → Done
```

- 모든 side effect는 `Approval`(pending→approved)을 거쳐야 실행됨
- `markDone`은 passed/warning QualityGate가 있어야만 호출 가능
- Renderer는 push 이벤트(`onTaskRunChanged`)를 수신하면 `getTaskRunDetail`로 fresh 상태를 pull

### IPC 등록 패턴

새 IPC 도메인 추가 시 반드시 9개 레이어를 순서대로 수정:

1. `packages/core/src/api.ts` — `HarnessDesktopApi` 인터페이스
2. `packages/core/src/types/` — 필요한 타입
3. `packages/storage` — repository/service (필요 시)
4. 해당 packages 서비스 — 비즈니스 로직
5. `apps/desktop/electron/ipc/{domain}-ipc.ts` — IPC 핸들러
6. `apps/desktop/electron/ipc/{domain}-ipc-register.ts` — 등록 함수 (필요 시)
7. `apps/desktop/electron/ipc/index.ts` — `registerAllIpc`에 추가
8. `apps/desktop/electron/preload.ts` — contextBridge expose
9. `apps/desktop/src/types/window.d.ts` — renderer 타입 선언

### DB 규칙

- 모든 timestamp는 ISO string
- JSON column은 `_json` suffix (`known_risks_json`, `trigger_terms_json` 등)
- migration은 idempotent (`IF NOT EXISTS`), `SCHEMA_VERSION` 숫자 증가
- `PRAGMA journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`

### Renderer 이벤트 구독

Renderer는 반드시 polling이 아닌 push 구독을 사용한다:

```ts
window.harness.events.onTaskRunChanged(({ taskRunId }) => {
  // pull fresh state
  window.harness.conversation.getTaskRunDetail({ taskRunId });
});
```

### 테스트에서 AgentPlanningService 또는 CLI 사용 시

`packages/storage/src/id.ts`를 먼저 확인하고, 실제 CLI를 호출하지 않도록 stub/mock 처리한다.

## 문서 위치

- 아키텍처 결정: `docs/architecture/architecture-decisions.md`
- IPC 계약 (단일 source of truth): `docs/contracts/ipc-contracts.md`
- 구현 단계별 계획: `docs/implementation/phase-0*.md`
- 엔지니어링 컨벤션 상세: `docs/engineering/conventions.md`
