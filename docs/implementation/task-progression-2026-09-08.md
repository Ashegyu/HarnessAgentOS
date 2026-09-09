# 승인·실행·답변·완료 흐름 정리

범위: 화면에 의존하던 진행을 메인 프로세스로 모으고, 실제 실행과 답변 표시를 구분한다. 새로운 오케스트레이션 프레임워크나 단계별 확장은 추가하지 않는다.

## 완료 기준과 구현

| 사용자 상황 | 동작과 근거 |
| --- | --- |
| 작업 입력 | `conversation.startTask` 한 번 제출. main에서 계약·TaskRun 생성, 추천 준비 또는 선택한 파이프라인/하네스 초안 생성 |
| 추천 준비 중 | main의 준비 잠금으로 후보 생성 도중 AI 시작 방지. SQLite host snapshot에 준비 완료 기록 |
| 선택적 추천 승인/거절 | 후보를 모두 결정한 뒤 main이 AI를 한 번 시작. 거절된 후보는 사용하지 않음 |
| 파일 생성·수정 승인 | `승인 후 실행` 한 번. revision을 승인하고 main이 runner 실행을 이어감 |
| 자동 승인 | 기존 정책을 main에서 판정. 프로필 차단·예산·읽기 전용 계약·수동 확인 의무가 우선 |
| shell·삭제·승인 내용 변경 | 개별 확인 유지. 자동 승인 또는 파이프라인 선택으로 우회하지 않음 |
| 화면 이동·새로고침 | 실행 소유자는 main. renderer는 push 이벤트를 받은 뒤 DB의 fresh detail을 조회 |
| AI 답변 도착 | `AI 답변`으로 표시. 이 사실만으로 작업 완료나 파일 저장 성공을 표시하지 않음 |
| 실행 종료 | 전체 checkpoint의 미결 승인, 실행 중 step/invocation, 불명확 실행 상태를 확인한 뒤 QA |
| QA 통과 | 증거가 충족된 passed만 자동 완료. warning은 사용자 위험 확인, failed는 실패 처리 |
| 처리 오류 | 실패 step과 진단 log를 저장하고 blocked로 표시. 이미 취소·일시정지·완료된 작업은 되살리지 않음 |

## 책임 경계

- `ConversationStartService`: 일반 입력창의 요청 한 번을 받아 비동기 준비. 선택한 경로가 잘못되면 다른 경로로 몰래 전환하지 않고 실패를 저장한다.
- `TaskProgressionService`: task별 singleflight, 변경 이벤트 병합, 준비 잠금, 최신 승인 순서, 실행, QA를 조정한다. 진행 변화 없는 continuation을 반복하지 않는다.
- `task-progression-host`: SQLite 조회, 활성/기본 프로필과 예산 확인, 기존 오케스트레이션 계획 포맷 복원, 오류 저장.
- `ConversationService` / runner: 승인의 현재 revision, 수동 동의, 승인 단일 소비, 실행 잠금과 파일 경계 검사를 유지한다.
- `TaskRunCompletionService`: QA 결과뿐 아니라 미결 승인과 실행 상태를 확인한다. 비동기 trace 기록 후 QA/승인 상태를 다시 확인한다.
- Renderer: 요청·명시적 사용자 결정·상태 표시만 담당. localStorage를 실행 동의의 기준으로 사용하지 않는다.

SQLite WAL, typed IPC, renderer Node 격리, core의 storage import 금지를 유지한다. 신규 schema migration은 없다. 기존 `conversation.createTask`는 낮은 수준의 호환 API로 남기고, 일반 입력창은 `startTask`를 사용한다.

## HTML 보고서 저장

`분석해서 HTML 파일로 저장해줘`는 자동 작업 목적에서 change로 분류한다. 사용자가 리뷰 전용이나 읽기 전용을 명시했다면 이를 덮어쓰지 않는다.

보고서 전용 저장은 실행 완료된 file_write 승인과 실제 파일의 경로·확장자·크기·내용이 일치하는지 host가 확인한다. 보고서 파일 전달에 관계없는 코드 테스트가 없다는 이유만으로 warning을 만들지 않는다. 코드 수정·shell 등이 섞인 작업이나 명시적으로 요구한 테스트는 이 예외에 포함하지 않는다. 보고서 **내용의 사실성까지 자동으로 증명하는 기능은 아니다**.

