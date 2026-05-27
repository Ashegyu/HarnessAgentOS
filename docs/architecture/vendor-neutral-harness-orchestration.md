# Vendor-Neutral Harness Orchestration Design

Date: 2026-05-27
Status: Draft

## 1. Purpose

This document defines the target architecture for running document-described
agent team harnesses in HarnessAgentOS without binding the product to either
Claude-specific or Codex-specific folder conventions.

The immediate trigger is the `harness-100` reference shape:

```text
.claude/
  CLAUDE.md
  agents/*.md
  skills/*/skill.md
```

That reference is valuable, but it is not the internal standard for
HarnessAgentOS. HarnessAgentOS must be able to import and execute harnesses that
come from Claude-style packages, Codex-style skills, or a native neutral package
format.

The internal standard is therefore a canonical `HarnessDefinition` model. Source
formats and execution providers are adapters around that model.

## 2. Pre-Documentation Design Review

### 2.1 Evidence from the current project

- `docs/architecture/harness-agent-os-design.md` defines the product as a
  user-supervised workbench, not an autonomous hidden agent system.
- `docs/implementation/phase-07-optional-agent-orchestration.md` explicitly
  keeps orchestration as an advanced path behind plan approval.
- `packages/core/src/types/orchestration.ts` already has
  `OrchestrationPlan`, `WorkerStep`, `WorkerRole`, dependency metadata, optional
  A2A endpoint selection, and output contracts.
- `packages/core/src/types/agent-pipeline.ts` already has reusable pipeline
  templates with steps, dependencies, output contracts, allowed actions, and
  backflow rules.
- `packages/orchestration/src/orchestration-planner.ts` already maps an
  `AgentPipeline` into an immutable `OrchestrationPlan` snapshot before approval.
- `packages/orchestration/src/worker-handoff.ts` already normalizes worker output
  into `harness_worker_handoff_v1` and degrades to synthesized/warning payloads
  instead of breaking the run.
- `docs/architecture/pipeline-backflow-routing-plan.md` keeps pipeline backflow
  separate from normal dependencies and A2A refinement.
- `docs/architecture/a2a-integration-plan.md` keeps A2A as an outbound remote
  worker/client boundary, not the local orchestration mechanism.
- `packages/core/src/types/agent-profile.ts` already supports `provider:
  "auto" | "claude" | "codex"` and profile-level permissions, skills, MCP
  servers, and model tuning.
- `packages/core/src/types/skill-source.ts` already models trusted and untrusted
  skill source roots for `<root>/<id>/SKILL.md`.

### 2.2 Inference from the reference `harness-100` shape

- `CLAUDE.md` is a package overview and operator-facing guide.
- `agents/*.md` are role/persona definitions.
- `skills/*/skill.md` is the real orchestration description: trigger text,
  workflow phases, dependencies, outputs, data passing, error handling, and test
  scenarios.
- The word "pipeline" in those examples describes an agent-team workflow in
  prose. It does not imply that HarnessAgentOS should encode each domain
  workflow directly in TypeScript.

### 2.3 Design corrections before implementation

The existing `AgentPipeline` type must not become the new canonical package
model. It is useful, but it is already a runtime template for profile-bound
worker steps. A source package imported from Claude or Codex needs additional
metadata that `AgentPipeline` does not own:

- package identity and source format
- package-level overview document
- raw source file snapshot and import diagnostics
- agent role text before binding to a local `AgentProfile`
- workflow modes described by Markdown conventions
- source-format-specific trigger rules
- adapter capability requirements
- conversion confidence and manual-review status

The correct layering is:

```text
Source package (.claude / Codex skills / .harness)
  -> Source adapter
  -> Canonical HarnessDefinition
  -> ValidationResult
  -> TaskRun draft or AgentPipeline draft
  -> OrchestrationPlan snapshot
  -> Approval
  -> WorkerRunner / AgentPlanningService / A2A client
  -> Artifact / QualityGateResult
```

## 3. Non-Goals

- Do not make `.claude` the internal source of truth.
- Do not make Codex `SKILL.md` the internal source of truth.
- Do not store runtime state in Markdown or JSON files.
- Do not bypass the existing SQLite WAL state model.
- Do not let imported agent instructions execute file, shell, git, dependency,
  or network side effects directly.
