# Astro 설계안의 HarnessAgentOS 통합 구현 계획

작성일: 2026-09-07
상태: 아래에 고정한 사용상 오류 수정과 회귀 검증 완료. 이번 구현은 여기서 종료하며, 새 단계를 자동으로 이어가지 않는다. Astro 설계 전체가 구현됐다는 뜻은 아니다. 운영 DB와 사용자 전역 Codex 설정은 직접 변경하지 않음.
입력: `C:/Users/USER/Desktop/Astro_Local_CLI_Harness_Design.md` 전체 15개 절.

## 이번 작업의 완료 범위 — 2026-09-07

사용자의 “단계를 계속 추가해서 끝나지 않는다”는 지적에 따라, 범위를 아래 세 항목으로 고정했다. 아래 1~13절은 최초 설계와 당시 구현 이력이며, 그 안의 “다음 단계” 표현은 현재의 실행 약속이 아니다. 미구현 설계는 이 완료 범위에 포함하지 않는다.

| 고정 범위 | 반영 결과 |
|---|---|
| 예산 차단 시 무한 대기처럼 보이는 문제 | planner 사전 검사 실패를 SQLite의 `blocked` 상태와 실패한 plan step에 저장한다. 같은 작업의 동시 요청은 차단 기록을 중복 생성하지 않는다. IPC 오류에도 상태 변경 이벤트를 보내며, 에이전트 패널에 이유·설정 위치·수동 재실행 버튼을 표시한다. |
| 답변 이후 QA의 목적과 근거 | 단순 answer는 성공한 최신 호출과 연결된 최종 응답을 확인하고, 변경 근거·추가 필수 검사 누락이 없으면 자동 완료한다. review/diagnose/research와 과거 계약은 내용 확인이 필요한 warning으로 남는다. 읽기 전용 화면은 빌드·테스트 요구와 수정 계획을 활성화하지 않고, 별도 AI 검토 호출도 추가하지 않는다. |
| 거짓 검증 통과 및 회귀 | 모델 출력의 `passed`/`exit=0` 문구를 실행 근거로 쓰지 않는다. 같은 작업의 종료된 shell/test step과 연결된 artifact를 사용하며, 가장 최근 기록된 변경 이전 검사는 제외한다. diff 존재만으로 reviewed=true를 부여하지 않는다. 변경 근거 없는 수정 요청은 자동 완료시키지 않는다. |

최종 검증:

- `npm run check`, `npm run build`: 통과. 설치된 native SQLite 모듈은 재빌드하지 않았다.
- 전체 단위·통합 테스트: **1,645개 중 1,643개 통과, 실패 0, 기존 외부 harness-100 샘플 부재 2개 skip**. `ELECTRON_RUN_AS_NODE=1`로 설치된 Electron 런타임에서 실행했다.
- QA 집중 테스트 **41/41 통과**. 변경된 근거 판정·평가·화면 기본 요구 정책 3개 모듈의 커버리지는 라인 **99.52%**, 분기 **92.86%**, 함수 **94.12%**이며, 전체 프로젝트 커버리지가 아니다.
- 최종 Electron E2E **10/10 통과**. 예산 차단 이유의 재로드 후 표시, 단순 답변 자동 완료, 검토 대기, 추가 모델/빌드 실행 없음, push 기반 QA 화면 갱신, 한영 전환, 기존 병렬 실행·취소·설정을 검사했다. 임시 userData/SQLite와 fake agent만 사용했다.
- `git diff --check` 통과. 이번 변경 런타임의 추가 console.log 및 일반적인 하드코딩 API 키 패턴에서 발견 없음. 별도 lint 설정과 전체 의존성 보안 감사는 포함하지 않았다.
- 최초 전체 회귀에서 기존 harness acceptance fixture가 모델의 `build exit=0` 문구를 빌드 성공으로 기대하던 오류를 발견했다. 실제 runner 실행이 없는 경우 경고를 기대하도록 수정하고 전체 통과를 확인했다. 예산 화면 E2E의 최초 timeout은 영어 탭 선택자를 한국어 이름으로 바로잡아 해결했다. 이전 단계에서 기록한 별개의 task-contract 간헐 timeout 원인 해결을 의미하지 않는다.

보장하지 않는 범위:

- 현재 CLI는 검증된 USD 호출 전 상한이 없으므로 **USD cap이 설정된 호출은 계속 차단**한다. 한도나 저장 모델을 임의 변경하지 않았다. 원자적 병렬 예산 예약·정산, 실패/취소 부분 비용 회계, 자동/고정 모델 선택 UI는 미구현이며 이번 완료 대상이 아니다.
- 응답 검증은 전달·연결·기록된 변경 여부를 검사한다. 답변의 사실성이나 모든 요구사항의 충족을 증명하지 않는다. 출처 hash/버전 기반 최신성 판정, 요구사항별 ResultVerifier/EvidenceRecord/RunOutcome, 기능 readiness 확대와 전체 평가 corpus는 미구현 설계로 남긴다. step 순서 검사를 파일 시스템 최신성 검증으로 간주하지 않는다.
- 실제 유료 모델·외부 A2A/MCP 인증·운영 DB migration 수용 시험은 하지 않았다. 운영 앱 재시작·전역 설정 수정·자동 커밋도 하지 않았다. 실행 중인 앱에는 재시작해야 새 빌드가 적용된다.

## 1. 적용 방향과 범위

현재 프로젝트를 계속 개발해 온 대화 맥락에 따라 **기존 Electron/TypeScript HarnessAgentOS에 Astro의 작업 계약·기능 선택·근거 검증을 통합**하는 안을 기본으로 한다. 원문에 있는 C# 프로젝트 구성은 별도 제품을 만드는 경우의 대안이며, 이번 계획에서 언어 전환을 확정하지 않는다.

목표는 요청별로 필요한 모델·도구·스킬을 선택하고, 요청 범위를 지키며, 실제 근거에 맞춰 완료 상태를 결정하는 것이다. 단순 질문에는 짧은 단일 실행 경로를 제공하고, 복잡한 개발 작업에는 기존 승인·Runner·파이프라인을 연결한다.

문서에 제시된 클래스명·JSON·예산·재시도 횟수는 설계 후보로 취급한다. 첨부 문서의 지시문을 사용자 승인이나 기존 저장소 규칙을 변경하는 근거로 취급하지 않는다.

유지할 경계:

