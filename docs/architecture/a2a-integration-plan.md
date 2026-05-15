# A2A Integration Plan

> 작성일: 2026-05-15  
> 상태: Draft  
> 대상: HarnessAgentOS에 Agent2Agent(A2A) 프로토콜을 적용하는 설계 방향  
> 기준 자료: `a2a_agent_to_agent_npm_analysis.html`, A2A official specification, official `a2a-js` SDK README, HarnessAgentOS architecture decisions

---

## 1. 결론

HarnessAgentOS에는 A2A를 "새로운 실행 엔진"으로 넣지 않는다. 첫 적용은 다음 구조로 제한한다.

```text
Renderer
  -> window.harness.* IPC
  -> Electron Main
  -> AgentPlanningService / Orchestration Worker
  -> A2A Client Adapter
  -> Remote A2A Agent
```

초기 구현은 **A2A Client Adapter + Remote Agent Registry**만 포함한다. HarnessAgentOS 자체를 A2A Server로 노출하는 기능은 MVP 제약과 충돌하므로 별도 feature flag와 별도 gateway 설계 전까지 보류한다.

이 결정의 핵심 이유는 다음이다.

- ADR-0002는 Express, localhost API, WebSocket server를 MVP에서 금지한다.
- ADR-0003은 SQLite WAL을 canonical state로 둔다.
- ADR-0004는 network, file write, shell, dependency install, git commit 등 side effect를 approval 없이 실행하지 못하게 한다.
- 현재 Phase 8 agent planner는 이미 `AgentInvocation`, `AgentStreamEvent`, `Artifact`, `Approval` 흐름을 갖고 있다.
- A2A JavaScript SDK는 official SDK가 존재하지만, stable README는 v0.3 구현을 기준으로 하고 v1.0 지원은 alpha 라인을 별도로 안내한다. SDK 타입을 앱 전체로 노출하지 않고 adapter 안에 격리해야 한다.

### 1.1 절차적 검토 결과

구현 전 검토 기준은 다음 순서로 고정한다.

| 검토 항목 | 판정 | 구현 지침 |
|---|---|---|
| MVP serverless 제약 | 통과 조건부 | registry/client 호출은 Electron main process outbound network만 사용한다. Express, localhost API, WebSocket server는 만들지 않는다. |
| SQLite canonical state | 통과 | Agent Card cache와 remote task reference는 SQLite repository로 저장한다. JSON 파일은 debug/export snapshot으로만 사용한다. |
| Approval 경계 | 통과 조건부 | endpoint fetch, remote invocation, remote proposed action은 approval policy를 우회하지 않는다. remote agent는 proposal-only 실행자로 취급한다. |
| SDK 결합도 | 통과 조건부 | `@a2a-js/sdk`는 Phase C의 adapter 내부에서만 사용한다. Phase B registry 구현은 SDK 없이 진행한다. |
| 기존 agent stream 계약 | 통과 조건부 | terminal `result` 전의 remote stream chunk는 최종 답변으로 렌더링하지 않는다. |
| 구현 순서 | 통과 | Phase B registry-only를 먼저 만들고, 실제 A2A invocation은 Phase C로 미룬다. |

따라서 첫 구현 단위는 **Phase B: Remote Agent Registry**다. 이 단계는 SDK 설치 없이 core type, storage repository, IPC shell, Settings UI만 추가한다.

---

## 2. 적용 범위

### 2.1 포함

- Remote A2A Agent endpoint 등록
- Agent Card 조회, 검증, 캐싱
- Agent Card 기반 capability/skill metadata 표시
- A2A message/task 호출을 기존 `AgentInvocation` 흐름으로 정규화
- A2A streaming 또는 polling update를 기존 `AgentStreamEvent`로 변환
- A2A artifact를 기존 `Artifact` ledger에 저장
- 원격 agent 결과에서 side effect 제안만 추출하고 실제 실행은 기존 approval flow로 위임
- orchestration worker가 local CLI agent 또는 remote A2A agent를 선택할 수 있는 seam 마련

### 2.2 제외

- Electron main process 안에 Express server 추가
- Renderer에서 A2A SDK 직접 사용
- WebSocket server 또는 inbound webhook listener
- remote agent가 사용자의 workspace에서 직접 파일/shell/git 작업을 수행하는 흐름
- A2A SDK 타입을 `packages/core` public API로 그대로 노출
- A2A Server adapter를 MVP 기본 경로에 포함

