# Agent Framework Follow-up Roadmap

Date: 2026-05-16

Source document: `agent_framework_unified_v4.html`

This document reviews the ideas that were intentionally left outside the
completed Agent Framework adoption work and turns the applicable parts into a
follow-up design plan for HarnessAgentOS.

## 1. Decision Summary

Current HarnessAgentOS adoption of `agent_framework_unified_v4.html` is closed
for the MVP/Phase 8 boundary. The follow-up scope should not reopen that
completed work. It should add only narrowly-scoped improvements that preserve
the existing Harness constraints:

1. No external Ruflo, Agno, Hermes, ECC runtime package is installed by default.
2. No TanStack or new frontend state library is introduced.
3. No Express, localhost API, WebSocket, FastAPI, or inbound listener is added
   to the desktop runtime.
4. Renderer continues to call only `window.harness.*`.
5. SQLite WAL remains the canonical local state.
6. Side effects still pass through `Approval` and `RunnerService`.
7. External agent output is never trusted as execution authority.

Recommended follow-up direction:

1. Phase 9: Shadow workspace preview for agent-generated file changes.
2. Phase 10: Repository context index and prompt packing.
3. Phase 11: Multi-step quality repair loop v2.
4. Phase 12: Model, token, cost, and latency policy tuning.
5. Phase 13: A2A live endpoint validation runbook and optional live smoke.
6. Phase 14: Fan-out preview and conservative read-only parallel agent waves.
7. Phase 15: Skill authoring and refresh UX hardening.

Rejected for the current product path:

- full Ruflo swarm runtime, Queen auto-execution, GOAP, consensus, daemon
- Agno AgentOS/FastAPI/Postgres/ClickHouse control plane inside desktop
- inbound A2A server/listener/localhost wrapper
- MCP HTTP server hosted by HarnessAgentOS
- automatic skill patch/delete or hidden hook mutation
- remote worker side effects without local approval

## 2. Reviewed Evidence

### Local Evidence

The following local docs and implementation files were reviewed:

- `docs/design/agent-framework-unified-v4-adoption-plan.md`
- `docs/implementation/phase-08-agent-cli-integration.md`
- `docs/implementation/phase-08-completion-checklist.md`
- `docs/architecture/a2a-integration-plan.md`
- `docs/verification/a2a-phase-f-ops-report.md`
- `docs/architecture/internal-agent-message-bus-plan.md`
- `docs/design/agent-topology-panel.md`
- `docs/design/agent-detailed-settings.md`
- `packages/agent/src/agent-prompt-builder.ts`
- `packages/agent/src/agent-planning-service.ts`
- `packages/orchestration/src/worker-runner.ts`
- `packages/orchestration/src/internal-agent-bus.ts`
- `packages/learner/src/topology-advisor.ts`
- `apps/desktop/src/screens/workbench/AgentPanel.tsx`
- `apps/desktop/src/screens/workbench/AgentTopologyPanel.tsx`
- `apps/desktop/src/screens/workbench/InternalHandoffPanel.tsx`

Already completed follow-up pieces:

- worker topology metadata: `dependsOn`, `allowedActions`, `outputContract`
- topology recommendation from capability, learner trace, and instinct signals
- local internal worker handoff messages
- handoff prompt injection into downstream worker prompts
- Agent tab handoff visibility derived from persisted prompt artifacts
- Graph tab for TaskRun/agent/approval/A2A state scanning
- outbound A2A registry/client/worker routing
- A2A lifecycle attention states: `input-required`, `auth-required`
- serverless A2A pure gateway contract with no listener

Still open or only partially covered:

- shadow workspace edit mode
- repository-wide indexing and context packing
- multi-step repair loop quality improvements
- token/cost estimator and model policy tuning
- live remote A2A cancellation/retry smoke
- A2A Inspector/TCK operational validation
- fan-out execution preview and conservative parallel waves
- skill source hot reload and SKILL.md authoring UX

### External Evidence

External sources checked on 2026-05-16:

- A2A specification:
  <https://github.com/a2aproject/A2A/blob/main/docs/specification.md>
  - A2A centers on Agent Card, Message, Task, Part, Artifact, streaming, task
    lifecycle, and protocol bindings.
  - This matches Harness's current outbound client/remote task ref approach.
  - Push notification and inbound serving remain a poor fit for the MVP
    serverless desktop constraint.

- A2A JavaScript SDK:
  <https://github.com/a2aproject/a2a-js>
  - The stable README targets A2A v0.3.
  - v1.0 support is currently on an alpha line.
  - SDK types should stay behind `A2AClientPort`; they should not leak into
    `packages/core`, storage rows, or renderer types.

- A2A TCK:
  <https://github.com/a2aproject/a2a-tck>
  - The TCK validates A2A server compliance.
  - It is useful for operational validation when an external compatible server
    exists, but it should not force HarnessAgentOS to host a local server.

- A2A Inspector:
  <https://github.com/a2aproject/a2a-inspector>
  - Inspector is a web UI with a FastAPI backend for inspecting A2A servers.
  - It is an external validation tool, not a runtime dependency for the
    Harness desktop app.

- MCP transports:
  <https://modelcontextprotocol.io/specification/2025-06-18/basic/transports>
  - MCP supports stdio and Streamable HTTP.
  - HTTP transport requires Origin validation, authentication, and careful
    local binding. This reinforces the existing "do not host a local server"
    decision.

- Agno AgentOS docs:
  <https://docs.agno.com/tutorials/agent-platform/overview>
  <https://docs.agno.com/agent-os/usage/mcp/enable-mcp-example>
  - Agno's production path uses AgentOS, FastAPI, Postgres, Docker, and MCP
    endpoints.
  - These are not suitable as Harness runtime dependencies, but Agno remains a
    useful control-plane reference for trace, policy, and model/cost surfaces.

- Ruflo repository:
  <https://github.com/ruvnet/ruflo>
  - Ruflo's full loop includes MCP server, hooks, daemon, many commands,
    numerous agents, memory, and swarm coordination.
  - Harness should continue to adopt only limited topology, handoff, and
    visualization concepts.

- Hermes project reference:
  <https://github.com/fathah/hermes-desktop/blob/main/.claude/skills/hermes-agent/SKILL.md>
  - Hermes emphasizes skill lifecycle, context compression, memory search,
    subagent delegation, approval, redaction, and multiple backends.
  - Harness has already adopted the safe parts around skill metadata and
    handoff. The remaining useful ideas are context packing and skill authoring
    UX, not autonomous skill mutation.

- ECC cross-harness platform reference:
  <https://ecc.tools/platforms>
  - ECC's portable policy/skill/workflow concept maps well to Harness profiles
    and skill source trust.
  - Cross-harness install automation should remain outside the desktop runtime.

## 3. Applicability Matrix

| Follow-up item | Source influence | Apply now? | Priority | Rationale |
|---|---|---:|---:|---|
| Shadow workspace preview | Phase 8 Phase 9 handoff, Hermes safe execution, ECC reviewability | Yes | P0 | Safest next step before stronger automation. It lets users inspect generated edits before target workspace mutation. |
| Repo context index and prompt packing | Hermes context compression, Agno trace/platform discipline | Yes | P0 | Improves agent quality without adding network/server/runtime dependencies. |
| Repair loop v2 | Phase 8 Phase 11 handoff, quality gate architecture | Yes | P1 | Directly addresses failed quality gates while keeping repair inside the same TaskRun. |
| Model/cost policy tuning | Agno production control-plane, Learner architecture | Yes | P1 | Needed before parallelism or more agent invocations. Must remain advisory unless `model_use` is approved. |
| A2A live remote smoke | A2A official client/server model | Yes, manual/optional | P2 | Validates already-implemented outbound client behavior against real endpoints. |
| A2A Inspector/TCK | A2A server compliance tooling | Runbook only | P2 | Useful only when a network-accessible compatible A2A server exists. Do not add a local server to satisfy it. |
| Fan-out preview | Ruflo topology, existing Graph panel | Yes | P2 | Good operator visibility, low risk if renderer-only. |
| Read-only parallel agent waves | Ruflo limited swarm idea | Later | P3 | Useful but must wait until cost, retry, and shadow safety are stronger. |
| Skill authoring wizard | Hermes skill lifecycle, ECC portable skills | Later | P3 | Existing skill source registry is already safe. Authoring UX is useful but not execution-critical. |
| Skill hot reload/watch | Hermes lifecycle | Defer | P4 | Adds event complexity and possible trust confusion. Manual refresh is safer. |
| Agno AgentOS runtime | Agno | No | Reject | Adds FastAPI/Postgres/Docker server path and conflicts with desktop IPC/serverless architecture. |
| Ruflo full swarm/Queen/GOAP | Ruflo | No | Reject | Too much autonomous execution surface. Harness topology runner is the safe boundary. |
| Inbound A2A server/listener | A2A | No for MVP | Reject | Conflicts with no-localhost-server rule and exposes workspace control surface. |
| MCP HTTP server hosted by Harness | MCP/Agno/Hermes | No | Reject | Requires server hardening, auth, Origin checks, and a new local listener. |

