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

## 8. Phase G-2 Prompt Injection Review

### Evidence

- `WorkerRunner` now creates an `InternalAgentMessage` after each successful worker artifact is persisted.
- `WorkerRunner` passes the accumulated `handoffMessages` to `WorkerCliInvoker.invokeForWorker`.
- `AgentPlanningService.invokeForWorker` currently builds a worker prompt from only `taskRun`, `profile`, `userRequest`, and approved capability context.
- `buildSplitAgentPrompt` has no internal handoff section, so real CLI workers do not yet receive the upstream worker output even though the orchestration contract passes it.

### Design Decision

Phase G-2 injects handoff messages into the worker CLI prompt inside `packages/agent`.

The `@harness/agent` package must not import `@harness/orchestration`. The prompt builder will define a minimal structural handoff type with only the fields required for prompt rendering:

- `fromRole`
- `fromTitle`
- `content`
- `artifactId`
- optional `createdAt`

`InternalAgentMessage` from `packages/orchestration` is structurally compatible with this prompt type, so the existing `WorkerCliInvoker` seam can pass it without adding a package dependency cycle.

### Minimal Implementation Plan

1. Add RED coverage in `agent-prompt-builder.test.mjs` for an `INTERNAL AGENT HANDOFF` user-prompt section.
2. Add RED coverage in `agent-planning-service.test.mjs` proving `invokeForWorker` persists and sends the handoff section to the CLI adapter request.
3. Extend `PromptBuildInput` with optional `handoffMessages`.
4. Render a bounded handoff section before other optional context sections.
5. Extend `AgentPlanningService.invokeForWorker` input with optional `handoffMessages` and pass it to `buildSplitAgentPrompt`.

### Verification

Target commands:

```bash
node --import tsx --test --test-force-exit packages/agent/src/agent-prompt-builder.test.mjs packages/agent/src/agent-planning-service.test.mjs
npm run check
npm run test
npm run build
```

Expected outcome:

- downstream local CLI workers receive prior worker outputs as bounded prompt context
- prompt artifacts expose the same handoff context for operator review
- no new IPC, DB, localhost, companion, or external A2A surface is introduced
- approval gating and worker side-effect policy remain unchanged

## 9. Phase G-3 UI Visibility Review

### Evidence

- `TaskRunDetail` already returns `artifacts` and `agentInvocations` to the renderer.
- `RightPanel` already has an `Agent` tab that displays worker invocations through `AgentPanel`.
- Phase G-2 persists the actual worker prompt artifact as `Worker prompt — {profileName}`.
- That prompt artifact contains the exact `INTERNAL AGENT HANDOFF` section sent to the downstream CLI worker.

### Design Decision

Phase G-3 surfaces internal handoffs in the existing `Agent` tab by deriving them from prompt artifact summaries.

This phase intentionally does not add:

- a SQLite `agent_messages` table
- a new IPC contract
- a background server or localhost transport
- a new orchestration runtime path

The UI should show what was actually injected into each downstream worker prompt, not merely what the runner intended to pass. This keeps the operator view tied to persisted evidence.

### Minimal Implementation Plan

1. Add a pure renderer utility that extracts handoff deliveries from `Artifact[]`.
2. Add RED tests for:
   - prompt artifact with one handoff message
   - prompt artifact with multiple handoff messages
   - prompt artifact without a handoff section being ignored
3. Add a compact, collapsible `InternalHandoffPanel` to `AgentPanel`.
4. Pass `state.detail.artifacts` from `RightPanel` into `AgentPanel`.
5. Style the panel as an inline operational section, not a nested card.

### Verification

Target commands:

```bash
node --import tsx --test --test-force-exit apps/desktop/src/screens/workbench/agent-handoff-display.test.mjs
npm run check
npm run test
npm run build
```

Expected outcome:

- the Agent tab shows `fromRole: fromTitle -> target worker` handoff routes
- each route can be collapsed and expanded
- source artifact id, created time, and bounded content preview are visible
- no database, IPC, approval, or worker execution behavior changes