---

## 3. 기존 프로젝트와의 매핑

| A2A 개념 | HarnessAgentOS 적용 |
|---|---|
| Agent Card | remote endpoint registry row와 card snapshot으로 저장 |
| Skill | Skillify capability 후보 또는 routing metadata로 변환 |
| Message | `AgentInvocation` prompt/raw output, `AgentStreamEvent`로 변환 |
| Part | text/json/file/url part를 내부 `A2APartSnapshot`으로 보존 |
| Task | remote task id를 가진 `AgentInvocation` 보조 상태로 저장 |
| Task status | `AgentInvocationStatus`, `TaskRunStatus`, progress event로 매핑 |
| Artifact | 기존 `Artifact` row와 filesystem artifact store에 저장 |
| input-required | `TaskRun`을 `paused` 또는 `waiting_for_approval`로 전환 |
| auth-required | secret/auth setup approval 또는 settings action으로 전환 |
| cancel task | `agent.cancelInvocation` 또는 orchestration cancel 경로로 연결 |

---

## 4. 상태 모델

### 4.1 Core 내부 타입

`packages/core`에는 SDK 독립 타입만 둔다. `@a2a-js/sdk` import는 금지한다.

```ts
export type A2ATransport = "json-rpc" | "http-json" | "grpc";

export type A2ARemoteTaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "auth-required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected"
  | "unknown";

export interface A2AEndpoint {
  id: string;
  name: string;
  baseUrl: string;
  agentCardUrl: string;
  preferredTransport: A2ATransport;
  enabled: boolean;
  trusted: boolean;
  authSecretRef?: string;
  createdAt: string;
  updatedAt: string;
}

export interface A2AAgentCardSnapshot {
  endpointId: string;
  protocolVersion?: string;
  agentName: string;
  description?: string;
  version?: string;
  skills: readonly A2ASkillSnapshot[];
  inputModes: readonly string[];
  outputModes: readonly string[];
  capabilities: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };
  fetchedAt: string;
  etag?: string;
  rawCardJson: string;
}

export interface A2ARemoteTaskRef {
  invocationId: string;
  endpointId: string;
  remoteTaskId?: string;
  remoteContextId?: string;
  state: A2ARemoteTaskState;
  lastEventAt?: string;
}
```

`rawCardJson`은 디버깅과 호환성 확인용 snapshot이다. canonical state는 SQLite row이며, 파일 JSON을 canonical source로 삼지 않는다.

### 4.2 Storage schema 초안

초기 migration은 다음 테이블을 추가한다.

```sql
CREATE TABLE IF NOT EXISTS a2a_endpoints (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  agent_card_url TEXT NOT NULL,
  preferred_transport TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  trusted INTEGER NOT NULL,
  auth_secret_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS a2a_agent_card_snapshots (
  endpoint_id TEXT PRIMARY KEY REFERENCES a2a_endpoints(id) ON DELETE CASCADE,
  protocol_version TEXT,
  agent_name TEXT NOT NULL,
  description TEXT,
  version TEXT,
  skills_json TEXT NOT NULL,
  input_modes_json TEXT NOT NULL,
  output_modes_json TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  etag TEXT,
  raw_card_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS a2a_remote_tasks (
  invocation_id TEXT PRIMARY KEY REFERENCES agent_invocations(id) ON DELETE CASCADE,
  endpoint_id TEXT NOT NULL REFERENCES a2a_endpoints(id),
  remote_task_id TEXT,
  remote_context_id TEXT,
  state TEXT NOT NULL,
  last_event_at TEXT
);
```

JSON column은 기존 규칙에 맞게 `_json` suffix를 사용한다. `raw_card_json`은 외부 payload snapshot이므로 동일 규칙을 따른다.

---

## 5. Package 경계

### 5.1 `packages/core`

- SDK 독립 타입 정의
- 상태 매핑 enum 정의
- IPC API shape 정의
- validator 추가
- storage import 금지 유지

### 5.2 `packages/storage`

- A2A endpoint/card/task repository 추가
- schema version 증가
- idempotent migration
- Agent Card snapshot과 remote task mapping 저장

