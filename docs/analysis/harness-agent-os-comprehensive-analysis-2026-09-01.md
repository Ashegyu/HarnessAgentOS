# HarnessAgentOS 전체 프로젝트 분석 및 학습 기록

- 분석 기준일: 2026-09-01 (Asia/Seoul)
- 기준 커밋: `c8edf03f4f308cc90c5a0a30af3a03f1c6093311` (`master...origin/master`)
- 분석 성격: 전 파일 정적 구조 분석 + 계약/보안/성능/동시성/테스트/빌드 증거 점검
- 최초 분석 변경 경계: 제품 코드는 수정하지 않았고, 분석 산출물과 이해용 지식 그래프만 추가했다.

## 0. 후속 수정 상태 (2026-09-01)

이 문서의 Evidence/Inference는 최초 분석 시점의 snapshot이다. 후속 구현에서 아래 항목을 반영했으며, 원래 발견 내용은 문제의 근거와 의사결정 이력을 보존하기 위해 그대로 둔다.

| 발견 | 후속 상태 | 반영 내용 |
|---|---|---|
| R1 realpath containment | 완료 | Runner/file patch/shadow/DB snapshot에 canonical real-path 검증을 추가하고 junction escape, dangling link, missing target root 테스트를 추가 |
| R2 pipeline block floor | 완료 | 활성 profile `blockedActions`와 budget을 pipeline consent보다 앞선 floor로 적용하고, 차단 시 Approval UI를 수동 검토 상태로 복귀 |
| R3 workspace-write 계약 | 완료 | Settings/IPC/product 계약에 direct-write 예외를 명시하고, 실행 전후 bounded snapshot 기반 A/M/D manifest + 가능한 text diff를 secret-redacted artifact로 자동 저장 |
| R4 RepoIndex | 완료 | 동일 project/target/limit singleflight와 size/mtime short-circuit, changed-only read/hash/parse/upsert 적용. 800파일 warm p50 85.93%, p95 86.29%, upsert 100% 감소를 별도 baseline으로 저장 |
| R5 stale file_write | 완료 | 명시된 `before`와 실제 파일 내용이 다르면 덮어쓰지 않고 실패 |
| R6 stream budget/batching | 완료 | CLI stdout/stderr, normalized/persisted event, provider/renderer pending line, aggregate text/tool list에 상한을 두고 renderer burst를 animation frame 단위로 batch |
| R7 verify CI | 완료 | PR과 master push에서 `npm run verify`를 수행하는 workflow 추가 |
| R8 CRLF test | 완료 | CSS와 selector의 newline을 LF로 정규화해 checkout EOL과 무관하게 검증 |
| R9 Electron/toolchain advisory | 완료 | Electron 41.10.7, electron-builder 26.15.3, Vite 7.3.6, tsx 4.23.13, Playwright 1.62.1 및 안전한 전이 의존성을 갱신해 전체 `npm audit` 39건을 0건으로 정리 |
| R10 상태 전이 validator | 완료 | pure transition table을 core에 추가하고 `LocalStateService.setTaskRunStatus`에서 모든 내부 전이를 검증. skip/terminal 역행을 차단하면서 비동기 QualityGate·repair/refinement 경로는 보존 |
| GPT 기본 모델 | 완료 | Harness 기본/seed/smoke 모델을 `gpt-5.6-sol`로 갱신. legacy 전역 기본값은 승격하고 custom profile/명시 runtime pin은 보존 |

최종 검증 결과: TypeScript workspace check 통과, 전체 테스트 1,434개 중 1,432 통과·2 스킵·0 실패, Electron production build 통과, fake-agent/recovery smoke 통과, 실제 Electron Playwright E2E 3개 통과, 전체 `npm audit` 0건이다. 외부 유료 모델·원격 A2A 호출은 이 변경의 로컬 검증 범위에 포함하지 않았다.

## 요약 결론

HarnessAgentOS는 Renderer → typed preload → 얇은 Main IPC → domain service → SQLite WAL/Runner로 이어지는 레이어 경계가 명확하고, 승인·증거·품질 게이트·작업자 handoff를 실제 타입과 저장소 상태로 모델링한 성숙한 로컬 우선 Electron 워크벤치다. `packages/core`의 저장소 독립성, renderer의 Node 격리, SQLite 단일 source of truth, QualityGate 기반 완료 조건, 원격 A2A의 신뢰/가용성 확인 등 핵심 설계 의도는 코드에 상당 부분 반영되어 있다.

가장 먼저 다뤄야 할 위험은 네 가지다.

