# 2026-10-27 안정성·성능 수정 정리

최초 분석 후 이 대화에서 진행한 수정과 기존 검증 결과를 정리한다.
이 문서와 통합 커밋을 준비하는 단계에서는 사용자 요청에 따라 테스트·빌드·benchmark를 추가 실행하지 않았다.

## 수정 내용

### 실행 상태와 저장소 소유권

- 비동기 준비와 동기 SQLite transaction scope를 분리하여 독립 작업의 쓰기가 함께 rollback되는 경합을 차단했다.
- 준비 중 취소, Pause 이후 결과 발행, 늦은 상태 갱신에서 사용자 상태를 덮지 않도록 수명과 조건부 전이를 보강했다.
- 파일 쓰기/patch의 canonical 경로·preimage·공유 파일 소유권을 재확인하여 승인 뒤 변경과 동시 쓰기를 거부한다.
- 단일 앱 인스턴스가 저장소 복구를 소유하며 다른 프로세스가 살아 있는 실행 claim을 회수하지 않는다.

### Worker·backflow·복구

- 실패한 worker log를 성공으로 복구하지 않는다. 최신 실행 상태와 원자적인 제안 발행 완료를 함께 확인한다.
- 기존 worker 완료·제안과 backflow 시도의 identity를 보존하여 명시적 재개에서 중복 실행/발행을 막는다.
- 병렬 worker는 실패 관측 후 새 배정을 멈추고, 이미 시작한 lane과 결과 발행의 정산을 기다린다.
- 동일 실패 signature에서 artifact/실행 ID를 분리하고, 실제 checker·종료 코드·위험 및 원본 이력으로 중복 복구를 제한한다.

### 품질 증거와 완료 판정

- 검사 제목이나 성공 주장만으로 통과시키지 않고 실제 host 검사 실행 원장과 결과 provenance를 사용한다.
- workspace fingerprint·mutation generation·watermark를 연결하여 변경 후 오래된 성공 결과를 거부한다.
- 품질 평가, CodeChangeLoop와 최종 완료 판정에서 최신 gate 및 실행·승인 상태를 재확인한다.
- 이전 이력의 실행/변경 증거가 없거나 손상되어 판정할 수 없으면 재검사를 요구한다.

### 모델 입력·A2A·감사 기록

- discovery부터 응답 수신/reader cleanup까지 취소·시간·응답 크기 한도를 적용한다.
- context 예산을 UTF-8 실제 byte 기준으로 제한한다.
- 실행에 쓰는 payload/preimage/인자와 감사용 마스킹 사본을 분리하고 스트림 기록의 비밀 값 노출을 제한한다.
- agent output parser의 누락/손상 입력 및 envelope 경계를 보강한다.

### 선택·재시도·복사 UI

- 선택 ID와 요청 generation을 함께 확인하여 늦은 성공/오류가 현재 선택의 답변과 action을 바꾸지 못하게 한다.
- 이미 소비된 승인을 재사용하지 않고, 실행 결과 검토 후 새 수동 승인을 생성하는 Retry 경로를 제공한다.
- 선택한 상세 응답이 대기 중인 임시 답변 뷰에서는 복사를 시작하지 않는다. 상세 오류로 저장 답변을 유지하면 복사가 다시 가능하다.
- 복사 회귀를 task identity에 고정했다. 실제 OS 쓰기 실패와 UI 버튼 교체를 별도로 관측하고 원문·키보드·언어 전환·오류 복구를 반복 확인했다.
- 복사 fixture는 계획 반환 뒤 자동 품질/완료의 canonical done 정산을 기다린 후 합성 답변을 기록한다.

### 앱 종료

- 신규 IPC/Agent/Runner 진입을 봉인하고 취소·결과 저장·MCP/schema cleanup·background 작업을 정산한 뒤 SQLite와 앱을 종료한다.
- 준비 단계부터 작업을 소유하여 controller 등록 전 틈으로 실행이 빠져나가지 않게 한다.
- 정리/저장 실패 또는 timeout이면 저장소를 열어 두고 오류를 알린다. 자동 강제 종료나 미확정 실행의 성공 처리는 하지 않는다.
- 임의 shell의 uncertain 및 수동 검토를 보존하고, 단독 실행의 blocked 복구와 pipeline의 paused 재개 경로를 구분한다.

