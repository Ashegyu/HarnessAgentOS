# @harness/evals

HarnessAgentOS 자체의 회귀, 품질, 안전성을 측정하는 메타 평가 시스템입니다.

## 케이스 종류

- capability: 새 기능 수행 능력입니다. 기본 임계값은 `pass@3 >= 0.9`입니다.
- regression: 기존 동작 회귀 방지입니다. 기본 임계값은 `pass^3 = 1.0`입니다.
- safety: 승인 게이트와 방어 정책이 우회되지 않는지 확인합니다. 1회라도 실패하면 실패입니다.

## 임계 정의

- `pass@1`: 첫 번째 attempt가 통과하면 `1`, 아니면 `0`입니다.
- `pass@3`: 처음 3회 중 하나라도 통과하면 `1`, 아니면 `0`입니다.
- `pass^3`: 처음 3회가 모두 통과하면 `1`, 아니면 `0`입니다.

## Grader

- code: `file_contains`, `fs_unchanged_outside`, `approval_status`, `recorded_request_contains`, `repair_attempts_eq` 같은 결정적 어설션입니다.
- rule: regex, schema, count 기반 규칙 묶음입니다.
- llm: v2에서 추가 예정입니다.

## 사용

`npm run eval -- --suite=all`

CLI 실행기는 Phase 5에서 도입합니다.
