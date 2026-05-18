# HarnessAgentOS

사용자 감독형 개발 워크벤치. 에이전트가 흐름을 통제하는 것이 아니라 사용자가 통제한다.
모든 side effect는 approval → runner → artifact → quality gate를 거친다.
Serverless Electron + React + SQLite WAL, 로컬 전용.

## 문서

- [workspace/README.html](workspace/README.html) — 전체 개요, 사용법, 핵심 개념, FAQ (브라우저에서 열기)
- [workspace/app-flow-visualization.html](workspace/app-flow-visualization.html) — 동작 흐름 · 데이터 모델 · 상태 머신 · 가드레일 시각화
- [docs/](docs/) — 아키텍처 결정, 구현 단계, IPC 계약 등 상세 문서

## 핵심 원칙

- **Approval-first**: 파일 쓰기 · shell · git commit · network · skill script 등 9가지 action type 전부 사용자 승인 필수
- **BLOCK FLOOR 우회 불가**: Agent Profile의 `blockedActions`는 전역 auto-approve 토글보다 우선
- **Pre-execution budget gate**: Agent Profile에 USD 한도 설정 시, 추정 비용 초과 자동 승인 차단
- **Decision trace 영구 기록**: 모든 자동 승인 결정의 7단계 결정 흐름과 사유를 approval row에 저장
- **Evidence-based 완료**: `markDone`은 passed/warning QualityGate가 있어야 호출 가능

## Quick start

```bash
npm install
npm run dev
```

## Scripts

- `npm run dev` - Electron 앱 dev 모드 실행
- `npm run check` - 전체 워크스페이스 타입체크
- `npm run test` - 단위 · 통합 테스트 (Node, no Electron)
- `npm --workspace=@harness/desktop run e2e` - Playwright + Electron 스모크 하네스
- `npm run build` - 전체 워크스페이스 빌드
- `npm run verify` - check + test + build

## Layout

```
apps/desktop/                Electron app (main, preload, renderer, e2e)
packages/core/               공유 타입, IPC contracts, 순수 정책 함수
packages/storage/            SQLite WAL repository, migration, LocalStateService
packages/runners/            file/shell/git/test runner (cancellation signal 지원)
packages/quality/            evidence 기반 QualityEvaluator + RepairLoop
packages/skillify-adapter/   Skill metadata, capability registry/suggestion
packages/learner/            LearningTrace, model/capability 추천 (estimatedCostUsd 포함)
packages/orchestration/      multi-worker pipeline 플래너
packages/agent/              CLI agent 호출 (claude/codex, AbortSignal 전파)
packages/evals/              메타 평가 시스템 (capability · regression · safety)
docs/                        설계 및 구현 단계 명세
```

## TaskRun lifecycle

9-state machine: `drafting` → `waiting_for_approval` → `running` → `paused` / `blocked` /
`quality_failed` / `ready_for_review` → `done` 또는 `cancelled`.

우측 패널은 비종료 TaskRun에 대해 Pause / Resume / Retry last action / Cancel을 노출한다.
Cancel은 비어있지 않은 사유와 함께 `quality_report` artifact를 남기고, Retry는
`blocked` / `quality_failed` 상태에서만 가장 최근 승인된 action을 idempotent runner 경로로 재실행한다.

TaskRun row가 canonical store에서 바뀌면 main이 `events:taskRunChanged` push를 보내고
workbench는 polling 없이 fresh 상태를 재조회한다.

## 절대 위반 금지 (CLAUDE.md 참조)

1. `packages/core`는 `@harness/storage`를 import 하지 않는다
2. 테스트 파일은 반드시 `.test.mjs` (`.test.ts` / `.test.tsx` 금지)
3. Renderer는 `window.harness.*`만 호출 (`nodeIntegration` off)
4. Express / localhost / WebSocket 서버 추가 금지 — UI ↔ Core 통신은 Electron IPC만
5. JSON을 canonical state로 사용 금지 — SQLite WAL이 유일한 source of truth
6. Approval 없이 side effect 실행 금지

자세한 배경은 [CLAUDE.md](CLAUDE.md) 참고.