## 4. Phase 9 - Shadow Workspace Preview

### Goal

Let a user preview agent-generated file changes in an isolated temporary
workspace before the approved `file_write` touches the real `targetDir`.

### Design Direction

Add a `ShadowWorkspaceService` in `packages/runners` or a new
`packages/runners/src/shadow-workspace-service.ts`.

First implementation supports `file_write` approvals only.

```text
file_write approval with proposedAction.filePatch
  -> user clicks Preview in shadow
  -> main process creates shadow directory under app userData/temp
  -> target file baseline is copied
  -> proposed patch is applied in shadow
  -> diff artifact and shadow snapshot artifact are persisted
  -> UI shows preview/staleness/result
  -> final real workspace write still uses RunnerService.executeApproved
```

### Storage

Add a migration-backed table only if the preview must be reopened after app
restart. Use SQLite as canonical state:

```sql
CREATE TABLE IF NOT EXISTS shadow_previews (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  approval_id TEXT NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  target_dir TEXT NOT NULL,
  shadow_dir TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready','stale','discarded','failed')),
  base_file_hashes_json TEXT NOT NULL DEFAULT '{}',
  artifact_ids_json TEXT NOT NULL DEFAULT '[]',
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

If restart persistence is not needed in the first PR, skip this table and
persist only normal `snapshot` and `diff` artifacts. The later table can then
index artifact ids.

### IPC

Use the 9-layer IPC pattern.

```ts
shadow.createPreview(input: {
  approvalId: string;
}): Promise<ShadowPreview>;

shadow.discard(input: {
  previewId: string;
}): Promise<ShadowPreview>;

