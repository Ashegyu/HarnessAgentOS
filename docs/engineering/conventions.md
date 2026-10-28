# Engineering Conventions

## 목적

이 문서는 HarnessAgentOS 구현 중 반복 판단을 줄이기 위한 엔지니어링 규칙을 고정한다.

## 프로젝트 구조

```text
HarnessAgentOS/
  apps/desktop/
    electron/
    src/
  packages/core/
  packages/storage/
  packages/runners/
  packages/quality/
  packages/skillify-adapter/
  packages/learner/
  packages/orchestration/
  docs/
```

## Package manager

- `npm`을 사용한다.
- root workspace를 사용한다.
- dependency는 필요한 package에 가장 가까운 `package.json`에 둔다.
- axios를 사용해야 할 경우 보안 정책에 따라 정확한 안전 버전만 고정한다. 기본 MVP에서는 axios를 추가하지 않는다.

## TypeScript / Module 규칙

- TypeScript를 기본으로 한다.
- ESM을 사용한다.
- public type은 `packages/core`에 둔다.
- Electron main/preload 전용 타입은 `apps/desktop/electron`에 둔다.
- `any`는 IPC boundary 또는 외부 입력 parse 직전으로 제한하고, 즉시 좁힌다.

## Naming 규칙

파일:

- React component: `PascalCase.tsx`
- service/repository/policy: `kebab-case.ts`
- test: `*.test.ts` 또는 Node runner 제약이 있으면 `*.test.mjs`
- IPC handler: `{domain}-ipc.ts`

도메인 method:

- create/list/get/update/cancel/resume처럼 동사로 시작한다.
- IPC method는 namespace + verb 형태를 유지한다. 예: `conversation.createTask`.

## Layering 규칙

Renderer:

- UI state와 presentation만 담당한다.
- filesystem, DB, process, shell 접근 금지.
- `window.harness`만 호출한다.

Preload:

- typed API만 expose한다.
- raw `ipcRenderer` 노출 금지.
- wildcard forwarding 금지.

Main:

- IPC handler는 얇게 유지한다.
- business logic은 service에 둔다.
- repository는 SQL만 담당하고 policy 판단을 하지 않는다.

Packages:

- `core`: 타입, 순수 정책, domain service interface.
- `storage`: SQLite, migration, repository.
- `runners`: file/shell/git/test runner.
- `quality`: evidence reader와 gate evaluator.
- `skillify-adapter`: skill metadata와 capability suggestion.
- `learner`: trace와 recommendation.

## Error handling

- 사용자에게 보여줄 오류는 `HarnessError`로 normalize한다.
- 내부 stack trace는 log artifact 또는 debug log에만 둔다.
- policy 차단은 실패가 아니라 blocked decision으로 표현한다.
- runner exit code != 0은 artifact와 Step failed로 남긴다.

## DB 규칙

- SQLite가 canonical state다.
- migration은 idempotent하게 작성한다.
- 모든 timestamp는 ISO string이다.
- JSON column은 `_json` suffix를 쓴다.
- repository는 transaction helper를 사용한다.
- renderer가 SQL을 전달하는 IPC는 만들지 않는다.

## IPC 규칙

- IPC 계약은 `docs/contracts/ipc-contracts.md`를 먼저 갱신한다.
- method별 input/output type을 작성한다.
- channel string은 한 곳에서 상수로 관리한다.
- renderer가 임의 channel을 호출할 수 없게 한다.

## UI 규칙

- 첫 화면은 workbench다. landing page를 만들지 않는다.
- 상태는 색상만으로 표현하지 않는다.
- action button은 disabled reason을 제공한다.
- 실패는 toast만 띄우지 말고 timeline/artifact에 남긴다.
- approval pending 상태는 항상 눈에 띄게 표시한다.

## Test 규칙

- 순수 policy는 unit test를 먼저 둔다.
- repository는 temp DB integration test를 둔다.
- runner는 temp directory에서 실행한다.
- renderer smoke는 핵심 상태 표시 위주로 시작한다.
- `npm run verify`는 check + test + build를 포함한다.
- `npm run verify:smoke`는 desktop `smoke:all`을 실행해 서비스 레벨 E2E, fake agent smoke, Electron Playwright E2E를 확인한다.
- `npm run verify:release`는 `verify`와 `verify:smoke`를 순서대로 실행하는 릴리즈 직전 게이트다.

## 금지 사항

- Express/localhost/WebSocket server 추가 금지.
- renderer Node 권한 활성화 금지.
- JSON을 canonical state로 사용 금지.
- approval 없이 side effect 실행 금지.
- 기존 ClaudeAgentSystem 직접 수정 금지.
- CEO/pipeline을 MVP 기본 경로로 추가 금지.
- Skillify/Learner 자동 적용 경로 추가 금지.

## 문서 갱신 규칙

