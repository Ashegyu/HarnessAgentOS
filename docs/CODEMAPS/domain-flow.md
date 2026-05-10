# CODEMAP: Domain flow

`Thread → TaskRun → Step → Checkpoint → Approval → Artifact → QualityGateResult → LearningTrace`

Use this map when you need to find where a row is created/mutated, or when
tracing why the workbench shows a particular status.

## Tables and their owning repository

| Domain object | Repository |
|--|--|
| Thread | [packages/storage/src/repositories/thread-repository.ts](../../packages/storage/src/repositories/thread-repository.ts) |
| TaskRun | [packages/storage/src/repositories/task-run-repository.ts](../../packages/storage/src/repositories/task-run-repository.ts) |
| Step | [packages/storage/src/repositories/step-repository.ts](../../packages/storage/src/repositories/step-repository.ts) |
| Checkpoint | [packages/storage/src/repositories/checkpoint-repository.ts](../../packages/storage/src/repositories/checkpoint-repository.ts) |
| Approval | [packages/storage/src/repositories/approval-repository.ts](../../packages/storage/src/repositories/approval-repository.ts) |
| Artifact | [packages/storage/src/repositories/artifact-repository.ts](../../packages/storage/src/repositories/artifact-repository.ts) |
| QualityGateResult | [packages/storage/src/repositories/quality-gate-repository.ts](../../packages/storage/src/repositories/quality-gate-repository.ts) |
| LearningTrace | [packages/storage/src/repositories/learning-trace-repository.ts](../../packages/storage/src/repositories/learning-trace-repository.ts) |
| Capability | [packages/storage/src/repositories/capability-repository.ts](../../packages/storage/src/repositories/capability-repository.ts) |

All repositories sit behind [LocalStateService](../../packages/storage/src/local-state-service.ts). Services should depend on `LocalStateService`, never on individual repositories.

## TaskRun status transitions (canonical)

| From → To | Driver |
|--|--|
| `drafting` → `waiting_for_approval` | `ConversationService.createTask` |
| `waiting_for_approval` → `running` | `ConversationService.approve` (last pending), `RunnerService.executeApproved` |
| `running` → `blocked` | runner policy denies (e.g. dependency_install) |
| `running` → `quality_failed` | `QualityEvaluator.evaluate` returns `failed` + `TaskRunCompletionService.applyQualityGateResult` |
| `running`/`blocked`/`quality_failed` → `running` | `RunnerService.retryApproval` |
| `running` → `ready_for_review` | `TaskRunCompletionService.applyQualityGateResult` (passed/warning) |
| `ready_for_review` → `done` | `TaskRunCompletionService.markDone` (+ `LearnerAdvisor.recordOutcome` from QualityPanel) |
| any non-terminal → `paused` | `ConversationService.pauseTask` |
| `paused` → `waiting_for_approval`/`running` | `ConversationService.resumeTask` |
| any non-terminal → `cancelled` | `ConversationService.cancelTask` (writes `quality_report` artifact) |

`done` and `cancelled` are terminal — no transitions out.

## Approval lifecycle

`pending` → `approved` (or `always_approved_for_run`) | `rejected`

- `ConversationService.approve` flips to approved/always_approved_for_run.
- `ConversationService.rejectApproval` flips to rejected and pauses parent TaskRun.
- `cancelTask` rejects all still-pending approvals with `Cancelled: <reason>`.
- `redirectTask` rejects with `Replaced by redirect`.

## Quality gate decision matrix

| `result.status` | `markDone` allowed? |
|--|--|
| `passed` | yes |
| `warning` | only if a `quality_report` artifact exists with URI ending `/<gate.id>` (the known-risk approval branch — see "Artifact kinds" below) |
| `failed` | no — `QUALITY_DONE_BLOCKED` |
| `not_run` | no — `QUALITY_DONE_BLOCKED` |

The known-risk approval is created by [TaskRunCompletionService.approveKnownRisks](../../packages/core/src/task-run/task-run-completion-service.ts), invoked from the [RiskApprovalDialog](../../apps/desktop/src/screens/workbench/RiskApprovalDialog.tsx) inside [QualityPanel](../../apps/desktop/src/screens/workbench/QualityPanel.tsx).

## Artifact kinds (canonical set)

The DB `artifacts.kind` `CHECK` constraint in [packages/storage/src/schema.ts](../../packages/storage/src/schema.ts) is the single source. Allowed kinds:

`plan` · `diff` · `log` · `test_result` · `quality_report` · `orchestration_plan` · `file` · `snapshot`

Sub-types are encoded in the `uri` field, not by adding new kinds:

| Logical sub-type | Stored as | Identifying URI suffix |
|--|--|--|
| Plan | `plan` | `harness:plan/<taskRunId>/<ts>` |
| Repair plan | `plan` | same shape; produced by `createRepairPlan` |
| Quality gate report | `quality_report` | `harness:quality/<taskRunId>/<gateId>` |
| Known-risk approval | `quality_report` | `harness:quality/<taskRunId>/<gateId>` (URI is the discriminator the completion service checks) |
| Cancellation report | `quality_report` | written by `cancelTask` |
| Worker step log | `log` | `harness:worker/<taskRunId>/<stepId>` |
| Test runner output | `test_result` | `harness:test/<taskRunId>/<stepId>` |

When you need a new logical kind, prefer extending the URI scheme over adding a SQL CHECK value — it keeps migrations rare and the renderer's filtering logic uniform. Add a SQL kind only when you need a different storage/serialisation contract.

Artifact bodies live on disk (managed by [FilesystemArtifactStore](../../packages/storage/src/filesystem-artifact-store.ts)); the SQLite row stores metadata + URI only.