1. Runner의 경로 containment가 lexical `resolve/startsWith`에 머물러 junction/symlink의 실제 대상 경계를 보장하지 않는다.
2. pipeline 자동 승인 경로가 일반 `blockedActions`와 budget gate보다 먼저 분기해, README와 일반 승인 정책이 말하는 block floor와 충돌한다.
3. Codex `workspace-write` 모드는 의도적으로 Harness의 approval/artifact-before-write 실행 모델을 벗어나지만 UI와 계약 문서가 이 차이를 충분히 명시하지 않는다.
4. 매 agent invocation마다 최대 500개 파일을 전부 다시 읽고 해시·요약·upsert하는 repo-context 경로는 이 715파일 저장소에서 지연과 문맥 절단을 동시에 만든다.

전체 재작성이나 모듈 폐기는 정당화되지 않는다. 안전 경계와 실행 계약을 먼저 고정하고, 그 다음 repo indexing과 stream 처리의 측정 가능한 병목만 작은 단계로 개선하는 것이 맞다.

---

## 1. Scope

### 1.1 전수 범위

자동 스캔 기준 715개 파일, 182,704줄을 누락 없이 배치 분석 대상으로 삼았다.

| 분류 | 파일 수 |
|---|---:|
| Code | 576 |
| Documentation | 89 |
| Configuration | 35 |
| Markup/Research HTML | 14 |
| Infrastructure | 1 |
| 합계 | 715 |

테스트 자산은 `*.test.mjs` 207개와 Playwright E2E spec 1개다. 전 파일별 분류와 판정은 `docs/analysis/harness-agent-os-repo-scan-2026-09-01.html`에 검색·필터 가능한 형태로 저장했다. 구조 관계는 `.understand-anything/knowledge-graph.json`에 저장한다.

### 1.2 모듈별 규모

| 영역 | 파일 | 줄 | 분석상 역할 |
|---|---:|---:|---|
| `apps/desktop` | 246 | 66,219 | Electron composition root, IPC, preload, React workbench, E2E |
| `packages/agent` | 54 | 14,131 | CLI/A2A 호출, prompt/context, invocation lifecycle |
| `packages/core` | 85 | 11,783 | 순수 타입, 정책, 계약, API surface |
| `packages/evals` | 55 | 6,202 | fixture, grader, case orchestration, reports |
| `packages/learner` | 25 | 6,499 | trace/observation/reward/topology advisory |
| `packages/orchestration` | 39 | 13,643 | plan DAG, worker waves, handoff, backflow |
| `packages/quality` | 12 | 1,475 | evidence 수집 및 quality gate |
| `packages/runners` | 17 | 3,794 | file/shell/git/test side-effect boundary |
| `packages/skillify-adapter` | 15 | 2,261 | skill metadata, registry, suggestions |
| `packages/storage` | 63 | 18,840 | SQLite schema/repository/local state/secret vault |
| `docs` | 76 | 26,045 | 계약, 설계, 구현 단계, 검증 기록 |

### 1.3 지식 그래프 결과

- 최종 노드: 2,090개 (`file` 590, `config` 35, `document` 89, `pipeline` 1, `function` 1,287, `class` 88)
- 최종 edge: 3,352개 (`contains` 1,389, `imports` 764, `exports` 566, `tested_by` 233, `calls` 201, `documents` 98, `configures` 36, `related` 33, `depends_on` 31, `triggers` 1)
- Architecture layers: 10개, file-level node 715개를 중복·누락 없이 정확히 한 layer에 배정
- Guided tour: 12단계, 실제 node ID만 사용하며 non-code reference 6개 포함
- Import map: 765개 entry 중 실제 non-self 관계 764개가 모두 graph에 존재. `apps/desktop/scripts/smoke-shared.mjs` 자기 참조 1개는 source self-import가 없고 self-edge 금지 규칙에 따라 제외
- 최종 deterministic validation: issue 0개. edge가 없는 문서/독립 script/config node 32개는 warning으로 유지했으며 삭제 근거로 사용하지 않음
- Structural fingerprints: 715/715 생성

Layer는 Renderer UI, Desktop Runtime And IPC, Core Domain And Contracts, SQLite Persistence, Approved Side-Effect Runners, Agent And Learning Runtime, Orchestration Quality And Evaluation, Automated Tests, Documentation And Design, Configuration And CI다.

### 1.4 제외 및 불확실성

- tracked build artifact, vendored/minified third-party source, embedded license bundle은 탐지되지 않았다.
- `PERFORMANCE.md`, `BENCHMARKS.md`, `RTK.md`는 상위 지침에서 참조하지만 현재 checkout에는 존재하지 않는다. 따라서 세 문서의 추가 정책은 적용·검증할 수 없었다.
- 실제 Electron GUI, 실제 Codex/Claude CLI, 외부 A2A endpoint, 장시간 production workload는 실행하지 않았다.
- 정적 분석과 단위 테스트를 실제 사용자 화면 acceptance나 production latency 증거로 간주하지 않는다.

