# 파일·CLI·승인 검수 결과

> **후속 수정·검수 완료 (v40):** 승인 후 내용 변경 및 중복 실행 결함을 수정하고, Windows npm 호출과 단일 파일 휴지통 이동을 구현했다. 최종 타입 검사·빌드 통과, 단위/통합 **1,662 통과 / 0 실패 / 2 제외**, Electron E2E **14/14 통과**. 아래 최초 검수 결과는 변경 전 증거로 보존하며, 최신 결과는 문서 끝의 후속 검수를 따른다.

검수일: 2026-09-07 17:09~17:12 KST

판정: **전체 통과 아님. 기본 파일 생성·수정은 동작하지만 승인 무효화와 중복 실행 방지에 결함이 있고, Windows npm 실행 호환성이 불완전하다.**

이번 요청은 검수이므로 제품 소스·운영 DB·전역 설정을 수정하지 않았다. `master`의 기존 미커밋 변경은 보존했다. 현재 소스로 빌드한 Electron 앱을 별도 임시 userData로 실행했으며, 모델 호출은 하지 않았다. 실행 후 검수 DB의 `agent_invocations`는 0건이었다.

## 결과 요약

| 항목 | 결과 | 실제 확인 내용 |
|---|---|---|
| 승인 전 파일 실행 | 통과 | `RUNNER_APPROVAL_REQUIRED`, 파일 없음 |
| 화면에서 승인 후 실행 | 통과 | 승인 버튼만 눌렀을 때 파일 없음 → 실행 버튼을 누른 뒤 생성, approval=`executed`, diff artifact 1건 |
| 기존 파일 수정 | 통과 | `file_write`의 before/after 적용 후 실제 디스크 내용 확인 |
| 부분 patch 적용 | 통과 | `file_patch`로 `two` → `TWO` 변경 확인 |
| 거절한 승인 실행 | 통과 | 화면에서 사유 입력 후 거절, 실행 차단, 파일 없음 |
| 취소한 작업 실행 | 통과 | 승인 뒤 작업 취소 후 실행을 시도하면 `TASK_RUN_INVALID_TRANSITION`, 파일 없음 |
| 실행 중 CLI 취소 | 통과 | 실제 Node 프로세스 시작 marker 확인 → `runner.cancelExecution` → `RUNNER_CANCELLED`, 예약된 후속 쓰기 없음 |
| 완료한 승인 순차 재실행 | 통과 | 같은 승인 ID를 완료 후 다시 실행하면 차단 |
| stale before / 외부 파일 경로 | 통과 | 이전 내용 불일치와 `../` 경로 차단, 기존 내용 보존 |
| 승인 기록 유지 | 통과 | renderer 재로드 후 SQLite의 executed 상태와 artifact 유지 |
| 승인 후 실행 내용 변경 | **실패 / P1** | 승인된 A 경로를 B로 바꿔도 approved 유지, 재승인 없이 B 파일 생성 |
| 동일 승인 동시 실행 | **실패 / P1** | 동일 approval ID에 동시 IPC 두 번 → 둘 다 실행 성공, 1회 추가 예상 파일에 `xx` 기록 |
| 파일 삭제 | **미지원** | 승인한 `Remove-Item`은 `RUNNER_BLOCKED_HIGH_RISK`, `/dev/null` 삭제 patch는 `RUNNER_PATCH_INVALID`. 대상 파일 모두 남음 |
| 일반 CLI | 부분 통과 | Node, Git, .NET, PowerShell, Codex 버전 조회와 작은 Node 프로그램 실행 성공. npm 기본 명령은 실패 |
| shell의 작업 경로 격리 | **제약 있음** | cwd는 targetDir이지만 승인된 Node 명령이 `../outside-cli.txt`에 쓸 수 있음. 대상은 모두 검수 임시 루트 안에 한정 |

## 우선 수정이 필요한 결함

### P1 — 승인 이후 내용 변경이 승인을 무효화하지 않음

재현: `approved-A.txt` 생성 승인 → `conversation.setProposedAction`으로 `unapproved-B.txt`로 변경 → 새 approve 호출 없이 `runner.executeApproved` 실행.

실제 결과는 승인 상태가 `approved`로 유지되고 B만 생성됐다. 형식과 actionType 검증은 있지만 승인한 내용의 revision/hash와 현재 실행 내용의 연결이 없다. 화면에서도 승인된 카드에 “세부 수정” 기능이 노출된다.

