# Direct Harness Orchestration

## Purpose

This design adds a question-time harness execution path without requiring the
user to save an `AgentPipeline` template first.

The goal is not to replace existing pipeline templates. The goal is to support
both workflows:

- reusable path: `HarnessDefinition -> AgentPipeline template -> question`
- direct path: `HarnessDefinition -> question -> OrchestrationPlan`

Both paths must keep the existing HarnessAgentOS safety model:

- `TaskRun` remains the canonical execution unit
- `orchestration_plan` approval remains the execution gate
- worker side effects still become downstream approvals
- SQLite WAL remains the source of truth
- package import/export remains declaration-only

## Current State

Current question-time routing is pipeline-based:

```text
ConversationInput Pipeline dropdown
-> WorkbenchShell.handleCreateTask
-> conversation.createTask
-> orchestration.draftPlan({ pipelineId })
-> OrchestrationPlanner.synthesizeFromPipeline
-> WorkerRunner.runApproved
```

Harness package import currently supports this reviewed path:

```text
Harness package directory
-> HarnessDefinition snapshot
-> AgentProfile bindings
-> convertHarnessWorkflowToPipelineDraft
-> save AgentPipeline template
-> question-time Pipeline dropdown
```

This means a user can already use `.claude`/Codex package declarations, but
must first materialize a pipeline template.

## Proposed Direct Path

Add a direct harness draft source to `OrchestrationDraftInput`:

```ts
interface OrchestrationDraftInput {
  taskRunId: string;
  mode: OrchestrationMode;
  instruction?: string;
  pipelineId?: string;
  harness?: {
    packageId: string;
    workflowId?: string;
    bindingSetId: string;
  };
}
```

Precedence:

1. `harness` source
2. `pipelineId` source
3. legacy mode synthesizer

The direct harness source is expanded by the planner:

```text
load HarnessDefinition from state.harnessPackages
-> assess binding/readiness enough to reject missing bindings
-> convertHarnessWorkflowToPipelineDraft
-> synthesize WorkerStep[] from the in-memory CreateAgentPipelineInput
-> create orchestration_plan artifact/checkpoint/approval
```

No `AgentPipeline` row is created.

## Data Model

`OrchestrationPlan` should preserve direct harness provenance separately from
`sourcePipelineId`:

```ts
interface OrchestrationPlan {
  sourcePipelineId?: string;
  sourceHarness?: {
    packageId: string;
    packageName: string;
    workflowId: string;
    workflowName: string;
    bindingSetId: string;
    bindingSetName: string;
  };
}
```

The immutable plan still carries full per-step provenance in
`WorkerStep.source`, which already supports `kind: "harness_package"`.

## UI Model

Question input should expose a second opt-in selector when orchestration is
enabled:

```text
Run with:
  (none - normal chat)
  Pipeline: <saved pipeline>
  Harness: <package / workflow>
```

Minimal usable slice:

- keep the existing Pipeline dropdown
- add a Harness dropdown next to it or below it
- selecting Harness clears Pipeline for that message
- selecting Pipeline clears Harness for that message
- only packages with at least one workflow are listed
- direct Harness submission sends package id, workflow id, and a persisted
  binding set id

Direct question use cannot depend on the Harnesses tab's transient dropdown
state. A binding selected during package review must be saved to SQLite before it
can be used from the question composer.

## Binding Persistence

Add a small persisted binding set model:

```ts
interface HarnessBindingSet {
  id: string;
  packageId: string;
  workflowId: string;
  name: string;
  bindings: readonly HarnessAgentProfileBinding[];
  createdAt: string;
  updatedAt: string;
}
```

Rules:

- A binding set belongs to one package snapshot and one workflow.
- Saving a binding set validates the package and workflow exist.
- It also runs binding readiness and rejects error-level issues.
- It does not copy package content or create an `AgentPipeline`.
- Direct orchestration uses `bindingSetId`, not ad-hoc bindings from renderer
  memory.

## IPC Contract

`orchestration.draftPlan` accepts optional `harness` input and validates:

- `harness.packageId` is a non-empty string
- `harness.workflowId`, when present, is a non-empty string
- `harness.bindingSetId` is a non-empty string
- `pipelineId` and `harness` are mutually exclusive