---

## 2. Relevant files and call chain

### 2.1 프로세스/데이터 흐름

```text
React Renderer
  └─ window.harness.*
       └─ preload contextBridge (typed IPC only)
            └─ registerAllIpc / domain IPC handler
                 └─ Agent / Orchestration / Quality / Runner / Learner service
                      ├─ repositories → SQLite WAL
                      ├─ Codex queue → Codex CLI process
                      ├─ remote refinement → approval-gated A2A endpoint
                      └─ approved runner → file/shell/git/test side effect

TaskRun 변경
  └─ Main event bus push
       └─ renderer onTaskRunChanged / onAgentStreamEvent
            └─ fresh detail pull 또는 stream state 갱신
```

### 2.2 핵심 진입점

- `apps/desktop/electron/main.ts`: `initServices`, BrowserWindow 보안 옵션, repo context composition.
- `apps/desktop/electron/ipc/index.ts`: 모든 IPC domain 등록.
- `apps/desktop/electron/preload.ts`: raw `ipcRenderer`를 숨긴 typed bridge.
- `apps/desktop/src/App.tsx` 및 `WorkbenchShell.tsx`: renderer composition과 주요 상태/이벤트 구독.
- `packages/core/src/api.ts`: `HarnessDesktopApi` 단일 계약 surface.
- `packages/storage/src/db.ts`, `schema.ts`, repositories: WAL 기반 canonical state.
- `packages/agent/src/agent-planning-service.ts`: standalone/worker invocation의 prompt, context, transcript, 결과 저장.
- `packages/orchestration/src/worker-runner.ts`: DAG wave, handoff, proposed action 생성.
- `packages/runners/src/runner-service.ts`: 승인된 side effect의 최종 실행 경계.
- `packages/quality/src/quality-evaluator.ts`: evidence 기반 완료 게이트.

### 2.3 확인된 좋은 경계

- `apps/desktop/electron/main.ts:619-622`는 `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`를 유지한다.
- renderer 제품 코드에는 Node API 직접 import가 없고, raw `ipcRenderer`는 preload에만 있다.
- `packages/core`는 `@harness/storage`를 실제 import하지 않는다.
- Express/localhost/WebSocket UI bridge가 없고 Electron IPC 경계를 유지한다.
- `packages/storage/src/db.ts:30-32`는 WAL, foreign key, 5초 busy timeout을 설정한다.
- SecretVault는 renderer에 decrypt/read를 노출하지 않고 Electron `safeStorage` 경계를 main에 둔다.
- WorkerRunner는 explicit dependency wave에서 read-only 작업만 병렬화하고 side-effect wave는 직렬화한다.
- QualityGate는 `passed` 또는 명시적으로 수용된 `warning` 없이 완료 처리되지 않는다.

---

## 3. Hot-path assessment

| 경로 | 온도 | 판단 근거 | 현재 위험 |
|---|---|---|---|
| agent invocation 전 repo context refresh | Warm/Hot | standalone 및 worker 호출마다 실행 | 전체 파일 I/O, 해시, 요약, DB rewrite, 500파일 절단 |
| model stdout/stderr → normalized stream → renderer | Hot during invocation | chunk마다 parser/event/state 갱신 | 문자열 누적 복사, 중복 보관, 중복 구독/render |
| worker DAG wave scheduling | Warm | pipeline step 수와 호출 빈도에 비례 | 현재 구조는 합리적; fan-out 시 provider/DB contention 측정 필요 |
| SQLite repository writes | Warm | TaskRun/Step/Artifact/event마다 수행 | 짧은 sync wrapper는 예측 가능하나 장시간 transaction 계약 주의 |
| approved file/shell runner | Cold/Warm, high risk | 실행 횟수보다 안전성이 중요 | realpath/reparse-point 경계와 stale write |
| migration/settings/bootstrap | Cold | 앱 시작/설정 변경 시 | 최적화 우선순위 낮음 |
| 문서/seed/import 변환 | Cold | 관리 작업 | 대형 파일은 유지보수 문제이지 즉시 hot-path 문제는 아님 |

핵심 성능 후보는 RepoIndex와 streaming 두 곳이다. `workbench.css`나 대형 repository를 단순히 크다는 이유만으로 최적화 대상으로 취급하지 않는다.

---

## 4. Allocation and copy analysis

### 4.1 RepoIndex 전체 재구축

**Evidence**

