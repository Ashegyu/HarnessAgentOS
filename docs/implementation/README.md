# HarnessAgentOS Phase별 구현 설계 인덱스

> 기준 문서: `docs/architecture/harness-agent-os-design.md`  
> 구현 문서 위치: `docs/implementation/`  
> 원칙: 서버 없는 Electron + React + Node 로컬 데스크톱 앱, SQLite WAL canonical state, 사용자 승인 기반 실행.

## 1. 문서 목적

이 문서 세트는 HarnessAgentOS를 Phase 0부터 Phase 8까지 순서대로 구현하기 위한 실행 설계와, Phase 8 이후 닫힌 runtime/IPC/A2A 경계 정리를 함께 담는다. 기준 설계서는 제품 철학과 전체 구조를 고정하고, 이 구현 문서 세트는 실제 작업자가 어떤 순서로 어떤 모듈, 타입, IPC, DB, UI, 테스트를 만들어야 하는지 결정 완료 상태로 제공한다.

구현자는 별도 아키텍처 결정을 새로 하지 않는다. Phase 문서의 완료 기준을 만족한 뒤 다음 Phase로 넘어간다. 단, 2026-05-16 기준 현재 repo는 Phase 8 이후 follow-up 일부가 이미 반영되어 있으므로, 새 작업 전에는 이 README의 "Post-Phase 8 close-out 문서"를 먼저 확인한다.

## 2. 공통 구현 원칙

- Express, localhost API, WebSocket server는 MVP에서 만들지 않는다.
- Electron main process가 filesystem, git, runner, SQLite, quality, Skillify/Learner adapter를 소유한다.
- React renderer는 `contextBridge`로 노출된 제한 IPC만 호출한다.
- Renderer에 Node 권한을 주지 않는다.
- SQLite는 canonical state이며 WAL, foreign keys, busy timeout을 초기화한다.
- JSON은 debug/export snapshot 용도이며 canonical state가 아니다.
- 모든 side-effect action은 approval 모델을 통과한다.
- approval row에는 service-layer `policyEvaluation`이 붙고, `blocked` decision은 runner/orchestration 실행을 막는다.
- `TaskRun -> Step -> Checkpoint -> Approval -> Artifact -> QualityGateResult` 흐름을 모든 Phase에서 유지한다.
- Skillify와 Learner는 추천/근거 계층이며 자동 실행 주체가 아니다.
- public IPC 계약은 `docs/contracts/ipc-contracts.md`와 `packages/core/src/ipc-channels.ts`가 함께 유지한다.
- 기존 `ClaudeAgentSystem`은 직접 수정하지 않고 참조 및 이식 후보로만 사용한다.

## 3. 읽는 순서

1. `docs/architecture/harness-agent-os-design.md`
2. `docs/contracts/ipc-contracts.md`
3. `docs/implementation/phase-00-foundation.md`
4. `docs/implementation/phase-01-local-state-model.md`
5. `docs/implementation/phase-02-conversation-to-approval.md`
6. `docs/implementation/phase-03-runner-and-artifacts.md`
7. `docs/implementation/phase-04-quality-gates.md`
8. `docs/implementation/phase-05-skillify-capability-adapter.md`
9. `docs/implementation/phase-06-learner-advisor.md`
10. `docs/implementation/phase-07-optional-agent-orchestration.md`
11. `docs/implementation/phase-08-agent-cli-integration.md`
12. `docs/implementation/phase-08-completion-checklist.md`
13. `docs/implementation/runtime-contract-fixes-plan.md`
14. `docs/architecture/a2a-integration-plan.md`
15. `docs/verification/a2a-phase-f-ops-report.md`

## 4. Phase 의존성

| Phase | 목적 | 선행 조건 | 다음 단계에 넘길 산출물 |
|---|---|---|---|
| 0 | 프로젝트 뼈대와 검증 기준 | 없음 | 실행 가능한 Electron scaffold, 공통 타입/패키지 구조 |
| 1 | 로컬 상태 모델 | Phase 0 | SQLite store, repositories, core CRUD |
| 2 | 대화에서 승인 대기 | Phase 1 | TaskRun 생성 흐름, plan/checkpoint/approval UI |
| 3 | Runner와 artifact | Phase 2 | 승인 기반 실행, diff/log/test artifact |
| 4 | 품질 게이트 | Phase 3 | 완료 전 evidence 기반 gate |
| 5 | Skillify capability | Phase 4 | capability registry와 추천 UI |
| 6 | Learner advisor | Phase 5 | recommendation-only learner trace |
| 7 | 선택적 orchestration | Phase 6 | Harness 제어 아래의 고급 orchestration 옵션 |
| 8 | Agent CLI integration | Phase 4, Phase 6 권장 | 기존 ClaudeAgentSystem식 CLI 호출을 Harness approval 흐름 안에 넣는 실제 agent planner |