Invalid input returns `STATE_INVALID_INPUT`.

Unknown package/workflow/binding-set or stale binding profile references return
an orchestration error and block the `TaskRun` through the existing diagnostic
path in `OrchestrationService.draftPlan`.

## Safety Review

This design intentionally does not:

- run package source directly
- execute `.claude`/`AGENTS.md` instructions outside the worker prompt path
- write files during preview or draft
- create hidden provider probes
- bypass approval policy
- bypass per-worker allowed action gates

The direct path only changes where worker steps are synthesized from. Execution
still goes through the same `WorkerRunner`.

## Implementation Phases

### Phase 1: Planner Contract

- Add `HarnessBindingSet` core/storage model.
- Add `harness` input type using `bindingSetId`.
- Add tests proving direct harness draft creates worker steps without creating
  an `AgentPipeline` row.
- Refactor pipeline synthesis so both saved pipeline and in-memory harness
  pipeline draft use the same `CreateAgentPipelineInput -> WorkerStep[]`
  mapping.

### Phase 2: IPC Contract

- Extend `orchestration.draftPlan` IPC validation.
- Add harness binding-set IPC for list/save/remove.
- Add tests for valid harness payload, unknown binding set, malformed input, and
  mutual exclusion with `pipelineId`.

### Phase 3: UI Entry

- Add "Save Binding Set" in the Harnesses tab after readiness passes.
- Add a direct Harness selector to the question input.
- Pass selected package/workflow/binding-set id to
  `WorkbenchShell.handleCreateTask`.
- Auto-run behavior can match per-message pipeline selection, because selecting
  a direct harness for the message is the user opt-in.

### Phase 4: Polish

- Consider a compact binding-set editor in the question composer only after the
  saved binding set workflow is stable.
- Consider default binding set selection per package/workflow.

## Verification

Required checks:

```powershell
node --import tsx --test --test-force-exit packages/storage/src/repositories/harness-binding-set-repository.test.mjs packages/storage/src/migrations.test.mjs packages/orchestration/src/orchestration-planner.test.mjs
node --import tsx --test --test-force-exit packages/core/src/ipc-channels.test.mjs packages/core/src/ipc-contracts-surface.test.mjs apps/desktop/electron/ipc/harness-package-ipc.test.mjs apps/desktop/electron/ipc/orchestration-ipc.test.mjs apps/desktop/src/screens/workbench/pipeline-auto-approval.test.mjs
npm run check
npm run test
npm run build
git diff --check
```

Manual smoke:

1. Import `harness-100/en/01-youtube-production`.
2. Bind all abstract agents to local `AgentProfile` rows.
3. Save a binding set for the workflow.
4. Ask a question with direct Harness selected.
5. Confirm an `orchestration_plan` artifact is created without an
   `AgentPipeline` template row.
6. Confirm worker execution still requires/records approvals as before.

## Design Review

- Evidence: current question routing accepts only per-message `pipelineId`.
- Evidence: current Harnesses tab binding dropdown state is React-local and not
  stored in SQLite.
- Inference: direct question use cannot be reliable without persisted binding
  sets because leaving the tab or restarting the app would lose the agent
  mapping.
- Decision: persist binding sets before adding question-composer direct harness
  selection.

## Implementation Notes

Implemented in this slice:

- `HarnessBindingSet` core/storage model and SQLite `harness_binding_sets`
  table (`SCHEMA_VERSION = 35`).
- `harnessPackages.listBindingSets/getBindingSet/saveBindingSet/removeBindingSet`
  IPC surface.
- `orchestration.draftPlan({ harness })` direct source.
- Testable orchestration IPC handlers covering harness payload validation,
  `pipelineId` mutual exclusion, and planner error propagation.
- Shared pipeline-like synthesis for saved `AgentPipeline` rows and in-memory
  harness workflow drafts.
- Question composer direct Harness selector backed only by saved binding sets.
- Harnesses tab `Save Binding Set` action after readiness checks.
- Plan provenance via `OrchestrationPlan.sourceHarness` and per-step
  `WorkerStep.source`.