- `apps/desktop/electron/main.ts:512-517`의 `getRepoContext`는 `repoIndexService.refresh`를 항상 호출한다.
- `packages/agent/src/agent-planning-service.ts:349`와 `:1056`에서 standalone/worker invocation 모두 repo context를 로드한다.
- `packages/agent/src/repo-index-service.ts:76-123`은 기본 최대 500파일을 재귀 수집하고, 파일별 `lstat`, 최대 96KB text read, hash/summary/symbol/import 계산, 전체 upsert와 누락 삭제를 수행한다.
- 이 저장소는 715개 파일이므로 기본 cap을 초과한다.

**Inference**

- warm invocation에서도 반복 파일 read와 문자열/해시/요약 객체 생성이 발생한다.
- 여러 worker가 동시에 시작되면 같은 targetDir에 대한 중복 scan과 SQLite write transaction이 겹칠 수 있다.
- DFS/알파벳순 500파일 제한은 최근성·관련성보다 경로 순서에 따라 context를 버릴 가능성이 있다.

**Uncertainty**

- 실제 p50/p95/p99와 allocation 크기는 파일 시스템 cache, 저장소 크기, worker 수에 따라 달라 profiler/benchmark가 필요하다.

### 4.2 CLI stream의 중복 보관

**Evidence**

- `packages/agent/src/model-cli-adapter.ts:102-117`은 stdout/stderr 문자열과 `normalizedEvents` 배열을 invocation 동안 누적한다.
- AgentPlanningService도 stream event를 별도 수집하고 transcript 생성을 위해 다시 map/stringify/join한다.
- 개별 raw payload에는 제한이 있으나 event 총 개수와 전체 transcript의 통합 byte budget은 명확하지 않다.

**Inference**

- 큰 출력에서 문자열 `+=`와 배열 복사, transcript 직렬화가 같은 데이터를 여러 표현으로 보관한다.
- 장시간 CLI나 verbose tool call에서 peak heap과 GC pause가 증가할 수 있다.

**Uncertainty**

- 일반 invocation 출력 크기가 작다면 영향은 낮다. output-size별 heap profile이 필요하다.

### 4.3 Renderer stream state

`AgentStreamView.tsx:93`, `InlineAgentStream.tsx:91`, `WorkbenchShell.tsx:543`, `AgentProviderStatus.tsx:59`가 같은 stream 계열 이벤트를 각각 구독한다. parser의 `state.pending += chunk` (`agent-stream-parser.ts:155`)와 chunk별 shallow copy/setState는 고빈도 출력에서 렌더와 단기 객체 생성을 늘릴 수 있다.

---

## 5. CPU and dispatch analysis

### 5.1 반복 파싱/해시/요약

RepoIndex의 변경 여부 확인 전에 파일 본문을 읽고 해시·요약하는 구조가 가장 큰 반복 CPU 후보다. persisted `mtime + size + hash`를 사용해 unchanged 파일을 먼저 제외하고, changed file만 parse/upsert하는 순서가 KISS 원칙과 측정 가능성 모두에 맞다.

### 5.2 Renderer dispatch fan-out

한 stream event가 shell, provider status, full stream, inline stream으로 fan-out될 수 있다. 각각의 책임은 이해되지만 동일 invocation을 두 stream view가 동시에 표시할 때 parser와 state 갱신이 중복된다. per-invocation store 하나가 parsing을 소유하고 view는 selector로 읽도록 통합할 여지가 있다.

### 5.3 Bundle 증거

`npm run build` 결과 main bundle은 1,462.07KB, renderer JS는 1,222.22KB, renderer CSS는 216.65KB의 단일 주요 산출물이었다. Electron 로컬 앱이므로 웹 TTFB와 동일하게 해석하면 안 되지만, startup parse/evaluation과 renderer memory를 측정할 이유는 충분하다. 우선 route/tab 수준 lazy loading 가능성을 bundle analyzer로 확인하고, 숫자 없이 분할 자체를 목표로 삼지는 않는다.

### 5.4 대형 유지보수 hotspot

- `workbench.css`: 9,834줄
- `agent-pipeline-repository.ts`: 2,534줄
- `PipelinesTab.tsx`: 2,396줄
- `agent-planning-service.ts`: 1,871줄
- `pipeline-form.ts`: 1,747줄
- `agent-profile-repository.ts`: 1,622줄
- `worker-runner.ts`: 1,620줄
- `WorkbenchShell.tsx`: 1,609줄
- `HarnessPackagesTab.tsx`: 1,609줄

이는 자동으로 CPU hot path라는 뜻은 아니다. 변경 충돌, 리뷰 비용, 책임 경계의 불명확성을 높이는 유지보수 신호다.

---

## 6. Concurrency and latency analysis

### 6.1 확인된 강점