## 5. Post-Phase 8 close-out 문서

| 문서 | 현재 역할 |
|---|---|
| `docs/implementation/phase-08-completion-checklist.md` | Phase 8과 이후 A2A/Policy/IPC follow-up을 현재 검증 결과 기준으로 닫은 체크리스트 |
| `docs/implementation/runtime-contract-fixes-plan.md` | approval 실행 상태, pipeline 실패 노출, targetDir, quality evidence, retry/scope 같은 runtime 계약 보강 계획 |
| `docs/contracts/ipc-contracts.md` | renderer-facing `window.harness.*` public IPC 단일 계약. `ipc-contracts-surface.test.mjs`가 실제 `IPC_CHANNELS`와 대조한다. |
| `docs/architecture/a2a-integration-plan.md` | A2A remote registry/client/worker routing 설계와 serverless gateway boundary |
| `docs/verification/a2a-phase-f-ops-report.md` | loopback companion listener 제거와 A2A Phase F serverless 경계 검증 기록 |

## 6. 전체 완료 기준

- 앱은 서버 없이 실행된다.
- 사용자는 대화창에서 작업을 시작하고 이어서 질문할 수 있다.
- 모든 작업은 `TaskRun`으로 기록된다.
- 파일 수정, shell 실행, dependency 설치, git commit 같은 side effect는 approval 없이 실행되지 않는다.
- 중간 산출물은 artifact로 남고 UI에서 볼 수 있다.
- 실패 로그와 품질 리스크는 숨겨지지 않는다.
- 품질 게이트가 완료 전 실행된다.
- Skillify와 Learner는 추천/근거로만 동작한다.
- 기존 CEO/pipeline 자동 진행은 기본 경로에 없다.
- agent CLI가 사용 가능한 환경에서는 사용자가 직접 파일 내용을 타이핑하지 않아도 agent-generated approval을 통해 작업을 실행할 수 있다.
- orchestration worker와 remote A2A worker도 approval 없이 side effect를 만들 수 없다.
- A2A inbound listener, localhost wrapper, WebSocket server는 현재 runtime에 없다.
- IPC 계약 문서와 실제 IPC surface는 테스트로 대조된다.

## 7. 검증 원칙

각 Phase는 다음 검증 계층을 가진다.

- Unit: pure function, repository, policy, type guard.
- Integration: main process service와 SQLite, runner adapter, artifact store.
- UI smoke: renderer에서 주요 상태와 버튼이 보이는지 확인.
- Manual acceptance: 사용자가 실제 흐름을 따라갈 수 있는지 확인.

현재 repo-wide close-out 기준:

```powershell
npm run check
npm run test
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'; npm run build
git diff --check
```

릴리즈 직전 smoke 포함 기준:

```powershell
npm run verify:release
git diff --check
```

Phase 8/A2A/IPC focused verification은 `phase-08-completion-checklist.md`를 따른다. 앱 scaffold/build/test 실행은 실제 구현 단계에서 수행한다. 이 문서 세트는 구현 기준이다.

## Legacy Reference Location

기존 ClaudeAgentSystem은 이식 후보와 설계 참고용으로만 사용한다.

```text
Legacy reference project:
C:\Users\FORYOUCOM\Desktop\Code\ClaudeAgentSystem
```

허용:

- Skillify, Learner, quality gate, runner, targetDir, conversation context의 기존 구현을 읽고 개념을 이식한다.
- 테스트 이름, 실패 사례, 검증 명령, 정책 결정을 참고한다.
- 필요한 기능은 HarnessAgentOS 구조에 맞게 새 package/service로 재작성한다.

금지:

- ClaudeAgentSystem 파일을 직접 수정하지 않는다.
- ClaudeAgentSystem의 DB, `state/`, `messages/`, runtime artifact를 HarnessAgentOS의 runtime dependency로 사용하지 않는다.
- 기존 CEO/pipeline/message queue를 MVP 기본 경로로 import하지 않는다.
- 레거시 코드를 그대로 복사해 새 권한/approval 경계를 우회하지 않는다.