### 5.3 `packages/agent`

- `A2AClientAdapter` 구현 위치 후보
- SDK 의존성 격리
- A2A response를 `AgentStreamEvent`와 artifact로 변환
- `AgentPlanningService` 또는 별도 invoker가 호출

### 5.4 `packages/orchestration`

- `WorkerCliInvoker`를 더 일반적인 worker agent invoker로 확장
- pipeline step이 local CLI profile과 remote A2A endpoint 중 하나를 참조할 수 있게 설계
- worker output은 side-effect-free proposal만 반환

### 5.5 `apps/desktop`

- IPC handler는 얇게 유지
- preload는 raw `ipcRenderer` 또는 SDK 객체를 노출하지 않음
- Settings > Agents 탭에 remote A2A registry 표시
- Agent 탭에 remote task id, endpoint, A2A state 표시

---

## 6. IPC 설계

새 IPC 도메인은 `window.harness.a2a` 또는 `window.harness.remoteAgents` 중 하나로 둔다. A2A가 구현 세부사항이 될 가능성을 고려하면 UI API는 `remoteAgents`가 더 안정적이다.

초안:

```ts
remoteAgents.list(): Promise<A2AEndpoint[]>;
remoteAgents.get(input: { endpointId: string }): Promise<{
  endpoint: A2AEndpoint;
  card?: A2AAgentCardSnapshot;
}>;
remoteAgents.register(input: {
  name?: string;
  agentCardUrl: string;
  preferredTransport?: A2ATransport;
  authSecretRef?: string;
}): Promise<{
  endpoint: A2AEndpoint;
  card: A2AAgentCardSnapshot;
  approval?: Approval;
}>;
remoteAgents.refreshCard(input: { endpointId: string }): Promise<A2AAgentCardSnapshot>;
remoteAgents.toggle(input: { endpointId: string; enabled: boolean }): Promise<A2AEndpoint>;
remoteAgents.delete(input: { endpointId: string }): Promise<void>;
```

네트워크 호출은 ADR-0004의 `network` action에 해당한다. 초기 UX는 다음 중 하나를 선택해야 한다.

- endpoint 등록 시 사용자가 명시적으로 URL을 입력하면 그 단일 fetch를 승인된 행위로 간주한다.
- 더 엄격하게는 `network` approval을 생성하고 승인 후 fetch한다.

보수적인 기본값은 두 번째 방식이다. 단, 설정 화면에서 사용자가 직접 누른 "Agent Card 조회" 버튼은 action summary가 명확하므로 approval UX를 간소화할 여지가 있다.

---

## 7. 실행 흐름

### 7.1 Endpoint 등록

```text
사용자 URL 입력
  -> remoteAgents.register
  -> network approval 생성 또는 명시 action 확인
  -> main process fetch
  -> Agent Card validate
  -> a2a_endpoints 저장
  -> a2a_agent_card_snapshots 저장
  -> Settings UI refresh
```

검증 규칙:

- `http://`는 기본 차단. local/dev allowlist에서만 허용.
- private network, loopback, file URL은 기본 차단. 개발 모드 예외는 명시 설정 필요.
- redirect chain은 최대 횟수 제한.
- response size 제한.
- static secret 또는 token으로 보이는 값이 Agent Card에 있으면 warning.

### 7.2 Agent mode에서 원격 A2A 호출

```text
conversation.createTask({ mode: "agent" })
  -> agent.generatePlan({ provider: "a2a", endpointId })
  -> AgentInvocation queued/running
  -> A2AClientAdapter.sendMessage or sendMessageStream
  -> AgentStreamEvent progress/raw/assistant_text
  -> raw output artifact 저장
  -> remote task ref 저장
  -> proposedActions normalize
  -> Approval row 생성 또는 ready_for_review
```

remote agent가 파일 수정이나 shell 실행을 제안해도 직접 실행하지 않는다. 모든 action은 기존 `validateProposedActionDetails`와 approval policy를 통과해야 한다.

### 7.3 Orchestration worker에서 원격 A2A 호출

```text
orchestration.runApproved
  -> WorkerStep resolves executor
  -> local AgentProfile 또는 remote A2A endpoint 선택
  -> worker invoker 호출
  -> output artifact 저장
  -> proposedActions approval 생성
  -> worker result summary 저장
```

