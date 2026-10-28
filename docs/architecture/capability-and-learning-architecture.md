# Capability And Learning Architecture

## 목적

Skillify와 Learner를 Harness OS의 자동 실행자가 아니라 추천과 근거 제공 계층으로 배치하는 아키텍처를 정의한다.

## 계층 구조

```mermaid
flowchart TB
  TaskRun["TaskRun context"] --> Cap["CapabilityService"]
  TaskRun --> Learner["LearnerAdvisor"]
  Cap --> Skills["Skill metadata / SKILL.md"]
  Learner --> Traces["LearningTrace history"]
  Cap --> Suggestions["Capability suggestions"]
  Learner --> Recommendations["Model/capability recommendations"]
  Suggestions --> UI["Recommendation UI"]
  Recommendations --> UI
  UI --> User["User chooses"]
```

## Capability 역할

Capability는 재사용 가능한 능력 단위다.

- built-in capability
- imported skill
- Skillify-derived skill
- runner-backed capability

Capability는 실행 권한이 없다. 실행이 필요한 경우 approval을 생성하고 Runner 계층으로 넘긴다.

## Skill loading 원칙

- metadata는 app boot 또는 refresh 때 읽는다.
- instruction은 사용자가 skill detail을 열거나 추천이 선택된 경우에만 읽는다.
- script는 approval 없이 실행하지 않는다.
- untrusted skill은 기본 비활성화한다.

## Learner 역할

Learner는 실행 결과를 관찰하고 다음 작업에 추천 근거를 제공한다.

저장하는 정보:

- selected model
- selected capabilities
- reward
- success/failure
- latency
- cost estimate
- failure reason
- accepted/rejected recommendation decision

금지:

- 자동 prompt promotion
- 자동 pipeline activation
- 자동 agent type promotion
- 자동 high risk approval
- 사용자에게 보이지 않는 route 변경

## 추천 흐름

```text
TaskRun created
  -> CapabilityService suggests skills
  -> LearnerAdvisor suggests model/capabilities from traces
  -> UI shows recommendation and rationale
  -> user accepts/rejects
  -> decision recorded
  -> selected capability influences plan context, not direct execution
```

## Trace와 privacy

LearningTrace는 요약과 artifact id만 저장한다. 전체 stdout/stderr, 파일 본문, secret-looking token은 trace에 저장하지 않는다.

검증된 실패 경험은 별도의 project-scoped Observation으로 저장한다. 같은 checker의 실제 실패, 승인된 파일 수정, 현재 입력에서의 재통과를 연결하며, 민감정보 제거 후 실패 출력 일부(최대 1,200자), 수정 설명(최대 1,200자), 실제 diff 일부(최대 3,500자)와 근거 ID를 보존한다. 전체 로그나 전체 파일을 복제하지 않는다. 수정 설명은 원인 가설이며, 실제 원인이 인과적으로 증명되었다고 표시하지 않는다.

경험은 Instinct 후보를 만들 뿐 자동 활성화하지 않는다. 사용자가 승인한 뒤 프로젝트·관련성·현재 작업 제외 조건을 확인해 제한된 수만 프롬프트에 제공한다. 메모리 검색과 사용 기록에도 구체적인 경험을 유지하며, 로그에 포함된 지시문은 실행 권한으로 취급하지 않는다. 실패 기록이 없거나 검증이 현재 입력과 맞지 않으면 성공 경험을 만들지 않는다.

## 수용 기준

- Skillify-derived capability가 추천되어도 자동 실행되지 않는다.
- Learner recommendation은 실행 권한을 갖지 않는다.
- 사용자가 추천을 거절해도 TaskRun이 실패하지 않는다.
- 추천의 근거와 위험 수준이 UI에 표시된다.