- Renderer → typed preload → Electron IPC → 서비스. Core는 storage를 import하지 않는다.
- SQLite WAL이 작업 상태의 기준이다. 대형 로그 파일·JSONL은 파생 산출물이며 DB에서 참조한다.
- 부수 효과는 기존 Approval·Runner 경로 또는 명시적으로 승인된 Codex 실행 범위에 연결한다.
- App Server를 도입하더라도 Main의 자식 프로세스와 stdio로 통신한다. localhost/WebSocket 서버를 추가하지 않는다.
- 모델 API 직접 구현, C# 전면 이식, 벡터 DB, 범용 MCP gateway, 에이전트 대량 추가는 첫 버전에서 제외한다.

## 2. 현재 구현과 설계안의 차이

아래는 최초 계획 작성 당시 체크아웃의 정적 코드 확인 기록이다. 이후 반영 결과는 문서 상단의 완료 범위와 각 구현 이력을 기준으로 하며, 이 표를 현재의 미수정 목록으로 해석하지 않는다.

| 영역 | 현재 근거 | 구현 계획에 반영할 차이 |
|---|---|---|
| 작업 계약 | `packages/core/src/types/task-run.ts:24` — 원문, 작업 경로, 실행 상태 저장 | 원문은 재사용하고 intent·명시 제약·가정·완료 기준·계약 revision을 추가 |
| CLI 실행 | `packages/agent/src/model-cli-invocation.ts`, `model-cli-adapter.ts` — stdin, shell:false, JSONL, timeout, 취소, 출력 상한 구현 | 신규 어댑터를 중복 구현하지 않고 UTF-8 경계, 프레임 검증, 종료 의미, 자식 프로세스 정리를 보강 |
| 기능 추천 | `packages/skillify-adapter/src/capability-suggester.ts:12` — trigger-term 기반, 기본 상위 5개 | 명시 요청·작업 계약·준비 상태를 먼저 반영하고 키워드는 후보 검색 보조로 사용 |
| 스킬 실행 | `capability-service.ts` — 승인된 스킬 본문 주입 및 스크립트 승인 제안 | 스킬 지침 채택과 스크립트 실행 권한을 분리하고 현재 호출 가능한 자원인지 표시 |
| MCP | `packages/core/src/types/mcp.ts`, `packages/agent/src/mcp-config-builder.ts:41` | 설정 모델에는 HTTP/SSE가 있지만 실행별 Codex 설정은 stdio·SecretVault 참조 없는 구성만 지원. UI 등록과 실제 호출 가능 상태를 구분해야 함 |
| QA | `packages/quality/src/evidence-reader.ts`, `quality-evaluator.ts`, `apps/desktop/electron/services/automatic-quality-service.ts` | 빌드·테스트·diff 중심. 자료 조사·번역·원인 설명의 완료 조건을 계약별로 추가 |
| QA 근거 강도 | `quality-evaluator.ts:70` — diff 존재 시 reviewed=true. evidence reader는 요약의 pass/exit 문자열도 사용 | diff 존재·검토 수행·검토 통과를 분리하고, 검증된 실행 레코드를 주 근거로 사용 |
| 모델 선택 | `packages/core/src/types/agent-model-allocation.ts:17` — 역할별 고정 모델 | 역할을 기본값으로 사용하되 요청 난이도·허용 모델·잔여 예산에 따라 호출마다 결정 |
| 비용 | `agent-planning-service.ts:663,1183`에서 usage 추정 시 가격표 미전달. `model-usage-estimator.ts`의 기본 가격표는 빈 객체 | 현재 CLI 경로에서는 USD 추정이 비어 있을 수 있음. 가격/사용량 출처와 unknown 상태부터 정비 |
| 예산 | `packages/core/src/conversation/budget-policy.ts:29` — 추정 비용이 없으면 allow | 기존 예산 정책을 재사용하면서 가격 미확인 처리, 호출 전 예약, 병렬 호출 합산을 보완 |
| 학습 | `packages/learner/src/model-selection-feedback.ts` — 평균 reward 우선, 표본 수에 따른 confidence | 작업 유형별 검증 품질·비용·지연을 함께 평가. 단일 성공을 일반화하지 않음 |
| 생성 프로필 | `agent-profile-repository.ts:1456` — 시드 ID/이름 일치 시 tuning 재정렬 | auto/pinned와 시드 소유 정보를 명시해 사용자가 수정한 생성 프로필도 재시작 시 보존 |

추가 확인 사항:

- 현재 설치: `codex-cli 0.153.4`, .NET SDK `10.0.400`. 원문의 "실행 파일 미확인"은 문서 작성 환경에 한정된 정보다.
- 로컬 도움말에서 stdin, `exec --json`, `--output-schema`, `exec resume`, App Server 기본 stdio 지원을 확인했다.
- 이 셸의 Codex 진단에는 home-directory 경고가 발생한다. 실제 앱 자식 프로세스의 홈·인증 환경 확인은 Phase 0에 포함한다.
- 이번 검토에서는 모델 호출·MCP 인증·실제 C# 빌드·전체 앱 회귀 테스트를 실행하지 않았다.

## 3. 목표 실행 흐름

```text
사용자 요청 + 첨부 자료
  → TaskContract / AuthorizationScope
  → ModelDecision + CapabilitySnapshot + 예산 확인
  → 단일 Codex 실행 또는 기존 명시적 파이프라인
  → 실행 이벤트 + Artifact + EvidenceRecord
  → 요구사항별 ResultVerifier
  → 완료 / 부분 완료 / 입력 필요 / 차단 / 실패 / 취소
```

각 단계가 별도 모델 호출을 의미하지 않는다. 간단한 계약은 원문과 UI의 작업 모드에서 만든다. 복잡한 계약 정리는 첫 작업 응답 안에 포함할 수 있으나, 모델이 해석한 필드는 권한을 확대하지 못한다.

## 4. 데이터와 호환성 설계

| 신규 또는 확장 개념 | 핵심 필드와 규칙 | 배치 |
|---|---|---|
| TaskContract | taskRunId, revision, intent, deliverable, constraints, assumptions, acceptanceCriteria, evidenceRequirements, freshness, language, origin | core 타입 + storage의 `task_contracts` |
| AuthorizationScope | 허용 작업·경로·외부 대상·승인 ID·정책 revision. 모델의 제안과 신뢰된 사용자/정책 값을 구분 | 기존 Approval/Policy 확장 |
| CapabilitySnapshot | 기능 ID, kind, 버전/hash, installed/enabled/authenticated/callable의 개별 상태, 점검 시각, 제한 사유 | 기존 capability/MCP 저장소 확장 |
| EvidenceRecord | artifactId, invocation/step ID, 출처, 읽은 범위, 관측 시각, hash/version, 명령·cwd·exitCode, 생성 주체 | `evidence_records`; 큰 내용은 Artifact 저장소 |
| RequirementResult | criterionId, satisfied/unmet/unknown/not_applicable, evidenceIds, 이유 | `requirement_results` |
| RunOutcome | completed/partial/needs_input/blocked/failed/cancelled, unresolved, contractRevision, evidenceRevision | 기존 TaskRun의 실행 상태와 별도 결과 레코드 |
| ModelDecision | auto/pinned, model, effort, 이유, 정책 버전, 예상 사용량, 비용 상태 | 호출/학습 레코드 확장 |
| WorkingState | 최신 계약 참조, 근거 참조, 남은 조건, 결정 요약, 예산, 재개 기준 | 기존 snapshot과 계약 참조 우선 재사용 |