- provider별 invocation queue와 worker lane이 분리되어 동일 provider의 기본 FIFO와 worker isolation을 제공한다.
- cancellation은 `AbortController`로 전파된다.
- WorkerRunner는 dependency wave를 계산하고, read-only 독립 step만 병렬 실행하며 결과 side effect는 순서 있게 저장한다.
- EvalOrchestrator는 case 단위 직렬 실행과 격리된 작업 디렉터리를 사용해 결과 오염을 줄인다.

### 6.2 RepoIndex singleflight 부재

동일 targetDir의 동시 invocation이 `refresh`를 공유한다는 증거가 없다. 파일 scan은 비동기 I/O여도 hashing, parsing, object construction 및 better-sqlite3 write는 main process event-loop 지연에 영향을 줄 수 있다. targetDir별 singleflight와 stale-while-revalidate가 tail latency를 안정화할 가능성이 높다.

### 6.3 DB transaction 계약

`LocalStateService.withTransaction`은 `BEGIN IMMEDIATE` 후 async callback을 await한다. 현재 확인된 호출자는 DB wrapper만 즉시 호출해 transaction이 짧으므로 현행 결함으로 보지 않는다. 다만 향후 callback 안에 network/process await가 들어가면 writer lock을 오래 유지할 수 있으므로 “transaction callback 내 외부 I/O 금지” 계약 또는 synchronous callback 타입이 필요하다.

### 6.4 Stream backpressure

현재 구조는 수신 chunk 수에 비례해 event와 renderer update가 발생한다. 화면 갱신은 animation frame 또는 25–50ms batch로 묶되, raw transcript 저장과 cancellation/error event는 손실 없이 유지해야 한다.

---

## 7. Ranked recommendations

### 7.1 상세 발견

#### R1. 실제 파일시스템 경계 고정 — P1, 조건부 P0

**Evidence:** `packages/core/src/path-policy.ts:4`는 realpath/symlink 검사를 runner 책임으로 남긴다. `packages/runners/src/runner-policy.ts:11-17`은 `resolve/normalize/startsWith`만 사용하고, `file-runner.ts:34-56`, `runner-service.ts:431-481` 및 DB snapshot 경로가 이 lexical 판정에 의존한다. 반면 `docs/architecture/security-and-approval-architecture.md:59`는 symlink traversal을 고려한 realpath containment를 요구한다.

**Inference:** targetDir 내부의 junction/symlink parent가 외부를 가리키면 승인된 상대 경로가 workspace 밖 파일로 해석될 수 있다. untrusted workspace가 reparse point를 준비할 수 있는 환경이면 승인 경계 우회가 된다.

**Uncertainty:** Windows symlink 권한, junction 생성 가능성, 실제 threat model에 따라 exploitability가 달라진다.

**권고:** 기존 ancestor와 target parent를 canonical realpath로 비교하고, 생성 파일은 nearest existing ancestor부터 경계를 확인한다. 가능하면 open/write 시 reparse-point/TOCTOU 전략도 문서화한다. Windows junction, file symlink, nested symlink, missing leaf, case-insensitive path 테스트를 추가한다.

#### R2. pipeline consent와 block floor 계약 통합 — P1

**Evidence:** `WorkbenchShell.tsx:683-687`은 pipeline task일 때 `pipelineAutoApproveDecision`으로 먼저 반환한다. 일반 `blockedActions`와 budget은 `:688-690` 이후에만 적용된다. `pipeline-auto-approval.ts:29-33`은 profile block list가 worker approval에 적용되지 않는다고 명시한다. 반면 `README.md:16`, 일반 `shouldAutoApprove` 테스트와 UI 설명은 block floor가 auto-approve보다 우선한다고 말한다.

**Inference:** 사용자는 profile에서 `shell` 등을 차단해도 pipeline 선택만으로 해당 worker approval이 자동 실행될 수 있다고 예상하기 어렵다. 구현은 테스트된 의도적 동작이지만 공개 계약과 충돌한다.

**Uncertainty:** “pipeline 선택 자체가 모든 하위 side effect에 대한 blanket consent인가”는 제품 결정이 필요하다.

**권고:** 하나의 pure decision function에 policy-blocked → profile block floor → budget → explicit pipeline consent → 일반 auto-approve 순서를 모으거나, blanket consent를 유지한다면 UI에서 action 범위와 block-floor 비적용을 선택 전에 명시한다.

#### R3. Codex workspace-write 실행 모델 명시 — P1 계약 위험

**Evidence:** 설정은 기본 false이나 활성화 시 prompt builder가 Codex에 직접 파일 수정을 허용한다. provider tool-call event는 telemetry이며 실행 전 interception이 아니다. IPC 계약은 모든 side effect가 approval을 거친다고 설명한다.

