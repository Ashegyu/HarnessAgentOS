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

## ADR-0007: SQLite transaction은 동기 scope가 소유한다

Status: Accepted (2026-10-27)

Context: 공유 SQLite 연결에서 `BEGIN` 이후 비동기 callback을 기다리면 독립 요청도 `db.inTransaction`을 통해 같은 transaction에 들어간다. 독립 요청이 성공을 반환한 뒤 다른 요청의 rollback으로 데이터가 사라지는 실행 순서를 회귀 테스트로 확인했다.

Decision: 비동기 준비는 transaction 전에 끝내고, `ConversationService.createTask`의 원자 쓰기는 제한된 동기 gateway로 실행한다. `withTransaction`은 Promise/thenable callback을 거부하고 callback이 끝나면 scope를 폐기한다. 동기 중첩은 SQLite savepoint를 사용한다. 기존 외부 서비스와 repository의 Promise API는 동기 primitive에 위임하여 유지한다.

Alternatives: transaction wrapper에 mutex만 두면 wrapper 밖 repository 쓰기는 여전히 혼입된다. 모든 DB 접근에 비동기 ownership/queue를 추가하는 방법은 현재 유일한 draft 생성 경로보다 영향 범위가 크다. 동기 scope는 transaction 중 yield 자체를 제거하여 더 작은 구조로 연결 소유권을 보장한다.

Consequence: 내부 transaction callback은 네트워크/파일 I/O와 비동기 서비스 호출을 할 수 없다. 필요한 상태 쓰기만 동기 primitive를 공유하며 SQL·검증 로직을 중복하지 않는다. renderer IPC, 저장 형식과 migration version은 변경하지 않는다.

## ADR-0008: Worker 완료는 제안 발행과 함께 확정하고 backflow는 같은 시도에서 재개한다

Status: Accepted (2026-10-27)

Context: 실패 로그와 성공 로그가 같은 URI를 사용하고 로그 존재만으로 성공 handoff를 복구했다. 성공 Step과 제안 승인도 따로 저장되어 부분 실패를 완료로 오인할 수 있었다. Backflow는 Pause를 terminal 실패로 만들고 일반 실행의 오래된 결과를 재사용하여 재개 위치와 재시도 예산이 어긋났다.

Decision: 로그는 진단 자료이며, 성공 Step과 제안 승인 전체를 동기 transaction으로 저장한 완료 표식을 복구 조건으로 사용한다. 기존 성공 기록에 이 증거가 없으면 모호한 액션을 다시 발행하지 않고 명시적으로 중단한다. Backflow artifact는 attempt ID로 구분한다. Pause/승인 대기는 같은 running attempt를 유지하고 그 attempt에서 확정한 결과만 복구한다. 품질 backflow의 재개는 기존 main-process progression과 task별 singleflight가 소유한다.

Alternatives: Step 성공 여부만 확인하면 승인 부분 발행 문제는 남는다. 별도 cursor 테이블/JSON 파일은 성공 증거와 또 다른 일관성 경계를 만든다. SQLite의 기존 Step·Checkpoint·Artifact·attempt row를 함께 사용하면 schema 변경 없이 완료와 재개 소유권을 표현할 수 있다.

Consequence: 재개는 같은 attempt의 남은 worker만 실행하고 미해결 제안 승인 앞에서 멈춘다. 실제 replay 실패와 사용자 Pause를 구분하며, 완료 저장의 조건부 UPDATE는 늦은 Pause/Cancel을 보존한다. IPC public API와 schema version은 유지한다. 실제 모델 및 외부 A2A 실행의 exactly-once는 이 결정의 보장 범위가 아니다.

## ADR-0009: 공유 파일·시작 복구·복구 시도 예약의 소유권을 명시한다

Status: Accepted (2026-10-27)

Context: 승인 ID의 실행 claim만으로는 다른 승인이 같은 파일을 덮는 일을 막지 못했다. 별도 앱의 시작 복구도 살아 있는 앱의 claim을 abandoned로 바꿀 수 있었고, RepairLoop의 분리된 조회/삽입은 동시 시도 제한을 우회했다.

