# Phase 00 - Foundation

## 목표

HarnessAgentOS의 구현 기반을 만든다. 이 Phase는 기능보다 구조와 안전한 실행 경계를 고정한다. 완료되면 서버 없이 Electron 앱을 실행할 수 있고, renderer가 main process의 제한 IPC만 호출하는 구조가 존재해야 한다.

## 비범위

- SQLite schema 구현은 Phase 1에서 한다.
- 대화 입력, TaskRun 생성, approval UX는 Phase 2에서 한다.
- Runner, Quality Gate, Skillify, Learner는 구현하지 않는다.
- Express, localhost API, WebSocket server는 만들지 않는다.
- 기존 ClaudeAgentSystem 코드는 복사하지 않는다.

## 구현 단위

권장 폴더 구조:

```text
HarnessAgentOS/
  apps/desktop/
    electron/main.ts
    electron/preload.ts
    electron/ipc/
    src/app/
    src/components/
    src/screens/
  packages/core/src/
  packages/storage/src/
  packages/runners/src/
  packages/quality/src/
  packages/skillify-adapter/src/
  packages/learner/src/
  docs/
```

Package manager는 `npm`으로 시작한다. 기존 프로젝트가 npm 기반이고 Windows 환경에서 가장 예측 가능하다. Root `package.json`은 workspace를 정의하고, 모든 package는 ESM과 TypeScript 기준으로 작성한다.

공통 명령 이름:

```json
{
  "scripts": {
    "dev": "npm --workspace apps/desktop run dev",
    "build": "npm --workspaces run build",
    "test": "node --test --test-force-exit \"packages/**/*.test.mjs\" \"apps/desktop/**/*.test.mjs\"",
    "check": "npm --workspaces run check",
    "verify": "npm run check && npm run test && npm run build"
  }
}
```

## 주요 타입과 인터페이스

Phase 0에서는 도메인 타입 전체를 구현하지 않고, 공통 결과와 IPC 오류 형태만 고정한다.

```ts
export type HarnessResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: HarnessError };

export interface HarnessError {
  code: string;
  message: string;
  details?: unknown;
}

export interface RuntimeInfo {
  platform: NodeJS.Platform;
  appDataDir: string;
  documentsDir?: string;
}

export interface HarnessDesktopApi {
  app: {
    getVersion(): Promise<string>;
    getRuntimeInfo(): Promise<RuntimeInfo>;
  };
}
```

Preload는 raw `ipcRenderer`를 노출하지 않고, channel별 method만 `contextBridge`로 제공한다. Public IPC method 이름의 단일 source of truth는 `docs/contracts/ipc-contracts.md`이며, Phase 문서는 그 dot notation을 따른다.

## 데이터 흐름

```text
Renderer boot
  -> window.harness.app.getRuntimeInfo()
  -> preload validates channel call
  -> ipcMain handler in main process
  -> RuntimeService reads app paths
  -> renderer displays ready state
```

Phase 0에서는 DB 쓰기나 파일 수정 없이 앱이 뜨고 런타임 정보를 읽는 흐름만 만든다.

## UI 요구사항

첫 화면은 landing page가 아니라 workbench shell이다.

필수 영역:

- 좌측 Thread sidebar placeholder
- 중앙 Conversation workbench placeholder
- 우측 Checkpoint/Artifact/Quality placeholder
- runtime status 표시

빈 상태 문구는 기능 설명이 아니라 현재 상태를 짧게 표시한다. 예: `작업 없음`, `대상 폴더 미선택`, `승인 대기 없음`.

## 보안/승인 정책

Electron BrowserWindow 기본값:

```ts
webPreferences: {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  preload: preloadPath
}
```

금지:

- renderer에서 `fs`, `child_process`, `ipcRenderer` 직접 사용
- remote URL 로드
- preload에서 wildcard channel forwarder 제공
- `shell.openExternal`을 untrusted URL에 직접 연결

허용:

- 명시적으로 정의된 IPC method만 호출
- main process가 모든 local capability를 소유

## 테스트 계획

Unit:

- `HarnessResult` helper와 error mapping 테스트.
- IPC channel allowlist 테스트.

Integration:

- main process service가 runtime info를 반환하는지 테스트.
- preload에서 노출하는 API 이름이 allowlist와 일치하는지 테스트.

UI smoke:

- workbench shell이 렌더링되는지 확인.
- server 없이 앱 dev mode가 뜨는지 확인.

Manual acceptance:

- `npm run dev`로 Electron 창이 열린다.
- 브라우저에서 `localhost`로 접속하지 않는다.
- DevTools에서 renderer가 Node API에 직접 접근할 수 없다.

## 완료 기준

- root workspace와 `apps/desktop` scaffold가 있다.
- Electron + React + Vite 앱이 서버 없이 실행된다.
- `contextBridge` 기반 최소 API가 동작한다.
- renderer에 Node 권한이 없다.
- `npm run check`, `npm run test`, `npm run build` 명령 이름이 존재한다.
- 기준 설계서와 구현 문서가 앱 안에서 참조 가능한 경로에 있다.

## 다음 Phase 인계

Phase 1은 Phase 0의 workspace 구조와 Electron main process를 사용해 SQLite store를 붙인다. Phase 0은 `RuntimeInfo.appDataDir`를 안정적으로 제공해야 한다.