**Inference:** opt-in 모드에서 approval/artifact-before-write/audit 보장이 달라지지만 사용자가 단순 sandbox 옵션으로 이해할 수 있다.

**권고:** “supervised proposal mode”와 “direct workspace-write mode”를 별도 실행 모델로 명명하고, 후자는 사전 approval 보장이 없음을 UI·계약·audit에 표시한다. 유지한다면 invocation 전후 git diff/파일 manifest를 post-hoc artifact로 남긴다.

#### R4. RepoIndex incremental + singleflight — P1 성능/문맥 품질

위 4.1의 증거를 바탕으로 targetDir별 refresh singleflight, persisted `mtime/size`, changed-only read/parse/upsert, 명시적인 truncation telemetry를 먼저 도입한다. 500파일 cap은 단순 상향보다 query relevance와 최근 변경 우선순위를 적용한다.

#### R5. stale `file_write` 방지 — P2 정확성

**Evidence:** `ProposedFilePatch.before?: string`가 계약에 있지만 FileRunner는 현재 내용을 읽은 뒤 `before`와 비교하지 않고 `after`를 덮어쓴다. unified patch는 context mismatch를 검출한다.

**Inference:** 승인과 실행 사이의 사용자/agent 변경이 조용히 유실될 수 있다.

**권고:** `before`가 있으면 optimistic concurrency 비교를 의무화하고 mismatch 시 새 approval을 요구한다. create-only 의도라면 missing/existing 규칙도 명시한다.

#### R6. stream memory budget과 shared parser — P2

raw stdout/stderr, normalized events, AgentPlanning stream events, persisted transcript의 총 byte/event budget을 정의한다. in-memory에는 capped tail만 유지하고 전체가 필요하면 streaming artifact/temp file로 보낸다. renderer는 invocation별 parser/store 하나와 render batching을 사용한다.

#### R7. CI에 `check + test + build` 추가 — P2

현재 `.github/workflows/eval.yml`은 eval 중심이며 PR path filter에 `apps/desktop/**`가 없다. 모든 package/app을 대상으로 빠른 verify job을 두고, Electron smoke/E2E는 별도 job과 artifact로 분리한다.

#### R8. CRLF 독립적인 CSS contract test — P2 품질

실제 CSS 규칙은 `workbench.css:1016-1028`에 존재한다. 실패 원인은 test selector가 LF 문자열을 literal regex로 만들지만 checkout CSS는 CRLF이기 때문이다. 진단 결과 raw match는 false, newline 정규화 후 true였다. 테스트 helper에서 selector/CSS whitespace를 정규화하거나 CSS parser를 사용한다.

#### R9. shipped Electron/toolchain advisory 정리 — P2

`npm audit --omit=dev`는 production dependency 67개, 취약점 0개였다. 전체 audit은 low 7, moderate 4, high 27, critical 1로 39건이다. 대부분 build/dev chain이지만 Electron은 devDependency로 분류되어도 실제 shipped runtime이므로 “dev-only”로 일괄 무시하면 안 된다. Electron, Vite, electron-builder, tar chain을 호환성 테스트와 함께 수동 갱신한다.

**후속 결과:** 메이저 도약 없이 Electron 41 최신 patch와 호환 범위 내 toolchain/transitive fix를 적용했고, `npm audit` 0건 및 Electron Playwright E2E 3/3 통과를 확인했다.

#### R10. 상태 전이 validator 중앙화 — P3

DB CHECK는 status 값의 유효성은 보장하지만 service별 `setTaskRunStatus` 호출의 전이 순서를 한곳에서 강제하지 않는다. 현재 외부 bypass 증거는 없으나 상태와 service 수가 증가했으므로 pure transition table을 LocalStateService 경계에 두는 편이 안전하다.

**후속 결과:** core pure table + LocalStateService enforcement를 적용했다. 전체 회귀에서 확인된 QualityGate 비동기 완료와 repair/refinement 재진입은 명시적으로 허용하고 `drafting -> done`, `running -> drafting`, `cancelled -> running`, `done -> running`은 거부한다.

#### R11. 책임 집중 파일의 동작 보존형 분리 — P3

`WorkbenchShell`, `workbench.css`, `PipelinesTab`, `HarnessPackagesTab`, seed-heavy pipeline/profile repository를 기존 domain 경계로 나눈다. public API와 동작을 유지한 채 state owner, event subscription owner, form model, seed catalogue를 물리적으로 분리하고 각 단계마다 테스트한다.

#### R12. A2A `authSecretRef`의 상태 명확화 — P3 기능 완결성