Decision: 파일 write/patch는 main-process 전체의 canonical destination queue에서 preimage 재확인과 bound handle 수명을 소유한다. 일반 파일·단일 링크 정책을 적용하고 queue 대기 취소가 후속 owner를 추월시키지 않게 한다. 동일 userData의 Electron single-instance lock 승자만 DB를 열고 시작 복구를 수행한다. RepairLoop는 DB immediate transaction에서 최신 gate·상한·signature 검사와 예약을 함께 수행한다.

Alternatives: 승인 단위 lock은 파일 identity가 다른 승인과 공유될 때 충분하지 않다. OS 전체 분산 파일 lock이나 다중 앱 owner/lease 체계는 현재 로컬 단일 앱 요구보다 크다. RepairLoop의 서비스별 mutex는 다른 연결/서비스를 보호하지 못하므로 DB 예약을 사용한다.

Consequence: 외부 편집자/악의적인 연속 경로 교체와 이미 시작한 파일 쓰기의 rollback은 보장 범위 밖이다. crash recovery와 기존 signature 의미는 유지하며 스키마 변경 없이 적용한다.

## ADR-0010: 감사 마스킹은 실행 payload와 분리한다

Status: Accepted (2026-10-27)

Decision: 공통 redaction은 core의 순수 함수로 두고 learner API를 보존한다. local/A2A의 감사 복사본과 표시 필드에 적용하되 파일 preimage/본문/patch/명령/인수는 실행 원문을 유지한다. 분리된 stream chunk는 bounded invocation buffer에서 안전 경계까지 결합하여 마스킹하고 감사 callback 실패와 자원 정리를 분리한다.

Reason: 모든 string을 재귀적으로 마스킹하면 로그 누출은 줄어도 실제로 승인·실행할 파일 내용과 충돌 검사가 바뀐다. 반대로 chunk별 stateless 마스킹만으로는 JSON key/value가 경계에 걸리는 경우를 막지 못한다. 공유 순수 함수를 core로 옮겨 orchestration이 learner 구현 계층에 의존하지 않도록 한다.

Consequence: 비밀 패턴 탐지는 제한된 감사 정책이며 자격 증명 저장소의 대체물이 아니다. 실행과 정확한 복구를 위한 승인 payload/metadata는 원문이 필요하다. 텍스트 보류 상한을 넘으면 raw 대신 생략 표식을 보내며 callback 순서와 cleanup 수명을 유지한다.

## ADR-0011: 품질 검사는 실제 실행과 현재 입력에 연결한다

Status: Accepted (2026-10-27)

Context: Step 제목의 build/test/smoke 단어와 성공 상태만으로는 검사가 실행됐는지 알 수 없다. Step index와 diff 순서는 외부 수정, 동시에 끝나는 재검사, 변경 후 원상 복구도 구분하지 못한다. CodeChangeLoop의 exit=0 직접 통과 경로에도 같은 문제가 있었다.

Decision: schema 41의 SQLite validation_runs에 승인 claim, 실행 Step, 정확한 명령·argv·cwd·해석된 script identity, 종료 결과와 출력 artifact를 연결한다. 지원되는 실제 실행 모드만 검사 종류를 부여한다. 동일 checker는 단조 증가한 시작 순서의 최신 실행만 사용하고, 실행 중·취소·불확실한 최신 실행에서 이전 성공으로 돌아가지 않는다. CodeChangeLoop도 core의 동일한 순수 증거 선택 정책을 사용한다.

Decision: 검사 시작·종료·품질 평가·완료 시 입력 파일 전체 SHA256과 metadata/inventory 안정성을 확인한다. Git 작업공간은 tracked와 nonignored untracked 파일을 포함하며, 일반 폴더는 versioned dependency/output 제외 정책을 사용한다. 작업공간별 mutation generation과 active owner 수는 내부 write 및 direct workspace-write의 변경 후 복구와 실행 경합을 검출한다. 한도 초과·읽기 실패·모호한 링크는 미검증이다. Gate는 revision/generation/실행 watermark를 저장하고, 완료 직전 재확인과 동기 DB CAS로 최신 gate·미해결 승인·실행·Pause/Cancel 상태를 확인한다. Gate의 최신 순서는 표시 timestamp 대신 SQLite 저장 순서를 사용한다.

