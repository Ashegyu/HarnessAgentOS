# 메타 평가 시스템 (Meta Evaluation) — 구현 계획서

> **상태**: DRAFT · 사용자 confirm 대기 중 · 코드 미작성
> **작성**: 2026-05-17
> **대상**: HarnessAgentOS의 회귀·품질·안전성을 측정하는 자체 평가 시스템 구축

---

## 0. 한 문장 요약

이 harness가 *어떤 종류의 작업에서 잘 통과하고 어떤 종류에서 실패하는지* — 그리고 그 비율이 **커밋마다 어떻게 변하는지** — 를 측정한다.

## 1. 왜 지금 만드는가

현재 시스템에 빠진 한 가지: `QualityEvaluator`는 *개별 TaskRun*을 평가한다. 하지만 *"이 harness 자체가 신뢰할 만한가"* 를 측정하는 회귀 셋이 없다. 프롬프트·파이프라인·모델을 바꿔도 다음과 같은 질문에 답하지 못한다:

- 이번 변경이 안전 게이트(`blockedActions`, autoApprove)를 우회시키는가?
- 파이프라인 instruction이 worker step에 *verbatim* 전달되고 있는가?
- RepairLoop이 max 2 attempts에서 진짜로 멈추는가?
- 승인된 capability/learner context가 prompt artifact에 *실제로* 들어가는가?

이 모든 질문에 매 커밋마다 자동으로 답하는 시스템이 필요하다.

## 2. 세 축 (100% 커버리지)

| 축 | 출처 | 우리가 차용하는 것 |
|---|---|---|
| **agent-eval** | ECC `agent-eval` 스킬 | 격리 실행, 3+ runs, Pass/Cost/Time/Consistency, code grader 필수 |
| **eval-harness** | ECC `eval-harness` 스킬 | EDD (정의 먼저), Capability/Regression/Safety 분리, `pass@1`/`pass@3`/`pass^3`, 4종 grader |
| **Safety (자체)** | 이 프로젝트 차별점 | `blockedActions` 방어 · autoApprove 4트리거 · RepairLoop 경계 · context delivery · instruction verbatim |

## 3. v1 핵심 결정 (변경 시 plan 수정 필요)

| # | 결정 | 정당화 |
|---|------|------|
| D1 | 새 패키지 `packages/evals` + `scripts/eval/run.mjs` | 기존 monorepo 패턴 일치 |
| D2 | Fixture 포맷 = **JSON** (`*.eval.json`) | 의존성 0개, Zod 패턴 재활용 |
| D3 | `SCHEMA_VERSION` 20 → **21**, 새 테이블 `eval_runs` | 컬럼: `id, suite, started_at, finished_at, status, summary_json` |
| D4 | Report 하이브리드: DB row + `workspace/eval-runs/<runId>/report.md` | DB=조회, md=PR 리뷰 |
| D5 | Provider head-to-head는 **v1 인터페이스만, 실행 v2 deferred** | fixture에 `provider?` 필드만 미리 추가 |
| D6 | LLM judge **v2 deferred**, v1은 code/rule grader만 | `Grader`를 discriminated union으로 확장 가능 |
| D7 | Safety = **FakeScenario 확장** (real LLM jailbreak ×) | 평가 대상은 *harness 방어*, LLM 내성 아님 |
| D8 | CI 기본 = fake, real CLI는 `EVAL_REAL_CLI=1` env-gate | `npm run verify`는 빠르고 결정적 유지 |
| D9 | **초기 10 케이스**: capability 3 · regression 3 · safety 4 | safety가 차별점이라 가장 두텁게 |

## 4. Phase 목록

| Phase | 문서 | 한 줄 설명 | 복잡도 | 추정 |
|-------|------|---------|--------|------|
| 0 | [phase-0-types-schema.md](./phase-0-types-schema.md) | 타입·Zod schema·메트릭 함수 정의 (EDD: 정의 먼저) | Small | 1-2일 |
| 1 | [phase-1-fake-introspection.md](./phase-1-fake-introspection.md) | FakeAdapter introspection + CaseRunner + capability 케이스 1개 | Medium | 2-3일 |
| 2 | [phase-2-capability-regression.md](./phase-2-capability-regression.md) | capability +2, regression 3 (verbatim · injection · model) | Medium | 3-4일 |
| 3 | [phase-3-safety.md](./phase-3-safety.md) | safety 4 케이스 + 3중 어설션 (이 프로젝트 차별점) | Medium-High | 3-4일 |
| 4 | [phase-4-persistence.md](./phase-4-persistence.md) | migration v21 + `EvalRunRepository` + md reporter | Small-Medium | 1-2일 |
| 5 | [phase-5-cli-ci.md](./phase-5-cli-ci.md) | `scripts/eval/run.mjs` CLI + 임계 exit code + `npm run eval` | Small | 1-2일 |
| 6 | [phase-6-v2-deferred.md](./phase-6-v2-deferred.md) | real CLI · provider 비교 · LLM judge · viewer UI (deferred) | Medium | 별도 마일스톤 |

**v1 합계**: Medium-High · 11-17일 (1인 기준)

## 5. 의존성 그래프

```
Phase 0 (types · schema · metrics)
  └─▶ Phase 1 (introspection · case runner · 1 capability case)
        ├─▶ Phase 2 (capability +2 · regression 3)     ┐
        └─▶ Phase 3 (safety 4 · 3중 어설션)            ┤ 병렬 가능
                                                        │
                                                        ▼
                                                  Phase 4 (DB · reporter)
                                                        │
                                                        ▼
                                                  Phase 5 (CLI · CI gate)
                                                        │
                                                        ▼
                                                  Phase 6 (v2 deferred)
```

Phase 2와 Phase 3는 case-runner 공유 외에는 독립적이라 **병렬 진행 가능**.

## 6. 미수정 영역 (negative scope)

이 phase 동안 절대 손대지 않을 곳:

- ❌ `packages/core` — `@harness/storage` import 금지 제약 준수
- ❌ IPC 레이어 전체 — renderer surface 없음 (v2 viewer 시점에 도입)
- ❌ `DEFAULT_HARNESS_SETTINGS` normalize 함수 — renderer 노출 없음
- ❌ Renderer 코드 (`apps/desktop/src/`) — UI는 v2
- ❌ 기존 `packages/quality` 동작 — eval은 *측정자*, 변경자 아님

## 7. 글로벌 리스크 (상세는 각 phase 문서)

| 등급 | 리스크 | 어느 phase에서 다루나 |
|-----|------|------|
| HIGH | Safety false-positive (fake가 위험 action 안 내놓아 "blocked"처럼 보임) | Phase 3 — 3중 어설션 |
| HIGH | Sandbox escape 미검출 (targetDir 밖 fs write) | Phase 1 — fs snapshot diff |
| MEDIUM | Fake adapter 비결정성 누수 (timestamp/id 흔들림) | Phase 1 — `now?`/`idGen?` 주입 |
| MEDIUM | RepairLoop 케이스가 기존 단위 테스트와 중복 | Phase 2 — full path 통합 신호 강조 |
| LOW | `SCHEMA_VERSION = 21` 다른 브랜치와 충돌 | Phase 4 — 머지 직전 재확인 |

## 8. 사용자 confirm 후 다음 단계

1. 이 문서가 `workspace/eval-plan/`에서 `docs/implementation/phase-16-meta-evaluation/`으로 승격
2. Phase 0부터 TDD로 진행 (RED → GREEN → IMPROVE)
3. **두 단계 머지** 권장: Phase 0~1까지 머지 → 사용자 확인 → Phase 2~3 진행
