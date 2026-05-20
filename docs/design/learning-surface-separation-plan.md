# Learning Surface Separation Plan

## Scope

This plan separates task-run context tools from workspace learning and knowledge management surfaces.

The current right context drawer is only available after a `TaskRun` is selected. That is correct for task-run artifacts, approvals, quality, cost, and per-run recommendations, but it hides global/project learning surfaces that should be inspectable before any task exists.

## Current Evidence

- `RightPanel` renders tab content only when `taskRunDetail.state.kind === "ready"`; otherwise it shows the `TaskRun` placeholder.
- `SlimRail` disables the context drawer button when no `TaskRun` is selected.
- `InstinctPanel` does not receive a `TaskRun`; it calls `window.harness.instinct.listCandidates({})` and `window.harness.instinct.list({ includeDisabled })`.
- `CapabilityPanel` has mixed responsibilities:
  - catalog operations: `capability.list()`, `capability.refresh()`, `readSkill()`
  - task-run operations: `capability.suggest({ taskRunId, prompt })`, `proposeCandidates({ taskRunId, prompt })`, `proposeScriptRun({ taskRunId, ... })`
- `LearnerPanel` is task-run scoped: `recommend({ taskRunId })`, `getTrace({ taskRunId })`, `proposeRecommendation({ taskRunId })`.
- `SkillSourcesTab` already owns skill source and generation management, but it is only reachable through the Settings modal.

## Design Goal

Add a task-run independent `Learning` surface reachable from the left rail.

The right context drawer remains selected-TaskRun-only. The new Learning surface owns review and management of reusable learning assets.

## Surface Split

| Surface | Belongs In Right Context Drawer | Belongs In Learning Surface |
| --- | --- | --- |
| Skill suggestions for current prompt | Yes | No |
| Skill candidate approval for current TaskRun | Yes | No |
| Skill source management | No | Yes |
| Skill catalog and rescan | No | Yes |
| Instinct candidate review | No | Yes |
| Active/disabled Instinct review | No | Yes |
| Learner recommendation for current TaskRun | Yes | No |
| Current TaskRun trace | Yes | No |
| Learner budget/trace overview | No | Later |

## Minimal Implementation

1. Introduce `LearningPanel` in `apps/desktop/src/screens/workbench/LearningPanel.tsx`.
2. Add `learningOpen` state to `WorkbenchShell`.
3. Add a `Learning` button to `SlimRail`; it must not depend on selected `TaskRun`.
4. Render `LearningPanel` as a full-screen overlay using the existing Settings modal layout patterns, with tabs:
   - `Instincts`: render the existing `InstinctPanel`.
   - `Skills`: render the existing `SkillSourcesTab`.
5. Remove the `Instinct` tab from `RightPanel`.
6. Keep `CapabilityPanel` and `LearnerPanel` under the right drawer because their recommendation actions need a selected `TaskRun`.
7. Leave Settings `Skills` tab in place for now to avoid disrupting existing settings workflows.

## Out Of Scope

- No schema changes.
- No IPC changes.
- No new learner history API.
- No migration of existing Instinct data.
- No change to capability recommendation semantics.
- No change to approval policy.

## Design Review

### Correctness

- The new panel reuses existing IPC calls and components, so it does not alter learning behavior.
- `InstinctPanel` is safe to move because it is already independent from `TaskRun`.
- `SkillSourcesTab` is safe to reuse because it already handles its own data loading and mutation through existing IPC.

### UX Risk

- If the right `Instinct` tab remains, users will see duplicate entry points. Remove it from the right drawer.
- If Skills is removed from Settings immediately, users who expect it under Settings lose a known path. Keep both entry points for this pass.
- If Learning opens as another drawer, the four-column grid becomes cramped. Use an overlay/modal pattern like Settings for this pass.

### Implementation Risk

- Lowest-risk implementation is UI-only: new component, rail state, and tab list cleanup.
- `CapabilityPanel` should not be split in this pass because script-run proposal needs selected `TaskRun`; splitting it now would expand the change.
- `LearnerPanel` should not be moved in this pass because current APIs are task-run keyed.

## Verification Plan

- Run focused source tests for workbench navigation expectations.
- Run `npm run check`.
- If native module state allows it, run targeted desktop/workbench tests.
- Manual UI check:
  - Learning rail button opens without selecting a thread or TaskRun.
  - Learning `Instincts` tab loads candidates and active instincts.
  - Learning `Skills` tab shows skill sources.
  - Right context drawer no longer shows `Instinct`.
  - Right context drawer still shows `Capabilities` and `Learner` after selecting a TaskRun.