근거: [ConversationService](C:/Users/USER/Desktop/Work/HarnessAgentOS/packages/core/src/conversation/conversation-service.ts:311), [승인 저장소](C:/Users/USER/Desktop/Work/HarnessAgentOS/packages/storage/src/repositories/approval-repository.ts:219).

수정 조건: 실행 세부 변경 시 승인을 pending으로 되돌리거나 변경 자체를 거부하고, 실행 시 승인된 내용과 일치하는지 확인해야 한다. 이번 검수에서는 구현하지 않았다.

### P1 — 같은 승인 ID의 동시 요청이 중복 실행됨

단일 승인에 대해 두 `executeApproved` IPC를 동시에 보냈다. 두 호출 모두 승인 상태 검사를 통과하고 각각 별도 step과 CLI 실행을 만들었다. 테스트용 명령은 검수 폴더의 `duplicates.txt`에 `x` 한 글자를 추가하는 것이었고, 실제 결과는 `xx`였다.

순차 재실행은 막지만, 실행 전에 승인을 원자적으로 점유하는 검사가 없다. taskRunId별 AbortController 저장은 중복 실행 잠금이 아니다.

근거: [실행 진입과 승인 검사](C:/Users/USER/Desktop/Work/HarnessAgentOS/packages/runners/src/runner-service.ts:143), [실행 controller 저장](C:/Users/USER/Desktop/Work/HarnessAgentOS/packages/runners/src/runner-service.ts:258).

수정 조건: side effect 시작 전에 승인 ID별 단일 실행을 원자적으로 확보하고, 경합 요청이 새 프로세스·파일 쓰기를 만들지 않아야 한다. 이번 검수에서는 구현하지 않았다.

### P2 — npm 탐색 및 Windows batch 실행 호환성

| 검수 명령 | 결과 |
|---|---|
| `node --version` | 성공: v24.19.0 |
| `git --version` | 성공: 2.55.0.windows.5 |
| `dotnet --version` | 성공: 10.0.400 |
| `pwsh --version` | 성공: PowerShell 7.6.5 |
| Windows PowerShell 버전 조회 | 성공: 5.1.26100.9168 |
| `codex --version` | 성공: codex-cli 0.153.4, 모델 세션은 시작하지 않음 |
| `node check.mjs` | 성공: 간단한 assert 프로그램 실행 |
| `npm --version`, `npm run check`, `npm test` | 실패: 앱 자식 프로세스에서 npm 명령을 찾지 못함 |
| 따옴표로 감싼 절대 `npm.cmd` 경로를 명령 문자열로 실행 | 성공: 11.17.0 |
| 절대 `npm.cmd` + 별도 args 배열 | 실패: `spawn EINVAL` |
| 절대 Node + `npm-cli.js test` | 성공: npm script가 작은 Node 테스트를 실행 |

이번 검수 앱이 상속한 PATH에는 확인된 npm 디렉터리가 없었다. npm 자체가 설치되지 않았다고 판정한 것은 아니다. 경로를 명시한 비교 실행으로 PATH 문제와 구조화된 `.cmd` 실행 문제를 분리했다. 설치·전역 PATH 변경·의존성 다운로드 없이 확인했다.

근거: [ShellRunner 실행 환경 및 spawn 분기](C:/Users/USER/Desktop/Work/HarnessAgentOS/packages/runners/src/shell-runner.ts:83). args가 있으면 `shell:false`, 없으면 `shell:true`이며 npm/batch 전용 해석은 없다.

부수 관찰: npm 미발견 오류의 한국어 stderr가 깨져 artifact에 저장됐다. [현재 stdout/stderr UTF-8 변환](C:/Users/USER/Desktop/Work/HarnessAgentOS/packages/runners/src/shell-runner.ts:233)은 Windows 기본 명령 출력 인코딩과 항상 일치하지 않는다. 이를 수정 완료로 표시하지 않는다.

## 기능·보안 경계