shadow.listForTask(input: {
  taskRunId: string;
}): Promise<ShadowPreview[]>;
```

Do not add `shadow.promote` in the first implementation. Promotion can imply
"apply this without thinking"; the real write path should stay the existing
approval execution path.

### UI

- Add `Preview in shadow` to file write approvals.
- Show baseline hash, generated diff artifact, and stale warning.
- If the real target file changed after preview creation, mark preview stale and
  require a new preview before execution.

### Acceptance Criteria

- Shadow preview never writes to `TaskRun.targetDir`.
- Preview output is visible as artifacts.
- Real workspace write still requires existing approval execution.
- Stale preview is detected when the target file baseline changed.
- Parent traversal, drive path, UNC path, and absolute path remain blocked by
  existing file patch validation and runner containment.

### Tests

```powershell
node --import tsx --test --test-force-exit packages/runners/src/shadow-workspace-service.test.mjs
node --import tsx --test --test-force-exit apps/desktop/electron/ipc/shadow-ipc.test.mjs
node --import tsx --test --test-force-exit apps/desktop/src/screens/workbench/approval-panel-shadow-preview.test.mjs
npm run check
```

### Expected Effect

- Fewer accidental destructive edits.
- Better operator confidence for agent-generated patches.
- A safe foundation for later repair loops and optional shadow test runs.

## 5. Phase 10 - Repository Context Index and Prompt Packing

### Goal

Improve agent planning quality by building a local, deterministic repository
index and selecting bounded context for prompts.

### Design Direction

Add two internal services:

- `RepoIndexService`: scans target directories and stores file metadata in
  SQLite.
- `ContextPacker`: selects the smallest useful set of file summaries, package
  facts, prior artifact summaries, and quality risks for `agent-prompt-builder`.

No external search server, embedding DB, vector service, or new package is
required for the first version.

### Index Scope

Scan:

- `package.json`, lockfiles, tsconfig/vite/electron config
- source files under known source roots
- README and docs headings
- recent artifacts from the same TaskRun/thread

Ignore:

- `.git`
- `node_modules`
- `dist`, `out`, `build`, `coverage`
- binary files
- `.env`, secrets, key files
- files above size threshold

### Storage

```sql
CREATE TABLE IF NOT EXISTS repo_index_files (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  target_dir TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  file_kind TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  symbols_json TEXT NOT NULL DEFAULT '[]',
  imports_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  UNIQUE(project_key, target_dir, relative_path)
);
```

### Prompt Packing

```text
TaskRun + targetDir
  -> RepoIndexService.getFreshIndex(projectKey, targetDir)
  -> ContextPacker selects:
       package facts
       file summaries relevant to prompt
       recent artifacts
       latest quality risks
       approved capability contexts
  -> PromptBuilder renders bounded CONTEXT section
```

The packer must preserve the existing hard prompt cap. It should produce a
visible artifact summary so the operator can see which repository facts were
included.

### Approval Boundary

Indexing is read-only and may run without an approval. Any LLM-based summary
generation is not part of Phase 10A. If introduced later, it must go through a
model invocation path and store artifacts.

### Acceptance Criteria

- Index refresh does not run shell commands.
- Index state is in SQLite, not JSON files.
- Prompt context cites file paths and artifact ids.
- Secrets and `.env`-like files are skipped.
- Large files are summarized by metadata only.
- Agent prompts improve without exceeding the 80KB prompt cap.

### Tests

```powershell
node --import tsx --test --test-force-exit packages/agent/src/repo-index-service.test.mjs
node --import tsx --test --test-force-exit packages/agent/src/context-packer.test.mjs
node --import tsx --test --test-force-exit packages/agent/src/agent-prompt-builder.test.mjs
npm run check
```

### Expected Effect

- Better file/path selection from agent plans.
- Fewer hallucinated project assumptions.
- Better basis for repair planning and model selection.

## 6. Phase 11 - Multi-step Quality Repair Loop v2

### Goal

Upgrade the current simple repair plan into a structured loop that can use
quality evidence, prior worker handoffs, shadow previews, and repeated failure
fingerprints.

### Current Gap

`TaskRunCompletionService.createRepairPlan()` currently creates a plan artifact
and a generic `file_write` approval. That preserves the approval boundary, but
it does not yet use the agent planning path to produce targeted repair actions
from the actual failed quality evidence.

### Design Direction

Add a `RepairLoopService` that is composed from:

- `TaskRunCompletionService`
- `AgentPlanningService`
- `QualityEvaluator`
- `RunnerService`
- storage repositories

```text
quality.evaluate -> failed
  -> user clicks Create repair plan
  -> RepairLoopService builds repair prompt:
       latest QualityGateResult
       failed test/build artifacts
       recent worker handoffs
       relevant repo index entries
  -> AgentPlanningService.generateRepairPlan
  -> parsed plan artifact + pending approvals
  -> approved actions run through RunnerService
  -> quality.evaluate again
  -> stop, retry with recorded assumptions, or surface a blocked state
```

### Storage

Use a small attempt table if the loop needs durable attempt tracking:

```sql
CREATE TABLE IF NOT EXISTS repair_attempts (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  quality_gate_id TEXT NOT NULL,
  attempt_index INTEGER NOT NULL,
  failure_signature TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('planned','waiting_for_approval','executed','passed','failed','stopped')),
  invocation_id TEXT,
  generated_approval_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### Stop Conditions