Alternatives: 로그 문자열/명령 이름만 강화하면 echo와 오래된 성공을 배제하지 못한다. mtime만 비교하면 내용 변경을 놓친다. 파일시스템 snapshot/복제 실행은 강한 격리를 제공하지만 기존 승인 cwd와 실행 semantics를 크게 바꾼다. 현재 실행을 보존하면서 provenance를 붙이고 불확실하면 미검증으로 남기는 방식을 선택한다.

Consequence: 기존 검사 성공에 provenance가 없으면 재실행이 필요하다. 지원하지 않는 wrapper/실행 모드는 정상 실행해도 품질 통과 증거가 되지 않는다. npm hook은 identity에 포함하되 main script만 검사 종류를 부여한다. 읽기 전용 응답에서 검사/변경을 주장하지 않으면 기존 응답 전달 판정을 유지한다. Toolchain/PATH·설치된 package의 신뢰, 테스트 내용의 충분성, 외부 프로세스의 악의적인 A→B→A 수정과 마지막 파일 확인 이후 외부 수정의 완전 격리는 보장 범위 밖이다. 파일 hashing은 correctness를 위한 추가 I/O이며 성능 개선으로 주장하지 않는다.

## ADR-0012: 선택 수명과 재시도 동의를 별도로 소유한다

Status: Accepted (2026-10-27)

Context: Renderer 상세 응답이 선택 ID와 무관하게 적용되어 이전 작업의 액션이 현재 선택에 나타났다. Retry는 소비된 approval을 재사용하여 Runner의 정상적인 claim 차단과 충돌했다.

Decision: thread/task 선택별 generation과 요청 owner를 두고 이전 수명의 성공·실패를 폐기한다. 동일 선택의 push는 한 후속 pull로 합치고 request owner는 promise 정산 전에 해제하여 microtask 사이의 push를 잃지 않는다. 선택 변경 시 상세의 표시 identity도 검사하고 작업별 panel 수명을 분리한다. 비동기 생성 응답은 요청 당시 선택이 유지된 경우에만 선택을 바꾼다.

Decision: Retry는 이전 실행 결과 검토 후 새 pending/manual approval을 생성한다. schema 42의 원본 `retry_approval_id`가 명시적 검토와 새 동의를 연결하며 원본의 claim/수정/결정을 영구 차단한다. 새 approval·검토 기록·연결·작업 전이는 한 SQLite immediate transaction이다. uncertain은 원본 결과 그대로 보존하되 검토된 원본이 새 승인을 가로막지 않도록 progression/runner/completion이 같은 대체 의미를 사용한다. Worker는 원래 제안의 replacement chain leaf를 기다리고 완료 후 다음 worker만 재개한다. 새 pending/실행은 여전히 완료를 차단한다.

Alternatives: 실행 claim을 지우거나 원본을 성공으로 바꾸면 부분 부수효과와 승인 이력을 숨긴다. UI에서 원본과 같은 내용을 재전송하는 방식은 원자성·재시작·동시 요청을 보호하지 못한다. 별도 retry job/queue 대신 nullable 승인 간 연결과 기존 checkpoint/artifact를 사용한다.

Consequence: 자동 재실행은 없으며 기존 정책/예산·파일 preimage·삭제 snapshot 검증은 유지한다. 검토는 품질 검사 통과를 뜻하지 않는다. 임의 shell의 이전 부분 부수효과를 자동으로 되돌리거나 exactly-once로 만드는 계약은 아니다. Renderer는 계속 typed IPC와 push/pull만 사용한다.

## ADR-0013: A2A의 전체 수신 수명과 UTF-8 context 예산을 제한한다

Status: Accepted (2026-10-27)

Context: Agent Card discovery가 취소/timeout scope 앞에서 대기했고, adapter는 응답 text/artifact/event를 종료까지 누적했다. repository context는 byteLength로 검사한 후 UTF-16 slice로 잘라 한글/emoji에서 예산을 초과했다. SDK의 별도 200,000자 마스킹/절단은 한도 이하 실행 계획도 바꿨다.

