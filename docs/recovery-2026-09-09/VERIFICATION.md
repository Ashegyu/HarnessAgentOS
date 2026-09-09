# 핵심 실행 경로 복구 — 구현 및 검증 기록

2026-09-09 KST. 범위: 기능 추가 없이 요청 분기, 구조화 응답, 승인, 단계 진행, 결과 검증, 복사.

## 재현한 결함과 변경

| 결함 | 재현 근거 | 수정 계약 |
| --- | --- | --- |
| 선택한 하네스가 읽기 전용/검색 금지 조건에서 조용히 사라짐 | main 시작 서비스 회귀 테스트 3건에서 예상한 거절이 발생하지 않음 | `taskRouteConflict`를 화면과 main에서 공유. 태스크 생성 전에 충돌을 반환하고 입력 보존. 명시적 선택 해제 제공 |
| 정상 JSON 안의 코드 블록을 바깥 펜스 끝으로 처리 | 실행 파서는 정상 입력을 거절하고 화면은 raw JSON을 표시하는 테스트 모두 실패 | `extractAgentPlanEnvelope`에서 문자열과 escape 상태를 추적. JSON/schema/실행 승인 검증은 그대로 유지 |
| HTML 하네스가 조사 후 작성자 예산에서 중단 | 실제 seeded 하네스 E2E에서 Planner 성공 후 HTML Report Documenter가 USD 비용 미확인으로 실패 | 모든 선택 프로필을 계획 생성 전에 검사. 준비 상태 경고와 실행 시 오류에 단계/프로필/설정 안내 포함. 기존 예산 보존 |
| 위험 확인을 하지 않아도 승인 버튼이 눌림 | SSR 테스트에서 승인 버튼이 활성화됨. 클릭 시 내부 확인 검사에서 거절되어 진행하지 않음 | 표시된 revision의 위험 확인 전 버튼 비활성화. 기존 main 수동 확인 검사도 유지 |
| OS 복사 실패에도 성공 표시 | no-op native writer 회귀 테스트가 성공을 반환. 실제 Electron에서 빈 읽기 결과 관찰 | 원문 읽기 일치 검사. 일시적 실패 최대 3회/총 100ms 대기. 영구 실패는 오류로 유지 |

다음 작업을 결정하는 새 엔진은 추가하지 않았다. `TaskProgressionService` → 승인 → Runner → worker 재개 → QualityGate 경로를 사용한다. 모델 응답 완료, 승인 대기, 실제 파일 변경, 작업 완료는 별개 상태로 유지한다.

설정 저장 가능성과 실행 가능성은 구분한다. 예산 제약을 구조적 binding 오류로 취급한 중간 수정은 전체 테스트에서 신규 binding 저장을 방해하는 것으로 드러났다. 이를 준비 상태 경고 + 계획 실행 전 엄격한 검사로 교정하고 전체 검증을 재실행했다.

## 최종 검증

| 검증 | 결과 / 경계 |
| --- | --- |
| 전체 workspace 타입 검사 | `npm run check` 통과 |
| 전체 단위·통합 테스트 | 총 1,770개: 1,768 통과, 실패 0, 건너뜀 2. 외부 harness-100 fixture 부재로 기존 2건 미실행 |
| 핵심 변경 영역 커버리지 | 42개 테스트, 라인 92.90%, 분기 87.64%, 함수 93.62%. 전체 저장소 커버리지 수치가 아님 |
| 전체 Electron E2E | 24/24 통과. 모델은 fake adapter, 파일·SQLite·로컬 CLI·휴지통·화면은 실제 실행 |
| 실제 OS 복사 반복 | 원문/한글/코드 블록/키보드 선택 복사/오류 안내/재시도/언어 전환을 새 앱에서 3회 연속 통과 |
| 빌드/Windows 패키지 생성 | `npm run build`, `electron-builder --win --dir` 통과 |
| 패키징된 EXE 검증 | 15건 중 14건 최초 통과. 마지막 일반 채팅 자동 HTML 전달 사례 1건은 30초 시간 초과 후 단독 재실행 통과(8초). 전체 15건 최초 통과로 집계하지 않음 |
| Git whitespace 점검 | 저장소의 원래 Git 설정에서 `git diff --check` exit 0. LF→CRLF 경고 150건. 줄바꿈 설정 변경/전체 정규화 안 함 |