이 흐름은 기존 `WorkerRunner`의 side-effect-free contract를 유지한다.

---

## 8. 상태 매핑

| A2A remote state | AgentInvocation | TaskRun | UI 표시 |
|---|---|---|---|
| submitted | queued/running | drafting 또는 running | 원격 작업 제출됨 |
| working | running | running | 원격 agent 작업 중 |
| input-required | running | paused | 사용자 입력 필요 |
| auth-required | running 또는 failed | paused | 인증 설정 필요 |
| completed | succeeded | ready_for_review 또는 waiting_for_approval | 완료, 검토 필요 |
| failed | failed | blocked | 실패 |
| canceled | cancelled | cancelled 또는 paused | 취소됨 |
| rejected | failed | blocked | 원격 agent가 거절 |
| unknown | running 또는 failed | blocked | 알 수 없는 상태 |

`completed`가 곧 `done`은 아니다. HarnessAgentOS의 완료 조건은 quality gate와 사용자 최종 승인이다.

---

## 9. Artifact 처리

A2A artifact는 다음 원칙으로 저장한다.

- 텍스트 응답: `ArtifactKind = "log"` 또는 parsed plan이면 `"plan"`
- structured JSON: raw JSON artifact로 저장하고 summary에 schema/size 기록
- file/url part: 파일을 즉시 다운로드하지 않고 URL reference artifact로 먼저 저장
- binary data: size limit과 content type 검증 후 filesystem artifact store에 저장
- remote artifact id, content type, original filename은 artifact summary 또는 별도 metadata에 기록

초기에는 `ArtifactKind`를 늘리지 않는다. A2A 전용 kind가 필요하다는 증거가 생기면 `remote_agent_artifact` 같은 새 kind를 검토한다.

---

## 10. 보안과 승인 정책

### 10.1 네트워크 경계

- A2A 통신은 main process에서만 수행한다.
- renderer는 URL fetch나 SDK 객체를 직접 다루지 않는다.
- endpoint는 allowlist와 trust flag를 가진다.
- local/private network endpoint는 개발 모드 또는 explicit trust 없이는 차단한다.
- timeout, response size, redirect limit을 둔다.

### 10.2 인증과 secret

- Agent Card에 secret을 저장하지 않는다.
- bearer token/API key는 secret vault reference만 저장한다.
- secret은 main process adapter에서만 해석한다.
- prompt/raw output/artifact 저장 전 `redactSecrets`를 적용한다.

### 10.3 Side effect

remote agent는 Harness workspace에 대한 권한을 갖지 않는다.

허용:

- 계획 제안
- 분석 결과 반환
- patch/shell/git action을 proposed action으로 제출
- artifact 반환

금지:

- remote agent가 직접 local file write 수행
- remote agent가 직접 shell/git/dependency install 수행
- remote agent가 approval 없이 follow-up network call을 proxy처럼 수행

---

## 11. UI 설계

### 11.1 Settings > Agents

Remote A2A Agents 섹션을 추가한다.

- endpoint name
- base URL 또는 Agent Card URL
- protocol version
- transport
- enabled/trusted 상태
- 마지막 card fetch 결과
- skills/capabilities 요약
- refresh/test 버튼

Agent Card의 전체 JSON은 접힌 상세 영역으로 보여준다. secret으로 보이는 값은 마스킹한다.

### 11.2 Right Panel > Agent

기존 AgentInvocation view에 다음 정보를 추가한다.

- provider: A2A endpoint name
- remote task id
- remote context id
- A2A state
- last event time
- stream/polling mode
- artifacts count

중간 응답과 최종 응답 구분은 현재 `AgentStreamEvent` final gate 규칙을 유지한다. remote stream event가 도착해도 terminal `result` 전에는 최종 답변으로 취급하지 않는다.

---

## 12. 단계별 구현 계획

### Phase A: 설계 고정

- 이 문서를 review한다.
- A2A Server를 MVP에서 제외한다는 결정을 ADR에 추가할지 결정한다.
- `remoteAgents` IPC 이름을 확정한다.
- `AgentProvider`에 `"a2a"`를 추가할지, 별도 remote invocation 타입을 둘지 결정한다.

### Phase B: Registry only

