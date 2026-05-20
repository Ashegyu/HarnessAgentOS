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

## 10. Phase G-4 Bounded Handoff Context Policy

### Evidence

- `WorkerRunner` keeps two runtime handoff collections:
  - `handoffMessages`: successful worker outputs accumulated during the run.
  - `handoffsByStepId`: the latest successful handoff keyed by worker step id.
- `resolveHandoffsForStep()` currently has two behaviors:
  - if `WorkerStep.dependsOn` is missing, it returns all prior
    `handoffMessages`
  - if `WorkerStep.dependsOn` is present, it recursively visits every ancestor
    dependency before returning handoffs
- `worker-wave-planner.ts` treats missing `dependsOn` as a legacy linear
  dependency on the previous step only.
- `createInternalAgentMessage()` truncates each stored handoff body to 12,000
  characters.
- `formatInternalHandoffMessages()` renders the last six visible handoffs and
  slices each rendered message body to 6,000 characters.
- `buildSplitAgentPrompt()` applies an 80 KB combined prompt hard cap.

### Problem

The current implementation is bounded by character caps, but it can still carry
too much context semantically.

For a linear pipeline such as:

```text
planner -> coder -> reviewer -> tester
```

the last worker can receive multiple prior raw worker outputs. If the coder also
summarizes the planner output, the reviewer/tester can see both the original
planner handoff and the coder's repeated summary of it. The bytes are bounded,
but the prompt can still accumulate stale assumptions, duplicated decisions, and
irrelevant intermediate details.

This is acceptable for short early pipelines, but it is not the right default for
longer chains or future A2A refinement/backflow. Handoff must be explicit,
bounded, and dependency-shaped rather than "everything seen so far".

### Design Decision

Use **direct dependency handoff by default**.

Rules:

1. A worker receives handoff messages only from its direct `dependsOn` step ids.
2. `dependsOn: []` means no upstream handoff.
3. Missing `dependsOn` preserves legacy linear ordering by resolving to the
   immediately previous worker step only, matching `worker-wave-planner.ts`.
4. Transitive context is allowed only when the plan explicitly lists every
   needed upstream step in `dependsOn`.
5. Raw handoff body remains bounded, but the preferred long-term handoff payload
   is a summary contract, not full worker output.

This keeps the plan graph as the source of truth. If the planner wants `tester`
to see both `planner` and `coder`, it must write:

```json
{ "id": "tester", "dependsOn": ["planner", "coder"] }
```

It should not get `planner` implicitly through transitive recursion from
`coder`.

### Prompt Contract

Handoff prompt content should move toward a compact structure:

```text
INTERNAL AGENT HANDOFF

### planner: Plan
- artifact: art_...
- decision: ...
- assumptions: ...
- risks: ...
- requested_next_action: ...
```

The first implementation can continue using existing worker output, but the
prompt builder should label the section as context only and should prefer
structured summaries when they become available.

### Minimal Implementation Plan

1. Add RED coverage in `worker-runner.test.mjs` for the handoff dependency
   contract:
   - four-step legacy chain `plan -> code -> review -> test`
   - explicit `dependsOn: []` independent step
   - explicit multi-dependency step such as `dependsOn: ["plan", "code"]`
   - fan-out steps that both depend on `plan`
2. Add or extract a pure helper that computes effective handoff dependency ids
   from the immutable `OrchestrationPlan.workerSteps` order:
   - if `dependsOn` is present, return that array as direct dependencies
   - if `dependsOn` is missing, return only the immediately previous step id
   - if the step is first, return `[]`
3. Update `WorkerRunner` to use that helper before calling
   `resolveHandoffsForStep()`. Do not infer "previous step" from accumulated
   runtime `handoffMessages`; use the approved plan snapshot order.
4. Update `resolveHandoffsForStep()` so it maps the computed direct dependency
   ids to `handoffsByStepId` only. Remove recursive ancestor traversal from the
   default path.
5. Add prompt-builder coverage that the handoff section remains within the
   existing prompt hard cap.
6. Run focused tests, then `npm run check`, then the full verification set.

No new DB table, IPC namespace, server, renderer network path, or approval path
is required for this phase.

### Verification

Target commands:

```bash
node --import tsx --test --test-force-exit packages/orchestration/src/worker-runner.test.mjs packages/agent/src/agent-prompt-builder.test.mjs
npm run check
npm run test
npm run build
```

Expected outcome:

- direct dependencies still pass useful handoff context
- explicitly independent workers receive no handoff
- long linear chains do not implicitly accumulate all prior raw outputs
- prompt size caps remain intact
- approval gating and worker side-effect policy remain unchanged

### Design Review and Corrections

Review pass: 2026-05-20.

Findings and applied corrections:

1. The first handoff implementation optimized for context availability, but did
   not define a default scope. This section now makes direct dependency handoff
   the default.
2. `worker-wave-planner.ts` already treats missing `dependsOn` as previous-step
   linear dependency, while `resolveHandoffsForStep()` currently returns all
   prior handoffs in that case. The design now requires those semantics to be
   aligned.
3. Recursive ancestor traversal makes prompt growth hard to reason about. The
   design now requires transitive context to be explicit in `dependsOn`.
4. The existing character caps prevent unbounded byte growth but not duplicated
   meaning. The design now calls out structured handoff summaries as the next
   improvement after direct-only delivery.
5. Procedural review found an implementation-order issue: the original plan
   jumped straight from tests to editing `resolveHandoffsForStep()`, but that
   function does not receive enough ordered plan context to compute "immediate
   previous step" safely. The plan now adds a pure effective-dependency helper
   first and requires `WorkerRunner` to use the immutable approved plan snapshot
   order.
6. Procedural review also clarified compatibility risk: old plans without
   `dependsOn` currently receive all prior runtime handoffs, but the corrected
   behavior intentionally changes them to previous-step-only to align with
   `worker-wave-planner.ts`. The regression tests must make that behavior change
   explicit.