패키지 검사에는 실제 HTML 하네스 조사→파일 생성→검토, 코드 하네스 패치→수동 승인된 `node --test`→리뷰, 명시적 선택 충돌, 예산 사전 차단, CLI 실패 후 재시작, 설명 답변 완료, 복사, 승인 거절, revision 변경, 중복 실행 차단, 파일 휴지통 이동, abandoned claim의 uncertain 복구를 포함했다.

HTML/코드 정상 경로 fixture에서는 **임시 DB의 프로필 예산만** 제거해 비용 없는 fake 모델 응답으로 실행 경로를 검사했다. 예산 제약을 유지한 별도 사례에서는 첫 모델 호출이 0건이고 실제 파일이 만들어지지 않는 것을 검사했다. 이 둘을 혼동해 기본 설정의 모든 하네스가 곧바로 실행 가능하다고 주장하지 않는다.

## 실행파일

- 경로: `apps/desktop/release/win-unpacked/HarnessAgentOS.exe`
- 생성 시각: 2026-09-09 10:50:02 +09:00
- EXE: 223,747,072 bytes. `resources/app.asar`: 17,252,029 bytes.
- app.asar SHA-256: `10FA982A9F099EEB54E0B91EA25D8D1C50CC90972B068E7DEC2A3F3B551A51BB`
- `win-unpacked` 전체 폴더가 필요한 portable directory 패키지다. 단일 EXE 배포나 설치 프로그램이 아니다.
- Authenticode 서명 없음. 이 PC에서 패키지 E2E는 실행했지만 다른 PC의 SmartScreen/보안 정책 통과까지 검증한 것은 아니다.

## 재실행

Node/npm을 PATH에 둔 PowerShell에서:

```powershell
npm run check
npm run build
node node_modules/@playwright/test/cli.js test --config apps/desktop/playwright.config.ts

$env:HARNESS_E2E_EXECUTABLE = (Resolve-Path apps/desktop/release/win-unpacked/HarnessAgentOS.exe).Path
node node_modules/@playwright/test/cli.js test --config apps/desktop/playwright.config.ts harness-delivery.test.mjs harness-catalog.test.mjs answer-copy.test.mjs task-progression.test.mjs task-completion.test.mjs approval-acceptance.test.mjs
```

이번 전체 단위 테스트는 이미 Electron ABI로 준비된 better-sqlite3를 보존하기 위해 Electron을 `ELECTRON_RUN_AS_NODE=1`로 실행하고 `--import tsx --test --test-force-exit`을 사용했다. `npm test`를 사용하면 Node ABI 재빌드가 포함되므로 Electron 실행 전 `npm run rebuild:electron`이 필요하다.

## 보존 및 미검증

- 작업 시작 전 미커밋 변경 203항목을 보존했다. 운영 AppData DB, 저장된 프로필 예산, 사용자의 프로젝트 파일을 수정/초기화하지 않았다. 테스트 생성/수정/삭제는 격리된 임시 targetDir/userData에 한정했다.
- TDD의 실패 테스트→수정→같은 테스트 통과를 기록했다. 기존 미커밋 변경과 섞이는 Git 체크포인트 커밋은 생성하지 않았다. 이는 사용한 TDD 스킬의 Git 체크포인트 요구에 대한 미충족 항목이다.
- 유료/실제 모델 호출은 이번 검증에서 수행하지 않았다. 실제 모델의 긴 응답, 정확한 분석 내용, 인증/사용량 제한, 대규모 사용자 프로젝트에서의 전체 동작은 미검증이다.
- USD hard cap을 저장한 프로필은 현 CLI의 호출 전 비용 보장 부재로 계속 실행할 수 없다. 자동 승인으로 우회하거나 예산을 임의 제거하지 않는다. 과금 보장 방식 도입 또는 사용자가 선택한 예산 정책 변경 없이 이 제약을 없앴다고 주장할 수 없다.
- 최초 패키지 E2E의 단일 시간 초과 원인은 확정하지 못했다. 단독 재실행 통과는 간헐적 문제의 영구 해결 증거가 아니다.
- 별도 lint script는 이 저장소 package.json에 없다. 전 의존성 취약점 감사, 성능 측정, 모든 실제 모델 조합 및 OS 삭제 경쟁 검증을 이 결과에 포함하지 않는다.

따라서 이 결과는 **재현된 핵심 결함 수정과 로컬 실행 검증**이다. 제품 전체가 완벽하거나 모든 사용자 작업을 무조건 완료한다는 판정이 아니다.