- 삭제는 전용 승인 action이 없고, FileRunner는 생성/대체, unified patch는 기존 파일 수정만 지원한다. [삭제 patch 거부](C:/Users/USER/Desktop/Work/HarnessAgentOS/packages/runners/src/unified-patch.ts:135), [삭제 shell 패턴 차단](C:/Users/USER/Desktop/Work/HarnessAgentOS/packages/runners/src/runner-policy.ts:116).
- 위 차단을 “삭제가 어떤 방식으로도 불가능하다”는 보안 보장으로 해석하면 안 된다. 일반 shell은 OS 수준 sandbox가 아니고 승인된 프로그램은 cwd 밖 경로에도 접근할 수 있다. 검수에서는 바깥 경로도 검수용 임시 루트 안으로 제한했다.
- 파일 Runner의 경로 containment와 일반 CLI의 권한 범위는 서로 다르다. `targetDir` 설정만으로 임의 shell 코드가 해당 폴더에 갇히지는 않는다.
- 기본 자동 승인은 false인 격리 프로필로 검사했다. 기존 자동 승인·pipeline 정책은 관련 회귀 테스트로 확인했으며, 모든 사용자 프로필/원격 서버 조합을 실제 실행한 것은 아니다.
- 실제 모델이 수정안을 생성하는 과정, 로그인·유료 추론·외부 MCP/A2A·배포/설치/네트워크 작업은 검수하지 않았다. 일반 CLI 버전 확인을 실제 모델 작업 수용 시험으로 간주하지 않는다.

## 실행 증거와 재현 자료

- 현재 소스 `npm run build`: 통과.
- 승인·ConversationService·FileRunner·RunnerService·ShellRunner·정책·patch·승인 저장소·pipeline 자동 승인 관련 기존 `.test.mjs`: **115/115 통과**. Electron Node 런타임으로 실행했다. 이 결과만으로 위 새 검수 결함이 없다고 판정하지 않는다.
- 새 임시 검수 스크립트: 기본 27항목 중 PASS 19, FAIL 5, 미지원 2, 한계 1. FAIL 5는 승인 결함 2개와 npm 기본 명령 3개다. 추가 진단 4건으로 절대 npm 실행 성공, 구조화 `.cmd` 실행 실패, npm script 성공, 실제 CLI 취소를 확인했다.
- 최초 검수 시도는 스레드 버튼의 부가 문구를 고려하지 않은 exact 선택자 때문에 멈췄다. 선택자를 수정하고 새 임시 DB에서 전체 시나리오를 실행했다. 제품 문제로 집계하지 않았다.
- `git diff --check`: 통과. 제품 소스 수정·커밋·push 없음. 이 보고서만 저장소에 추가했다.

검수 루트: `C:/Users/USER/AppData/Local/Temp/harness-acceptance-41fd77ad1ba742449bc16dd0ff3779c1`.

- [기본 검수 스크립트](C:/Users/USER/AppData/Local/Temp/harness-acceptance-41fd77ad1ba742449bc16dd0ff3779c1/approval-audit.test.mjs)
- [CLI 추가 진단 스크립트](C:/Users/USER/AppData/Local/Temp/harness-acceptance-41fd77ad1ba742449bc16dd0ff3779c1/cli-diagnosis.test.mjs)
- [검수 SQLite DB](C:/Users/USER/AppData/Local/Temp/harness-acceptance-41fd77ad1ba742449bc16dd0ff3779c1/userData-xu3UxM/app.db)
- [실행 완료 화면](C:/Users/USER/AppData/Local/Temp/harness-acceptance-41fd77ad1ba742449bc16dd0ff3779c1/02-executed-approval.png)

검수 파일과 DB는 증거 보존을 위해 임시 폴더에 남겼다. 스크립트는 해당 1회 검수 fixture용이며, 수정된 fixture를 초기화하지 않고 재실행하는 것은 재현 절차가 아니다. 안전한 재현에는 새 임시 루트와 초기 fixture가 필요하다.

## 후속 구현 및 최종 검수 — v40

사용자가 승인한 네 범위(승인 안전성, Windows CLI, 단일 파일 삭제, DB 호환/최종 검증)를 구현했다. 운영 프로필 DB 수정·기존 앱 재시작·글로벌 PATH 변경·패키지 설치·유료 모델 추론·커밋은 수행하지 않았다. 기존 미커밋 변경은 보존했다.

