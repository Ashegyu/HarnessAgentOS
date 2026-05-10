# Phase 05 - Skillify Capability Adapter

## 목표

기존 Skillify의 장점을 HarnessAgentOS의 capability registry/advisor로 이식한다. 완료되면 TaskRun 문맥에 따라 관련 skill 후보가 표시되고, skill instruction 또는 script 실행은 사용자가 볼 수 있는 approval 흐름을 통과해야 한다.

## 비범위

- 기존 Skillify runtime을 그대로 복사하지 않는다.
- pre-tool hook으로 숨겨진 자동 실행을 만들지 않는다.
- skill script 자동 실행을 허용하지 않는다.
- Learner reward 기반 ranking은 Phase 6에서 한다.

## 구현 단위

```text
packages/skillify-adapter/src/
  skill-metadata.ts
  skill-loader.ts
  capability-registry.ts
  capability-suggester.ts
  skill-risk-policy.ts
apps/desktop/electron/ipc/capability-ipc.ts
apps/desktop/src/screens/workbench/
  CapabilityPanel.tsx
  SkillDetailDrawer.tsx
```

Skill 위치:

```text
HarnessAgentOS/skills/
app.getPath("userData")/skills/
```

기존 ClaudeAgentSystem의 Skillify 관련 코드는 참조만 한다. 직접 import하는 대신 metadata와 concept를 새 package에 맞춰 재작성한다.

## 주요 타입과 인터페이스

```ts
export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  sourceDir: string;
  riskLevel: "low" | "medium" | "high";
  allowedActions: string[];
  triggerTerms: string[];
  trusted: boolean;
}

export interface CapabilitySuggestion {
  capability: Capability;
  score: number;
  reason: string;
  matchedTerms: string[];
}
```

IPC:

```ts
capability.list(): Promise<Capability[]>;
capability.refresh(): Promise<Capability[]>;
capability.suggest(input: { taskRunId: string; prompt: string }): Promise<CapabilitySuggestion[]>;
capability.readSkill(input: {
  capabilityId: string;
}): Promise<{
  capability: Capability;
  instructions: string;
  resources: SkillResources; // { scripts, templates, examples }
}>;
capability.proposeScriptRun(input: {
  capabilityId: string;
  taskRunId: string;
  scriptName: string;
}): Promise<Approval>;
```

`SkillResources`는 `SKILL.md` 옆에 위치한 `scripts/`, `templates/`, `examples/`
하위 항목 목록을 그대로 노출한다. 단일 소스는 `docs/contracts/ipc-contracts.md`이며
구조 변경 시 그 쪽을 먼저 갱신한다.

## 데이터 흐름

```text
App boot or manual refresh
  -> SkillLoader scans trusted skill directories
  -> reads SKILL.md metadata only
  -> stores/updates capabilities table

TaskRun plan phase
  -> CapabilitySuggester compares prompt/plan with metadata
  -> suggestions rendered in CapabilityPanel
  -> user opens detail
  -> instructions loaded on demand
  -> script run creates approval, not execution
```

## UI 요구사항

- 추천 skill 이름, 설명, risk level, 추천 이유 표시.
- `자동 적용됨` 같은 표현 금지. `추천됨`으로 표시한다.
- untrusted skill은 비활성 또는 warning 상태로 표시한다.
- script가 있는 skill은 `실행 요청` 버튼을 누르면 approval이 생성된다.
- Skill detail drawer에는 SKILL.md instructions, scripts/templates/examples 목록, high risk warning을 표시한다.

## 보안/승인 정책

- metadata scan은 허용하되, script 실행은 approval 필요.
- untrusted skill script 실행 금지.
- SKILL.md는 Markdown으로 렌더링하되 HTML 실행 금지.
- skill directory traversal 방지.
- skill이 targetDir 밖 파일을 요구하면 high risk로 분류하고 MVP에서는 차단한다.
- capability recommendation은 TaskRun 상태를 직접 변경하지 않는다.

## 테스트 계획

Unit:

- SKILL.md frontmatter parser.
- trigger term matching.
- risk classifier.
- directory traversal 차단.

Integration:

- skills directory scan -> capabilities table upsert.
- `capability.suggest` returns ranked suggestions.
- script proposal creates Approval but runner does not execute automatically.

UI smoke:

- 추천 skill 목록 표시.
- skill detail 열기.
- untrusted skill warning 표시.
- script 실행 요청 시 approval panel에 pending action 표시.

Manual acceptance:

- 관련 skill이 추천되지만 자동 적용되지 않는다.
- skill instruction은 선택 시에만 로드된다.
- script 실행 전 approval이 필요하다.

## 완료 기준

- Capability registry가 동작한다.
- Skillify 개념이 Harness capability로 재표현된다.
- 추천 근거가 UI에 보인다.
- skill script는 approval 없이 실행되지 않는다.
- 기존 ClaudeAgentSystem을 수정하지 않는다.

## 다음 Phase 인계

Phase 6은 Capability 사용 결과와 TaskRun 결과를 LearningTrace로 남기고, 추천 품질을 개선한다. Phase 5는 다음 handoff payload를 trace에 연결할 수 있게 제공해야 한다.

```ts
interface CapabilityUsageForTrace {
  capabilityId: string;
  suggestionReason: string;
  score?: number;
  decision: "accepted" | "rejected";
}
```