- core 타입 추가
- storage migration/repository 추가
- IPC register/list/get/refresh/toggle/delete 추가
- Settings UI에 remote registry 표시
- Agent Card fixture 기반 repository/validator 테스트 추가

### Phase C: Client invocation

- `@a2a-js/sdk`를 adapter package 내부에만 설치/사용
- send message, streaming message, cancel/get task 최소 구현
- `AgentInvocation`과 `AgentStreamEvent`로 변환
- raw output/artifact 저장
- proposed action normalization 추가

### Phase D: Orchestration integration

- worker invoker interface 확장
- pipeline step에서 remote endpoint 선택 가능하게 함
- remote worker 결과를 step artifact와 approval로 변환
- local CLI path와 동등한 contract test 추가

### Phase E: Task lifecycle hardening

- polling/SSE fallback
- input-required/auth-required UX
- cancellation/retry/idempotency
- compatibility fixtures
- A2A Inspector/TCK 검증

### Phase F: Optional A2A Server

별도 opt-in 기능으로만 검토한다.

- Electron main 안에 Express를 넣지 않는 대안 우선
- 별도 gateway process 또는 external companion service
- feature flag off by default
- inbound auth, rate limit, audit log, workspace permission boundary 필수

---

## 13. 테스트 계획

### Unit

- Agent Card validator
- endpoint URL policy
- A2A state mapping
- response/artifact normalization
- proposed action filtering
- secret redaction

### Repository

- endpoint CRUD
- card snapshot upsert
- remote task ref lifecycle
- cascade delete
- migration idempotency

### IPC

- renderer-facing shape가 SDK 타입을 노출하지 않는지 확인
- network approval 또는 explicit user action 경로 확인
- taskRunChanged/agentStreamEvent 발행 확인

### Integration

- fake A2A client adapter로 `agent.generatePlan` 흐름 검증
- streaming event가 terminal result 전까지 최종 답변으로 표시되지 않는지 검증
- remote proposed file/shell/git action이 직접 실행되지 않고 approval로만 생성되는지 검증

### Compatibility

- official A2A sample Agent Card fixture
- local mock A2A server fixture
- A2A Inspector/TCK는 Phase E 이후 도입

---

## 14. 결정 필요 사항

1. `AgentProvider`에 `"a2a"`를 추가할 것인가, remote invocation을 별도 타입으로 둘 것인가?
2. endpoint 등록 fetch를 approval로 처리할 것인가, settings 화면의 명시 버튼 클릭을 approval equivalent로 볼 것인가?
3. Agent Card의 skill을 Skillify capability로 자동 등록할 것인가, remote routing metadata로만 둘 것인가?
4. A2A `auth-required`를 settings flow로 보낼 것인가, approval flow로 보낼 것인가?
5. local/private network endpoint를 개발 모드에서만 허용할 것인가?

---

## 15. 현재 권장 결정

- `AgentProvider`에는 바로 `"a2a"`를 추가하지 말고 Phase B에서는 registry만 만든다.
- Phase C에서 실제 invocation을 붙일 때 `"a2a"` provider 추가 여부를 다시 결정한다.
- Agent Card skill은 자동 capability 등록하지 않고 routing metadata로만 저장한다.
- endpoint 등록과 card refresh는 `network` approval을 거친다.
- 첫 transport는 HTTP+JSON/REST 또는 JSON-RPC만 허용한다. gRPC는 Node peer dependency와 packaging 부담이 있으므로 후순위다.
- inbound webhook/push notification은 구현하지 않는다. outbound polling/SSE client만 허용한다.
- A2A Server는 별도 ADR 전까지 구현하지 않는다.

---

## 16. 참고 자료

- `a2a_agent_to_agent_npm_analysis.html`
- [A2A Protocol Specification](https://github.com/a2aproject/A2A/blob/main/docs/specification.md)
- [A2A Protocol v1.0 Announcement](https://a2a-protocol.org/latest/announcing-1.0/)
- [Official A2A JavaScript SDK](https://github.com/a2aproject/a2a-js)
- `docs/architecture/architecture-decisions.md`
- `docs/contracts/ipc-contracts.md`
- `packages/core/src/types/agent-invocation.ts`
- `packages/orchestration/src/worker-runner.ts`