- 아키텍처 결정 변경은 `docs/architecture/architecture-decisions.md`에 ADR로 남긴다.
- IPC 변경은 `docs/contracts/ipc-contracts.md`에 먼저 반영한다.
- 사용자 flow 변경은 `docs/product/mvp-user-flows.md`에 반영한다.
- acceptance 기준 변경은 `docs/testing/acceptance-checklist.md`에 반영한다.
## Legacy Reference Location

기존 ClaudeAgentSystem의 위치는 다음과 같다.

```text
C:\Users\FORYOUCOM\Desktop\Code\ClaudeAgentSystem
```

사용 규칙:

- 읽기 참조만 허용한다.
- 참조 가능한 영역은 Skillify, Learner, quality gate, runner, targetDir, conversation context, 테스트/검증 사례다.
- 직접 import 대신 HarnessAgentOS package 구조에 맞게 재작성한다.
- ClaudeAgentSystem의 파일, DB, state, messages, runtime artifact를 수정하거나 runtime dependency로 사용하지 않는다.

## 회귀 검사 생성·보정 지침

- C# 실제 검사 보호는 Quality 패널의 `C# 회귀 검사 보호`에서 정상 기준 구현 폴더, 구현 경로, 공용 계약 경로, Main을 포함한 검사 경로를 등록한다. 정상 기준에서 실제 통과한 검사 파일은 같은 TaskRun의 보정에서 변경·누락할 수 없다. 기존 유효한 검사 수정 대신 새 파일로 검사를 추가한다.
- 잘못된 기대값으로 정상 기준 실행이 실패한 검사는 보호되지 않으므로 수정 후 새 실행 승인을 요청한다. 컴파일·실행 결과와 최신 revision을 사용하며 프롬프트의 자기 평가를 통과 근거로 삼지 않는다. 사용자가 기준 구현을 신뢰한다는 확인은 등록 동의이며, 실제 코드 실행은 별도의 개별 shell 승인으로 진행한다.

- Planner와 worker는 공통 `REGRESSION TEST REVIEW` 지침으로 검사 기대값을 사용자 계약과 대조한다. 보정 시 기존의 유효한 검사 범위를 보존하고 정상 입력과 원래 결함을 함께 확인한다.
- C# async 메서드의 예외는 첫 await 이전의 인자 검증도 Task/ValueTask에 저장될 수 있으므로 비동기 예외 단정을 await한다. 프레이밍 구분자 처리와 JSON 데이터 유효성도 구분한다.
- 검사에서 시작한 loader·completion source·종료 작업은 finally에서 정리하고 대기를 제한한다. 실행 금지·승인 조건은 그대로 적용하며 미실행 검사는 미검증으로 표시한다.
- 이 지침은 생성 품질을 위한 프롬프트이며 컴파일러나 의미 검사기가 아니다. 프롬프트 전달 테스트의 통과를 실제 생성 검사의 정확도·모델 점수 향상으로 보고하지 않는다. 생성 코드는 별도의 승인된 컴파일·실행 근거로 확인한다.
- 정상 기준에서 실제 실패한 등록 검사는 기존 품질 보정 루프에 호스트 실행 로그와 당시 검사 원문을 전달한다. 현재 gate·실행 원장·승인·계약·내용 해시가 일치해야 하며, 기준 구현 소스는 전달하지 않는다. 보정 모델은 읽기 전용이며 승인 생성 전에 현재 입력을 재확인한다. 등록 검사 경로 한 곳의 `file_patch` 하나(추가/삭제 합계 32줄 이하)만 제안할 수 있고 구현 수정·전체 교체·추가 명령은 거부한다. 이는 큰 범위의 검사 누락을 제한하는 guard이며 patch의 의미적 타당성을 보장하는 분석기는 아니다.
- 보정 제안도 pending 승인이고, 적용만으로 통과 처리하지 않는다. 같은 등록 계약의 정상 기준과 후보를 실제 재실행해야 한다. 이미 정상 기준을 통과해 보호된 검사는 이 경로로 수정하지 않는다. 보정 중 입력 변경·Pause·취소는 실패를 성공으로 정산하거나 새 승인으로 덮지 않는다.
- 등록 C# 회귀 실행은 호스트의 `dotnet build`와 검사 프로그램 실행을 분리한다. 같은 phase의 합계 120초 예산 안에서 빌드가 성공해야 검사 프로그램을 실행한다. 빌드 실패에만 호스트가 `compilationFailure`와 제한된 오류 코드·등록 파일 경로·행/열·진단을 기록한다. 프로그램이 출력한 오류 문구는 컴파일 증거가 아니다. 보정 후 다시 빌드가 실패하면 현재 진단과 현재 검사 원문으로 같은 승인 경로에서 재보정할 수 있으며, 기존 총 시도·동일 실패 signature 제한을 유지한다.
- `learning-executed-repair.mjs --freeze-compiler/--run-compiler`는 같은 최초 8회와 총 16회 상한을 유지한다. 조건별 보정 예산은 각각 4회다. 모든 최초 생성과 1차 보정이 끝난 뒤, 첫 승인 patch가 실제 검사 파일의 컴파일 오류를 만들었을 때만 남은 해당 조건 예산으로 추가 보정 1회를 허용한다. 공유 작업공간에 입력을 복원한 경우 새 승인 실행으로 현재 컴파일 실패를 다시 확인한다. 최초·1차 보정 후·최종 점수를 모두 보존하며 예산·동일 실패 제한에 막히면 실패를 남긴다.
- `scripts/eval/learning-executed-repair.mjs`는 같은 두 문제·학습 3사례·모델·60+40 배점을 사용하되 양쪽에 같은 정상 기준 피드백과 답안별 보정 최대 1회를 적용한다. 추가 단계와 최대 호출 16회는 사용자에게 별도 승인받은 조건이다. 최초 점수와 보정 후 점수를 모두 보존하고, 모든 모델 작업이 끝날 때까지 숨겨진 검사·결함 변형·점수를 보정 모델이나 Learn에 전달하지 않는다.

