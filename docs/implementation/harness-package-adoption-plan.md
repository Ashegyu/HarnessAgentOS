# Harness Package Adoption Plan

Date: 2026-05-27
Status: Draft

## 1. Goal

Adopt Claude-compatible and Codex-compatible document-based harness packages in
HarnessAgentOS without breaking the existing user-supervised runtime model.

The target is:

```text
Claude-compatible
Codex-compatible
Harness-native internally
```

The first implementation must be read-only import and inspection. Execution
comes only after validation, user binding, draft conversion, and approval.

## 2. Current Baseline

The project already has several pieces that should be reused:

- `AgentProfile` supports `provider = "auto" | "claude" | "codex"`.
- `SkillSource` models trusted and untrusted skill roots.
- `AgentPipeline` models reusable worker-step templates.
- `OrchestrationPlanner` converts `AgentPipeline` into an immutable
  `OrchestrationPlan`.
- `WorkerRunner` executes approved worker plans and persists artifacts.
- `harness_worker_handoff_v1` normalizes worker outputs.
- A2A remote workers are optional outbound endpoints, not local orchestration.
- Pipeline backflow is a bounded local retry route, not A2A refinement.
- SQLite WAL remains canonical state.

The adoption work should extend these seams instead of replacing them.

## 3. Workstream Boundaries

| Workstream | Responsibility |
|---|---|
| Core model | Neutral `HarnessDefinition` types and validators |
| Source adapters | Read `.claude`, Codex skill roots, and native `.harness` packages |
| Storage | Persist import snapshots and diagnostics when needed |
| Conversion | Produce user-reviewable `AgentPipeline` or TaskRun drafts |
| UI | Import/inspect/bind/convert flow |
| Execution | Reuse approved orchestration runner |
| Verification | Contract tests, sample imports, and runtime no-regression checks |

## 4. Phase 0: Design Lock

### Scope

- Add architecture and contract documents.
- Confirm terminology:
  - source package
  - canonical harness definition
  - runtime draft
  - execution adapter
  - provider binding
- Confirm that `AgentPipeline` is a conversion target, not the package standard.

### Deliverables

- `docs/architecture/vendor-neutral-harness-orchestration.md`
- `docs/contracts/harness-package-format.md`
- `docs/implementation/harness-package-adoption-plan.md`
- `docs/architecture/README.md` index update

### Exit Criteria

- The design separates Claude source format, Codex source format, and
  Harness-native internal model.
- The design preserves existing Approval, Artifact, QualityGate, A2A, and
  backflow boundaries.
- No runtime code changes are introduced in this phase.

## 5. Phase 1: Core Type Skeleton

### Scope

Add neutral type definitions only.

Candidate files:

```text
packages/core/src/types/harness-package.ts
packages/core/src/types/harness-package.test.mjs
```

### Implementation Notes

- Keep `packages/core` pure. It must not import `@harness/storage`.
- Define type guards for:
  - `HarnessSourceFormat`
  - `HarnessValidationStatus`
  - `HarnessDefinition`
  - `HarnessAgentDefinition`
  - `HarnessSkillDefinition`
  - `HarnessWorkflowDefinition`
  - `HarnessWorkflowStep`
  - `HarnessArtifactContract`
  - `HarnessFailurePolicy`
- Export from `packages/core/src/types/index.ts`.

### Tests

- Accept minimal valid definition.
- Reject unknown source format.
- Reject duplicate ids if validator owns cross-field checks.
- Reject invalid validation status.
- Reject invalid action types or output contracts.

### Exit Criteria

- Type guards pass targeted tests.
- `npm run check` passes.
- No import, UI, or runtime behavior changes yet.

## 6. Phase 2: Read-Only Source Adapter Prototype

### Scope

Implement source detection and minimal read-only parse.

Candidate files:

```text
packages/orchestration/src/harness-source-detection.ts
packages/orchestration/src/harness-claude-adapter.ts
packages/orchestration/src/harness-codex-adapter.ts
packages/orchestration/src/harness-native-adapter.ts
packages/orchestration/src/harness-import.ts
packages/orchestration/src/harness-import.test.mjs
```

### Adapter Minimum Behavior

Claude-compatible:

- detect `.claude/CLAUDE.md`
- detect `.claude/skills/*/skill.md`
- detect `.claude/agents/*.md`
- parse skill frontmatter `name` and `description`
- import agent file text as abstract persona
- emit warnings for missing workflow table

Codex-compatible:

- detect `AGENTS.md`
- detect `skills/*/SKILL.md`
- parse skill frontmatter `name` and `description`
- preserve AGENTS constraints as package policy text
- emit warnings for absent explicit workflow sections