- Do not merge local worker handoff, A2A remote invocation, and backflow retry
  into one mechanism.
- Do not build a broad Markdown DSL parser before the import-only workflow has
  proven useful.
- Do not encode domain-specific workflows, such as YouTube production or
  performance optimization, as hardcoded TypeScript paths.

## 4. Target Architecture

```text
             Claude package
                  |
                  v
          ClaudeSourceAdapter

             Codex package
                  |
                  v
           CodexSourceAdapter

             Native package
                  |
                  v
          NativeSourceAdapter

                  |
                  v
        Canonical HarnessDefinition
                  |
                  v
        Harness validation and review
                  |
                  v
       TaskRun draft / AgentPipeline draft
                  |
                  v
        OrchestrationPlan snapshot
                  |
                  v
              Approval gate
                  |
                  v
   Local Claude/Codex worker or remote A2A worker
                  |
                  v
      Artifact, structured handoff, quality gate
```

The source adapter decides how to read a package. The execution adapter decides
how to invoke a provider. The canonical harness model is between them and must
not leak source-format or provider-specific behavior into persisted task state.

## 5. Layer Responsibilities

### 5.1 Source package

A source package is a directory that contains reusable harness instructions. It
is declarative input, not runtime state.

Supported source families:

| Source family | Typical files | Role |
|---|---|---|
| Claude-compatible | `.claude/CLAUDE.md`, `.claude/agents/*.md`, `.claude/skills/*/skill.md` | Import existing Claude Code style harnesses |
| Codex-compatible | `AGENTS.md`, `skills/*/SKILL.md`, optional project policy fragments | Import Codex skill and project instruction packages |
| Harness-native | `.harness/HARNESS.md`, `.harness/agents/*.md`, `.harness/skills/*/SKILL.md`, optional manifest | Preferred long-term neutral package |

### 5.2 Source adapter

A source adapter reads a package and produces a `HarnessDefinition` plus
diagnostics. It must be deterministic and side-effect-free.

It may:

- read Markdown files
- parse frontmatter
- parse known Markdown sections and tables
- preserve raw source snippets for audit
- emit warnings when sections are missing or ambiguous

It must not:

- execute scripts
- call external tools
- mutate the workspace
- create approvals
- run workers
- silently guess missing dependency edges for automatic execution

### 5.3 Canonical harness model

The canonical model is the neutral contract that both Claude and Codex packages
map into.

It captures:

- package identity
- source format and source snapshot
- skill triggers
- agent profiles as abstract role definitions
- workflow modes
- steps
- dependencies
- artifact contracts
- handoff policy
- failure policy
- capability requirements
- validation status

It does not capture:

- live TaskRun state
- provider queue state
- approval decisions
- actual artifact content
- quality gate results

### 5.4 Runtime draft

After validation, a `HarnessDefinition` can be converted into either:

- a `TaskRun` draft for one-off execution, or
- an `AgentPipeline` draft for user-editable reuse inside the existing pipeline
  editor.

The conversion is intentionally explicit. Importing a harness package does not
automatically create a runnable approval.

### 5.5 Execution adapter

Execution adapters invoke workers after a user-approved `OrchestrationPlan`
exists.

Supported execution targets:

| Target | Mapping |
|---|---|
| Local Claude CLI | `AgentProfile.provider = "claude"` and current `AgentPlanningService` CLI path |
| Local Codex CLI | `AgentProfile.provider = "codex"` and current provider queue path |
| Auto provider | Existing profile/settings resolver chooses available provider |
| Remote A2A endpoint | `WorkerStep.remoteEndpointId` and existing A2A outbound client path |

Execution adapters may render provider-specific prompt sections, but all worker
outputs must return through the same artifact, proposed-action, and structured
handoff path.

## 6. Canonical Model Sketch

The concrete TypeScript should be refined in the contract phase, but the
architecture should start from this shape:

```ts
type HarnessSourceFormat = "claude" | "codex" | "harness-native";

interface HarnessDefinition {
  id: string;
  name: string;
  version?: string;
  source: HarnessSourceSnapshot;
  overview: HarnessOverview;
  skills: HarnessSkillDefinition[];
  agents: HarnessAgentDefinition[];
  workflows: HarnessWorkflowDefinition[];
  capabilities: HarnessCapabilityRequirement[];
  validation: HarnessValidationResult;
}

interface HarnessWorkflowDefinition {
  id: string;
  skillId: string;
  mode: string;
  description: string;
  steps: HarnessWorkflowStep[];
  failurePolicy: HarnessFailurePolicy;
  handoffPolicy: HarnessHandoffPolicy;
}

interface HarnessWorkflowStep {
  id: string;
  title: string;
  agentRef?: string;
  roleHint: string;
  instruction: string;
  dependsOn: string[];
  artifactContracts: HarnessArtifactContract[];
  allowedActions: ApprovalActionType[];
  outputContract: WorkerOutputContract;
  parallelGroup?: string;
}
```

## 7. Mapping to Existing Runtime

The neutral model should reuse the current runtime instead of replacing it.

| Canonical harness field | Existing runtime target | Notes |
|---|---|---|
| `HarnessDefinition` | new import snapshot tables or artifacts | Package declaration only |
| `HarnessAgentDefinition` | `AgentProfile` draft | Binding is user-reviewed before execution |
| `HarnessSkillDefinition` | `SkillSource` / capability metadata | Existing skill source trust model remains |
| `HarnessWorkflowDefinition` | `AgentPipeline` draft or direct TaskRun draft | User chooses whether to save reusable pipeline |
| `HarnessWorkflowStep` | `AgentPipelineStep` then `WorkerStep` | Existing planner still creates immutable plan snapshot |
| `dependsOn` | `WorkerStep.dependsOn` | Missing edges should produce warnings unless convention parser is confident |
| `parallelGroup` | dependency wave planner | Parallelism remains bounded by runner/provider policy |
| `artifactContracts` | `expectedArtifactKinds`, artifact expectations | Full artifact schema belongs to new contract |
| `allowedActions` | `AgentPipelineStep.allowedActions` | Approval policy still enforces at runtime |
| `handoffPolicy` | `harness_worker_handoff_v1` and internal agent bus | Do not use provider-specific message semantics as canonical |
| `failurePolicy` | backflow rules, retry metadata, or manual review | Automatic retry must be explicit, bounded, and dependency-safe |
| `runtimeTarget` | `AgentProfile.provider` or `remoteEndpointId` | Source package should not force unsafe local execution |

## 8. Claude and Codex Compatibility

### 8.1 Claude-compatible import

Claude-style packages are imported as source declarations:

```text
.claude/CLAUDE.md
.claude/agents/*.md
.claude/skills/*/skill.md
```

Adapter behavior:

- `CLAUDE.md` becomes package overview.
- `agents/*.md` become abstract `HarnessAgentDefinition` rows.
- `skills/*/skill.md` frontmatter becomes skill metadata.
- Known sections such as workflow, agent table, dependency table, data passing,
  error handling, and test scenarios become validation input.
- `SendMessage` is translated to neutral handoff policy. It is not preserved as
  a required runtime primitive.

### 8.2 Codex-compatible import

Codex-style packages are imported from project instructions and skills:

```text
AGENTS.md
skills/*/SKILL.md
```

Adapter behavior:

- `AGENTS.md` becomes package-level operating constraints.
- `SKILL.md` frontmatter and body become skill metadata and workflow hints.
- Codex tool/plugin/MCP constraints become capability requirements.
- Approval and sandbox expectations are preserved as policy hints, not as
  automatic permissions.

### 8.3 Harness-native package

The preferred long-term package is neutral:

```text
.harness/
  HARNESS.md
  agents/*.md
  skills/*/SKILL.md
  manifest.json
```

`manifest.json` may be used as a structured accelerator, but the runtime source
of truth after import is still SQLite. A native manifest is a package declaration
snapshot, not task state.

## 9. State and Persistence Policy

Source package files are declarations. Runtime state remains in SQLite WAL.

Allowed persistence:

- package import snapshot
- raw source file hash and relative path
- parsed canonical definition
- validation diagnostics
- user binding decisions
- generated `AgentPipeline` draft
- generated `OrchestrationPlan` artifact
- TaskRun, Step, Checkpoint, Approval, Artifact, QualityGateResult

