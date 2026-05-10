# Phase 01 - Local State Model

## 목표

HarnessAgentOS의 canonical state를 SQLite WAL DB로 구현한다. 완료되면 앱 재시작 후에도 Thread, TaskRun, Step, Checkpoint, Approval, Artifact가 복원되고, renderer는 IPC를 통해 이 상태를 조회할 수 있어야 한다.

## 비범위

- 대화 입력에서 TaskRun을 자동 생성하지 않는다.
- Approval 실행 정책은 schema와 repository까지만 만든다.
- Runner 실행, Quality Gate, Skillify, Learner는 구현하지 않는다.
- JSON 파일을 canonical state로 만들지 않는다.

## 구현 단위

```text
packages/core/src/types/
  thread.ts
  task-run.ts
  step.ts
  checkpoint.ts
  approval.ts
  artifact.ts
packages/storage/src/
  db.ts
  schema.ts
  migrations.ts
  repositories/
  services/local-state-service.ts
apps/desktop/electron/ipc/state-ipc.ts
```

DB 파일 위치는 `app.getPath("userData")/app.db`로 고정한다. Artifact 파일의 실제 저장소는 Phase 3에서 확장하지만, Phase 1부터 artifact row의 `uri`는 저장 가능해야 한다.

Schema 최소 제약:

- `threads.id`, `task_runs.id`, `steps.id`, `checkpoints.id`, `approvals.id`, `artifacts.id`는 text primary key로 둔다.
- `task_runs.thread_id`, `steps.task_run_id`, `checkpoints.task_run_id`, `approvals.task_run_id`, `artifacts.task_run_id`는 foreign key로 연결한다.
- `task_runs.status`는 `drafting`, `waiting_for_approval`, `running`, `paused`, `blocked`, `quality_failed`, `ready_for_review`, `done`, `cancelled`만 허용한다.
- `steps.status`는 `pending`, `running`, `succeeded`, `failed`, `skipped`만 허용한다.
- `approvals.status`는 `pending`, `approved`, `rejected`, `always_approved_for_run`만 허용한다.
- `approvals.action_type`은 `file_write`, `shell`, `dependency_install`, `git_commit`, `network`, `skill_script`, `orchestration_plan`만 허용한다.
- `artifacts.kind`는 `plan`, `diff`, `log`, `test_result`, `quality_report`, `orchestration_plan`, `file`, `snapshot`만 허용한다.
- migration은 여러 번 실행해도 같은 결과가 되는 idempotent 방식으로 작성한다.

## 주요 타입과 인터페이스

```ts
export interface Thread {
  id: string;
  title: string;
  targetDir?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export type TaskRunStatus =
  | "drafting"
  | "waiting_for_approval"
  | "running"
  | "paused"
  | "blocked"
  | "quality_failed"
  | "ready_for_review"
  | "done"
  | "cancelled";

export interface TaskRun {
  id: string;
  threadId: string;
  userRequest: string;
  targetDir: string;
  status: TaskRunStatus;
  currentStepId?: string;
  createdAt: string;
  updatedAt: string;
}
```

Repository interface:

```ts
export interface ThreadRepository {
  create(input: CreateThreadInput): Promise<Thread>;
  list(): Promise<Thread[]>;
  get(id: string): Promise<Thread | null>;
  update(id: string, patch: UpdateThreadInput): Promise<Thread>;
}

export interface TaskRunRepository {
  create(input: CreateTaskRunInput): Promise<TaskRun>;
  listByThread(threadId: string): Promise<TaskRun[]>;
  get(id: string): Promise<TaskRun | null>;
  updateStatus(id: string, status: TaskRunStatus): Promise<TaskRun>;
}
```

IPC:

```ts
state.listThreads(): Promise<Thread[]>;
state.getThread(input: { threadId: string }): Promise<ThreadDetail>;
state.createThread(input: { title: string; targetDir?: string }): Promise<Thread>;
```

## 데이터 흐름

```text
App boot
  -> main process opens SQLite
  -> PRAGMA journal_mode=WAL
  -> PRAGMA foreign_keys=ON
  -> PRAGMA busy_timeout=5000
  -> migrations run
  -> renderer calls state.listThreads
  -> sidebar renders persisted threads
```

TaskRun 생성 흐름:

```text
Service call
  -> validate targetDir string if provided
  -> create Thread if needed
  -> insert TaskRun
  -> insert initial Step when requested by caller
  -> return full ThreadDetail
```

## UI 요구사항

- 좌측 sidebar에 Thread 목록을 표시한다.
- Thread가 없으면 `작업 스레드 없음` 상태를 표시한다.
- Thread 선택 시 중앙 영역에 해당 Thread의 TaskRun 목록을 표시한다.
- TaskRun status는 badge로 표시한다.
- DB 오류 시 renderer에 stack trace를 그대로 보여주지 말고 짧은 오류와 세부 보기 affordance를 둔다.

## 보안/승인 정책

- DB 접근은 main process에서만 한다.
- Renderer는 SQL을 보낼 수 없다.
- IPC input은 object schema로 검증한다.
- `targetDir`는 이 Phase에서 문자열 저장만 허용하되, 절대경로/상대경로 validation helper를 만든다.
- 모든 timestamp는 ISO string으로 저장한다.

## 테스트 계획

Unit:

- schema migration idempotency.
- repository CRUD.
- status enum validation.
- timestamp serialization.

Integration:

- temp userData path에서 DB 생성 후 앱 재시작 시 데이터 복원.
- WAL/foreign_keys/busy_timeout pragma 적용 확인.
- IPC로 Thread list/create/get 호출.

UI smoke:

- 빈 Thread 목록 표시.
- Thread 생성 후 sidebar 갱신.
- TaskRun status badge 표시.

Manual acceptance:

- 앱을 닫았다 열어도 Thread가 유지된다.
- DB 파일이 app userData 아래에 생성된다.
- 프로젝트 폴더에는 runtime DB가 생성되지 않는다.

## 완료 기준

- SQLite canonical DB가 동작한다.
- Thread/TaskRun/Step/Checkpoint/Approval/Artifact 기본 table이 있다.
- repository와 service 경계가 분리되어 있다.
- renderer가 SQL 없이 IPC로 상태를 읽는다.
- 앱 재시작 후 상태가 복원된다.
- JSON state를 canonical로 사용하지 않는다.

## 다음 Phase 인계

Phase 2는 이 상태 모델 위에서 실제 대화 입력을 `TaskRun`으로 변환한다. Phase 1은 `createThread`, `createTaskRun`, `createStep`, `createCheckpoint`, `createApproval`, `createArtifact` service method를 안정적으로 제공해야 한다.