Decision: discovery 이전부터 소유한 signal/deadline을 fetch/body·send·iteration에 연결한다. SDK의 Card resolver와 JSON-RPC/HTTP+JSON transport에는 공유 byte meter를 가진 bounded fetch를 주입한다. decoded event·artifact의 JSON 크기와 복잡성도 저장/표시 전에 검사한다. adapter는 최종 text의 구분자 byte와 event/artifact 누적량을 검사하고 기존 bounded event buffer를 diagnostic tail에 재사용한다. 초과는 명시적 실패이며 partial payload를 성공으로 전달하지 않는다. 비협조 Promise/return의 정산을 무한정 기다리지 않되 late body/stream을 정리하고 모든 거절을 관찰한다.

Decision: 실행용 remote 원문은 예산 안에서 보존하고 감사 복사본만 기존 main 경계에서 마스킹한다. prose/fenced JSON 속 문자열 값에도 재귀적인 감사 검사를 적용한다. context는 marker byte를 먼저 예약한 뒤 유효한 UTF-8 prefix를 선택하며 summary의 UTF-16 경계도 보존한다.

Alternatives: discovery 이후 timeout만 두거나 SDK parsing 뒤 크기를 확인하면 I/O 대기와 parsing 전 buffer가 보호되지 않는다. 출력 tail만 남겨 성공시키면 실행 계획 일부를 잃을 수 있다. 별도 서버·process·새 transport를 추가하지 않고 설치된 SDK의 fetch seam과 순수 자원 정책을 사용한다.

Consequence: 기본 수신 body 4 MiB, event 4,096개, artifact 128개 등 명시적 상한을 넘는 endpoint는 실패하고 사용자 검토 대상이 된다. 임의 외부 서버의 작업 중단, live A2A 호환성, process 전체 RSS 상한을 보장하지 않는다. SDK가 이미 넘긴 사용자 정의 JS 객체의 사전 allocation을 되돌릴 수도 없다. 스키마 42와 IPC 계약은 유지하며 소켓/localhost 서버나 dependency를 추가하지 않는다.

## ADR-0014: RepairLoop의 실패 identity를 기록 identity에서 분리한다

Status: Accepted (2026-10-27)

Context: F10의 예약 원자성은 보장했지만 signature에 artifact ID가 포함되어 같은 검사 실패를 다시 기록하면 중복 제한을 우회했다. ID만 제거하면 일반적인 `tests failed` 위험 문구를 가진 서로 다른 checker 실패까지 합쳐진다.

Decision: 상태·build/tests/smoke 결과와 정확한 위험 집합을 기본 identity로 사용한다. gate의 evidence artifact에 연결된 실제 실패 validation 실행이 있으면 checkerId·검사 종류·종료 코드 집합을 추가한다. ID·시각·workspace revision은 제외하고 집합은 정렬·중복 제거한다. 새 hash는 `quality-v2:` prefix로 구분하며 저장소에서 계산한다.

Decision: 기존 immediate 예약 transaction 안에서 모든 이전 attempt의 원본 gate와 해당 gate의 실행 증거를 재구성한다. 과거 hash를 수정하거나 새 정책 적용 시 예산을 초기화하지 않는다. 한쪽 증거가 부족하면 기본 identity로 보수적으로 반복을 차단하고, 손상되거나 다른 task에 연결된 원본은 판정 불가로 차단한다. 최신 gate·시도 상한·다른 task의 독립성·모델 호출 전 예약은 유지한다.

Alternatives: artifact ID만 삭제하면 다른 checker를 합친다. 이전 hash만 새 hash와 비교하면 업그레이드 직후 동일 실패가 한 번 더 허용된다. 로그/stack trace를 임의 정규화하면 root cause를 추측하고 진단의 중요한 경로·숫자를 지울 수 있다. 새 테이블/스키마 대신 SQLite에 이미 저장된 gate와 실행 원장을 재사용한다.

Consequence: 판정 단위는 gate/검사 결과이며 같은 검사·종료 코드·위험으로 나타나는 다른 assertion을 구분하지 않는다. 증거가 없는 legacy 이력은 보수적으로 멈출 수 있다. 기본 시도 상한은 2회이고, 상한 도달 시 count만 읽어 중단한다. 허용된 이전 시도와 해당 task의 실행 원장을 동기 비교하는 읽기 비용이 추가되며 로그 파일/전체 workspace를 읽거나 모델을 호출하지 않는다. 스키마 42와 IPC는 유지한다.

