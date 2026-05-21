# Pipeline Backflow Routing Plan

Date: 2026-05-20
Status: Implemented

## 1. Purpose

Pipeline backflow is a user-configured conditional runtime route owned by an
agent step inside an approved pipeline. It is not A2A remote refinement and it
is not dependency graph reversal.

The user defines a backflow connection on each agent step during pipeline
editing:

- when that worker step fails, rerun the connected earlier target agent and then
  retry the owning agent
- when a quality gate fails, rerun the connected earlier target agent, retry the
  selected owning agent, then run the normal downstream steps after that retry

Successful steps continue through the normal `dependsOn` flow. Backflow is not a
separate final pipeline step. It runs only when a matching failure trigger occurs
for the agent that owns the connection.

## 2. Scope

Included:

- agent-owned pipeline `backflowRules` stored on the pipeline template
- planner remap from pipeline step ids to worker step ids
- runtime attempts and lifecycle events persisted in SQLite WAL
- step failure backflow in `WorkerRunner.runApproved`
- quality failure backflow from Electron main after `quality.evaluate`
- renderer controls, graph edge display, TaskRun detail history, and Activity Log

Excluded:

- merging this feature with `A2ARefinementAttempt`
- adding backflow edges to `dependsOn` cycle validation
- unbounded recursive agent loops
- automatic quality re-evaluation after backflow
- user-visible `pipeline.run` IPC

## 3. State Model

`AgentPipeline.backflowRules` stores template-time rules. The UI presents these
rules inside the agent step whose id is `retryStepId`; that step owns the
connection.

```ts
type PipelineBackflowTrigger = "step_failed" | "quality_failed";

interface AgentPipelineBackflowRule {
  id: string;
  trigger: PipelineBackflowTrigger;
  targetStepId: string;
  retryStepId: string;
  maxAttempts: number;
  instruction?: string;
}
```

`OrchestrationPlan.backflowRules` stores the immutable run snapshot after planner
remap. `targetStepId` and `retryStepId` are worker step ids in this snapshot.
`retryStepId` is the owning agent. `targetStepId` is the earlier agent to rerun
before retrying the owner.

Runtime execution writes:

- `pipeline_backflow_attempts`
- `pipeline_backflow_events`

Attempt statuses are `running`, `succeeded`, `failed`, and
`max_attempts_reached`. Event types are `triggered`, `target_started`,
`target_succeeded`, `retry_started`, `retry_succeeded`, `failed`, and
`max_attempts_reached`.

## 4. Validation Rules

Pipeline repository validation rejects:

- malformed rules
- duplicate rule ids
- unknown `targetStepId`
- unknown `retryStepId`
- `targetStepId === retryStepId`
- target step positioned at or after retry step
- `maxAttempts` outside 1..5

`dependsOn` cycle validation stays normal-flow only. Backflow is a conditional
runtime edge and must not make a valid DAG appear cyclic.

## 5. Runtime Flow

Normal worker execution still uses dependency waves from `dependsOn`.

For `step_failed`:

1. A worker step fails.
2. `WorkerRunner` finds a `step_failed` rule whose `retryStepId` equals the
   failed worker step id.
3. The persisted attempt count is checked against `maxAttempts`.
4. The target step runs as a new DB step and artifact.
5. If the target succeeds, the retry step runs as another new DB step and
   artifact.
6. If retry succeeds, the original failure is considered resolved and the normal
   downstream flow continues.
7. If target/retry fails or attempts are exhausted, the TaskRun becomes
   `blocked`.

For `quality_failed`:

1. `quality.evaluate` persists the `QualityGateResult`.
2. Electron main calls `PipelineBackflowService` only when
   `QualityGateResult.status === "failed"`.
3. The service loads the latest orchestration plan.
4. If a `quality_failed` rule exists, `WorkerRunner.runQualityBackflow` runs
   target, retry, then the normal downstream steps after retry.
5. The TaskRun returns to `ready_for_review` when the backflow sequence succeeds.
6. No automatic quality re-evaluation runs. The user must evaluate again.

`passed` and `warning` quality results do not trigger pipeline backflow. `warning`
keeps the existing known-risk approval path.

## 6. Observability

Renderer surfaces:

- Pipeline form: create/edit/remove Backflow connections inside each agent step
- Pipeline graph: dashed conditional backflow edges separate from normal
  dependency edges
- Agent tab: TaskRun-level backflow attempt history with rule, trigger, target,
  retry, attempt index, status, and reason
- Activity Log: Pipeline Backflow Events section with lifecycle events

Public IPC additions:

- `TaskRunDetail.pipelineBackflowAttempts`
- `conversation.listBackflowEvents(input)`

## 7. A2A Refinement Boundary

Pipeline backflow and A2A refinement are intentionally separate.

Pipeline backflow reruns approved pipeline worker steps inside the local
orchestration plan. A2A refinement sends a bounded follow-up request to a remote
A2A endpoint about a previous remote invocation. They use separate tables,
separate UI sections, and separate loop guards.

## 8. Procedural Review

Reviewed execution order:

1. Pipeline template saves valid normal DAG plus optional conditional rules.
2. Planner remaps step ids once into the immutable orchestration plan.
3. Normal execution uses only `dependsOn` waves.
4. Failure handling checks trigger and persisted attempt count before rerunning
   anything.
5. Backflow reruns always create new Step/Artifact/Event rows and do not
   overwrite prior artifacts.
6. Retry success clears only the matching failed step condition, then normal
   downstream execution resumes.
7. Quality failure backflow returns to `ready_for_review` and waits for explicit
   user evaluation.

No ordering issue remains in this procedure. The intentionally retained
constraint is that v1 supports one target/retry pair per rule; multi-target repair
chains should be a later feature.
