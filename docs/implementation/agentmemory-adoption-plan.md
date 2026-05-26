# Agentmemory 적용 재검토 및 Harness-native 적용 계획

작성일: 2026-05-23  
분석 대상: `rohitg00/agentmemory` checkout commit `355124141625ccc0d740ae08ddaaf77fe2c165ae`  
이전 분석 문서: `docs/analysis/agentmemory-github-analysis.html`

## 1. 재검토 결론

agentmemory의 전체 런타임을 HarnessAgentOS에 직접 통합하는 것은 현재 프로젝트에 적용하면 안 된다.

대신 다음 범위는 HarnessAgentOS 내부 기능으로 재구현해 적용할 수 있다.

- 기존 `observations`, `learning_traces`, `artifacts`, `agent_invocations`를 대상으로 한 회상 검색
- agentmemory의 BM25 + optional vector + progressive disclosure 패턴
- pinned context slot 개념
- session/task handoff summary 생성
- secret redaction과 provenance/audit 필드
- recall benchmark/eval harness

적용 방식은 "agentmemory 서버를 실행하거나 MCP로 붙이는 것"이 아니라, Harness의 SQLite WAL, Electron IPC, approval/user-visible recommendation 흐름 안에 작은 기능 단위로 흡수하는 것이다.

## 2. 재검토 근거

### 2.1 agentmemory 쪽 확인 사항

agentmemory는 라이브러리보다 독립 로컬 런타임에 가깝다.

- `iii-config.yaml` 기준 HTTP `3111`, stream `3112`, viewer `3113` 포트를 사용한다.
- `src/index.ts`는 `StateKV`, `VectorIndex`, `HybridSearch`, 다수의 `mem::*` function, REST trigger, MCP endpoint, viewer, timer를 함께 부팅한다.
- `src/triggers/api.ts`는 `/agentmemory/observe`, `/context`, `/search`, `/remember`, `/forget`, `/export`, `/import`, `/consolidate-pipeline` 등 넓은 API 표면을 노출한다.
- `src/mcp/tools-registry.ts`에는 `memory_compress_file`, `memory_export`, `memory_save`, `memory_smart_search` 등 읽기와 쓰기가 섞인 도구들이 있다.
- hook 흐름은 prompt/tool output을 자동 관찰하고, 옵션이 켜지면 tool turn에 context를 자동 주입할 수 있다.
- `AGENTMEMORY_SECRET`이 없으면 로컬 API 보호 수준이 약해질 수 있고, 외부 embedding/LLM provider 사용 시 데이터 경계가 넓어진다.

### 2.2 HarnessAgentOS 쪽 확인 사항

현재 프로젝트는 이미 다음 구조를 갖고 있다.

- `docs/architecture/architecture-decisions.md`
  - ADR-0002: Express, localhost API, WebSocket server를 사용하지 않는다.
  - ADR-0003: SQLite WAL DB가 canonical state다.
  - ADR-0004: 파일 쓰기, shell, dependency install, git commit, network, skill script는 approval 모델을 통과해야 한다.
  - ADR-0005: Skillify와 Learner는 추천 계층이다.
- `packages/storage/src/schema.ts`
  - `observations`, `instincts`, `evolution_candidates`, `learning_traces`, `artifacts`, `agent_invocations` 테이블이 이미 있다.
- `packages/learner/src/observation-collector.ts`
  - approval 결정과 QualityGate 결과를 advisory observation으로 저장한다.
- `packages/learner/src/learner-advisor.ts`
  - 추천은 approval 후보로 올리며 자동 실행하지 않는다.
- `packages/skillify-adapter/src/capability-service.ts`
  - skill/capability 사용도 approval 후보로만 만들고 자동 실행하지 않는다.
- `docs/contracts/ipc-contracts.md`
  - renderer는 observation을 직접 기록할 수 없고, internal observer가 approval/quality signal을 기록한다.

즉 "새 메모리 시스템"을 붙일 필요가 없다. 현재 구조에는 이미 observation과 learner의 뼈대가 있고, 부족한 것은 회상 검색, pinned context, handoff summary, benchmark다.

## 3. 최종 적용 판정