Disallowed persistence:

- JSON files as canonical task state
- Markdown files as live run state
- hidden provider-native task state that bypasses `TaskRun`
- source package mutation during import

## 10. Approval and Security Policy

Imported harnesses are untrusted until validated and approved.

Rules:

- Importing a package is read-only.
- Saving a package source root requires the existing trusted source policy.
- Binding an imported agent to an `AgentProfile` is a user-visible decision.
- Running a workflow requires an `orchestration_plan` approval.
- Worker-proposed side effects remain proposed actions.
- `policyEvaluation = blocked` still blocks execution even if an approval row is
  approved.
- Remote A2A workers can propose artifacts and actions, but cannot directly
  mutate the local workspace.
- Codex or Claude provider tool output is telemetry unless Harness executes the
  side effect through its own approval boundary.

## 11. UI Product Model

The UI should describe this feature as "Harness packages" or "Agent team
harnesses", not as a generic pipeline builder.

Required views:

- package import/inspect view
- source format and validation status
- package overview
- skills and trigger terms
- agent role definitions
- workflow modes
- dependency graph
- expected artifacts
- capability/tool requirements
- unsupported or ambiguous sections
- conversion preview to TaskRun or AgentPipeline
- approval gate before execution

The existing pipeline graph can remain as an execution visualization, but the
source of the workflow should be visible as a package-derived harness definition.

## 12. Stepwise Architecture Phases

### Phase A: Design and contract only

- Document the neutral model.
- Document source package format compatibility.
- Document adoption phases.
- No code execution changes.

### Phase B: Import and inspect

- Add source adapters with read-only parsing.
- Store import diagnostics.
- UI shows package structure and warnings.
- No TaskRun creation from imports.

### Phase C: Canonical model validation

- Introduce `HarnessDefinition` core types.
- Validate required fields, dependency references, artifact contracts, and
  capability declarations.
- Classify imported packages as `valid`, `valid_with_warnings`,
  `needs_review`, or `unsupported`.

### Phase D: Draft conversion

- Convert validated workflows into `AgentPipeline` drafts or TaskRun drafts.
- Require user review before saving or execution.
- Preserve raw source references for audit.

### Phase E: Provider binding

- Bind abstract agents to local `AgentProfile` rows.
- Support `provider = "auto" | "claude" | "codex"` and optional A2A endpoint.
- Validate permissions, tool requirements, MCP requirements, and budget hints.

### Phase F: Approved execution

- Reuse current `OrchestrationPlanner` and `WorkerRunner`.
- Require `orchestration_plan` approval.
- Store worker outputs as artifacts.
- Use structured handoff for downstream context.

### Phase G: Backflow and review loops

- Map explicit failure policies to bounded backflow rules only when
  `targetStepId`, `retryStepId`, retry limit, ordering, and dependency path are
  all valid.
- Keep ambiguous retry instructions as manual-review guidance.
- Preserve separation between local backflow and A2A refinement.

### Phase H: Export

- Export a Harness-native package from a validated local configuration.
- Optionally export Claude-compatible or Codex-compatible projections.
- Exported packages are declarations, not execution histories.

## 13. Open Questions

- Should imported package definitions become first-class DB rows, or should v1
  store them as artifacts until import behavior stabilizes?
- Should the first runnable conversion target be `AgentPipeline` only, avoiding
  direct TaskRun draft generation?
- How strict should Markdown table parsing be before marking a workflow
  `valid_with_warnings` instead of `needs_review`?
- Should package import require approval when the source root is outside the
  current workspace?
- Should provider binding default to `auto`, or should every imported agent
  require explicit `claude` or `codex` selection before execution?

## 14. Decision Summary

- HarnessAgentOS should be Claude-compatible and Codex-compatible, but internally
  Harness-native.
- `.claude` and Codex skill folders are import formats, not runtime standards.
- The canonical model is `HarnessDefinition`.
- Existing `AgentPipeline`, `OrchestrationPlan`, `WorkerStep`, Approval,
  Artifact, and QualityGate flows remain the execution substrate.
- The first implementation must be import/inspect only. Execution comes after
  validation, conversion, provider binding, and explicit approval.