값은 저장·UI 편집되지만 OfficialA2AClientPort에서 실제 인증에 소비되지 않는다. 문서도 인증 흐름을 open design으로 둔다. 보안 결함으로 과장하지 말고 “deferred/partial”로 UI에 표시하거나 구현할 때 main-only secret resolution과 header redaction을 적용한다.

### 7.2 우선순위 행렬

| 순위 | 항목 | 기대 영향 | 확신 | 구현 위험 | 유지비 |
|---:|---|---|---|---|---|
| 1 | realpath/reparse-point containment | 안전 경계 | 높음 | 중간 | 중간 |
| 2 | pipeline approval 계약 통합 | 안전/예측 가능성 | 높음 | 중간 | 낮음 |
| 3 | workspace-write 실행 모델 명시 | 감사 가능성 | 높음 | 낮음~중간 | 낮음 |
| 4 | RepoIndex incremental/singleflight | latency/context 품질 | 높음(병목), 효과량 미측정 | 중간 | 중간 |
| 5 | stale file write 검사 | 데이터 보존 | 높음 | 낮음 | 낮음 |
| 6 | verify CI + CRLF test | 회귀 차단 | 높음 | 낮음 | 낮음 |
| 7 | stream budget/shared parser | heap/렌더 안정성 | 중간 | 중간 | 중간 |
| 8 | dependency/toolchain upgrade | 공급망/런타임 | 높음 | 중간 | 중간 |
| 9 | 상태 전이 중앙화 | 장기 정확성 | 중간 | 중간 | 낮음 |
| 10 | 대형 파일 분리 | 리뷰/변경 안정성 | 높음 | 중간 | 낮음 |

---

## 8. Proposed minimal implementation plan

아래는 최초 분석 시 제안한 순서다. 이번 수정 범위의 실행 항목은 모두 완료됐으며 최종 상태는 문서 상단 표와 9.1의 검증 증거를 기준으로 본다.

1. **계약 결정 ADR**
   - pipeline 선택이 하위 action 전체 consent인지, block floor/budget이 항상 우선인지 결정한다.
   - workspace-write 모드의 보장 범위를 별도 실행 모델로 기록한다.
2. **Runner 경계 강화**
   - canonical path helper 하나를 추가하고 file write, unified patch, DB snapshot이 공유한다.
   - Windows junction/symlink와 missing leaf 테스트부터 작성한다.
3. **승인 결정 함수 단일화**
   - WorkbenchShell 분기를 pure policy 함수로 이동하고 정책 trace를 동일 결과에서 생성한다.
4. **낙관적 file write**
   - `before` 비교와 conflict error를 추가한다. public type 변경 없이 동작을 강화할 수 있다.
5. **RepoIndex baseline 측정 후 최소 최적화**
   - 먼저 cold/warm/parallel benchmark를 추가한다.
   - targetDir singleflight → metadata short-circuit → changed-only upsert 순으로 각각 측정한다.
6. **stream 상한과 batching**
   - 총 event/byte cap을 먼저 정의하고 adapter에 적용한다.
   - 그 다음 renderer parser/store를 통합하고 render batch를 측정한다.
7. **CI와 dependency 갱신**
   - verify job, line-ending 독립 테스트, Electron/toolchain upgrade를 작은 PR로 분리한다.
8. **유지보수 분리**
   - behavior change와 대형 파일 physical split을 같은 변경에 섞지 않는다.

---

## 9. Verification plan

### 9.1 이번 실행에서 확보한 증거

| 명령/검사 | 결과 | 의미 |
|---|---|---|
| `npm ci` | 성공, 504 packages | lockfile 기반 의존성 복원 |
| `npm run check` (verify의 첫 단계) | 전체 workspace 통과 | TypeScript 정적 계약 통과 |
| 공식 `npm run verify` | 실패 | Node 24/Windows `uv_os_get_passwd ENOMEM`로 tsx bootstrap 대량 실패; build 단계 미도달 |
| `node -e os.userInfo()` | 동일 ENOMEM | 테스트 assertion 이전의 host/runtime 문제임을 확인 |
| 분석용 installed-tsx 사용자명 우회 + `--test-concurrency=1` | 1,407 tests: 1,404 pass, 1 fail, 2 skip | 코드 수준 실패를 CRLF CSS test 1개로 분리; 공식 verify 성공으로 간주하지 않으며 우회는 실행 후 원복함 |
| CRLF diagnostic | raw false, LF-normalized true | CSS 규칙 누락이 아니라 test whitespace 의존성 |
| `npm run build` | 성공 | Electron main/preload/renderer production bundle 생성 |
| `npm audit --omit=dev --json` | 0 vulnerability | npm production graph snapshot |
| 최초 `npm audit --json` | 39 advisories | runtime으로 shipping되는 Electron 포함 수동 분류 필요 |
| 최종 `npm audit --json` | 0 vulnerability | Electron/toolchain 및 안전한 전이 의존성 패치 반영 |
| 최종 `npm run verify` | check 통과 + 1,434 tests(1,432 pass, 0 fail, 2 skip) + build 성공 | 임시 preload 없이 정상 호스트 환경에서 CI canonical command 전체 통과 |
| `npm run verify:smoke` | recovery/fake-agent smoke 성공, Electron Playwright 3/3 성공 | 실제 로컬 Electron 프로세스·preload·renderer·SQLite native module 통합 확인 |
| `npm run bench:repo-index` workload | 800 files, 7 warm runs; before p50 350.99ms/p95 388.84ms → after p50 49.38ms/p95 53.33ms; warm upsert 5,600 → 0 | unchanged refresh의 반복 read/hash/parse/DB write 제거 효과. raw 결과는 `.ecc/benchmarks/repo-index-refresh.json`에 저장 |