기존 `TaskRunStatus`를 한 번에 교체하지 않는다. 실행 상태와 결과 상태를 구분해 추가하고, 완료 서비스가 기존 `done` 전이와 `RunOutcome.completed`를 함께 검증하도록 한다. 경고·필수 조건 누락을 자동 완료로 올리지 않는다.

DB 변경은 단계별 additive migration으로 도입하고 `SCHEMA_VERSION`을 순차 증가시킨다. 기존 작업은 원문을 보존한 legacy 계약으로 읽되, 과거 로그를 새 검증 기준으로 통과했다고 소급 표시하지 않는다. IPC 변경은 AGENTS.md의 9개 레이어와 단일 계약 문서를 함께 갱신한다.

## 5. 단계별 구현 순서

### Phase 0 — 기준선과 호환 계약 확정

작업:

- 현재 미커밋 변경을 보존하고 이번 기능의 수정 범위를 분리한다.
- Codex 버전·실제 실행 파일·홈·인증 상태·지원 명령과 실행별 MCP 제한을 진단 화면/로그에 연결한다.
- 기존 자동 QA, 병렬 worker, 사용자 정의 프로필 보존 테스트의 기준선을 기록한다.
- 원문 사례를 평가 데이터로 옮기고, 첫 검증 시나리오를 번역·코드 원인 조사·코드 수정으로 고정한다.

완료 기준: 설치/연결/권한/미검증 상태를 구분하고, 실제 모델 호출 없이도 재현 가능한 fake CLI 테스트 기반을 확보한다.

### Phase 1 — 작업 계약과 권한을 실행까지 연결

변경 범위: `packages/core/src/types/task-run.ts`, `packages/core/src/conversation/`, `packages/storage/src/repositories/task-run-repository.ts`, 신규 계약 repository, `agent-prompt-builder.ts`, `agent-planning-service.ts`, 관련 IPC/대화 화면.

작업:

- `answer/review/diagnose/change/research` 등의 intent, 요청 결과, 필수 근거, 사용자 제약을 원문과 함께 저장한다.
- "원인만 설명", "검토만", "검색하지 말라"를 계약에 유지하고, 모델의 해석과 명시 지시를 구분한다.
- 계약 revision마다 실행 정책을 만든다. 전역 workspace-write 설정이 켜져 있어도 읽기 전용 요청은 실행별 sandbox와 Host 정책을 제한한다.
- 유효한 기존 승인은 대상·행동·경로 범위 안에서 재사용한다. 사용자 경험상 매번 묻지 않아도 승인 기록과 강제 지점은 유지한다.
- 단순 작업은 추가 라우터 호출과 다중 에이전트 파이프라인을 기본으로 생성하지 않는다.

완료 기준: 리뷰 요청에서 파일 변경이 실행되지 않고, 수정 요청은 허용된 경로에 한해 기존 승인 실행을 이어간다. 첨부 문서의 지시문으로 scope가 넓어지지 않는다.

### Phase 2 — 기존 Exec 어댑터의 결과·취소·사용량 신뢰성

변경 범위: `packages/agent/src/model-cli-adapter.ts`, `model-cli-invocation.ts`, `model-cli-types.ts`, `provider-tool-call-events.ts`, `agent-stream-limits.ts`, `model-usage-estimator.ts`.

작업:

- 상태를 유지하는 UTF-8 decoder와 JSONL frame reader를 사용해 한글 문자가 chunk 경계에서 깨지지 않도록 한다.
- `--json`의 전송 이벤트와 `--output-schema`의 최종 결과 계약을 분리한다. 버전에 맞는 task result schema를 적용한다.
- 모델 최종 메시지, terminal event, 프로세스 exit 상태를 함께 검사한다. 잘린 JSON EOF·turn 실패·최종 결과 누락을 성공으로 취급하지 않는다.
- 텍스트 delta는 합칠 수 있지만 승인·실패·종료·usage는 별도로 유지한다. 출력 상한 때문에 완료 근거가 유실되지 않도록 한다.
- Windows에서 취소·timeout 이후 이번 실행의 자식 프로세스 트리만 정리하고 종료 확인을 기다린다. 이미 실행한 변경은 기록한다.
- usage를 원시 로그 재파싱에만 의존하지 않고 수신 시 집계한다. provider event의 누적/증분 의미를 버전별 fixture로 고정한다.

완료 기준: 분할 UTF-8, 여러 JSONL frame, stderr 폭주, 잘린 EOF, exit=0이지만 turn 실패, 출력 초과, 취소/종료 경합의 fake CLI 테스트를 통과한다.

### Phase 3 — 작업별 모델 선택과 예산

변경 범위: `agent-model-allocation.ts`를 fallback으로 유지, 신규 core model-routing 정책, `agent-profile-resolver.ts`, `agent-planning-service.ts`, `budget-policy.ts`, 프로필/설정 repository 및 UI.

작업:

- 모델 선택을 `auto`와 `pinned`로 구분한다. 생성 프로필에 seedKey·정책 버전을 두고 이름만으로 사용자 선택을 덮어쓰지 않는다.
- auto는 작은 후보 집합에서 작업 난이도·필요 기능·명시 모델·계정 접근·잔여 예산을 확인한다. 별도 LLM 라우터는 초기 도입하지 않는다.
- 기본 후보: 짧은 요약/번역/문서 정리 Luna, 일반 구현/테스트 Terra, 복잡한 계획/분석 Sol, 고난도 또는 확인된 하위 모델 한계에 한해 Astra.
- 오케스트레이터라는 이유만으로 Astra를 고정하지 않는다. 보안 작업도 위험도와 완료 조건을 보되, 검증되지 않은 저가 모델로 일괄 낮추지 않는다.
- 가격표에 출처·기준일·모델 ID·입력/캐시/출력 단가를 저장하고 관측 usage와 추정을 구분한다. 계정 요금제 청구와 API 환산 비용을 혼동하지 않는다.
- 가격 미확인은 `unknown`으로 표시한다. 명시한 비용 상한을 계산할 수 없는 경우의 실행 정책을 설정하고 0원으로 간주하지 않는다.
- 호출 전에 비용을 예약하고 종료 시 정산한다. 병렬 작업이 같은 잔여 예산을 중복 사용하지 않도록 SQLite 트랜잭션으로 예약한다.
- 상향 재시도는 검증 실패 유형·횟수·예산에 근거한다. 응답이 유실된 변경 작업을 모델 승격과 함께 재실행하지 않는다.