## ADR-0015: 병렬 worker의 실패 뒤에도 시작한 lane의 소유권을 정산한다

Status: Accepted (2026-10-27)

Context: F17의 실제 WorkerRunner/SQLite 회귀에서 지연된 liveness 조회 후 마지막 item을 두 lane이 예약해 undefined worker를 실행했다. 저장/발행 예외에서는 Promise.all이 먼저 reject하여 service singleflight를 해제한 뒤에도 다른 lane이 DB에 기록했다.

Decision: liveness await 직후 실패 latch와 남은 범위를 다시 검사하고 await 없이 index를 예약한다. 최초 관측한 예외를 보존해 새 배정을 멈추되, 시작한 lane의 실행과 직렬 발행은 모두 정산한다. 이후 원래 예외를 반환하므로 service의 in-flight 소유권은 정산까지 유지한다. 성공한 형제 worker의 완료/proposal 원자 기록은 보존하여 명시적 복구에서 재발행하지 않는다.

Alternatives: Promise.allSettled만 적용하면 실패 이후 새 worker 배정이 계속된다. task 전체를 취소하면 Pause/명시적 재개의 의미와 다른 실행까지 바꾼다. 별도 scheduler/cancellation API 대신 기존 lane과 최초 오류 latch만 사용한다.

Consequence: 시작한 worker는 기존 timeout/취소 계약 안에서 종료를 기다린다. 일반 worker의 failed 결과와 backflow 정책은 그대로다. 영원히 정산하지 않는 사용자 주입 adapter를 강제로 종료하는 계약은 아니다. 외부 프로세스의 OS 종료 확인은 기존 Runner/Agent 경계를 따른다.

## ADR-0016: 의존성 audit과 실제 런타임 호환성을 함께 검증한다

Status: Accepted (2026-10-27)

Context: npm audit의 high 8개 패키지를 재확인했다. Electron은 devDependency여도 배포 runtime이며, audit fix의 최신 major 일괄 적용은 native ABI와 앱 실행을 검증하지 않는다. 작은 입력으로 Zod collection 크기 제한 전 요소 순회, fast-uri encoded scheme 활성화, source-map-js offset 검증 누락을 재현했다.

Decision: 기존 dependency 범위 안의 보안 패치를 lockfile에 적용하고 Electron은 보안 완화가 있는 42.11.16으로 두 manifest를 함께 고정한다. ABI 145→146의 실제 SQLite 로드 실패를 확인한 뒤, 공식 Windows x64 ABI 146 prebuilt가 있는 같은 12.x의 better-sqlite3 12.11.1을 사용한다. 설치 script를 일괄 실행하지 않고 필요한 Electron/native 설치만 명시적으로 실행한다. SQLite schema/IPC는 바꾸지 않는다.

Decision: audit 숫자와 노출 경로를 분리한다. http-cache-semantics의 private 응답은 다운로드 caller의 storable guard 때문에 저장되지 않으며, 저장 불가 응답의 reuse 함수를 직접 호출하는 probe를 앱의 결함으로 간주하지 않는다. 메모리 request/cache를 연결한 정상 public hit와 private 미저장을 확인한다. 권고와 upstream 반박을 함께 기록한다.

Consequence: npm audit 0건은 registry dependency 판정이며 Electron에 내장된 Node/Undici/Chromium 전체의 취약점 부재를 뜻하지 않는다. Electron 42.11.16의 내장 Undici 7.29.0은 npm의 갱신된 7.30.1과 별개다. 현재 A2A는 권고 대상 EventSource/decompress interceptor를 사용하지 않고 기존 bounded fetch/reader를 사용하므로 추측만으로 HTTP transport를 추가하지 않는다. 향후 해당 API 사용 시 재검토한다. 개발 bundle뿐 아니라 unpacked Windows 앱에서도 승인·파일 생성·재시작·품질 완료 흐름을 검증하며 게시·배포·서명 인증을 대신하지 않는다.

## ADR-0017: 앱 종료는 새 작업 차단과 소유한 작업의 정산을 거쳐 저장소를 닫는다

Status: Accepted (2026-10-27)