| 범위 | 구현 및 검증 |
|---|---|
| 승인 내용 고정 | actionRevision/approvedRevision/승인 JSON 스냅샷. 승인된 A를 B로 수정하면 pending 및 개별 재승인 필요. stale expectedRevision 요청은 IPC와 서비스에서 차단 |
| 실행 단일 소비 | 서로 다른 SQLite 연결과 Runner 인스턴스에서 같은 승인 20회 동시 요청 → 실제 효과 1회. Electron IPC 20회 요청도 성공 1회. 서로 다른 승인 호출의 병렬성 회귀도 통과 |
| 상태 잠금 | 실행 중·실행 완료·불확실 실행의 편집/재생 차단. 거절 및 취소된 작업의 승인 부활 차단. 버전별 승인 내용과 실행 상태는 approval_events에 보존 |
| CLI | 실제 Node/Git/.NET/pwsh/Windows PowerShell/npm 버전, npm run check/test, 절대 npm.cmd + 구조화 args 실행 성공. 한글·공백·따옴표·메타문자 인수 보존. CP949/UTF-8/UTF-16LE 출력 디코딩 회귀 통과 |
| 명령 취소 | 실제 Node가 시작 마커를 만든 다음 취소. RUNNER_CANCELLED 확인, 예약된 후속 파일 쓰기 발생하지 않음 |
| 수동 경고 | host shell과 file_delete, 재승인 대상은 전역·프로필·pipeline 자동 승인 금지. UI 확인 체크박스·개별 승인 및 새 한영 경고 전환 검증 |
| 파일 동작 | 실제 IPC/UI에서 생성 → 기존 파일 수정 → unified patch 성공. 삭제 전 정보 준비/수동 승인 → 실제 Electron 휴지통 이동 및 diff 증거 저장. 휴지통 실패 시 영구 삭제하지 않음 |
| 삭제 경계 | 파일 변경·폴더·.git·wildcard·상위 경로·장치·ADS·정션/링크 거부. 별도 파일/디렉터리의 재귀 삭제 기능은 추가하지 않음 |
| DB | v40 이관 후 기존 기록 유지, 버전 없는 미실행 승인만 재확인. 반복 이관과 FK/인덱스 검증. 미완료 실행 선점을 저장한 뒤 실제 앱 재시작 → uncertain 유지, 자동 재생 없음 |
| 기존 기능 | 실제 Electron에서 병렬 실행 제한/취소, 예산 차단, 읽기 전용 계약, 응답 QA 완료, 한영 설정, pipeline 편집을 함께 재검증 |

최종 명령 결과:

- `npm run check`: 통과.
- `npm run build`: 통과 (개발용 Electron 번들; 설치형 exe 재패키징 아님).
- 전체 `.test.mjs` 실행: **1,664개 중 1,662 통과, 0 실패, 외부 harness-100 샘플 의존 2개 제외**. SQLite native ABI를 유지하기 위해 `ELECTRON_RUN_AS_NODE=1`로 Electron의 Node 런타임에서 실행했다. native rebuild를 포함하는 `npm test`/`npm run verify` 명령 자체를 실행한 것으로 표기하지 않는다.
- `node node_modules/@playwright/test/cli.js test --config apps/desktop/playwright.config.ts`: **14/14 통과**. 해당 프로세스에만 사용 가능한 Node/npm 설치 경로를 PATH로 제공했다. 원래 운영 앱 PATH에서 npm이 자동으로 보이는 것으로 간주하지 않는다.
- 핵심 변경 3개 모듈(`windows-command.ts`, `file-delete-runner.ts`, `approval-repository.ts`)의 별도 21개 테스트: 라인 **97.79%**, 분기 **84.08%**, 함수 **100%**. 프로젝트 전체 커버리지 수치가 아니다.
- `git diff --check`: 통과. 저장소에 별도 lint 스크립트가 없어 lint 전체 통과로 표기하지 않는다.

중간 E2E 실패도 기록한다. 신규 fixture의 생성/수정 순서 오류를 바로잡았다. 기존 병렬 검수는 sticky 작업 흐름이 chat 카드 클릭을 가리는 문제여서 보이는 작업 선택 버튼을 사용하도록 변경했다. 기존 pipeline 드래그 검수는 렌더링 전 즉시 좌표를 비교하던 불안정성을 확인하고, 단계적 포인터 이동 및 렌더링 좌표 대기로 보완했다. 최종 전체 실행은 재시도 옵션 없이 14개 모두 통과했다.

보안 한계는 유지된다. 임의 CLI는 OS sandbox가 아니며 cwd 밖 파일/네트워크 접근이 가능하다. 임의 .cmd/.bat 구조화 실행을 무조건 shell로 전환하지 않고, 실제 실행 파일/Node 스크립트 경로를 안내한다. 휴지통 이동 API는 검사와 OS 이동을 원자적으로 묶지 못하므로 악의적인 외부 프로세스의 경로 교체 경쟁까지 차단한다고 주장하지 않는다. 비정상 종료 검증은 저장된 미완료 claim의 재시작 복구이며, OS 강제 종료의 모든 순간을 fault injection한 것이 아니다.

사용법·이관 전 백업·복구 절차: [승인·CLI 안전성 v40 안내](C:/Users/USER/Desktop/Work/HarnessAgentOS/docs/implementation/approval-cli-safety-v40.md).