완료 기준: 동일 역할에서도 쉬운/어려운 작업의 선택이 달라지고 이유가 표시된다. pinned 선택은 재시작 후 유지되며, 동시 호출과 가격 unknown 사례가 예산 규칙을 지킨다. 실제 비용 절감은 동일 평가 작업의 총 토큰·재시도·품질을 측정해 판정한다.

### Phase 4 — 실제 사용할 수 있는 기능·스킬 선택

변경 범위: core capability/MCP 타입, `packages/skillify-adapter/`, `mcp-config-builder.ts`, MCP 설정/상태 서비스, Learning/Capability UI.

작업:

- 사용자가 지정한 기능을 우선 조회하고 설치·활성·인증·호출 가능 상태를 각각 표시한다. 모르는 상태를 성공으로 채우지 않는다.
- 후보 선택에 intent·필수 근거·명시 금지·권한을 반영한다. 키워드 점수는 좁은 후보를 찾는 용도로 제한한다.
- 선택한 스킬의 필수 지침을 읽고 참조 자료는 필요에 따라 연다. 목록과 버전을 작업에 기록하며 수정 시 cache를 무효화한다.
- 실행별 MCP에서 지원하는 transport·secret 전달·실제 enabled_tools/disabled_tools 연결을 검증한다. 서버 목록이 설정됐다는 이유만으로 도구별 제한이 강제됐다고 표시하지 않는다.
- 첫 MVP는 현재 검증된 stdio 경로를 사용하고, HTTP/인증 연동은 준비 상태가 확인된 후 확장한다. 설정 파일의 전역 재작성이나 자동 설치는 포함하지 않는다.

완료 기준: 명시 스킬 사용, 유사 이름의 잘못된 도구 회피, 인증 만료, 미지원 transport, 읽기 전용 도구 제한, 후보 검색 확대를 재현한다.

### Phase 5 — 요구사항별 검증·완료 표시·재개

변경 범위: `packages/quality/`, `packages/core/src/task-run/task-run-completion-service.ts`, 신규 evidence/result repository, `automatic-quality-service.ts`, 기존 QualityPanel·대화 상태·snapshot/learner 연결.

작업:

- 결과의 각 완료 기준에 근거 ID를 연결한다. 구조 검증과 내용 판단을 분리한다.
- 번역은 원문/요청 형식, 코드 조사는 읽은 소스/위치, 수정은 변경 파일/관련 실행 검사, 최신 정보는 출처/관측 시점을 기준으로 검증한다.
- 실행 근거에 producer·invocation·명령·경로·exitCode·시점·hash를 연결한다. 모델이 쓴 "pass" 문장이나 diff 존재만으로 실행/검토 통과를 인정하지 않는다.
- 일반적인 QA는 결정적 검증과 같은 세션의 검토를 활용한다. 별도 모델 검토는 고위험/복잡한 조건에서만 예산에 포함한다.
- 응답 스트리밍, 모델 응답 종료, 검증 중, 과제 완료를 UI에서 구분한다. 미충족 요구사항과 미실행 검사를 한국어/영어 표시에 연결한다.
- 재개 시 소스/입력 hash와 계약 revision을 비교한다. 변경된 근거는 stale로 처리하고 필요한 검사만 다시 수행한다.
- 검증된 결과와 provenance를 Learner에 공급한다. 비용/성공률은 같은 작업 유형의 충분한 표본으로 비교하며 권한·모델 고정을 학습이 덮어쓰지 않는다.

완료 기준: 단순 설명에 불필요한 빌드 QA가 붙지 않고, 수정 과제는 필수 검사가 남으면 완료되지 않는다. 과거 테스트·허위 성공 로그·취소 결과가 새 완료 근거로 재사용되지 않는다.

### Phase 6 — 평가와 점진 활성화

변경 범위: 기존 `packages/evals/`, `scripts/eval/`, 관련 `.test.mjs`, Electron UI smoke test.

- 평가 작성은 Phase 0부터 병행한다. 원문 10개 행동 유형을 기본으로 정상/실패/경계 변형을 더해 30~50개 규모로 확장한다.
- mock/fixture 계약 검사와 실제 Codex·MCP·Electron 검증을 별도 보고한다.
- 자동 라우팅은 처음에 추천만 기록해 고정 기준과 비교한다. 근거가 쌓인 작업 유형부터 auto 실행을 활성화한다.
- 범위 밖 변경·허위 완료·취소 후 추가 실행은 회귀 fixture에서 0건을 목표로 한다. 품질·전체 비용·P50/P95 지연은 동일 사례의 기준선과 비교한다.
- 여러 반복 결과를 수집하기 전에는 에이전트 개수 비율을 비용 절감률로 보고하지 않는다.

출시 기준: 해당 단계 타입 검사·관련 테스트·빌드 통과, DB migration 재실행/기존 데이터 보존, 대표 Electron 시나리오와 실제 실행 증거 확인. 실패 시 새 실행 기능 flag를 끄되 계약·근거·관측 데이터는 보존한다.

## 6. 후속 선택 단계 — App Server와 성능

지속 대화·도중 개입·승인 응답이 필요할 때 `CodexAppServerRuntime`을 별도 추가한다. 초기화, thread/turn, 서버 승인 요청, steer/interrupt, model/list를 담당하며 지원 기능을 명시한다. `exec`의 세션 재개와 실행 도중 steering은 다른 기능으로 표시한다.