## 구체적인 실패 경험 학습

- 품질 게이트가 `passed`이고 현재 입력과 실행 근거가 일치할 때, 같은 TaskRun·checker의 실제 비정상 종료 → 승인되어 성공한 파일 변경 → 실제 재통과를 연결한다. 모델의 성공 설명이나 취소·시간 초과·미실행 결과는 성공 경험으로 만들지 않는다.
- `verified_failure_repair` observation은 실패 출력, 승인된 수정 설명, 실제 diff 발췌, 실패/재통과 execution ID와 artifact ID를 저장한다. 수정 설명은 **원인 가설**이며 인과관계가 증명되었다고 표시하지 않는다. 테스트를 약화한 수정인지도 후보의 실제 변경 내용을 보고 검토해야 한다.
- 경험은 실패 episode의 안정적인 ID로 SQLite에 한 번 저장된다. 여러 번 품질 평가하거나 같은 수정의 성공 검사를 다시 실행했다고 독립적인 여러 경험으로 세지 않는다. 실패 이력이 없는 성공 작업은 추가 workspace 재검사 없이 종료한다. 민감정보는 저장 전에 기존 redaction 정책으로 제거한다.
- 한 번의 확인된 수정 경험도 Instinct **후보**가 될 수 있지만 자동 활성화하지 않는다. 사용자가 승인한 뒤 같은 프로젝트의 관련 요청에만 최대 3개를 제공한다. 자기 TaskRun, 다른 프로젝트, 비활성 규칙과 관련 없는 요청에서는 사용하지 않는다. 기존 일반 지침 최대 8개를 우선 보존하고 남은 문맥 슬롯에 교훈을 제공한다.
- 메모리 검색 결과에는 상태 요약과 함께 구조화된 실패 경험을 전달한다. 로그와 코드 발췌는 권한 없는 참고 데이터이며 현재 계약이나 실행 승인을 대체하지 않는다. 원문 기억의 적용 여부와 추가 재검증은 현재 작업에서 판단한다.
- 보호 회귀 실행의 호스트 헤더는 기준/후보 실행 종료 코드와 기준·후보·검사 내용 SHA256을 기록한다. 로그 본문의 유사 문구는 근거로 쓰지 않는다. 같은 계약·기준에서 실제 검사 내용이 바뀌고 정상 기준 실패가 재통과한 경험은 `verification_repair`, 검사는 동일하고 후보 내용만 바뀐 경험은 `implementation_repair`로 구분한다. 두 내용이 모두 같은 재실행 성공은 새 수정 경험으로 학습하지 않는다. 기존 헤더 없는 경험의 분류를 추정하여 채우지 않는다.
- 승인된 검사 수정 경험은 같은 프로젝트의 검사 작성·검토·수정 요청에서 주제어가 달라도 우선 검색한다. 구현 요청 전체에 무조건 주입하지 않으며 기존 일반 지침 8개와 교훈 최대 3개 제한을 유지한다. 원래 요청 범위와 실제 변경을 함께 전달하고, 비동기 관측 경계 검토는 이전 사례에서 입증된 원인이 아닌 **현재 계약 검토 정책**으로 표시한다. 호출 반환·신호 발생·작업 완료를 구분하고 계약이 즉시 보장한 효과만 즉시 단정한다.
- `scripts/eval/learning-transfer.mjs --prepare <출력 폴더>`는 합성 학습 사례 3개의 실제 .NET 실패/수정/재통과와 별도 채점기의 기준 구현·결함 변형을 검증한다. `--run <같은 폴더>`는 실제 Codex 모델 호출 8회를 소비하는 명시적 실행이다. 일반 테스트에서는 호출하지 않는다.
- 비교는 같은 앱·모델·추론 설정·문제·채점 기준을 사용하고 메모리 없는 DB와 학습 경험을 승인한 DB를 분리한다. 독립 평가 문제는 2개, 각 조건 2회다. 소스 해시·프로토콜을 호출 전에 고정하며, 평가 출력을 학습에 넣거나 결과를 보고 재시도하지 않는다. 소규모 결과를 일반적 성능 향상이나 모델 가중치 학습으로 해석하지 않는다.