비어 있는 host 파일 변경 snapshot(`Changed files: 0`, 비잘림, 빈 manifest)은 코드 변경으로 취급하지 않는다. 모델이 임의로 쓴 같은 문구나 잘린 snapshot은 변경 증거에서 제외하지 않는다.

## 재실행·호환성 경계

- 실행 중/결과 불명확 승인에는 자동 재시도를 하지 않는다. 파일 runner의 승인 단일 소비/SQLite claim을 유지한다.
- 오케스트레이션은 동일 main 프로세스에서 동시 실행 요청을 병합한다. 외부 CLI나 OS 작업의 모든 crash 경계를 포함한 보편적 exactly-once 보장은 아니다.
- 앱 부팅만으로 과거의 pending 작업을 실행하지 않는다. 화면 새로고침과 main 종료/재시작은 서로 다른 상황이다.
- 오래된 템플릿 작업의 내용 없는 `file_write` 승인을 임의 실행하거나 삭제하지 않는다. 새 흐름을 검증할 때는 새 요청으로 시작한다. 기존 운영 DB/승인을 일괄 변경하지 않았다.
- 실제 CLI가 반환하는 제안의 품질, OS 파일 교체 경쟁, 외부 도구 동작 등은 별도 경계로 남는다. 안전 확인을 없애서 진행을 강제하지 않는다.

## 검증 방식

- 회귀 테스트에서 실패를 먼저 확인한 뒤 수정했다. IPC 계약 목록과 기존 E2E의 ‘승인 후 별도 실행’ 전제도 새 계약에 맞게 갱신했다.
- 전체 워크스페이스 타입 검사, 단위·통합 테스트, Electron 빌드, 실제 Electron E2E를 수행한다.
- E2E는 임시 userData/프로젝트와 가짜 AI 응답을 사용한다. file/shell runner·IPC·SQLite·Electron 휴지통 API는 실제 경로를 사용한다. 운영 DB와 유료 AI 호출은 사용하지 않는다.
- 검증 항목: HTML 저장(수동/자동), 화면 새로고침, 승인 전 실행 차단, 수정된 승인 재확인, 20회 중복 실행 차단, 파일 수정·patch, CLI 인수 보존·취소, 휴지통 삭제, crash claim 재생 방지, 병렬 작업 수 제한·취소, 응답/리뷰 QA, 모델 예산, 복사와 언어 전환.
- 전체 저장소 커버리지와 새 진행 서비스의 커버리지는 구분한다.

## 최종 실행 결과 (2026-09-08, KST)

| 검증 | 결과 |
| --- | --- |
| `npm run check` | 전체 워크스페이스 통과 |
| 전체 `.test.mjs` 단위·통합 테스트 | 1,747개 중 1,745개 통과, 실패 0, 건너뜀 2 |
| 건너뜀 사유 | 별도 `../harness-100` 샘플 저장소가 없는 환경에서만 생략되는 디렉터리 import 테스트 2개 |
| 새 진행 서비스 4개 커버리지 | 줄 98.06%, 분기 88.08%, 함수 89.29% (42개 관련 테스트) |
| `npm run build` | Electron main/preload/renderer 빌드 통과 |
| 전체 Electron E2E | 18개 모두 통과 (58.9초) |
| Windows 패키지 | 기존 `apps/desktop/release/win-unpacked` 갱신, EXE 시각 15:06:22 |
| 패키지 EXE 별도 검수 | EXE를 임시 프로필로 실제 실행하여 수동·자동 HTML 저장 2개 통과 (17.2초) |
| `git diff --check` | 공백 오류 없음 |

native ABI 충돌을 피하기 위해 단위·통합 테스트는 설치된 Electron을 `ELECTRON_RUN_AS_NODE=1`로 실행하여 Node test runner와 tsx로 수행했다. `npm run test`의 `rebuild:node`로 운영용 Electron native 모듈을 바꾸지 않았다. 전체 저장소 커버리지를 측정한 결과로 위 98.06%를 해석하면 안 된다.

빌드·패키징 경고: 기본 Electron 아이콘, package author 미지정, workspace 의존성 중복 참조 안내. 실행 검수를 막지는 않았다. 별도 lint 스크립트나 전체 의존성 취약점 감사 결과를 주장하지 않는다. 운영 데이터 변경, Git commit/push, 실제 유료 모델 호출은 하지 않았다.
