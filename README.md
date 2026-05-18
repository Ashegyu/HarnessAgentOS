# HarnessAgentOS

Local desktop development workbench. Serverless Electron + React + SQLite.

## 문서

- [workspace/README.html](workspace/README.html) — 전체 개요, 사용법, 핵심 개념, FAQ (브라우저에서 열기)
- [workspace/app-flow-visualization.html](workspace/app-flow-visualization.html) — 동작 흐름 · 데이터 모델 · 상태 머신 · 가드레일 시각화
- [docs/](docs/) — 아키텍처 결정, 구현 단계, IPC 계약 등 상세 문서

## Quick start

```bash
npm install
npm run dev
```

## Scripts

- `npm run dev` - Launch Electron app in dev mode
- `npm run check` - Typecheck all workspaces
- `npm run test` - Run unit/integration tests (Node, no Electron)
- `npm --workspace=@harness/desktop run e2e` - Build the bundle and run the
  Playwright + Electron smoke harness
- `npm run build` - Build all workspaces
- `npm run verify` - check + test + build

## Layout

```
apps/desktop/        Electron app (main, preload, renderer, e2e)
packages/core/       Shared types, IPC contracts (incl. main → renderer events)
packages/storage/    SQLite repositories (Phase 1+)
packages/runners/    File/shell/git/test runners (Phase 3+)
packages/quality/    Quality gate evaluator (Phase 4+)
packages/skillify-adapter/  Skillify capability registry (Phase 5+)
packages/learner/    Learning trace + advisor (Phase 6+)
packages/orchestration/     Worker orchestration (Phase 7, feature-flagged)
docs/                Design and implementation specs
```

## TaskRun lifecycle controls

The right panel exposes Pause / Resume / Retry last action / Cancel for
non-terminal TaskRuns. Cancel requires a non-empty reason and writes a
`quality_report` artifact; Retry only fires on `blocked`/`quality_failed`
TaskRuns and re-runs the most recently approved action through the same
idempotent runner path.

Whenever a TaskRun row changes in the canonical store, main broadcasts an
`events:taskRunChanged` push so the workbench refetches without polling.