- Stop after configurable max attempts, default `2`.
- Stop if the same failure signature appears twice after repair.
- Stop if proposed actions are outside policy or path boundary.
- Stop if the repair plan proposes dependency install, network, or git commit.
  Those remain manual-only approvals and should not be part of automatic loop
  continuation.

### Dependency-aware Repair

When a TaskRun came from orchestration:

- Identify failed worker or quality evidence source.
- Include only relevant ancestor handoffs and artifacts.
- Do not rerun unrelated worker branches in the first version.

### Acceptance Criteria

- Repair stays in the same TaskRun history.
- No repair side effect happens without approval.
- Repeated same failure stops and asks the user instead of looping.
- Repair prompt includes quality risks and evidence artifact ids.
- Template fallback remains available when no CLI provider is available.

### Tests

```powershell
node --import tsx --test --test-force-exit packages/quality/src/repair-loop-service.test.mjs
node --import tsx --test --test-force-exit packages/agent/src/agent-planning-service.test.mjs
node --import tsx --test --test-force-exit apps/desktop/src/screens/workbench/quality-panel-repair-loop.test.mjs
npm run check
```

### Expected Effect

- Failed quality gates become actionable rather than generic.
- Repair work remains auditable and approval-gated.
- Repeated bad repairs are contained.

## 7. Phase 12 - Model, Token, Cost, and Latency Policy

### Goal

Make model choice and agent execution cost visible enough to guide decisions,
without turning the learner into an automatic executor.

### Current Gap

`AgentInvocation` and `LearningTrace` can carry `latencyMs` and
`costEstimate`, but CLI providers do not always expose token usage. Current
cost estimates are therefore often undefined.

### Design Direction

Add `ModelUsageEstimator` behind the agent package:

1. Prefer provider usage metadata when present.
2. Fall back to approximate tokens from prompt/output character length.
3. Mark fallback estimates as approximate.
4. Use a local pricing catalog only as advisory data.
5. Never auto-update pricing over the network.
6. Never auto-switch model without `model_use` approval.

### Pricing Data

Do not fetch current pricing at runtime. Pricing changes over time, so the
first version should support:

- unknown cost when model is not in catalog
- user-editable per-model pricing later through settings
- approximate label in UI

If a static checked-in catalog is added, treat it as defaults, not truth.

### Policy

Add a model policy evaluator that can produce recommendations:

```text
task risk + role + context size + historical success + latency + cost
  -> model recommendation
  -> model_use approval
  -> approved model context
  -> AgentPlanningService prompt/invocation path
```

### UI

- Show latency, estimated tokens, and estimated cost in Agent stream metadata.
- Show historical cost/latency hints in Learner panel.
- Show queue depth and provider availability as already implemented.
- Add "approximate" labels when using heuristics.

### Acceptance Criteria

- Missing provider usage does not fail invocation.
- Approximate token/cost estimates are clearly marked.
- Learner ranking can use cost only when a numeric estimate exists.
- `model_use` approval remains required before applying a recommendation.
- No external pricing network call is made.

### Tests

```powershell
node --import tsx --test --test-force-exit packages/agent/src/model-usage-estimator.test.mjs
node --import tsx --test --test-force-exit packages/learner/src/learner-advisor.test.mjs
node --import tsx --test --test-force-exit apps/desktop/src/screens/workbench/agent-stream-parser.test.mjs
npm run check
```

### Expected Effect

- Operators see why a model is recommended.
- Parallel or repeated agent calls become easier to reason about.
- Cost-aware recommendations remain supervised.

## 8. Phase 13 - A2A Operational Validation

### Goal

Validate the already-implemented outbound A2A client path against real remote
endpoints without adding an inbound Harness server.

### Design Direction

Add an optional live smoke script:

```text
HARNESS_A2A_REMOTE_URL
HARNESS_A2A_AUTH_SECRET_REF or HARNESS_A2A_BEARER_TOKEN
HARNESS_A2A_SMOKE_TIMEOUT_MS
  -> load endpoint
  -> refresh Agent Card
  -> send message
  -> stream or poll
  -> cancel when supported
  -> retry once
  -> persist remote task ref and artifacts
```

This script must be optional and environment-dependent, like
`smoke:agent-live`.

### Inspector/TCK Policy

Do not add a product server to satisfy Inspector/TCK. Use a runbook:

1. Prepare an external A2A-compatible server.
2. Run A2A Inspector or TCK against that external server.
3. Register that server as a Harness remote endpoint.
4. Run Harness outbound live smoke against it.
5. Compare state mapping and artifact output.

Harness's own pure gateway handler may be tested by contract tests, but it
does not imply the desktop app is an A2A server.

### Acceptance Criteria

- No Express, localhost API, WebSocket, or listener is added.
- Optional live smoke is skipped cleanly when endpoint env is absent.
- Cancellation/retry behavior is captured as artifacts and remote task refs.
- Inspector/TCK remains documented as external validation only.

### Tests

```powershell
node --import tsx --test --test-force-exit packages/agent/src/a2a-sdk-client.test.mjs
node --import tsx --test --test-force-exit packages/agent/src/a2a-worker-invoker.test.mjs
node --import tsx --test --test-force-exit apps/desktop/electron/a2a-worker-integration.test.mjs
```

Manual:

```powershell
$env:HARNESS_A2A_REMOTE_URL='https://example.invalid/a2a'
npm --workspace=@harness/desktop run smoke:a2a-remote-live
```

### Expected Effect

- Real-world A2A compatibility evidence without weakening local security.
- Clear separation between product runtime and external protocol validation.

## 9. Phase 14 - Fan-out Preview and Conservative Parallel Waves

### Goal

Adopt the useful part of Ruflo's swarm concept: visible role topology and
bounded fan-out. Do not adopt autonomous swarm runtime.

### Phase 14A: Preview Only

Add fan-out preview to Pipeline editor:

- group steps into dependency waves
- show which steps can run in the same wave
- show why a step cannot fan out
- surface remote endpoint trust/enabled state
- warn when a wave contains side-effecting action types

This phase is renderer/service read-only. It should not change worker execution.

### Phase 14B: Read-only Parallel Agent Waves

After Phase 12 cost policy is in place, allow parallel agent invocations only
when all steps in the wave satisfy:

- `allowedActions` is `[]`
- role is reviewer, planner, or documenter
- no `file_write`, `shell`, `dependency_install`, `network`, or `git_commit`
- provider queue policy allows it
- orchestration plan approval already exists

Tester shell commands should not run in this wave. They remain normal shell
approvals.

### Merge Policy

Parallel outputs are merged deterministically by step index:

```text
wave completed
  -> persist each worker artifact
  -> create downstream approvals if allowed
  -> sort by original pipeline step index
  -> continue to next dependency wave
```

### Acceptance Criteria

- Fan-out preview works before execution.
- Parallel read-only agent steps do not create side effects.
- Provider queue caps are respected.
- Output order is deterministic.
- Any side-effect proposal still becomes pending approval, not execution.

### Tests

```powershell
node --import tsx --test --test-force-exit packages/orchestration/src/worker-wave-planner.test.mjs
node --import tsx --test --test-force-exit packages/orchestration/src/worker-runner.test.mjs
node --import tsx --test --test-force-exit apps/desktop/src/screens/workbench/pipeline-form.test.mjs
node --import tsx --test --test-force-exit apps/desktop/src/screens/workbench/agent-topology-model.test.mjs
npm run check
```

### Expected Effect

- Better orchestration transparency.
- Limited latency reduction for review/planning phases.
- No uncontrolled swarm behavior.

## 10. Phase 15 - Skill Authoring and Refresh UX

### Goal

Improve the safe skill source workflow without introducing autonomous skill
mutation.

### Current State

Harness already has:

- custom skill source registry
- trusted/untrusted flag
- manual refresh
- untrusted script blocking
- trust promotion confirmation