Harness-native:

- detect `.harness/HARNESS.md`
- detect `.harness/skills/*/SKILL.md`
- optionally read `.harness/manifest.json` as declaration input only

### Safety Rules

- No script execution.
- No shell execution.
- No package mutation.
- No TaskRun creation.
- No approval creation.
- No worker invocation.

### Tests

- Create fixture directories under test fixtures.
- Import each supported shape.
- Assert diagnostics for missing/ambiguous sections.
- Assert source format classification.
- Assert raw file paths are relative.

### Exit Criteria

- Read-only adapters produce `HarnessDefinition` with diagnostics.
- Ambiguous workflows are marked `needs_review`.
- `npm run check` passes.

## 7. Phase 3: Import Snapshot Persistence

### Scope

Persist imported package declarations and diagnostics, not runtime state.

Candidate storage model:

```text
harness_packages
harness_package_files
harness_package_diagnostics
```

Possible fields:

```sql
CREATE TABLE IF NOT EXISTS harness_packages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_format TEXT NOT NULL,
  root_dir TEXT NOT NULL,
  validation_status TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Notes:

- JSON columns must use `_json` suffix if implemented. The example above should
  become `definition_json`.
- Source files remain declarations.
- Runtime state still lives in existing TaskRun tables.

### Tests

- Migration is idempotent.
- Persist and reload a package definition.
- Persist diagnostics.
- Delete package does not delete TaskRun history unless explicitly designed.

### Exit Criteria

- Import snapshots survive app restart.
- No source package file is mutated.
- Existing storage tests pass.

## 8. Phase 4: Inspect UI

### Scope

Add a read-only UI for imported harness packages.

Candidate surfaces:

- Settings or Agents area: package sources and imports
- Workbench context drawer: package inspection tab later if needed

Required UI sections:

- package name and source format
- root path
- validation status
- overview summary
- skills and trigger terms
- agents and role hints
- workflows and modes
- dependency graph or step list
- artifact contracts
- capability requirements
- diagnostics

### UX Rules

- Do not show this as a pipeline builder first.
- Use "Harness package" and "Agent team harness" language.
- Make unsupported/ambiguous parse results visible.
- Do not offer Run until conversion and binding exist.

### Tests

- Pure renderer tests for status rendering.
- Diagnostics are grouped by severity.
- No run button for `needs_review` or `unsupported`.

### Exit Criteria

- User can inspect `.claude`, Codex, and native packages.
- UI makes it clear that import is not execution.
- Existing workbench flows still pass.

## 9. Phase 5: Workflow Validation and Manual Repair

### Scope

Make imported workflows reviewable and repairable before conversion.

Features:

- edit inferred step titles
- resolve missing agent references
- edit dependency edges
- mark artifact contracts required/optional
- choose failure policy for ambiguous retry prose
- choose provider binding strategy

### Rules

- Manual repair creates a HarnessAgentOS-owned definition snapshot.
- It does not edit the source package unless a separate export action is later
  approved.
- Repairs must be audit-visible.

### Tests

- Cannot mark dependency cycle as valid.
- Cannot execute missing agent binding.
- Can resolve `needs_review` to `valid_with_warnings`.

### Exit Criteria

- Ambiguous imported packages can become executable only through explicit user
  repair.
- The original source snapshot remains inspectable.

## 10. Phase 6: AgentProfile Binding

### Scope

Bind abstract `HarnessAgentDefinition` entries to local `AgentProfile` rows.

Options:

- map to existing profile
- create profile draft
- use default profile with role override
- choose provider `auto`, `claude`, or `codex`
- optionally choose remote A2A endpoint for a step

### Rules

- Imported permissions are suggestions only.
- Tool/MCP/skill requirements must pass profile validation.
- High-risk capability requirements require visible warning.
- Binding to remote A2A does not grant local side-effect capability.

### Tests

- Existing profile mapping preserves provider.
- New profile draft validates permissions.
- Missing required capability blocks conversion or marks warning according to
  required flag.
- Provider unavailable is detected before execution if possible.

### Exit Criteria

- Every runnable workflow step has a concrete profile binding or approved
  fallback.
- Provider choice is visible before creating an execution draft.

## 11. Phase 7: Convert to AgentPipeline Draft

### Scope

Convert validated and bound workflows to existing `AgentPipeline` drafts.

Why `AgentPipeline` first:

- It already maps to `OrchestrationPlan`.
- It already supports dependencies, allowed actions, output contracts, and A2A
  endpoint overrides.
- It gives the user an editable template before execution.

### Conversion Rules

- Preserve full source instruction text in `AgentPipelineStep.instruction`.
- Preserve dependency edges.
- Preserve expected artifacts.
- Preserve allowed actions as approved policy candidates.
- Do not create an approved `OrchestrationPlan`.
- Store source package id on the draft if a field is added later.

### Tests

- Claude sample converts to pipeline draft.
- Codex sample converts to pipeline draft after missing fields are repaired.
- Dependency cycles are rejected.
- Missing profile binding blocks conversion.

### Exit Criteria

- User can create a pipeline draft from an imported package.
- User can inspect and edit it before any run.

## 12. Phase 8: Approved Execution Through Existing Runtime

### Scope

Run a converted pipeline only through current approval-based orchestration.

Flow:

```text
Imported package
  -> validated HarnessDefinition
  -> bound AgentPipeline draft
  -> OrchestrationPlanner.draftPlan
  -> orchestration_plan artifact
  -> before_orchestration checkpoint
  -> approval pending
  -> user approves
  -> WorkerRunner.runApproved
  -> artifacts and structured handoffs
  -> quality gate