Context: main은 will-quit에서 DB를 즉시 닫았다. 보존된 수정 전 Windows 앱과 실제 사설 CLI fixture를 연결하니 종료 요청 8초 뒤 worker/자식/손자 PID가 모두 살아 있었다. 승인된 Runner 실행은 재시작 후에도 작업/Step의 실행 상태가 정산되지 않았다. shell 종료를 failed로 확정하는 첫 테스트 기대는 기존 uncertain/부분 부수효과 계약에 맞지 않아 바로잡았다.

Decision: before-quit에서 IPC와 새 Agent/Runner 진입을 먼저 봉인한다. 현재 실행 및 준비 작업을 먼저 Pause하여 progression/추천 준비/자동 품질/backflow의 새 배정을 멈춘다. 정산 후 단독 Agent/Runner는 blocked로 남겨 기존 수동 재계획·실행 결과 검토 경로를 사용하고, pipeline은 paused로 보존하여 명시적 Resume을 기다린다. 기존 사용자 Pause는 바꾸지 않는다. 공통 AsyncWorkScope는 entry부터 finally cleanup까지 Promise를 소유한다. IPC 21개 등록 모듈은 같은 진입 scope를 사용하며, core에는 Node/SQLite 의존성을 추가하지 않는다.

Decision: 로컬 invocation/Runner는 기존 AbortController와 승인 claim 규칙으로 취소한다. A2A router는 호출 수명의 signal을 소유해 remote worker도 abort·정산한다. 준비 단계, invocation 발행 전후, queued/in-flight CLI, schema/MCP cleanup, 부모 orchestration, IPC handler, heartbeat의 진행 중 read 및 startup까지 정산한 뒤에만 DB를 닫고 최종 app.quit을 허용한다. 종료 중 새 CLI/승인 실행을 시작하지 않는다.

Alternatives: will-quit에서 취소만 발행하면 async cleanup 전에 DB/host가 종료된다. 고정 sleep과 process 이름 기반 일괄 kill은 정산/소유권 증거가 없다. DB claim을 성공/실패로 덮거나 TaskRun 전체를 cancelled로 만들면 부분 부수효과와 명시적 재개의 의미를 바꾼다. 새 서버/IPC 채널/외부 scheduler 없이 기존 수명 경계에 봉인·대기를 추가했다.

Consequence: 정상 창 닫기/quit의 drain 제한은 20초다. 시간 초과·프로세스 트리 정리 미확정·확인된 저장 실패에는 DB를 열어 두고 오류를 알린다. 새 실행 차단은 유지하며 자동 강제 종료나 cleanup 실패의 자동 해제는 하지 않는다. 시간 초과 뒤 작업이 실제로 정산되면 종료를 재시도할 수 있다. arbitrary shell은 uncertain 및 수동 검토 정책을 유지하고 pipeline의 미소비 승인/미완료 worker를 자동 재생하지 않는다. Windows 실제 fixture CLI/Node tree와 무관한 Node 보존을 검증하며 실제 모델은 호출하지 않는다. OS 강제 종료·전원 차단·원격 서버의 작업 중단·다른 OS의 process tree 보장은 이 검증 범위 밖이다.

## ADR-0018: 최근 명령과 알림은 필요한 metadata와 제한된 fresh pull만 읽는다

Status: Accepted (2026-10-27)

Context: 300 threads/3,000 tasks/10만 gates의 private WAL 부하에서 팔레트는 최근 10개를 위해 모든 thread의 answer history를 읽었다. P95 약 81ms와 큰 임시 heap을 관측했다. 실제 앱에서는 40개 thread IPC와 동일 task push 100개에 상세 100회/품질 100회가 겹쳤다. 품질 gate 조회는 다른 task의 모든 행을 스캔했다.

Decision: typed state.listRecentTaskRuns는 정수 1..100의 LIMIT을 SQLite에서 적용하고 TaskRun/contract/thread 제목만 반환한다. 팔레트는 10을 요청하고 선택 완료 시 기존 상세 경로를 사용한다. schema 43의 updated_at 인덱스와 task-scoped quality 인덱스를 idempotent하게 추가하며 gate 최신성은 기존 rowid 순서를 유지한다. 새 결과 캐시는 두지 않는다.