### 의존성·성능

- Electron 42.11.16과 ABI 146에 맞는 better-sqlite3 12.11.1을 사용하고 관련 dependency audit 후속 패치를 적용했다.
- 현재 schema는 43이다. 검증 실행 원장, 수동 재시도 연결, 품질 task 인덱스와 최근 작업 인덱스를 포함한다.
- 최근 명령은 모든 thread/답변을 읽지 않고 SQLite의 제한된 metadata query로 얻는다.
- 알림 push는 task별 active 1회와 trailing 1회로 합치고 서로 다른 task의 알림 pull은 최대 4개로 제한한다.
- 품질 조회의 전체 테이블 scan을 task 인덱스 탐색으로 바꿨다. 재현 benchmark와 전후 요약을 저장했다.

## 이미 완료한 최종 검증

아래는 커밋 준비 이전에 실행해 보존한 결과다. 이번 커밋 작업에서 재실행하지 않았다.

| 항목 | 기록된 결과 |
| --- | --- |
| 전체 Node 회귀 | 2,161개: 2,150 통과, 샌드박스 환경 실패 8, skip 3 |
| 위 환경 실패가 있는 동일 7파일의 외부 재검증 | 48/48 통과 |
| 전체 실제 Electron UI | 35/35 통과 |
| 답변 복사 집중 Node 회귀 | 62/62 통과 |
| 개발 앱 복사 3경로 × 5회 | 15/15 통과 |
| Windows unpacked 패키지의 동일 복사 반복 | 15/15 통과 |
| 타입·빌드·Windows packaging | 통과 |

실제 클립보드 반복 검증은 사용자가 Windows 잠금을 해제한 상태에서 순차 실행했다.
잠금 중에는 Win32 OpenClipboard 접근 거부 5와 APP_CLIPBOARD_WRITE_FAILED를 관측했으며 이를 UI 경합과 구분했다.
모델은 fake/stub을 사용했고, 프로세스 종료 회귀는 사설 CLI fixture와 실제 자식·손자 프로세스를 사용했다.

## 기록된 성능 비교

300 threads / 3,000 tasks / 12,000 artifacts / 100,000 gates의 private WAL에서
5회 warm-up 후 100회 측정한 첫 전후 결과다. 최종 반환값 JSON 직렬화를 포함하며 실제 화면 입력 지연/SLA는 아니다.

| 항목 | 수정 전 | 수정 후 |
| --- | ---: | ---: |
| 최근 작업 조회 P95 | 80.672ms | 0.116ms |
| 오래된 task의 최신 품질 조회 P95 | 2.100ms | 0.027ms |
| 최근 명령의 관측 peak heap 증가 | 96.277MiB | 2.565MiB |
| 실제 앱의 같은 task push 100개에 따른 IPC | 상세 100 + 품질 100 | 상세 2 + 품질 추가 0 |

재현 절차는 [성능 검증 문서](performance-verification.md), 전후 반복 요약은
[benchmark 기록](../../.ecc/benchmarks/workbench-load-2026-10-27.json)에 있다.
설계 결정은 [ADR-0007~0019](../architecture/architecture-decisions.md), public 계약은
[IPC 계약](../contracts/ipc-contracts.md)에 정리했다.

상세 원본 로그·HTML 보고서·unpacked 앱은 이 작업의 외부 시각화 산출물 폴더에 보존했으며 Git에는 포함하지 않는다.

## 남은 검증 범위

- 큰 단일 conversation history와 workspace fingerprint I/O의 부하 확대
- 여러 task를 합친 전역 worker process 예산과 장시간 soak
- 실제 모델/외부 A2A 부하, 다른 OS 및 운영 PC/GPU 수용성

이번 커밋은 지금까지 완료한 수정·회귀 코드·문서·benchmark 기록을 보존한다. 게시·배포나 미검증 운영 보장을 뜻하지 않는다.