```

### Rules

- No direct execution from import screen.
- No source package mutation.
- No side effect outside approval.
- No provider-native hidden done state.

### Tests

- Converted pipeline creates an orchestration approval.
- Worker proposed file write becomes pending approval.
- Structured handoff is generated or synthesized.
- Quality gate remains required before done.

### Exit Criteria

- A validated sample can run through the existing `TaskRun` lifecycle.
- The run is indistinguishable from other approved orchestration runs in state
  and audit surfaces, except for source package metadata.

## 13. Phase 9: Backflow and Failure Policy Mapping

### Scope

Map explicit package failure policies to existing bounded mechanisms.

Rules:

- `step_failed` with a clear target and retry step may map to
  `AgentPipelineBackflowRule`.
- `quality_failed` may map to existing quality backflow only with a clear target
  and bounded attempts.
- ambiguous retry prose remains manual review.
- remote A2A refinement is not local pipeline backflow.

### Tests

- Valid backflow maps to pipeline rule.
- Target not ancestor of retry step is rejected.
- Unbounded retry is rejected.
- A2A remote retry stays separate from local backflow.

### Exit Criteria

- Failure policy mapping is explicit, bounded, and visible.

## 14. Phase 10: Export and Compatibility Projections

### Scope

Export Harness-native packages and optional Claude/Codex projections.

Export targets:

- `.harness/`
- `.claude/`
- Codex `skills/*/SKILL.md` plus `AGENTS.md` fragment

Rules:

- Do not export secrets.
- Do not export TaskRun state unless user chooses a separate evidence bundle.
- Do not export approvals.
- Include compatibility warnings when projections lose information.
- The first implementation slice is preview-only: return projected files and
  warnings over IPC, but do not write source/export files until a separate
  approval-gated file_write flow is added.
- The second slice turns a reviewed export preview into pending `file_write`
  approvals under a user-selected target directory; the harness package IPC
  still never writes files directly.

### Tests

- Export native package and re-import it.
- Export Claude projection and re-import it.
- Export Codex projection and re-import it.
- Confirm no secrets or runtime state are present.

### Exit Criteria

- HarnessAgentOS can round-trip its native declaration format.
- Claude and Codex exports are compatibility projections, not canonical state.

## 15. Verification Strategy

### Targeted correctness tests

```bash
node --import tsx --test --test-force-exit packages/core/src/types/harness-package.test.mjs
node --import tsx --test --test-force-exit packages/orchestration/src/harness-import.test.mjs
node --import tsx --test --test-force-exit packages/storage/src/repositories/harness-package-repository.test.mjs
```

### Integration checks

```bash
npm run check
npm run test
npm run build
```

### Manual sample checks

Use two source samples:

- `harness-100/ko/01-youtube-production`
- `harness-100/ko/29-performance-optimizer`

For each:

1. Import package.
2. Inspect diagnostics.
3. Repair ambiguous fields if needed.
4. Bind agents to Claude/Codex profiles.
5. Convert to `AgentPipeline` draft.
6. Draft orchestration plan.
7. Confirm approval is required before execution.
8. Run only after approval.
9. Confirm artifacts and handoffs are visible.
10. Confirm quality gate behavior remains unchanged.

## 16. Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| Treating `.claude` as canonical | Locks architecture to Claude-specific conventions | Keep `HarnessDefinition` as internal model |
| Treating Codex `SKILL.md` as canonical | Makes Claude import lossy and provider-specific | Use Codex adapter only at source boundary |
| Overconfident Markdown parsing | Unsafe or wrong execution order | Use `needs_review` for ambiguous dependencies |
| Hidden provider side effects | Approval model bypass | All side effects become Harness approvals |
| AgentPipeline model overload | Existing runtime template becomes source package model | Keep source package fields in separate types |
| Unbounded retry loops | Latency and cost instability | Require maxAttempts and dependency validation |
| UI mislabels feature as pipeline builder | User expects code-defined pipelines, not document harnesses | Use package/import/agent-team language |
| Runtime state leaks into export | Secrets or audit data exposure | Export declarations only by default |

## 17. Recommended First Implementation Slice

The safest first slice is:

1. Add `HarnessDefinition` core types and tests.
2. Add read-only source detection.
3. Add Claude-compatible adapter for package overview, agents, and skill
   frontmatter only.
4. Add diagnostics that intentionally mark workflow execution as `needs_review`
   until dependency parsing exists.
5. Add a small CLI or service-level test fixture. Do not add UI yet.

This proves the source-boundary design without changing runtime execution.

## 18. Current Implementation Checkpoint

Date: 2026-05-27

### 18.1 Evidence

The current branch has moved beyond the first slice while preserving the same
source-boundary rules:

- Neutral `HarnessDefinition` types and validators exist in `packages/core`.
- Source format detection recognizes Claude-compatible, Codex-compatible, and
  Harness-native markers without treating any one layout as canonical.
- Directory import is read-only and scans bounded Markdown/JSON inputs only.
- Imported package snapshots are persisted as declarations, not runtime state.
- The desktop Harnesses tab can import, list, inspect, remove, bind profiles,
  preview a pipeline draft, and save a reviewed pipeline template.
- Harness workflow tables are parsed into reviewable workflow steps with
  dependency, owner, artifact, and Korean/English column alias handling.
- The `harness-100` sample directory is covered by parser regression tests.
- Manual repair is now exposed in the Harnesses tab: a user can edit inferred
  workflow step titles, owners, role hints, dependencies, artifact hints,
  output contracts, and instruction text, then save the result as a new
  HarnessAgentOS-owned package snapshot.
- The manual repair UI calls `harnessPackages.repair`; it does not mutate the
  source package directory or introduce a direct run/apply/export action.
- Repaired snapshots preserve source provenance and may share the original
  `root_dir`; the original imported snapshot remains inspectable.
- Binding readiness is now a reusable orchestration contract rather than a
  renderer-only helper: `assessHarnessBindingReadiness` and
  `harnessAgentBindingCandidates` live behind the
  `@harness/orchestration/harness-binding-readiness` subpath so renderer code
  can import the browser-safe preflight without pulling Node-only orchestration
  modules into the client bundle.
- `HarnessPackageService.previewPipelineDraft` now evaluates readiness from the
  persisted AgentProfile, MCP server, Skill source, and capability registries
  before conversion. Readiness errors block package-derived pipeline draft
  preview with `HARNESS_BINDING_READINESS_FAILED`; warnings and info remain
  visible but non-blocking.
- The Harnesses tab still shows readiness before pipeline preview, and the IPC
  preview result can now carry the same readiness summary for non-UI clients.
- Package-derived pipeline steps now carry structured source metadata in
  `AgentPipelineStep.source` and `WorkerStep.source`, including package id,
  original package id for repaired snapshots, workflow id/name, source format,
  source step id, and source file reference.
- Source metadata is stored inside the existing `steps_json` and orchestration
  plan JSON snapshots; no new SQLite canonical state is introduced.
- `HarnessDefinition -> AgentPipeline draft -> OrchestrationPlan` preserves full
  step instruction text in `AgentPipelineStep.instruction` and
  `WorkerStep.instruction`.
- The visible orchestration plan summary and worker step review card expose the
  full instruction when it differs from the display summary, so source metadata
  such as source harness, workflow, file, and artifact contracts remains visible
  before approval.
- Approved execution acceptance is now covered by a desktop integration test
  using a `harness-100`-style YouTube package fixture: import and persist the
  package snapshot, bind local AgentProfiles, save a pipeline template, draft an
  orchestration plan, require approval, run workers only after approval, confirm
  dependency handoffs, persist worker artifacts with source metadata, and create
  a passing quality gate.
- Export compatibility projection has a preview-only first slice: stored
  package snapshots can be projected into Harness-native, Claude, or Codex file
  sets with compatibility warnings, while source/export file writes remain
  outside the harness package IPC surface.
- Approval-gated export write is now proposed through `harnessPackages.proposeExport`:
  the user selects a target directory, HarnessAgentOS creates pending
  `file_write` approvals for every projected file, and the runner remains the
  only component that can write after approval.
- Explicit package failure policies can now map into `AgentPipelineBackflowRule`
  entries during `HarnessDefinition -> AgentPipeline` conversion, but only when
  the source rule is bounded and unambiguous: `backflow_to_step`,
  `step_failed`/`quality_failed`, clear `targetStepId`, clear `retryStepId`,
  bounded `maxAttempts`, and a validated dependency path from target to retry.
- Ambiguous failure prose remains review-only through
  `HARNESS_FAILURE_POLICY_REVIEW_REQUIRED`; it is not guessed into a local
  retry route.

Verified commands for the latest checkpoint:

```powershell
node --import tsx --test --test-force-exit packages/orchestration/src/harness-package-export.test.mjs apps/desktop/electron/ipc/harness-package-ipc.test.mjs apps/desktop/src/screens/workbench/HarnessPackagesTab.test.mjs
node --import tsx --test --test-force-exit packages/orchestration/src/harness-package-service.test.mjs apps/desktop/electron/ipc/harness-package-ipc.test.mjs apps/desktop/src/screens/workbench/HarnessPackagesTab.test.mjs packages/core/src/ipc-channels.test.mjs
node --import tsx --test --test-force-exit packages/orchestration/src/orchestration-planner.test.mjs
node --import tsx --test --test-force-exit packages/orchestration/src/harness-package-repair.test.mjs packages/orchestration/src/harness-package-service.test.mjs apps/desktop/electron/ipc/harness-package-ipc.test.mjs packages/storage/src/migrations.test.mjs
node --import tsx --test --test-force-exit apps/desktop/src/screens/workbench/harness-package-ui.test.mjs apps/desktop/src/screens/workbench/HarnessPackagesTab.test.mjs
node --import tsx --test --test-force-exit packages/core/src/types/agent-pipeline.test.mjs packages/orchestration/src/harness-pipeline-draft.test.mjs packages/storage/src/repositories/agent-pipeline-repository.test.mjs apps/desktop/src/screens/workbench/pipeline-form.test.mjs
node --import tsx --test --test-force-exit apps/desktop/electron/harness-package-acceptance.test.mjs
node --import tsx --test packages/orchestration/src/harness-binding-readiness.test.mjs
node --import tsx --test packages/orchestration/src/harness-package-service.test.mjs
node --import tsx --test apps/desktop/electron/ipc/harness-package-ipc.test.mjs
node --import tsx --test packages/orchestration/src/harness-pipeline-draft.test.mjs
node --import tsx --test packages/core/src/types/harness-package.test.mjs
npm run check
npm run test
npm run build
git diff --check
```

### 18.2 Inference

The current implementation is now suitable for reviewed package import,
manual workflow repair, pipeline-template creation, and persisted repaired
package snapshots. It now also has a closed approved-execution acceptance path,
a service-level readiness gate for package-derived pipeline preview, and an
explicit bounded failure-policy mapping path for safe local backflow rules, plus
an approval-gated export projection path. It is still intentionally not a
complete autonomous package runner: import, repair, binding, preview, save, plan
approval, worker side effects, and export writes remain separate user-visible
steps.

### 18.3 Remaining Uncertainty

- Real-world Markdown package shapes outside `harness-100` may need more parser
  aliases or stricter `needs_review` diagnostics.
- Provider availability can be included in the service-level readiness contract
  when a caller supplies a provider status map; the persisted registry checks
  already cover AgentProfile, MCP, Skill source, and capability state.
- Export write is approval-gated, but batch execution UX still depends on the
  existing approval panel rather than a dedicated "approve all export files"
  workflow.

## 19. Next Step Order

Proceed in this order:

1. **Provider-status pass-through**: if non-UI preview callers need provider
   availability in the service result, pass a validated provider status map into
   `HarnessPackageService.previewPipelineDraft`; do not make provider probing a
   hidden side effect of package preview.
2. **Export approval UX**: keep the current approval-gated file writes, then
   consider a dedicated batch review/approve surface for export projections.

The immediate user workflow is:

```text
Import Harness package
  -> inspect diagnostics and workflow steps
  -> repair ambiguous owner/dependency/artifact details if needed
  -> choose workflow
  -> bind abstract agents to local AgentProfiles
  -> inspect binding readiness errors/warnings
  -> preview pipeline draft
  -> save template
  -> start a TaskRun with that template
  -> review orchestration_plan approval
  -> approve execution
  -> inspect artifacts and quality gate
```
