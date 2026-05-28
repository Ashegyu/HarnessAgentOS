# Code Change Loop Architecture

Date: 2026-05-28
Status: Phase 1 implemented; Phase 2 auto-repair trigger implemented for pipeline auto tasks

## 1. Scope

HarnessAgentOS needs a bounded code modification loop for feature requests:

```text
user request
-> pipeline / harness worker plan
-> one coherent change set
-> apply approved file writes
-> run verification commands
-> feed failures back to a repair worker
-> repeat until verified or blocked
```

This is broader than the current worker proposal path. Today workers can
produce `file_write` and `shell` proposed actions, but the runtime stops at
approval creation. A separate user action executes each approval. There is no
single service that owns multi-file attempt state, verification feedback, or
bounded repair iteration.

This document defines that missing service boundary.

## 2. Relevant Files And Call Chain

Current evidence:

- `OrchestrationPlanner` turns a pipeline or direct harness source into an
  immutable `OrchestrationPlan`.
- `WorkerRunner` invokes worker agents and converts accepted
  `AgentProposedAction` items into downstream approvals.
- `RunnerService` executes one approved action at a time.
- `FileRunner` writes the approved `after` content to disk with `targetDir`
  containment checks.
- `QualityEvaluator` can judge evidence, but the repair loop is currently only
  described at the architecture level.

Target Phase 1 call chain:

```text
WorkerRunner / OrchestrationService
-> CodeChangeLoopService
-> RunnerExecutor.executeApproved(file_write approvals)
-> RunnerExecutor.executeApproved(verification shell approvals)
-> state artifacts / steps / TaskRun status
```

Later phases can insert a repair worker between verification failure and the
next apply attempt.

## 3. Hot-Path Assessment

This is not an application hot path. It is a control-plane loop with expensive
I/O, model calls, and test commands. The design should optimize for:

- predictable state transitions
- bounded retries
- auditability
- low accidental writes
- stable user-visible progress

Throughput is secondary. Parallel worker analysis is allowed, but file writes
and verification should be serialized unless a future conflict detector proves
parallel application is safe.

## 4. Allocation And Copy Analysis

Current `file_write` actions carry whole-file `after` content. That is simple
and safe for Phase 1, but repeated attempts can duplicate large strings across
model output, approval JSON, and diff artifacts.

Phase 1 keeps existing `file_write` semantics to avoid API churn. It adds a
change-loop manifest artifact that records:

- approval ids applied
- changed file paths reported by runners
- verification commands and exit codes
- attempt status

Later phases should consider diff-based patches or external blob storage only
after large-file pressure is measured.

## 5. CPU And Dispatch Analysis

The missing behavior is dispatch, not CPU optimization:

- group multiple approved `file_write` approvals into one attempt
- execute them in a deterministic order
- run approved verification commands after the batch
- mark the TaskRun `ready_for_review`, `quality_failed`, or `blocked`
- preserve logs as artifacts

The first implementation should avoid changing `RunnerService` dispatch rules.
It should depend on a small executor interface so tests can validate loop logic
without spawning shell commands or writing real files.

## 6. Concurrency And Latency Analysis

Phase 1 execution is intentionally serial:

1. Apply approved file writes in input order.
2. Stop on the first apply failure.
3. Run approved verification actions in input order.
4. Stop on the first failed verification unless the caller requested full
   evidence collection in a later phase.

This minimizes hidden conflicts and keeps progress readable. Parallel waves can
still produce worker proposals before the loop starts.

## 7. Ranked Recommendations

1. Add `CodeChangeLoopService` under `packages/orchestration`.
2. Keep the service independent from concrete `RunnerService` by depending on
   a narrow `RunnerExecutor` interface.
3. Model each pass as a `CodeChangeAttempt` value with applied approvals,
   changed files, verification results, status, and next action.
4. Persist one manifest artifact per attempt.
5. In Phase 1, support apply + verify only. Do not invoke repair workers yet.
6. In Phase 2, use failed verification artifacts as handoff input to a repair
   worker that returns another action set.
7. In Phase 2, use Workbench auto-execution results to trigger bounded repair
   attempts for pipeline/harness auto tasks.
8. In Phase 3, add richer renderer progress UI for attempt history.

## 8. Proposed Minimal Implementation Plan

Phase 1:

- Create `code-change-loop-service.ts`.
- Expose `runner.executeCodeChangeAttempt` so the renderer can execute a
  reviewed change set as one attempt instead of one approval at a time.
- Add focused unit tests for:
  - multi-file approval application
  - verification success
  - verification failure
  - runner apply failure
  - no-op attempts
- Export the service from `packages/orchestration/src/index.ts`.
- Add a Workbench auto-execution classifier that batches straightforward
  `file_write*` then `shell*` approval sequences into one code-change attempt,
  while preserving legacy per-approval execution for ambiguous ordering.
- Auto-increment attempt numbers from persisted code-change manifest artifacts
  when callers do not provide an explicit attempt number.

Phase 2:

- When a pipeline/harness auto task gets `repair_required` from a
  code-change attempt, call `quality.createRepairPlan` in the same TaskRun.
- Let existing `RepairLoopService` enforce `maxAttempts` and repeated failure
  signature stops.
- Let the next Workbench refresh auto-approve and execute the generated repair
  `file_write*` then `shell*` approvals through another code-change attempt.
- Keep repair auto-generation scoped to pipeline/harness auto tasks; non-pipeline
  auto-approve still requires explicit repair action.
- Surface repair-required state in the Workbench action area.

Phase 3:

- Surface attempts, changed files, and verification status in the Workbench.

## 9. Verification Plan

Phase 1 verification commands:

```bash
node --import tsx --test --test-force-exit packages/orchestration/src/code-change-loop-service.test.mjs
node --import tsx --test --test-force-exit apps/desktop/src/screens/workbench/auto-execution-plan.test.mjs packages/core/src/ipc-channels.test.mjs packages/orchestration/src/code-change-loop-service.test.mjs
npm run check
npm run test
npm run check --workspace @harness/orchestration
```

Completion evidence for Phase 1:

- The new test file is RED before implementation.
- The same test target is GREEN after implementation.
- TypeScript check passes.
- Full `npm run test` passes.

## Design Review

Accepted:

- Keep side effects approval-gated. The loop executes only approvals that are
  already approved by the existing approval model.
- Keep `RunnerService` as the actual side-effect owner. The new service
  orchestrates; it does not write files directly.
- Treat verification commands as approved shell/test actions. The loop does not
  execute raw commands.
- Keep the first implementation independent from UI and IPC to reduce blast
  radius.
- Persist loop results as artifacts instead of adding new database tables in
  Phase 1.

Rejected for Phase 1:

- Direct worker file writes. This would violate the existing approval boundary.
- Fully automatic repair worker invocation. It needs separate prompt contracts,
  attempt limits, and UI visibility.
- Parallel file application. It risks conflicting writes and unclear failure
  ownership.
- Diff/patch API replacement. Whole-file `after` writes are already supported
  and validated.

Open questions for later phases:

- Whether repair attempts need a dedicated SQLite table or artifact-only state
  remains enough.
- Whether verification should run all commands for complete evidence or stop on
  first failure for faster feedback.
- How much of the loop should be user-controllable from the Workbench UI.
