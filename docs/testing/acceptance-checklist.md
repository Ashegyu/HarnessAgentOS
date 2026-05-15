# Acceptance Test Checklist

## 목적

이 문서는 HarnessAgentOS 구현이 실제 사용자 흐름을 만족하는지 확인하기 위한 수동/스모크 acceptance checklist다. 자동 테스트가 생기기 전까지 최소 품질 기준으로 사용한다.

## 공통 체크

- [ ] 앱은 서버 없이 Electron 창으로 실행된다.
- [ ] 브라우저에서 localhost 접속이 필요 없다.
- [ ] renderer에서 Node API에 직접 접근할 수 없다.
- [ ] 기존 ClaudeAgentSystem 파일을 수정하지 않는다.
- [ ] runtime state는 app userData 아래에 저장된다.

## 자동 스모크 명령

- [ ] `npm --workspace=@harness/desktop run e2e`가 통과한다.
- [ ] `npm --workspace=@harness/desktop run smoke:e2e`가 통과한다.
- [ ] `npm --workspace=@harness/desktop run smoke:agent-fake`가 통과한다.
- [ ] 실제 인증된 CLI가 있는 PC에서는 `npm --workspace=@harness/desktop run smoke:agent-live`를 수동으로 실행한다.

## Phase 0: Foundation

- [ ] `npm run dev`로 Electron 앱이 열린다.
- [ ] Workbench shell이 보인다.
- [ ] Thread/sidebar, conversation, right panel placeholder가 보인다.
- [ ] `window.harness.app.getRuntimeInfo()`가 동작한다.
- [ ] raw `ipcRenderer`는 renderer에 노출되지 않는다.
- [ ] Express/localhost/WebSocket server가 생성되지 않는다.

통과 기준: 서버 없이 앱 shell이 열리고 IPC bridge 최소 기능이 동작한다.

## Phase 1: Local State Model

- [ ] 앱 최초 실행 시 SQLite DB가 userData 아래 생성된다.
- [ ] WAL, foreign_keys, busy_timeout이 초기화된다.
- [ ] Thread를 생성할 수 있다.
- [ ] TaskRun을 생성할 수 있다.
- [ ] 앱 재시작 후 Thread/TaskRun이 복원된다.
- [ ] renderer가 SQL을 직접 보내지 않는다.
- [ ] JSON 파일 삭제가 core state에 영향을 주지 않는다.

통과 기준: SQLite가 canonical state로 동작한다.

## Phase 2: Conversation To Approval

- [ ] 대화 입력으로 TaskRun이 생성된다.
- [ ] targetDir가 UI에 표시된다.
- [ ] invalid targetDir는 TaskRun 생성 전에 차단된다.
- [ ] plan artifact가 생성된다.
- [ ] `before_edit` checkpoint가 생성된다.
- [ ] pending approval이 표시된다.
- [ ] 승인 전에는 파일이 수정되지 않는다.
- [ ] 거절 시 이유 입력이 필수다.
- [ ] 수정 지시 시 새 plan/checkpoint/approval이 생성된다.

통과 기준: 사용자는 실행 전에 계획과 action을 보고 승인/거절/수정할 수 있다.

## Phase 3: Runner And Artifacts

- [ ] 승인된 approval id 없이는 runner가 실행되지 않는다.
- [ ] targetDir 밖 파일 쓰기가 차단된다.
- [ ] 파일 수정 후 diff artifact가 생성된다.
- [ ] shell 실행 후 log artifact가 생성된다.
- [ ] test 실행 후 test_result artifact가 생성된다.
- [ ] 실패한 command의 stderr가 보존된다.
- [ ] failed step이 Timeline에 표시된다.
- [ ] artifact를 UI에서 열 수 있다.

통과 기준: 모든 실행 결과가 artifact로 남고 실패가 숨겨지지 않는다.

## Phase 4: Quality Gates

- [ ] 테스트 미실행 작업은 passed로 표시되지 않는다.
- [ ] 실패한 test artifact는 quality_failed로 이어진다.
- [ ] missing build/smoke evidence가 UI에 표시된다.
- [ ] known risk 승인은 이유 입력이 필요하다.
- [ ] quality gate 없이 done 전환할 수 없다.
- [ ] repair plan 생성 시 다시 approval 흐름으로 돌아간다.
- [ ] final approval 후에만 done이 된다.

통과 기준: 완료 판정은 evidence와 사용자 승인에 기반한다.

## Phase 5: Skillify Capability Adapter

- [ ] skills directory metadata scan이 동작한다.
- [ ] 관련 capability 추천이 표시된다.
- [ ] 추천 이유와 risk level이 표시된다.
- [ ] untrusted skill은 warning 또는 비활성 상태다.
- [ ] SKILL.md instruction은 선택 시에만 로드된다.
- [ ] skill script 실행 요청은 approval을 생성한다.
- [ ] approval 없이 skill script가 실행되지 않는다.

통과 기준: Skillify는 추천 계층으로 동작하고 자동 실행자가 아니다.

## Phase 6: Learner Advisor

- [ ] TaskRun 완료 후 LearningTrace가 생성된다.
- [ ] selected model/capability가 trace에 기록된다.
- [ ] reward/cost/latency/success/failure가 표시된다.
- [ ] learner recommendation이 표시된다.
- [ ] 추천 채택/거절이 기록된다.
- [ ] 추천은 action을 자동 실행하지 않는다.
- [ ] high risk capability 추천이 approval policy를 약화하지 않는다.

통과 기준: Learner는 추천 근거만 제공한다.

## Phase 7: Optional Agent Orchestration

- [ ] orchestration feature flag 기본값은 off다.
- [ ] advanced toggle 없이는 orchestration UI가 노출되지 않는다.
- [ ] orchestration plan은 artifact로 저장된다.
- [ ] orchestration plan 자체가 approval 대상이다.
- [ ] worker output은 artifact/timeline에 표시된다.
- [ ] worker가 file/shell 실행을 approval 없이 우회할 수 없다.
- [ ] quality gate 없이 orchestration 결과를 done 처리할 수 없다.

통과 기준: orchestration은 Harness 통제 아래의 선택 기능이다.

## Release Readiness

- [ ] Phase 0-4가 모두 통과한다.
- [ ] `npm run verify`가 통과한다.
- [ ] 자동 스모크 명령 중 `e2e`, `smoke:e2e`, `smoke:agent-fake`가 통과한다.
- [ ] 주요 사용자 flow 1-12를 수동으로 재현했다.
- [ ] 알려진 리스크가 문서화되어 있다.
- [ ] 다음 phase로 넘길 미완료 항목이 정리되어 있다.