| 항목 | 판정 | 이유 |
| --- | --- | --- |
| agentmemory 서버 실행 | 적용 금지 | ADR-0002의 serverless Electron IPC 원칙과 충돌 |
| agentmemory StateKV/file DB 사용 | 적용 금지 | ADR-0003의 SQLite WAL canonical state와 충돌 |
| agentmemory hook 자동 저장 | 보류 | hidden prompt/tool output 저장이 사용자 감독형 UX와 충돌 가능 |
| agentmemory MCP tool 직접 노출 | 보류 | 읽기/쓰기/파일수정/export/import가 섞여 approval 경계가 흐려짐 |
| BM25 lexical recall | 적용 권장 | 외부 provider 없이 기존 observations/artifacts 검색 품질 개선 |
| vector recall | 후순위 조건부 적용 | embedding provider, 비용, 데이터 반출 disclosure 필요 |
| pinned slots | 적용 권장 | 사용자-visible 고정 맥락으로 구현 가능 |
| context auto injection | 적용 금지 | 자동 prompt promotion 금지 원칙과 충돌 |
| context preview/선택 사용 | 적용 가능 | 사용자가 볼 수 있고 선택하면 기존 approval/selection 흐름에 연결 가능 |
| handoff summary | 적용 권장 | TaskRun 재개성과 품질 증거 연결에 유리 |
| recall benchmark | 적용 권장 | 기능 효과를 grep/baseline 대비 측정 가능 |

## 4. 목표 아키텍처

```text
TaskRun / Approval / QualityGate / Artifact / AgentInvocation
  -> internal ObservationCollector
  -> redacted MemoryEntry materialization
  -> ObservationRecallService
       -> BM25 lexical ranking
       -> optional vector ranking later
       -> progressive disclosure result
  -> UI Recall panel / Learner evidence
  -> user chooses context, if needed
  -> no hidden prompt injection
```

핵심 원칙:

1. 저장은 SQLite WAL 안에서만 한다.
2. renderer는 파일, process, SQL에 직접 접근하지 않는다.
3. recall은 추천/근거 표면이며 자동 실행자가 아니다.
4. prompt에 context를 넣는 기능은 사용자가 볼 수 있는 preview와 선택을 거친다.
5. 외부 provider나 network가 필요한 기능은 기본 off다.
6. full stdout/stderr와 secret-looking token은 memory entry에 저장하지 않는다.

## 5. 구체적 적용 절차

### Phase 0. 계약 확정과 RED 테스트

목표: 구현 전에 scope와 실패 조건을 테스트로 고정한다.

작업:

- `docs/contracts/ipc-contracts.md`에 새 namespace 초안을 추가한다.
  - 권장 namespace: `window.harness.memory`
  - 첫 범위는 read-heavy recall과 pinned slot 관리만 포함한다.
- `packages/core/src/types/`에 memory 관련 타입 초안을 추가한다.
  - `MemoryEntry`
  - `MemoryRecallResult`
  - `MemoryRecallInput`
  - `PinnedContextSlot`
- RED 테스트를 먼저 추가한다.
  - `packages/learner/src/memory-redaction.test.mjs`
  - `packages/learner/src/observation-recall.test.mjs`
  - `packages/storage/src/repositories/memory-entry-repository.test.mjs`

수용 기준:

- secret-looking token이 recall text에 남으면 테스트가 실패해야 한다.
- 같은 projectKey 안에서 관련 observation이 top-K에 들어오지 않으면 테스트가 실패해야 한다.
- disabled/rejected pinned slot이 context 후보에 포함되면 테스트가 실패해야 한다.

### Phase 1. Redaction 유틸 추가

목표: 저장 전에 검색 가능한 텍스트를 안전하게 줄인다.

작업 파일:

- `packages/learner/src/memory-redaction.ts`
- `packages/learner/src/memory-redaction.test.mjs`

구현 내용:

- agentmemory의 `stripPrivateData` 패턴을 참고하되 Harness용으로 새로 작성한다.
- `<private>...</private>`, `api_key=`, `token=`, Bearer token, `sk-*`, `gh*_*`, AWS key, JWT, npm/GitLab/DigitalOcean류 token을 `[REDACTED_SECRET]`로 치환한다.
- 입력을 mutate하지 않고 새 문자열을 반환한다.
- 너무 긴 텍스트는 저장 목적에 맞게 truncate한다.

수용 기준:

- redaction 함수는 순수 함수다.
- 테스트 fixture에 포함된 secret-like 문자열이 모두 제거된다.
- 일반 파일 경로, approval type, quality status는 유지된다.

### Phase 2. MemoryEntry 저장 모델 추가

목표: 기존 `observations`를 source로 두고, 검색 전용 compact entry를 별도 테이블에 저장한다.

권장 DB schema:

```sql
CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  observation_id TEXT,
  task_run_id TEXT,
  thread_id TEXT,
  project_key TEXT,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  searchable_text TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  artifact_ids_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  redaction_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(observation_id) REFERENCES observations(id),
  FOREIGN KEY(task_run_id) REFERENCES task_runs(id),
  FOREIGN KEY(thread_id) REFERENCES threads(id)
);

CREATE INDEX IF NOT EXISTS idx_memory_entries_project_created
  ON memory_entries(project_key, created_at);

CREATE INDEX IF NOT EXISTS idx_memory_entries_task_run
  ON memory_entries(task_run_id);
```

작업 파일:

- `packages/core/src/types/memory.ts`
- `packages/storage/src/schema.ts`
- `packages/storage/src/migrations.ts`
- `packages/storage/src/repositories/memory-entry-repository.ts`
- `packages/storage/src/repositories/index.ts`
- `packages/storage/src/services/local-state-service.ts`

설계 판단:

- `observations`에 full text 검색 필드를 직접 추가하지 않는다. 기존 observation은 event ledger로 유지한다.
- `memory_entries`는 검색과 context preview를 위한 materialized view 성격으로 둔다.
- full artifact body나 raw stdout/stderr는 저장하지 않는다. 필요한 경우 artifact id만 연결한다.

수용 기준:

- migration은 idempotent다.
- `SCHEMA_VERSION`을 증가시킨다.
- repository test에서 create/list/get이 통과한다.
- 기존 observation 저장 흐름이 깨지지 않는다.

### Phase 3. ObservationMemory materializer 추가

목표: approval/quality/learner/runner/agent signal을 compact memory entry로 변환한다.

작업 파일:

- `packages/learner/src/observation-memory-service.ts`
- `packages/learner/src/observation-memory-service.test.mjs`
- `packages/learner/src/observation-collector.ts`

동작:

```text
ObservationCollector records advisory observation
  -> ObservationMemoryService.materialize(observation)
  -> build title, summary, searchableText, tags, artifactIds
  -> redact searchableText
  -> create memory_entries row
```

초기 materialization 대상:

- approval decision
- quality gate result
- learner recommendation decision
- agent invocation summary
- runner result summary

제외 대상:

- raw stdout/stderr 전문
- patch body 전체
- secret-looking env/config
- 사용자가 명시 저장하지 않은 파일 본문

수용 기준:

- observation 저장 실패가 approval/quality 성공을 막지 않는 기존 성질을 유지한다.
- memory entry 생성 실패도 원본 TaskRun 진행을 막지 않고, 내부 로그/diagnostic으로 남긴다.
- 같은 observation id에서 중복 materialization이 일어나지 않는다.

### Phase 4. BM25 기반 ObservationRecallService 구현

목표: 외부 provider 없이 project-local memory recall을 제공한다.

작업 파일:

- `packages/learner/src/observation-recall.ts`
- `packages/learner/src/observation-recall.test.mjs`
- 필요 시 `packages/learner/src/recall-tokenizer.ts`

동작:

```text
recall({ taskRunId, query?, limit })
  -> taskRun 조회
  -> projectKey 계산
  -> memory_entries project scope 조회
  -> query = explicit query || taskRun.userRequest
  -> tokenize query and entry.searchableText
  -> BM25 score 계산
  -> recency/quality/source boost 적용
  -> top-K compact results 반환
```

MVP ranking 신호:

- BM25 score
- 같은 projectKey
- 최근성
- source boost
  - quality/approval/agent invocation은 높게
  - 실패와 known risk는 query가 관련될 때 높게
- artifact link가 있는 entry는 explanation에 포함

한국어/CJK 처리:

- 1차는 whitespace/token normalization으로 시작한다.
- 한국어 query recall이 부족하면 character bigram 보조 tokenizer를 추가한다.
- tokenizer는 deterministic test fixture로 검증한다.

수용 기준:

- 같은 projectKey의 관련 entry가 다른 project entry보다 앞선다.
- `limit`은 1-20 사이로 clamp한다.
- 결과는 compact summary와 evidence id 중심으로 반환한다.
- full expansion은 별도 `memory.getEntry`에서만 제공한다.

### Phase 5. IPC 9-layer 연결

목표: renderer가 SQL이나 파일에 접근하지 않고 recall 결과를 볼 수 있게 한다.

수정 순서:

1. `packages/core/src/api.ts`에 `memory` namespace 추가
2. `packages/core/src/ipc-channels.ts`에 channel 추가
3. `packages/core/src/types/memory.ts` export
4. `packages/storage` repository/service 연결
5. `packages/learner` recall service 연결
6. `apps/desktop/electron/ipc/memory-ipc.ts` 작성
7. `apps/desktop/electron/ipc/index.ts`에서 register
8. `apps/desktop/electron/preload.ts`에서 `window.harness.memory` expose
9. `apps/desktop/src/types/window.d.ts` 갱신