### 9.2 권고 변경별 검증

1. **Path boundary:** NTFS junction, file/dir symlink, nested reparse point, case variation, non-existing leaf, targetDir 자체 교체 race를 포함한 integration test.
2. **Approval policy:** action × policyEvaluation × profile block × budget × pipeline consent × global toggle의 table-driven matrix; trace reason도 검증.
3. **Workspace-write:** 두 모드에서 실제 file mutation, pre-approval 존재 여부, post-hoc diff artifact를 E2E로 구분.
4. **File write:** 승인 후 파일 변경을 시뮬레이션해 overwrite 대신 conflict가 나는지 검증.
5. **RepoIndex benchmark:** 500/5,000/20,000파일, cold/warm/1·4·8 parallel invocation에서 elapsed, bytes read, rows updated, heap allocation, event-loop delay, p50/p95/p99.
6. **Stream benchmark:** 1MB/10MB/100MB, 작은 chunk/큰 chunk 조합에서 peak heap, GC, event count, render commit 수, cancellation latency.
7. **UI/runtime:** 실제 Electron dark/light dropdown, pipeline auto-run consent 문구, stream view를 Playwright smoke와 수동 화면으로 확인.
8. **CI:** Windows와 Linux Node LTS에서 `npm ci`, check, full unit, build; smoke/E2E는 별도 evidence artifact.

### 9.3 완료 판정 경계

- source contract와 unit test는 실제 Electron 화면 acceptance가 아니다.
- build 성공은 실제 Codex/Claude/A2A invocation 성공이 아니다.
- benchmark 없이 성능 향상을 주장하지 않는다.
- audit/benchmark 숫자는 2026-09-01 현재 lockfile과 이 호스트의 설치 snapshot이다. 다른 장비의 절대 latency는 달라질 수 있으므로 상대 변화와 warm upsert 수를 함께 본다.

---

## Repository asset verdict

- **Core Asset:** 모든 제품 package, Electron main/preload/renderer, tests, contracts, architecture docs, eval fixtures, CI/eval scripts.
- **Extract & Merge:** 책임이 집중된 대형 shell/tab/CSS/repository/service 파일 8개와 top-level/workspace 연구 HTML 11개. 동작 보존형 분리 또는 `docs/research` 재배치 대상이다.
- **Rebuild:** 현재 증거로 정당화되는 대상 없음.
- **Deprecate:** reachability/사용 중단 증거가 없어 판정한 대상 없음.
- **Embedded third-party source:** 탐지 없음.
- **Tracked build outputs:** 탐지 없음.

## 학습된 프로젝트 모델

이 프로젝트를 이후 작업에서 다음 규칙으로 이해해야 한다.

1. canonical state는 SQLite WAL이며 JSON은 projection/transport일 뿐이다.
2. renderer는 `window.harness.*`와 push event만 사용하고 Node/SQL/process를 직접 만지지 않는다.
3. side effect는 Approval → Runner → Artifact/Log → QualityGate 흐름이 기본 실행 모델이다.
4. pipeline, direct workspace-write처럼 기본 모델을 바꾸는 예외는 숨은 옵션이 아니라 별도 계약으로 다뤄야 한다.
5. 성능상 가장 먼저 측정할 경로는 repo context refresh와 CLI stream이다.
6. orchestration의 병렬성은 dependency wave와 read-only 여부가 소유하며, 저장 side effect의 순서는 안정적으로 유지해야 한다.
7. 파일/버퍼/secret의 ownership과 lifetime은 main/runner 경계에서 명시해야 한다.
8. 대형 파일은 재작성보다 established domain boundary에 맞춘 작은 physical split이 적합하다.
9. 테스트 수가 많아도 line ending, 실제 GUI, 실제 provider, production workload 경계는 따로 검증한다.
