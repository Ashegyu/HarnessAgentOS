# Architecture Decisions

이 문서는 HarnessAgentOS의 주요 아키텍처 결정을 기록한다. 결정을 바꿀 때는 기존 항목을 삭제하지 말고 새 ADR을 추가한다.

## ADR-0001: 새 프로젝트로 시작한다

Status: Accepted

Decision: HarnessAgentOS는 ClaudeAgentSystem 내부 리팩터링이 아니라 `C:\Users\FORYOUCOM\Desktop\Code\HarnessAgentOS` 새 프로젝트로 시작한다.

Reason: 기존 시스템은 CEO/pipeline/멀티 에이전트 자동 진행이 중심이고, 새 목표는 사용자 감독형 Harness OS다. 기존 구조 안에서 바꾸면 자동화 경로가 새 UX를 계속 오염시킬 가능성이 크다.

Consequence: ClaudeAgentSystem은 직접 수정하지 않고, Skillify/Learner/quality/runner/targetDir 개념의 참고 소스로만 사용한다.

## ADR-0002: 서버 없는 Electron 앱을 MVP 기준으로 한다

Status: Accepted

Decision: Express, localhost API, WebSocket server를 MVP에서 사용하지 않는다. Electron main process와 preload IPC로 로컬 기능을 제공한다.

Reason: 목표 사용 방식은 로컬 파일 수정, 테스트 실행, git, CLI runner, artifact 확인이다. 서버는 포트 충돌과 운영 복잡도를 늘린다.

Consequence: renderer는 IPC API만 사용하고, main process가 모든 로컬 권한을 소유한다.

## ADR-0003: SQLite WAL DB를 canonical state로 한다

Status: Accepted

Decision: Thread, TaskRun, Step, Checkpoint, Approval, Artifact, QualityGateResult, Capability, LearningTrace는 SQLite WAL DB에 저장한다.

Reason: 앱 재시작 후 이어서 작업하기, checkpoint/resume, artifact ledger, quality evidence를 안정적으로 유지해야 한다.

Consequence: JSON은 export/debug snapshot으로만 사용한다.

## ADR-0004: Side effect는 approval 없이 실행하지 않는다

Status: Accepted

Decision: 파일 쓰기, shell 실행, dependency 설치, git commit, network, skill script는 approval 모델을 통과해야 한다.

Reason: 기존 프로젝트의 가장 큰 문제는 사용자가 중간에 개입하지 못하고 자동 진행을 신뢰해야 한다는 점이었다.

Consequence: 모든 runner는 approval id를 입력으로 받고, policy가 승인 상태를 확인한다.

## ADR-0005: Skillify와 Learner는 추천 계층이다

Status: Accepted

Decision: Skillify와 Learner는 자동 실행 주체가 아니라 capability/recommendation/advisory 계층으로 둔다.

Reason: 기존 자산의 가치는 크지만, 숨겨진 자동 적용자가 되면 사용자 통제 문제를 반복한다.

Consequence: skill script 실행과 learner 추천 채택은 approval 또는 사용자 선택을 거친다.

## ADR-0006: CEO/pipeline은 Phase 7의 선택 기능이다

Status: Accepted

Decision: CEO/pipeline orchestration은 MVP 기본 경로에 넣지 않고, Phase 7에서 advanced feature flag 아래 재검토한다.

Reason: 초기 제품 가치는 대화 연속성, checkpoint, approval, artifact, quality gate다. orchestration은 이 흐름이 안정된 뒤에만 얹을 수 있다.

Consequence: orchestration도 Harness checkpoint/approval/quality gate를 우회할 수 없다.