App Server는 현재 공식 문서와 설치 CLI에서 실험적 표기가 확인된다. stdio 사용, CLI/schema 버전 고정, 동일 전송/취소 평가 통과, 기능 flag 적용을 도입 조건으로 한다. 알려지지 않은 서버 요청에는 오류 응답을 보내고, pending 요청은 EOF/timeout에 정리한다. 자동으로 실패한 변경 작업을 exec로 재실행하지 않는다. [공식 App Server 문서](https://learn.chatgpt.com/docs/app-server)

성능 작업은 문맥 크기·호출 횟수·도구 대기·UI 처리량을 먼저 측정한다. C# 전용 Pipelines/FrozenDictionary/ValueTask는 TypeScript 코드에 도입할 항목이 아니다. 현재 bounded buffer를 활용하고 계측된 병목에 한해 parser/queue/표시 갱신을 최적화한다.

## 7. 별도 C# CLI를 선택할 때의 분기

별도 제품이 목적이면 Phase 0 뒤에 `Astro.Cli`, `Astro.Core`, `Astro.Codex`, 테스트 프로젝트를 생성하는 단계가 추가된다. 현재 설치된 .NET SDK는 확인됐지만 target framework·지원 OS·패키징 기준은 그 시점의 공식 .NET 문서와 함께 정한다.

이 경우 기존 TypeScript 서비스는 직접 재사용할 수 없으므로 JSON Schema·golden JSONL·평가 fixture를 공통 계약으로 사용한다. 두 앱이 같은 SQLite DB를 각자 다른 migration으로 수정하지 않도록 저장소 소유권을 먼저 결정한다. 초기에는 독립 실행·독립 DB를 기본으로 하고, 데스크톱 통합은 후속 과제로 분리한다.

## 8. 첫 구현 단위

첫 PR 범위는 **TaskContract 저장과 읽기 전용 요청 강제**가 적절하다. 기존 코드에 직접 이어 붙일 수 있고, 이후 모델 선택·기능 선택·QA가 함께 사용할 기준을 만든다.

작게 검증할 세 가지 수용 시나리오:

1. "이 문장만 번역" → 부가 파이프라인/불필요한 검사 없이 원문에 대한 결과를 반환한다.
2. "이 코드의 원인만 설명" → 파일을 읽어 근거를 제시하고 수정 제안이 자동 실행되지 않는다.
3. "이 오류 수정" → 허용된 경로의 변경을 기존 승인 실행으로 처리하고 관련 검증 결과를 연결한다.

새 모델 호출·자동 재시도·App Server를 추가하기 전에 이 계약을 fake runtime으로 검증한다.

## 9. 확인한 공식 출처

- `--json`은 JSONL 이벤트이며 `--output-schema`는 최종 응답 구조를 지정한다. 실행 형식 계약의 근거로 사용했다. [비대화형 실행](https://learn.chatgpt.com/docs/non-interactive-mode)
- MCP의 활성화와 도구 allow/deny 설정을 실행별 기능 상태 계획의 근거로 사용했다. [MCP 설정](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- 스킬의 메타데이터 탐색과 선택 후 상세 지침 로딩을 기능 선택 계획의 근거로 사용했다. [스킬](https://learn.chatgpt.com/docs/build-skills)

계획에 적힌 신규 타입·테이블·정책·평가 목표는 HarnessAgentOS용 제안이다. 아래 구현 기록에 명시된 범위만 현재 구현에 반영되어 있으며 Codex 표준 필드를 뜻하지 않는다.

## 10. 첫 구현 기록 — 2026-09-07

### 반영 범위

- Core `TaskContract` revision 1: 목적·원문·기본 완료 기준·근거 요구·명시적 변경/검색 금지. UI 목적 선택을 main에서 검증한다. 자동 추론에는 추가 모델 호출이 없다.
- SQLite schema v39: `task_contracts` 종속 테이블을 추가하고 TaskRun과 동시 커밋한다. 기존 작업은 legacy 계약으로 읽으며, 손상된 계약은 오류로 처리한다. 기존 승인·학습 데이터의 내용이나 모델 배정은 변경하지 않는다.
- 대화 입력의 자동/답변/검토/진단/수정/조사 선택과 읽기 전용 배지. 한·영 번역 사전을 함께 확장했다. 읽기 전용 요청은 자동 부가 추천 승인과 파이프라인을 생략한다.
- 일반 agent와 worker 모두 원래 계약을 프롬프트·sandbox에 전달한다. workspace-write/자동 리뷰 전역 설정보다 읽기 전용 계약을 우선한다. 변경 제안은 승인 생성에서 거부하고 승인/Runner/worker 실행에도 강제 검사를 둔다.
- 기본 계획 fallback·재계획·다른 TaskRun 승인 혼용을 통한 우회를 차단한다. 권한 범위를 바꾸려면 새 메시지를 생성해야 한다.
- 실행별 MCP 사전 점검: 현재 CLI 0.153.4에서 `mcp_servers={}`는 기존 서버를 지우지 않는 것을 설정 조회로 확인했다. 서버별 `.enabled=false`와 앱·플러그인 비활성화를 사용하며, 점검에 실패하면 모델을 시작하지 않는다. 점검 전후 확인된 5개 서버의 enabled는 모두 false였다. [공식 Codex 설정](https://learn.chatgpt.com/docs/config-file/config-reference)
- 검색 금지 요청은 web search와 외부 도구를 끄고 Codex workspace-write 네트워크도 끈다. 별도 네트워크 격리가 없는 Host 명령·스크립트·git·dependency·pipeline 실행은 보수적으로 막는다. 승인된 파일 patch/write는 유지한다.

### 검증 결과

- `npm run check`: 전체 workspace 통과.
- `npm run build`: Electron main/preload/renderer 빌드 통과.
- 전체 `.test.mjs` 단위·통합 테스트: **1,508개 중 1,506개 통과, 실패 0, 기존 외부 harness-100 sample 의존 테스트 2개 skip**.
- 테스트 실행은 설치된 Electron native SQLite 모듈을 보존하기 위해 `ELECTRON_RUN_AS_NODE=1`과 `electron.exe --import tsx --test --test-force-exit`로 수행했다. 일반 `npm run test`의 Node native 모듈 재빌드는 실행하지 않았다.
- 새 정책 파일 `task-contract.ts` 커버리지: 라인 **97.78%**, 분기 **88.68%**, 함수 **88.89%**. 전체 코드베이스 커버리지를 뜻하지 않는다.
- Playwright Electron E2E **7/7 통과**: 새 목적 선택→IPC→SQLite, 기존 한·영 전환, 병렬 실행·취소, 모델 선택, pipeline UI 포함. 모두 임시 userData와 fake agent 사용.
- E2E `.test.mjs`는 Playwright 전용으로 유지하고, Node 테스트 script에는 `src/electron/scripts` 경로를 명시하여 서로 다른 테스트 런너가 섞이지 않게 했다.
- 운영 DB를 직접 열어 migration하지 않았고 유료 모델/실제 원격 A2A를 호출하지 않았다. 실제 Codex 모델의 파일 접근 sandbox 수용 테스트·운영 앱 재시작은 별도 검증 대상이다.

### 적용·호환·후속

- 다음에 빌드된 앱을 열면 정상 시작 경로에서 additive v39 migration이 적용된다. 계약 없는 과거 요청에 검증 완료 결과를 소급 부여하지 않는다.
- 이전 버전의 앱은 작업 계약을 강제하지 않는다. 단순 바이너리 downgrade를 안전한 정책 rollback으로 취급하지 않는다. 복구가 필요하면 앱을 모두 종료하고 호환 버전의 앱과 SQLite 일관성 백업을 함께 복원한다. 운영 백업/복원은 이 구현에서 실행하지 않았다.
- 현재는 안전한 도구 readiness가 없는 읽기 전용 pipeline/외부 도구 실행을 허용하지 않는다. Phase 4의 기능별 권한 분류 후 제한을 세분화한다.
- 자동 intent는 보수적인 규칙 기반 초기 버전이다. UI 목적 선택과 명시 금지가 우선하며, 일반 자연어·첨부의 모든 의미를 형식적으로 증명하지 않는다. 요구사항별 evidence 판정은 Phase 5에 남아 있다.
- 이 구현 직후의 다음 단위였던 Phase 2 전송·종료 안정화는 아래 11절에 기록한다. 이후 모델 비용 정책→기능 readiness→요구사항별 QA→평가 corpus 순으로 진행한다. Phase 0의 진단 화면 확대도 후속 범위다.

## 11. Phase 2 핵심 구현 기록 — 2026-09-07

### 반영 범위

- `CodexExecStream`: 상태 유지 UTF-8 decoder, CRLF/복수 JSONL/정상 non-newline EOF 처리. 비정상 UTF-8·잘린 JSON·잘못된 envelope를 실패로 처리한다. frame/final은 각각 기본 4 MiB로 제한한다.
- 최종 답변·terminal·usage를 raw 로그 tail과 독립적으로 보관한다. 종료 코드 0만으로 성공 처리하지 않고 유효한 마지막 assistant 메시지와 성공 terminal, EOF를 함께 확인한다. fatal error가 뒤의 성공 이벤트로 덮이지 않게 한다.
- stdout tool 이벤트도 이미 파싱한 객체를 사용한다. stderr는 별도 StringDecoder와 기존 bounded tool event parser를 유지한다.
- `ModelCliResult.tokenUsage`를 planner/worker 양쪽의 기존 invocation token 컬럼에 연결한다. null은 "관측했지만 정확한 사용량 없음", undefined는 legacy adapter로 구분해 이전 로그의 일부를 정확한 최종 사용량으로 승격하지 않는다. DB migration은 추가하지 않았다.
- Codex 0.153.4의 JSONL emitter가 `usage.total`을 내보내는 것을 공식 소스에서 확인했다. 최신 누적 값을 보관하고 이전 turn·동일 terminal을 합산하지 않는다. reasoning은 output total의 부분집합이므로 기존의 추가 합산을 제거했다. [0.153.4 emitter](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/exec/src/event_processor_with_jsonl_output.rs), [Responses usage 변환](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/sse/responses.rs), [reasoning usage](https://developers.openai.com/api/docs/guides/reasoning#managing-the-context-window)
- 취소 처리는 adapter가 소유한다. spawn에 AbortSignal을 위임해 부모가 먼저 죽는 경로를 제거하고, Windows는 이번 spawn PID에만 taskkill /T /F를 적용한다. helper 종료와 child close를 모두 기다린다. 다른 OS는 기존 SIGTERM→SIGKILL fallback을 유지한다. timeout/stall/abort의 최초 원인을 보존하고 stdin EPIPE·spawn error에서도 자식 정리를 거친다. [Windows 종료 범위](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill)
- 전체 회귀에서 드러난 기존 작업 계약 오류 코드 export 누락을 함께 보완했다. `TASK_CONTRACT_ACTION_BLOCKED`와 `TASK_CONTRACT_PREFLIGHT_FAILED`를 Core의 공용 오류 코드로 등록했다.

### 검증 경계

- TDD로 UTF-8 손상, 거짓 성공, 로그 유실, 사용량 중복 집계, 취소/종료 경합의 실패를 먼저 재현한 뒤 수정했다.
- Windows 실제 프로세스 테스트: 모델 대신 Node 가짜 CLI의 stdout pipe를 사용했다. 별도 테스트에서 부모·자식 프로세스 트리를 종료하고 같은 실행 파일의 무관한 sibling 프로세스가 살아 있음을 확인했다.
- 변경된 4개 런타임 모듈의 focused 테스트 61/61 통과. 커버리지 라인 98.49%, 분기 91.02%, 함수 96.00%. 전체 프로젝트 커버리지를 의미하지 않는다.
- 전체 테스트·타입 검사·빌드·Electron 최종 재검증 결과는 아래 최종 검증 항목에 기록한다. 실제 모델 호출, 사용자 데이터 변경, 앱 자동 재시작은 수행하지 않는다.

### 남은 범위와 다음 구현 단위

- **Phase 2 후속: 작업 결과 schema와 CLI 버전 호환 검증.** 이 절 작성 시에는 미적용이었으며, 이후 구현한 output schema v1과 호환 검증은 아래 12절에 기록한다. 요구사항별 evidence 의미 검증은 Phase 5의 별도 범위다. [공식 전송/최종 스키마 구분](https://learn.chatgpt.com/docs/non-interactive-mode)
- 현재 exec는 새 세션으로 실행한다. resume를 추가하면 누적 thread usage와 이번 호출 사용량을 분리하는 기준점이 필요하다.
- 실패/취소 중 부분 사용량 보존·캐시/추론별 가격 계산·예산 예약은 Phase 3에서 처리한다. 이번 수정은 실제 청구액 계산이나 비용 절감률 검증이 아니다. 과거 DB의 집계값도 소급 수정하지 않는다.
- Windows tree 테스트는 정상적으로 연결된 자식 트리와 정리 실패 mock을 포함한다. OS 권한 거부, 부모가 먼저 종료되어 이미 분리된 프로세스, CLI의 외부 데몬 전체 수명주기는 검증하지 않았다. 정리 실패를 성공으로 숨기지 않으며 기존에 발생한 파일 변경을 취소로 되돌리지 않는다.
- GUI E2E는 fake agent를 사용한다. 실제 Codex 인증·모델 응답·외부 MCP 수용 테스트는 별도로 실행해야 한다.

### 최종 검증 결과

- 전체 workspace `npm run check`와 `npm run build`: 통과. Electron main/preload/renderer 산출물 생성 확인.
- Electron Node 런타임 전체 `.test.mjs`: **1,546개 중 1,544개 통과, 실패 0, 외부 harness-100 샘플 부재로 기존 2개 skip**. native SQLite 재빌드나 운영 DB 열기 없이 실행했다.
- 최종 전체 Playwright Electron E2E: **7/7 통과**. 단, 직전 반복 실행에서 task-contract 화면 생성 대기가 한 번 5초 timeout(6/7)을 기록했다. 해당 테스트 단독 5회와 이후 전체 7개 재실행은 모두 통과했다. 최초 간헐 실패의 원인은 확정하지 못했으며 해결됐다고 간주하지 않는다.
- `git diff --check`: 통과. 변경된 런타임 파일의 추가 console.log 및 일반적인 하드코딩 API 키 패턴 점검에서는 발견 없음. 별도 lint script/config와 전체 의존성 보안 감사는 이번 검증에 포함하지 않았다.
- 자동 커밋·실제 모델 호출·사용자 전역 설정 변경·운영 앱 재시작 없음. 이번 실행에서 종료한 실제 프로세스는 테스트가 만든 임시 Node 트리뿐이다.

## 12. Phase 2 후속 구현 — 작업별 최종 응답 스키마 v1

### 반영 범위

- planner와 local worker가 원래 TaskRun의 TaskContract를 `outputContract`로 전달한다. worker의 부분 지시문으로 작업 목적/권한을 재분류하지 않는다.
- 기본 Codex adapter는 호출 전에 선택된 실행 파일의 `--version`과 `exec --help`를 확인한다. 식별 가능한 Codex 버전과 `--output-schema <FILE>` 지원을 확인하지 못하면 모델 spawn 전 `TASK_CONTRACT_PREFLIGHT_FAILED`로 중단한다. 이는 특정 버전의 전체 동작을 인증하는 절차가 아닌 기능 지원 점검이다.
- `exec --json`은 전송 이벤트 형식, `--output-schema`는 최종 답변 형식으로 분리했다. schemaVersion=1과 원래 taskIntent를 고정하며 모든 필드를 required로, 모든 object를 additionalProperties=false로 정의한다. 같은 host-owned 스키마 정의로 반환 JSON을 한 번 더 검사한다. [Codex 공식 문서](https://learn.chatgpt.com/docs/non-interactive-mode), [Structured Outputs 제약](https://developers.openai.com/api/docs/guides/structured-outputs)
- answer/review/diagnose/research의 읽기 전용 계약은 proposedActions와 suggestedQualityChecks를 빈 배열로 제한한다. 검색 금지 계약은 파일 제안만 허용하고 shell 제안과 실행형 quality check를 제외한다. 기존 Approval/Runner 정책은 그대로 남는다.
- CLI에는 단일 JSON 객체를 요구한다. 검증된 결과만 기존 harness_agent_plan 형태로 정규화해 renderer/approval과 호환한다. 문자열 안의 backtick은 JSON escape로 보존해 중첩 코드 블록이 파서의 첫 번째 plan을 바꾸지 못하게 한다. `file_write.before`의 null은 기존 optional 필드로 변환한다.
- 병렬 호출별로 임시 스키마 경로를 분리하고 종료/실패/취소 후 정리한다. 생성한 파일과 빈 디렉터리만 삭제하며, junction/심볼릭 링크로 바뀐 경로는 정리를 거부한다. 정리 오류는 경고로 남기고 원래 호출 오류를 덮지 않는다. 스키마 파일에는 비밀값/사용자 요청이 없으며 파생 실행 설정일 뿐 canonical state가 아니다.
- worker의 잘못된 응답이 빈 action + succeeded로 처리되는 경로를 제거했다. 실패 진단을 저장하고 오류 상태를 반환한다.
- 서비스는 200,000자 로그 미리보기가 아닌 완전한 최종 답변을 파싱한다. 비밀값은 검증된 JSON 문자열 필드마다 가려, 마스킹이 JSON 닫는 따옴표를 지우는 문제를 방지한다. UI 로그 저장 상한은 유지한다.

### 경계와 호환성

- 스키마 통과는 형식/작업 범위 검사이며 작업 완료나 QA 통과를 뜻하지 않는다. 출처의 진위, 요구사항 충족 여부와 증거 기반 완료 판정은 Phase 5에 남는다.
- 새 IPC 채널과 DB migration은 없다. 기존 저장된 plan과 신뢰된 주입형/가짜 adapter의 harness_agent_plan 출력은 호환 경로를 유지한다. 기본 Codex adapter에는 strict wire validation이 적용된다.
- 이미 승인된 workspace-write 실행 중 발생한 변경을 최종 JSON 오류만으로 되돌리지는 않는다. 기존 finally workspace-change evidence와 승인 경계를 유지한다.
- 실제 모델 호출, 외부 MCP 인증, API 비용 발생 테스트, 운영 DB 열기와 앱 재시작은 수행하지 않았다. 로컬 CLI 0.153.4의 버전/도움말 지원 확인과 가짜 프로세스/가짜 에이전트 테스트를 실제 모델 수용 검증으로 간주하지 않는다.
- 다음 단위는 **Phase 3 모델·비용 정책**이다. 가격/사용량의 unknown 구분, 실패 호출 부분 사용량, 호출 전 예산 예약과 병렬 합산을 우선하고, 자동 선택과 사용자가 고정한 모델을 구분한다.

### 검증 결과

- 새 형식의 누락/추가 필드, 잘못된 intent/version, 읽기 전용/검색 금지 위반, 잘못된 worker 성공 처리와 cleanup 오류 덮어쓰기를 먼저 실패 테스트로 재현했다.
- focused 테스트 144/144 통과. 신규 스키마 2개 모듈 커버리지: 라인 99.43%, 분기 91.67%, 함수 100%. 전체 프로젝트 커버리지가 아니다.
- 실제 Windows junction 교체 시 외부 대상 파일이 보존되는 테스트, 다른 호출의 스키마와 알 수 없는 파일을 삭제하지 않는 테스트 포함.
- 전체 회귀·최종 빌드 결과는 아래 최종 확인에 기록한다. Electron E2E 최초 실행은 7/7 통과했으며, 앞 단계에서 기록한 간헐적 task-contract timeout 원인의 해결을 의미하지 않는다.

### 최종 확인

- `npm run check`, `npm run build`, `git diff --check`: 통과.
- Electron Node 런타임 전체 테스트: **1,598개 중 1,596개 통과, 실패 0, 기존 외부 harness-100 샘플 부재 2개 skip**.
- 최종 빌드의 Electron E2E: **7/7 통과**. 이번 단계에서 전체 E2E를 두 번 실행해 모두 통과했으며, fake agent와 별도 임시 userData를 사용했다.
- 실제 설치된 `codex-cli 0.153.4`로 버전/도움말 확인 → 스키마 생성 → 소유 파일 정리 smoke 통과. 이 과정에서 모델 세션을 시작하지 않았다.
- 신규 런타임 모듈의 일반적인 하드코딩 API 키/console.log 패턴 점검에서 발견 없음. 별도 lint 스크립트와 전체 의존성 보안 감사는 포함하지 않았다.
- 자동 커밋·운영 앱 재시작·운영 DB 변경·실제 유료 모델 호출 없음. 새 코드를 실행 중인 앱에 적용하려면 앱 재시작이 필요하다.

## 13. Phase 3-1 — 저장 모델 보존과 비용 미확인 차단

### 구현 결과

- 기본 제공 seed의 모델을 앱 시작 때 역할 기본값으로 다시 덮어쓰던 경로를 수정했다. 지원되는 저장 모델과 추론 수준은 seed ID/이름 여부와 무관하게 보존한다. 실제 DB 원본에서 지원이 끝난 모델만 역할별 호환 값으로 변환하며, 추론 수준 누락만으로 정상 모델을 교체하지 않는다.
- planner는 활성/default 프로필을 고정 선택으로 취급한다. 이전에 승인된 Learner 추천이 저장 모델을 교체하지 않으며, 명시적인 호출별 override는 유지한다. 프로필이 없는 레거시 경로의 승인된 추천 fallback은 유지한다. worker는 전달된 프로필의 선택을 유지한다.
- 가격표의 정확한 모델 ID와 검증된 API 과금 모드를 요구한다. 불완전/비정상 요율은 미확인이고, 명시적 0 요율만 0달러로 산출한다. 부분 문자열/상속 속성으로 가격표를 선택하지 않는다.
- 일반 입력과 cached 입력을 분리 계산하고 reasoning 토큰을 출력 비용에 중복 가산하지 않는다. `maxStandardInputTokens`가 지정된 가격표에서 누적 입력이 범위를 넘으면 요청별 근거 없이 문맥 배수를 추정하지 않는다. 현재 누적 사용량만으로는 여러 API 요청의 가격 계층을 복원할 수 없다.
- transcript result의 `usage`에 토큰 기반 비용 상태·미확인 사유와 cached/reasoning 사용량을 기록한다. 이는 기존 SQLite artifact 안의 메타데이터이며 새 canonical JSON 파일이나 DB migration은 없다.
- 비용 미확인/비정상 값, 작업·일일 누적 비용의 미확인 호출은 설정된 USD cap 검사를 통과하지 못한다. 전역/프로필 자동 승인과 pipeline 동의 경로에 동일한 누적 정보를 전달하며, 누락된 정보를 화면에서 0으로 보정하지 않는다.
- planner/local worker는 모델 호출 및 MCP 준비 전에 예산을 검사한다. **현재 CLI에는 검증된 과금 방식과 호출 전 비용 상한이 없어, USD cap이 설정되어 있으면 `AGENT_BUDGET_UNVERIFIABLE`로 차단한다.** 설정을 임의 해제하지 않는다. 설정 화면의 경고를 한영으로 갱신했다.
- 이미 생성된 로컬 파일 적용 자체는 새 모델 호출이 아니므로 비용 미확인만으로 막지 않는다. 기존 권한·Approval·Runner 정책은 그대로 적용한다.

### 과금·완료 경계

- API 입력/캐시/출력 요율과 Codex 구독 포함 사용량/크레딧은 별개다. 실제 CLI 경로에 API 가격을 임의 주입하거나 구독 비용을 USD로 환산하지 않았다. 참고 토큰 추정은 tool/cache write/서비스 tier까지 포함한 청구액이 아니다. [OpenAI API 모델 과금](https://developers.openai.com/api/docs/models/gpt-6-astra), [Codex 구독/API 과금 구분](https://learn.chatgpt.com/docs/pricing)
- **Phase 3 전체 완료는 아니다.** SQLite 원자적 예약·정산, 취소/실패의 부분 사용량 회계, 요청별 가격 근거, 자동/고정 선택 모드 UI는 미구현이다. 이번 fail-closed 검사를 병렬 예산 총액 또는 실제 청구액의 완전한 상한 보장으로 해석하지 않는다.
- 실제 모델 호출, 운영 DB 변경, 운영 앱 재시작, 자동 커밋은 수행하지 않았다. 사용자의 기존 저장 모델/예산을 직접 일괄 변경하지 않는다.

### 검증

- 가격 누락·잘못된 캐시 요율·모델 오매칭·비용 미확인 승인 통과·Learner의 고정 모델 덮어쓰기·호출 전 예산 우회를 실패 테스트로 먼저 재현했다.
- focused 정책/서비스 테스트 81개와 SQLite 프로필 테스트 23개 통과. 프로필 테스트에는 실제 DB를 닫고 다시 열어 seed 초기화를 반복하는 모델 보존 검사와 원본 legacy row 변환을 포함한다.
- 최종 전체 회귀: **1,626개 중 1,624개 통과, 실패 0, 기존 harness-100 외부 샘플 부재 2개 skip**. 설치된 native 모듈 ABI를 변경하지 않고 Electron Node 런타임으로 실행했다.
- 변경된 비용·자동 승인 정책 4개 모듈: 라인 **98.69%**, 분기 **91.72%**, 함수 **100%**. 전체 프로젝트 커버리지가 아니다.
- `npm run check`, `npm run build` 통과. 별도 lint 설정/스크립트는 없으며 전체 의존성 보안 감사는 수행하지 않았다. 변경된 비용/자동 승인 런타임의 일반적인 하드코딩 API 키·console.log 패턴 점검에서 발견 없음.
- 신규 Electron 예산 테스트는 임시 SQLite 프로필 cap 저장 → typed IPC로 두 병렬 planner 요청 → 모두 차단되고 invocation/approval 없음까지 검사한다. 최초 실패는 테스트가 preload의 오류 메시지 prefix 대신 `.code` 속성을 읽은 문제였고 기존 오류 전달 계약에 맞춰 수정했다.
- 최종 빌드의 Electron E2E **8/8 통과**, `git diff --check` 통과. 실제 모델/외부 과금이 아닌 fake agent와 임시 userData 검증이다. Phase 2에서 기록한 간헐적 task-contract 5초 timeout의 원인 해결을 주장하지 않는다.

### 미구현 설계의 처리

원자적 비용 예약·정산, 부분 사용량 회계, 자동/고정 모델 선택 UI는 설계에만 남아 있다. 이를 현재 제공하는 기능으로 표시하지 않으며, 이번 완료 뒤 자동으로 착수하지 않는다. 새로운 기능 범위와 별도의 완료 조건이 합의되기 전까지 구현 약속으로 취급하지 않는다.
