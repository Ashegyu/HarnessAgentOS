# Phase 03 - Runner And Artifacts

## 목표

승인된 action을 안전한 runner로 실행하고, 모든 실행 결과를 artifact로 보존한다. 완료되면 파일 수정, shell/test/git diff 실행이 approval 이후에만 가능하고, 결과가 diff/log/test artifact로 UI에 표시되어야 한다.

## 비범위

- 품질 완료 판정은 Phase 4에서 한다.
- dependency install과 git commit은 runner interface만 준비하고 MVP 기본 실행에서는 high risk로 막는다.
- Skill script 실행은 Phase 5에서 한다.
- agent orchestration은 도입하지 않는다.

## 구현 단위

```text
packages/runners/src/
  runner-types.ts
  runner-policy.ts
  file-runner.ts
  shell-runner.ts
  git-runner.ts
  test-runner.ts
  runner-service.ts
packages/core/src/artifacts/
  artifact-store.ts
  diff-artifact.ts
apps/desktop/electron/ipc/runner-ipc.ts
apps/desktop/src/screens/workbench/
  ArtifactPanel.tsx
  DiffViewer.tsx
  LogViewer.tsx
```

Artifact 파일 위치:

```text
app.getPath("userData")/artifacts/{taskRunId}/{artifactId}.md
app.getPath("userData")/artifacts/{taskRunId}/{artifactId}.diff
app.getPath("userData")/artifacts/{taskRunId}/{artifactId}.log
```

## 주요 타입과 인터페이스

```ts
export interface RunnerRequest {
  taskRunId: string;
  stepId: string;
  approvalId: string;
  kind: "file" | "shell" | "git" | "test";
  targetDir: string;
  command?: string;
  filePatch?: ProposedFilePatch;
}

export interface RunnerResult {
  id: string;
  taskRunId: string;
  stepId: string;
  commandSummary: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  changedFiles?: string[];
  artifactIds: string[];
  startedAt: string;
  finishedAt: string;
}

export interface ProposedFilePatch {
  path: string;
  before?: string;
  after: string;
}
```

IPC:

```ts
runner.executeApproved(input: { approvalId: string }): Promise<RunnerResult>;
runner.listArtifacts(input: { taskRunId: string }): Promise<Artifact[]>;
runner.readArtifact(input: { artifactId: string }): Promise<{ artifact: Artifact; content: string }>;
```

## 데이터 흐름

```text
User approves action
  -> approval.status = approved
  -> renderer requests runner.executeApproved
  -> RunnerService loads approval/taskRun/checkpoint
  -> RunnerPolicy validates targetDir and action type
  -> Step edit/shell/test status = running
  -> runner executes
  -> stdout/stderr/diff/test artifacts written
  -> Artifact rows inserted
  -> Step status = succeeded or failed
  -> TaskRun status = running or blocked
  -> UI refreshes artifact panel
```

Diff flow:

```text
Before file action
  -> GitRunner captures git diff or file snapshot baseline
After file action
  -> GitRunner captures diff
  -> diff artifact saved
```

## UI 요구사항

- Artifact panel은 artifact 목록을 kind별로 grouping한다.
- diff artifact는 diff viewer로 표시한다.
- log artifact는 stdout/stderr를 구분한다.
- failed step은 timeline에서 명확한 `failed` badge와 재시도 action을 표시한다.
- 승인되지 않은 action은 실행 버튼이 비활성화된다.
- 실행 중에는 cancel/pause placeholder를 표시한다. 실제 process kill은 후속 개선으로 둔다.

## 보안/승인 정책

- runner는 approval row가 `approved` 상태인지 확인해야 한다.
- `targetDir` 밖 파일 쓰기는 차단한다.
- command는 shell string을 그대로 저장하되, 실행 전 policy가 high risk pattern을 검사한다.
- `rm`, `del`, `Remove-Item`, `git reset`, `git clean`, `git push`, package install은 MVP에서 개별 high risk로 막거나 별도 approval을 요구한다.
- stdout/stderr는 artifact로 저장하되 secret-looking token은 UI에서 마스킹하는 helper를 둔다.

## 테스트 계획

Unit:

- RunnerPolicy path containment.
- dangerous command classifier.
- artifact URI 생성.
- stdout/stderr secret masking.

Integration:

- approved file patch가 targetDir 내부 파일만 수정한다.
- unapproved approvalId는 실행되지 않는다.
- shell command 결과가 log artifact로 저장된다.
- git diff artifact가 생성된다.
- runner 실패 시 Step failed와 TaskRun blocked가 된다.

UI smoke:

- artifact list와 diff/log viewer 표시.
- failed runner 상태 표시.
- unapproved action 실행 버튼 비활성화.

Manual acceptance:

- 파일 수정 전에 approval이 필요하다.
- 수정 후 diff를 볼 수 있다.
- 실패한 command의 stderr가 숨겨지지 않는다.

## 완료 기준

- RunnerService가 approval 기반으로만 실행한다.
- File/Shell/Git/Test runner 최소 구현이 있다.
- diff/log/test artifact가 저장되고 UI에서 읽힌다.
- 실패 상태가 DB와 UI에 반영된다.
- targetDir 밖 쓰기가 차단된다.

## 다음 Phase 인계

Phase 4는 Phase 3이 저장한 runner 결과와 artifact를 evidence로 읽어 품질 게이트를 계산한다. Phase 3은 artifact kind와 runner result shape를 안정적으로 유지해야 한다.




