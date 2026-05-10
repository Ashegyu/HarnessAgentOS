# HarnessAgentOS Architecture Index

이 폴더는 HarnessAgentOS의 아키텍처 기준을 담는다. `harness-agent-os-design.md`는 제품/철학/전체 설계의 기준 문서이고, 아래 문서들은 구현 중 반복 참조할 세부 아키텍처 경계를 정의한다.

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
| `architecture-decisions.md` | 핵심 아키텍처 결정 기록 |

## 문서 간 역할

- Architecture 문서는 시스템 경계와 불변 원칙을 정의한다.
- Implementation 문서는 Phase별 작업 단위와 완료 조건을 정의한다.
- Architecture 문서의 결정을 바꾸려면 `architecture-decisions.md`에 새 결정으로 기록한다.

## 최상위 불변 원칙

- 서버 없는 로컬 데스크톱 앱이다.
- Electron main process가 로컬 권한을 소유한다.
- React renderer는 제한된 IPC만 호출한다.
- SQLite WAL DB가 canonical state다.
- 모든 side effect는 approval 모델을 통과한다.
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

