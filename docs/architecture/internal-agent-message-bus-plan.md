# Internal Agent Message Bus Plan

Date: 2026-05-15

## 1. Scope

This plan covers internal communication between Harness-created agents in one local HarnessAgentOS run.

It does not cover:

- connecting to another Harness instance
- exposing a localhost/public server
- companion startup scripts
- external A2A Inspector/TCK validation
- bypassing approval for file/shell/git/dependency/network actions

## 2. Current Evidence

- `packages/orchestration/src/orchestration-planner.ts` creates an ordered `OrchestrationPlan.workerSteps` snapshot.
- `packages/orchestration/src/worker-runner.ts` executes worker steps sequentially.
- Each worker output is already persisted as a `log` artifact.
- Worker proposed side effects are converted to pending approvals, not executed directly.
- Remote A2A endpoint routing is optional via `WorkerStep.remoteEndpointId`, but the user's current target is local internal agent communication.

## 3. Problem

Sequential workers currently share the same task instruction, but later workers do not receive a structured summary of previous workers' outputs. This weakens planner -> coder -> reviewer -> tester workflows because the downstream agent has to infer context from the original request rather than from the preceding internal agent's actual result.

## 4. Design

Introduce a small internal message bus inside `packages/orchestration`.

The first implementation is intentionally in-memory and run-local:

- no DB schema migration
- no IPC surface
- no renderer network access
- no companion/server involvement
- no new action execution path

The bus records a bounded handoff envelope after each worker step:

```ts
interface InternalAgentMessage {
  id: string;
  taskRunId: string;
  planId: string;
  fromStepId: string;
  fromRole: WorkerRole;
  fromTitle: string;
  toStepId?: string;
  content: string;
  artifactId: string;
  createdAt: string;
}
```

Before each downstream worker is invoked, the runner passes the prior messages as `handoffMessages` to the `WorkerCliInvoker`.

The invoker remains side-effect-free. It may use handoff messages as context, but any proposed file/shell/git action must still return through `proposedActions` and become approval rows.

## 5. Minimal Implementation

1. Add `internal-agent-bus.ts` in `packages/orchestration/src`.
2. Add tests for:
   - message envelope creation from worker output
   - bounded text truncation
   - downstream worker receives prior handoff messages
   - failed worker output is not passed to downstream steps because the runner stops on failure
3. Extend `WorkerCliInvoker.invokeForWorker` input with optional `handoffMessages`.
4. Update `WorkerRunner` to append a message after a successful worker artifact is persisted.
5. Export the bus types from `packages/orchestration/src/index.ts`.

## 6. Persistence Policy

The first phase does not add a new SQLite table. The durable source remains the existing worker output artifacts. The bus is a runtime delivery helper that converts already-persisted artifact output into downstream context.

If UI needs a dedicated conversation view later, add a migration-backed `agent_messages` table in a separate phase.

## 7. Verification

Target commands:

```bash
node --import tsx --test --test-force-exit packages/orchestration/src/internal-agent-bus.test.mjs packages/orchestration/src/worker-runner.test.mjs
npm run check
npm run test
npm run build
```

Expected outcome:

- downstream local agents receive bounded handoff context
- existing approval gating remains unchanged
- existing A2A remote routing tests remain green
