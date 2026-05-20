# HarnessAgentOS Architecture Index

이 폴더는 HarnessAgentOS의 아키텍처 기준을 담는다. `harness-agent-os-design.md`는 제품/철학/전체 설계의 기준 문서이고, 아래 문서들은 구현 중 반복 참조할 세부 아키텍처 경계를 정의한다.

현재 구현 기준은 이 폴더의 경계 문서와 `docs/contracts`, `docs/implementation`, `docs/verification`의 close-out 문서를 함께 읽어야 한다. 특히 IPC surface, runtime contract, A2A remote worker 경계는 Phase 8 이후 실제 검증 결과를 반영한다.

## 문서 목록

| 문서 | 목적 |
|---|---|
| `harness-agent-os-design.md` | 최상위 제품 및 시스템 설계 기준 |
| `system-context.md` | 시스템 경계, 외부 의존성, 레거시 ClaudeAgentSystem 관계 |
| `process-and-ipc-architecture.md` | Electron renderer/preload/main process 경계와 IPC 규칙 |
| `state-and-artifact-architecture.md` | SQLite canonical state, artifact 저장소, snapshot/export 정책 |
| `security-and-approval-architecture.md` | 승인 모델, 권한 경계, 위험 action 정책 |
| `runner-and-quality-architecture.md` | runner 계층과 quality gate 평가 흐름 |
| `capability-and-learning-architecture.md` | Skillify capability와 Learner advisor 구조 |
| `ui-workbench-architecture.md` | 대화형 workbench UI 정보 구조와 상태 표현 |
| `internal-agent-message-bus-plan.md` | 내부 에이전트 이벤트/메시지 버스 설계와 IPC push 경계 |
| `a2a-integration-plan.md` | A2A remote registry/client/worker routing과 서버리스 gateway 경계 |
| `a2a-refinement-backflow-plan.md` | A2A 수정 요청을 이전 remote worker로 되돌려 보내는 bounded refinement 설계 |
| `pipeline-backflow-routing-plan.md` | Pipeline template에 조건부 backflow rule을 저장하고 실패 시 target/retry worker를 자동 실행하는 설계 |
| `architecture-decisions.md` | 핵심 아키텍처 결정 기록 |

## 관련 설계 문서

| 문서 | 목적 |
|---|---|
| `../design/agent-framework-unified-v4-adoption-plan.md` | Ruflo, Agno, Hermes, ECC 개념을 HarnessAgentOS 내부 설계로 이식하는 단계별 계획 |

## 관련 계약/검증 문서

| 문서 | 목적 |
|---|---|
| `../contracts/ipc-contracts.md` | renderer가 호출할 수 있는 public `window.harness.*` IPC 계약의 단일 기준 |
| `../implementation/runtime-contract-fixes-plan.md` | approval executed 상태, pipeline error visibility, targetDir, quality evidence, retry/scope/latest plan 보강 계획 |
| `../implementation/phase-08-completion-checklist.md` | Phase 8 구현/검증 close-out과 남은 후속 범위 |
| `../verification/a2a-phase-f-ops-report.md` | A2A Phase F 서버리스 경계 검증과 companion listener 제거 근거 |

## 문서 간 역할

- Architecture 문서는 시스템 경계와 불변 원칙을 정의한다.
- Contracts 문서는 renderer-facing API의 단일 기준이며 `IPC_CHANNELS`와 drift 테스트로 동기화한다.
- Implementation 문서는 Phase별 작업 단위와 완료 조건을 정의한다.
- Verification 문서는 완료된 구현의 증거와 운영 경계 검증 결과를 남긴다.
- Architecture 문서의 결정을 바꾸려면 `architecture-decisions.md`에 새 결정으로 기록한다.

## 최상위 불변 원칙

- 서버 없는 로컬 데스크톱 앱이다.
- Electron main process가 로컬 권한을 소유한다.
- React renderer는 제한된 `window.harness.*` IPC만 호출하며 `docs/contracts/ipc-contracts.md`와 항상 일치해야 한다.
- SQLite WAL DB가 canonical state다.
- 모든 side effect는 approval 모델을 통과한다.
- `policyEvaluation`이 `blocked`이면 approval이 approved여도 runner/orchestration side effect를 실행하지 않는다.
- orchestration worker와 remote A2A worker는 approval 경계를 우회해서 side effect를 만들 수 없다.
- A2A는 inbound listener, localhost wrapper, WebSocket server를 추가하지 않고 순수 gateway handler와 outbound client 경계만 유지한다.
- Skillify와 Learner는 자동 실행자가 아니라 추천/근거 계층이다.
- 기존 ClaudeAgentSystem은 직접 수정 대상이 아니라 이식 후보 저장소다.

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