Decision: NotificationTray는 task별 active 1 + trailing 1 요청으로 push를 합치고 서로 다른 task의 조회를 최대 4개로 제한한다. 받은 detail의 gate 삽입 순서에서 최신 결과를 사용해 품질 IPC를 중복 호출하지 않는다. dispose는 queued 요청과 늦은 publish를 차단하며 실행 중 IPC의 main 소유권은 기존 종료 scope가 유지한다. 이는 notification read의 동시성 제한이며 model/worker 실행 정책은 바꾸지 않는다.

Alternatives: 처음 10개 thread만 읽으면 오래된 thread의 최신 task를 누락한다. 전체 detail을 cache하면 mutation/승인 최신성 무효화가 복잡하다. 임의 sleep/debounce는 완료를 보장하지 않는다. 전체 SQLite를 worker thread로 이전하거나 새로운 서버/추상 계층을 만드는 대신 bounded read와 작은 조회 queue를 사용한다.

Consequence: 팔레트/알림의 조회량을 줄이며 단일 큰 conversation 전체 history 로딩은 별도 후보로 남는다. 합성 warm 저장소 지연/처리량/관측 heap과 실제 IPC 개수를 구분한다. P95/P99를 운영 SLA나 UI frame latency로 주장하지 않는다. 인덱스 저장 공간과 기존 DB 적용 비용도 기록한다. 절대 시간 테스트 대신 query plan/호출 수/동시성/최신 결과/실패 후 슬롯 해제/이전 데이터 보존을 회귀로 고정한다.

## ADR-0019: 복사 진입은 선택한 답변 뷰의 확정된 수명에 연결한다

Status: Accepted (2026-10-27)

Context: TaskRun 선택 직후에는 thread detail의 저장 답변 fallback이 보이고, TaskRun detail 응답 후에는 invocation stream 뷰로 교체된다. 실제 앱에서 두 응답을 barrier로 제어하니 기존 버튼에서 복사 IPC가 성공한 뒤 해당 DOM이 제거되고 새 답변 버튼은 초기 상태로 나타났다. 수정 전 패키지에서도 동일 회귀가 2회 연속 재현됐다. 위치 기반 saved-answer locator는 교체 후 다른 task의 버튼을 검사할 수 있었다.

Decision: WorkbenchShell이 선택 ID에 일치하는 detail ready/error 정산 여부를 명시적으로 내려 준다. pending인 선택의 복사만 비활성화하고 버튼의 직접 handler도 같은 조건을 검사한다. 저장 fallback·중간 response·final section·inline 뷰에 이 상태를 전달한다. 다른 task의 안정된 저장 답변은 계속 복사하며, detail 오류로 fallback이 유지되면 복사가 다시 가능하다. IPC/OS clipboard 구현과 schema/dependencies는 바꾸지 않는다.

Alternatives: sleep·timeout 확대·테스트 재시도로 경합을 가리지 않는다. 뷰 교체를 가로지르는 전역 복사 결과 cache/context를 추가하면 answer identity·내용 변경·수명·메모리 정리 규칙이 필요하다. pending 단계의 임시 버튼에서 새 side effect를 시작하지 않는 작은 guard로 경합을 막고 기존 text/request generation 검사를 보존한다.

Consequence: 현재 선택한 상세를 불러오는 동안만 복사 버튼이 잠시 비활성화된다. 실패 후 readonly fallback의 복사와 다른 task의 복사를 잠그지 않는다. 회귀는 TaskRun identity에 고정하고 서로 다른 답변을 사용한다. 성공/오류 순서, 실제 clipboard 원문, 언어 변경, 빠른 중복 클릭, OS 실패 후 재시도/키보드 경로를 반복 확인한다. 계획 반환은 자동 품질/완료 정산이 아니므로 E2E fixture는 canonical done을 확인한 뒤 한 immediate transaction으로 합성 답변을 저장한다. 준비 중 SQLITE_BUSY와 UI 회귀를 구분한다. 같은 버튼 문구라도 실제 OS 쓰기 실패일 수 있어 IPC 결과를 확인한다. Windows 잠금 중 OpenClipboard 접근 거부/APP_CLIPBOARD_WRITE_FAILED를 별도 관측했으며 클립보드 권한이나 기존 재시도 상한을 바꾸지 않는다.