초기 IPC:

```ts
memory.recall(input: {
  taskRunId: string;
  query?: string;
  limit?: number;
}): Promise<MemoryRecallResult[]>;

memory.getEntry(input: {
  entryId: string;
}): Promise<MemoryEntry | null>;
```

금지:

- renderer에서 observation을 직접 생성하는 IPC를 만들지 않는다.
- recall 결과를 자동으로 agent prompt에 삽입하지 않는다.
- 외부 agentmemory REST API로 proxy하지 않는다.

수용 기준:

- preload는 raw `ipcRenderer`를 노출하지 않는다.
- memory IPC handler는 얇게 유지하고 service에 위임한다.
- `docs/contracts/ipc-contracts.md`가 실제 타입과 일치한다.

### Phase 6. Workbench Recall UI 추가

목표: 사용자가 과거 근거를 볼 수 있게 하되 실행 흐름은 자동 변경하지 않는다.

권장 위치:

- `apps/desktop/src/screens/workbench/RightPanel.tsx`
- 새 컴포넌트: `MemoryRecallPanel.tsx`
- 모델 유틸: `memory-recall-model.ts`

UI 동작:

- 선택된 TaskRun 기준으로 관련 memory top-K를 표시한다.
- 각 항목은 source, summary, score reason, linked artifact id를 보여준다.
- "자세히"는 `memory.getEntry`로 확장한다.
- "자동 적용됨" 같은 문구를 쓰지 않는다.
- 첫 버전에는 prompt injection 버튼을 만들지 않는다.

수용 기준:

- TaskRun 변경 시 push event를 받은 기존 fresh detail pull 흐름과 충돌하지 않는다.
- recall 실패는 TaskRun 실패로 이어지지 않는다.
- 사용자가 추천을 거절하거나 무시해도 workflow가 계속된다.

### Phase 7. PinnedContextSlot 추가

목표: agentmemory의 slot 개념을 사용자-visible project context로 재해석한다.

권장 DB schema:

```sql
CREATE TABLE IF NOT EXISTS pinned_context_slots (
  id TEXT PRIMARY KEY,
  project_key TEXT,
  scope TEXT NOT NULL CHECK(scope IN ('global','project','thread')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','disabled')),
  source_memory_entry_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pinned_context_slots_scope_project_status
  ON pinned_context_slots(scope, project_key, status);
```

IPC:

```ts
memory.listPinnedSlots(input?: {
  projectKey?: string;
  includeDisabled?: boolean;
}): Promise<PinnedContextSlot[]>;

memory.createPinnedSlot(input: {
  projectKey?: string;
  scope: "global" | "project" | "thread";
  title: string;
  content: string;
  tags?: string[];
  sourceMemoryEntryIds?: string[];
}): Promise<PinnedContextSlot>;

memory.disablePinnedSlot(input: {
  slotId: string;
  reason: string;
}): Promise<PinnedContextSlot>;
```

정책:

- slot 생성/삭제는 사용자가 누른 명시 action으로만 한다.
- slot은 agent prompt에 자동 삽입하지 않는다.
- 나중에 prompt에 사용하려면 preview와 사용자 선택을 거친다.

수용 기준:

- disabled slot은 recall/context 후보에서 제외된다.
- slot content도 redaction을 통과한다.
- slot provenance에 source memory entry id를 남긴다.

### Phase 8. Context 사용 preview와 approval 확장

목표: recall 결과를 agent prompt에 쓰고 싶을 때도 사용자 선택과 추적을 남긴다.

선택지:

1. MVP에서는 UI 표시만 하고 prompt context 사용은 하지 않는다.
2. 다음 단계에서 `approval.action_type`에 `memory_context_use`를 추가한다.

권장 구현은 2번이지만 Phase 1-7이 안정된 뒤 진행한다.

필요 변경:

- `ApprovalActionType`에 `memory_context_use` 추가
- DB CHECK constraint migration
- `evaluateApprovalActionPolicy` 업데이트
- `agent.generatePlan` prompt builder가 approved `memory_context_use`만 읽도록 변경
- approval card에 source entry/slot summary 표시

정책:

- recall 결과가 자동으로 prompt에 들어가면 안 된다.
- 승인된 context라도 file write, shell, network 권한을 부여하지 않는다.
- context 사용은 실행 권한이 아니라 prompt 구성 선택이다.

### Phase 9. Handoff summary 생성

목표: TaskRun 종료/quality gate 이후 다음 작업 재개에 필요한 요약을 남긴다.

작업:

