---
name: harness-agent-os-workflows
description: HarnessAgentOS 개발 워크플로우 — git 히스토리에서 추출한 실제 코딩 패턴
version: 1.0.0
source: local-git-analysis
analyzed_commits: 21
---

# HarnessAgentOS Workflows

Git 히스토리 21개 커밋 분석으로 추출한 팀 패턴.

## Commit Conventions

100% conventional commit 준수. 스코프 적극 활용:

```
feat(orchestration): Phase 2 — worker steps invoke the real agent CLI
fix(agent): prevent AGENT_STALL and harden provider selection
refactor(orchestration): auto-expand panel when feature flag enabled
docs(design): pipeline × thread binding execution plan
chore: add pnpm-lock.yaml
```

**자주 쓰이는 스코프:** `orchestration`, `agent`, `approval`, `skills`, `design`

## New Feature Workflow

새 IPC 도메인 추가 시 항상 함께 변경되는 파일 그룹 (공동 변경 빈도 6~9회):

```
1. packages/core/src/api.ts               ← HarnessDesktopApi 인터페이스
2. packages/core/src/types/index.ts       ← 새 타입 export
3. packages/core/src/ipc-channels.ts     ← 채널 상수
4. packages/storage/src/schema.ts        ← 필요 시 스키마
5. packages/storage/src/services/local-state-service.ts
6. apps/desktop/electron/ipc/{domain}-ipc.ts
7. apps/desktop/electron/ipc/{domain}-ipc.test.mjs
8. apps/desktop/electron/ipc/index.ts    ← registerAllIpc()
9. apps/desktop/electron/preload.ts      ← contextBridge
```

핵심 규칙: **api.ts 변경 → 9개 레이어 전체 수정**

## Schema Change Workflow

`schema.ts`가 변경되면 항상 함께 수정 (공동 변경 7회):

```
packages/storage/src/schema.ts
packages/storage/src/migrations.ts      ← SCHEMA_VERSION 숫자 증가
packages/storage/src/services/local-state-service.ts
```

## UI Change Pattern

UI 기능 추가 시 항상 함께 변경 (공동 변경 9회):

```
apps/desktop/src/screens/workbench/WorkbenchShell.tsx  ← 패널 라우팅
apps/desktop/src/screens/workbench/workbench.css       ← 스타일
```

새 패널/탭은 `WorkbenchShell.tsx`에 라우팅을 추가하고 `workbench.css`에 스타일을 추가.

## Testing Patterns

- **파일명:** `{source-name}.test.mjs` (`.test.ts` 사용 금지)
- **위치:** 소스 파일과 같은 디렉토리 (`__tests__/` 없음)
- **IPC 핸들러**는 반드시 매칭 `.test.mjs` 파일 보유
- 테스트 비율: 전체 변경 파일의 약 18%가 테스트 파일

```
packages/storage/src/repositories/thread-repository.ts
packages/storage/src/repositories/thread-repository.test.mjs  ← 필수
```

## Repository Pattern

새 도메인마다 반복되는 구조:

```
packages/storage/src/repositories/
  {domain}-repository.ts        ← CRUD 구현
  {domain}-repository.test.mjs  ← 테스트

packages/storage/src/repositories/index.ts  ← re-export 추가
```

## Hotspot Files

가장 자주 변경되는 파일 — 충돌 위험 높음:

| 파일 | 변경 횟수 |
|------|-----------|
| `WorkbenchShell.tsx` | 11 |
| `workbench.css` | 9 |
| `local-state-service.ts` | 8 |
| `schema.ts` | 7 |
| `api.ts` | 7 |
| `index.ts` (ipc) | 6 |
