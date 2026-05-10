# Engineering Conventions

## 목적

이 문서는 HarnessAgentOS 구현 중 반복 판단을 줄이기 위한 엔지니어링 규칙을 고정한다.

## 프로젝트 구조

```text
HarnessAgentOS/
  apps/desktop/
    electron/
    src/
  packages/core/
  packages/storage/
  packages/runners/
  packages/quality/
  packages/skillify-adapter/
  packages/learner/
  packages/orchestration/
  docs/
```

## Package manager

- `npm`을 사용한다.
- root workspace를 사용한다.
- dependency는 필요한 package에 가장 가까운 `package.json`에 둔다.
- axios를 사용해야 할 경우 보안 정책에 따라 정확한 안전 버전만 고정한다. 기본 MVP에서는 axios를 추가하지 않는다.

## TypeScript / Module 규칙

- TypeScript를 기본으로 한다.
- ESM을 사용한다.
- public type은 `packages/core`에 둔다.
- Electron main/preload 전용 타입은 `apps/desktop/electron`에 둔다.
- `any`는 IPC boundary 또는 외부 입력 parse 직전으로 제한하고, 즉시 좁힌다.

## Naming 규칙

파일:

- React component: `PascalCase.tsx`
- service/repository/policy: `kebab-case.ts`
- test: `*.test.ts` 또는 Node runner 제약이 있으면 `*.test.mjs`
- IPC handler: `{domain}-ipc.ts`

도메인 method:

- create/list/get/update/cancel/resume처럼 동사로 시작한다.
- IPC method는 namespace + verb 형태를 유지한다. 예: `conversation.createTask`.

## Layering 규칙

Renderer:

- UI state와 presentation만 담당한다.
- filesystem, DB, process, shell 접근 금지.
- `window.harness`만 호출한다.

Preload:

- typed API만 expose한다.
- raw `ipcRenderer` 노출 금지.
- wildcard forwarding 금지.

Main:

- IPC handler는 얇게 유지한다.
- business logic은 service에 둔다.
- repository는 SQL만 담당하고 policy 판단을 하지 않는다.

Packages:

- `core`: 타입, 순수 정책, domain service interface.
- `storage`: SQLite, migration, repository.
- `runners`: file/shell/git/test runner.
- `quality`: evidence reader와 gate evaluator.
- `skillify-adapter`: skill metadata와 capability suggestion.
- `learner`: trace와 recommendation.

## Error handling

- 사용자에게 보여줄 오류는 `HarnessError`로 normalize한다.
- 내부 stack trace는 log artifact 또는 debug log에만 둔다.
- policy 차단은 실패가 아니라 blocked decision으로 표현한다.
- runner exit code != 0은 artifact와 Step failed로 남긴다.

## DB 규칙

- SQLite가 canonical state다.
- migration은 idempotent하게 작성한다.
- 모든 timestamp는 ISO string이다.
- JSON column은 `_json` suffix를 쓴다.
- repository는 transaction helper를 사용한다.
- renderer가 SQL을 전달하는 IPC는 만들지 않는다.

## IPC 규칙

- IPC 계약은 `docs/contracts/ipc-contracts.md`를 먼저 갱신한다.
- method별 input/output type을 작성한다.
- channel string은 한 곳에서 상수로 관리한다.
- renderer가 임의 channel을 호출할 수 없게 한다.

## UI 규칙

- 첫 화면은 workbench다. landing page를 만들지 않는다.
- 상태는 색상만으로 표현하지 않는다.
- action button은 disabled reason을 제공한다.
- 실패는 toast만 띄우지 말고 timeline/artifact에 남긴다.
- approval pending 상태는 항상 눈에 띄게 표시한다.

## Test 규칙

- 순수 policy는 unit test를 먼저 둔다.
- repository는 temp DB integration test를 둔다.
- runner는 temp directory에서 실행한다.
- renderer smoke는 핵심 상태 표시 위주로 시작한다.
- `npm run verify`는 check + test + build를 포함한다.

## 금지 사항

- Express/localhost/WebSocket server 추가 금지.
- renderer Node 권한 활성화 금지.
- JSON을 canonical state로 사용 금지.
- approval 없이 side effect 실행 금지.
- 기존 ClaudeAgentSystem 직접 수정 금지.
- CEO/pipeline을 MVP 기본 경로로 추가 금지.
- Skillify/Learner 자동 적용 경로 추가 금지.

## 문서 갱신 규칙

- 아키텍처 결정 변경은 `docs/architecture/architecture-decisions.md`에 ADR로 남긴다.
- IPC 변경은 `docs/contracts/ipc-contracts.md`에 먼저 반영한다.
- 사용자 flow 변경은 `docs/product/mvp-user-flows.md`에 반영한다.
- acceptance 기준 변경은 `docs/testing/acceptance-checklist.md`에 반영한다.
## Legacy Reference Location

기존 ClaudeAgentSystem의 위치는 다음과 같다.

```text
C:\Users\FORYOUCOM\Desktop\Code\ClaudeAgentSystem
```

사용 규칙:

- 읽기 참조만 허용한다.
- 참조 가능한 영역은 Skillify, Learner, quality gate, runner, targetDir, conversation context, 테스트/검증 사례다.
- 직접 import 대신 HarnessAgentOS package 구조에 맞게 재작성한다.
- ClaudeAgentSystem의 파일, DB, state, messages, runtime artifact를 수정하거나 runtime dependency로 사용하지 않는다.