- `quality.markDone` 성공 직후 또는 TaskRun이 `ready_for_review`가 될 때 handoff summary를 생성한다.
- artifact kind는 기존 enum을 재사용한다.
  - 권장: `kind='log'`, title `TaskRun handoff summary`
- summary에는 다음 항목만 포함한다.
  - 사용자 요청
  - 주요 approval 결정
  - 실행된 runner 결과 요약
  - QualityGate status와 evidence artifact ids
  - known risks
  - follow-up candidate
- 생성된 handoff summary에서 memory entry를 만든다.

수용 기준:

- markDone은 기존처럼 passed/warning QualityGate가 필요하다.
- handoff summary 생성 실패가 markDone 성공을 막지 않는다.
- artifact id와 memory entry id가 서로 추적 가능하다.

### Phase 10. Optional vector recall

목표: lexical recall이 충분히 검증된 뒤 semantic recall을 선택 기능으로 추가한다.

조건:

- 기본값 off
- provider 설정 UI와 비용/데이터 반출 disclosure 선행
- 외부 network provider는 `network` approval 또는 명시 설정 action 필요
- embedding dimension guard와 rebuild/backfill 기능 필요

권장 DB schema:

```sql
CREATE TABLE IF NOT EXISTS memory_embeddings (
  entry_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  vector_blob BLOB NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(entry_id) REFERENCES memory_entries(id)
);
```

수용 기준:

- dimension mismatch 시 기존 embedding을 조용히 잘못 쓰지 않는다.
- provider off 상태에서도 BM25 recall은 정상 동작한다.
- vector recall 결과는 BM25 결과와 RRF로 결합한다.

### Phase 11. Recall benchmark/eval 추가

목표: agentmemory처럼 memory 기능의 효과를 수치로 확인한다.

작업:

- `packages/learner/src/observation-recall.eval.test.mjs` 또는 `packages/quality` 아래 eval fixture 추가
- synthetic TaskRun corpus 생성
- baseline:
  - recent-only
  - substring search
  - BM25 recall
  - optional vector recall

측정:

- Precision@5
- Recall@5
- MRR
- project leakage count
- redaction violation count
- query latency

수용 기준:

- BM25가 substring baseline보다 낮으면 release blocker로 본다.
- redaction violation은 0이어야 한다.
- projectKey가 다른 entry가 top-K에 섞이는 경우를 별도 측정한다.

## 6. 구현 순서 요약

1. `memory-redaction` 테스트와 구현
2. `MemoryEntry` 타입, schema, repository, migration
3. observation에서 memory entry를 materialize하는 service
4. BM25 기반 `ObservationRecallService`
5. `window.harness.memory.recall/getEntry` IPC 연결
6. Workbench `MemoryRecallPanel`
7. pinned context slot
8. context 사용 approval 확장
9. handoff summary artifact
10. optional vector recall
11. benchmark/eval

## 7. 검증 명령

초기 slice마다 다음 순서로 검증한다.

```bash
node --import tsx --test --test-force-exit packages/learner/src/memory-redaction.test.mjs
node --import tsx --test --test-force-exit packages/storage/src/repositories/memory-entry-repository.test.mjs
node --import tsx --test --test-force-exit packages/learner/src/observation-recall.test.mjs
npm run check
npm run test
npm run build
```

Windows에서 `better-sqlite3.node` ABI mismatch 또는 file lock이 나면 기능 회귀로 단정하지 말고, native module rebuild/lock 해소 후 다시 검증한다.

## 8. 지금 당장 하지 않을 것

- `@agentmemory/mcp`를 Codex config에 설치하지 않는다.
- agentmemory REST 서버를 HarnessAgentOS 앱에서 실행하지 않는다.
- agentmemory hook을 HarnessAgentOS의 기본 workflow에 설치하지 않는다.
- prompt/tool output을 hidden background memory로 저장하지 않는다.
- recall 결과를 자동으로 agent prompt에 주입하지 않는다.
- external embedding/LLM provider를 기본값으로 켜지 않는다.
- file compression/export/import/delete/forget 도구를 approval 없이 노출하지 않는다.

## 9. 최종 권고

현재 프로젝트에 적용해도 되는 범위는 "agentmemory의 제품을 통합"하는 것이 아니라 "agentmemory에서 검증된 메모리 설계 패턴을 Harness의 기존 관찰/학습 계층에 맞게 재구현"하는 것이다.

가장 먼저 착수할 slice는 `memory-redaction` + `memory_entries` + BM25 `ObservationRecallService`다. 이 slice는 외부 provider, 새 서버, 새 자동화 hook 없이도 적용 가능하고, 현재 HarnessAgentOS의 SQLite/IPC/approval 경계를 깨지 않는다.