### Useful Additions

1. SKILL.md authoring wizard that generates a draft template in the UI.
2. Validation preview before writing a new skill file.
3. Manual `Refresh source` action with scanned/updated count.
4. Trust warning that lists risky declared actions.
5. Optional import/export of skill source metadata, not skill execution state.

### Defer

- file watcher/hot reload
- automatic skill patch/delete
- autonomous skill creation from chat history
- auto-trust based on directory path

### Acceptance Criteria

- New skill file write requires explicit user action.
- Generated SKILL.md validates before write.
- Manual refresh updates capability metadata only.
- Script execution remains approval-gated and untrusted scripts remain blocked.

## 11. Recommended Implementation Order

### PR 1: Phase 9A Shadow Preview, file_write only

Why first:

- It reduces risk before adding stronger repair automation.
- It does not require new model calls, network, or external packages.
- It fits the existing approval and artifact model.

Merge condition:

- `shadow-workspace-service.test.mjs`
- `shadow-ipc.test.mjs`
- targeted ApprovalPanel UI tests
- `npm run check`

### PR 2: Phase 10A Repo Index and Context Packer

Why second:

- It improves agent plan quality and repair quality.
- It is mostly read-only.
- It gives Phase 11 better evidence.

Merge condition:

- index ignores secret/build directories
- prompt cap preserved
- prompt artifact shows selected context
- `npm run check`

### PR 3: Phase 11A Agent Repair Plan

Why third:

- It uses Phase 10 context and Phase 9 preview.
- It directly improves failed quality gate recovery.

Merge condition:

- failed quality gate produces targeted agent repair approvals
- repeated failure signature stops after configured max
- template fallback still works

### PR 4: Phase 12A Usage Estimator and Cost UI

Why fourth:

- Required before parallel waves create more invocations.
- Keeps model choice visible and supervised.

Merge condition:

- usage metadata parsed when available
- heuristic estimates marked approximate
- no runtime pricing network fetch

### PR 5: Phase 13A A2A Live Smoke Runbook

Why fifth:

- It validates the already-implemented A2A path without adding runtime surface.

Merge condition:

- optional script skips without env
- remote cancellation/retry evidence is captured when env exists
- docs explicitly forbid adding a local server for TCK

### PR 6: Phase 14A Fan-out Preview

Why sixth:

- Low-risk visualization before execution changes.
- Uses existing Graph and topology metadata.

Merge condition:

- dependency wave preview is deterministic
- side-effecting waves are warned
- no runner behavior change

### PR 7: Phase 14B Read-only Parallel Waves

Why seventh:

- Only after cost visibility and preview are stable.

Merge condition:

- allowed only for `allowedActions=[]`
- provider queue caps respected
- deterministic artifact ordering

### PR 8: Phase 15 Skill Authoring UX

Why later:

- Useful but not on the execution-critical path.
- Existing skill source trust flow is already functional.

Merge condition:

- generated SKILL.md validates before write
- trust/script boundaries unchanged

## 12. Cross-cutting Rules

Every follow-up PR must preserve:

- `packages/core` does not import `@harness/storage`
- tests end with `.test.mjs`
- renderer does not access Node, SQL, filesystem, process, or network
- no Express/localhost/WebSocket/FastAPI server
- no JSON file as canonical state
- migration ids are idempotent and schema version increases
- JSON columns use `_json` suffix
- push events are followed by fresh `getTaskRunDetail` pulls
- actual side effects execute only through existing approval and runner gates

## 13. Final Recommendation

The highest-value follow-up is not "more agents". It is safer execution and
better evidence:

1. preview generated edits safely,
2. give the agent better bounded local context,
3. repair failed quality gates with evidence,
4. make model/cost tradeoffs visible,
5. validate A2A externally without adding local server surface,
6. only then consider read-only fan-out.

This keeps the useful ideas from Ruflo, Agno, Hermes, ECC, MCP, and A2A while
preserving HarnessAgentOS as a user-supervised local workbench.
