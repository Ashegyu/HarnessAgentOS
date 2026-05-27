# Harness Package Format Contract

Date: 2026-05-27
Status: Draft

## 1. Purpose

This contract defines how HarnessAgentOS should read agent-team harness packages
from Claude-compatible, Codex-compatible, and Harness-native source directories.

The contract exists to prevent the implementation from hardcoding a
Claude-specific `.claude` layout or a Codex-specific `SKILL.md` layout as the
internal runtime model.

## 2. Contract Boundaries

### 2.1 Source package

A source package is a directory containing reusable instructions for an
agent-team workflow. It is read-only during import.

### 2.2 Canonical definition

A canonical definition is the normalized `HarnessDefinition` produced by a
source adapter. It is provider-neutral and source-format-neutral.

### 2.3 Runtime instance

A runtime instance is a `TaskRun` plus `Step`, `Checkpoint`, `Approval`,
`Artifact`, and `QualityGateResult` rows in SQLite WAL. Source package files are
not runtime state.

## 3. Supported Source Formats

### 3.1 Claude-compatible package

```text
.claude/
  CLAUDE.md
  agents/
    <agent-id>.md
  skills/
    <skill-id>/
      skill.md
```

Required for import:

- `.claude/CLAUDE.md`
- at least one `.claude/skills/*/skill.md`

Optional:

- `.claude/agents/*.md`
- nested skill references
- workspace output naming conventions

Important compatibility rule: lowercase `skill.md` is accepted for
Claude-compatible imports, but it should be normalized to a canonical skill
definition. HarnessAgentOS should not require lowercase names outside the
Claude-compatible adapter.

### 3.2 Codex-compatible package

```text
AGENTS.md
skills/
  <skill-id>/
    SKILL.md
```

Required for import:

- at least one `skills/*/SKILL.md`, or one project-level instruction file that
  references a known skill directory

Optional:

- `AGENTS.md`
- tool policy fragments
- MCP configuration references
- provider hints

Important compatibility rule: Codex `AGENTS.md` is project guidance and policy.
It should not be treated as a workflow by itself unless it explicitly declares a
workflow section.

### 3.3 Harness-native package

```text
.harness/
  HARNESS.md
  manifest.json
  agents/
    <agent-id>.md
  skills/
    <skill-id>/
      SKILL.md
```

Required for import:

- `.harness/HARNESS.md` or `.harness/manifest.json`
- at least one `.harness/skills/*/SKILL.md`

Optional:

- `.harness/agents/*.md`
- structured manifest sections for faster parsing
- exported compatibility projections for Claude or Codex

Harness-native is the preferred long-term interchange format, but it is not
required for the first import implementation.

## 4. Canonical Types

The following TypeScript sketch defines the contract shape. Exact names may
change during implementation, but the fields and boundaries should remain.

```ts
export type HarnessSourceFormat = "claude" | "codex" | "harness-native";

export type HarnessValidationStatus =
  | "valid"
  | "valid_with_warnings"
  | "needs_review"
  | "unsupported";

export interface HarnessSourceSnapshot {
  format: HarnessSourceFormat;
  rootDir: string;
  importedAt: string;
  files: HarnessSourceFileSnapshot[];
}

export interface HarnessSourceFileSnapshot {
  relativePath: string;
  kind:
    | "overview"
    | "agent"
    | "skill"
    | "manifest"
    | "policy"
    | "unknown";
  sha256: string;
  parserVersion: string;
}

export interface HarnessDefinition {
  id: string;
  name: string;
  version?: string;
  source: HarnessSourceSnapshot;
  overview: HarnessOverview;
  agents: HarnessAgentDefinition[];
  skills: HarnessSkillDefinition[];
  workflows: HarnessWorkflowDefinition[];
  capabilities: HarnessCapabilityRequirement[];
  validation: HarnessValidationResult;
}

export interface HarnessOverview {
  title: string;
  summary: string;
  usage?: string;
  outputPolicy?: string;
}
```

## 5. Skill Definition Contract

```ts
export interface HarnessSkillDefinition {
  id: string;
  name: string;
  description: string;
  triggerTerms: string[];
  negativeTriggerTerms: string[];
  sourceFile: string;
  workflowRefs: string[];
  relatedSkillRefs: string[];
  rawFrontmatter: Record<string, unknown>;
}
```

### 5.1 Frontmatter mapping

| Source field | Canonical field | Required |
|---|---|---|
| `name` | `id` and `name` | Yes for skill files |
| `description` | `description` | Yes for skill files |
| trigger phrases embedded in description | `triggerTerms` | No |
| NOT-trigger or exclusion text | `negativeTriggerTerms` | No |

If trigger phrases cannot be extracted confidently, the adapter should import
the skill but emit a warning.

## 6. Agent Definition Contract

```ts
export interface HarnessAgentDefinition {
  id: string;
  name: string;
  description: string;
  roleHint: string;
  sourceFile: string;
  persona: string;
  responsibilities: string[];
  outputTemplate?: string;
  communicationProtocol?: string;
  providerHint?: "auto" | "claude" | "codex";
  requiredCapabilities: string[];
}
```

### 6.1 AgentProfile binding

Imported agents are abstract definitions. They are not automatically trusted
`AgentProfile` rows.

Binding rules:

- A user must review profile creation or mapping.
- Provider defaults to `auto` unless the user or trusted package explicitly sets
  `claude` or `codex`.
- Imported permissions are suggestions, not grants.
- `allowedActions`, MCP servers, tool allowlists, and budget caps must pass the
  existing `AgentProfile` validation model.

## 7. Workflow Definition Contract

```ts
export interface HarnessWorkflowDefinition {
  id: string;
  skillId: string;
  name: string;
  mode: string;
  description: string;
  sourceFile: string;
  phases: HarnessWorkflowPhase[];
  steps: HarnessWorkflowStep[];
  handoffPolicy: HarnessHandoffPolicy;
  failurePolicy: HarnessFailurePolicy;
  testScenarios: HarnessTestScenario[];
  parseConfidence: "high" | "medium" | "low";
}

export interface HarnessWorkflowPhase {
  id: string;
  title: string;
  owner: "orchestrator" | "agent" | "system" | "user";
  summary: string;
}

export interface HarnessWorkflowStep {
  id: string;
  title: string;
  agentRef?: string;
  roleHint: string;
  phaseId?: string;
  instruction: string;
  dependsOn: string[];
  parallelGroup?: string;
  artifactContracts: HarnessArtifactContract[];
  allowedActions: ApprovalActionType[];
  outputContract: WorkerOutputContract;
  sourceRef: HarnessSourceRef;
}
```

### 7.1 Dependency parsing

Recognized dependency sources:

- workflow tables with columns equivalent to order, task, owner, dependency, and
  artifact. The source adapter accepts common aliases such as `Assigned To`,
  `Assignee`, `Responsible`, `Dependencies`, `Output`, `Artifact`, and Korean
  headers `순서`, `작업`, `담당`, `의존`, `산출물`.
- explicit `dependsOn` fields in Harness-native manifests
- prose phrases that are supported by adapter-specific rules, such as "2a and
  2b run in parallel after task 1"

Parsing rules:

- Missing dependency data should not be treated as fully independent execution.
- If dependencies are ambiguous, mark the workflow `needs_review`.
- Dependency ranges such as `1~4`, `1-3b`, and whole-workflow references such
  as `All`/`전체` may be expanded only when the referenced step ids are already
  present in the parsed workflow table.
- Multi-agent owner cells such as `pro + con` are not auto-bound to a single
  `AgentProfile`; they remain review issues unless the user splits the step or
  chooses an explicit binding.
- If a source format has a known legacy linear convention, the adapter may
  propose linear dependencies but must record a warning.
- Parallelism is advisory. The runner still applies provider queue, approval,
  and dependency-wave constraints.

## 8. Artifact Contract

```ts
export interface HarnessArtifactContract {
  id: string;
  pathHint?: string;
  title: string;
  kind: ArtifactKind | "workspace_file" | "external_url" | "provider_artifact";
  required: boolean;
  description: string;
  validationHint?: string;
}
```

Mapping rules:

- Source paths like `_workspace/01_report.md` become `pathHint`, not mandatory
  live filesystem writes.
- Actual artifact rows are created only during runtime execution.
- If a package requires file creation, the step must propose an approved
  `file_write` action or produce an artifact through the existing runner path.
- External URLs are references unless an approved network-capable worker retrieves
  them.

## 9. Handoff Policy

```ts
export interface HarnessHandoffPolicy {
  mode:
    | "structured_handoff"
    | "source_message_semantics"
    | "artifact_only"
    | "manual_review";
  routes: HarnessHandoffRoute[];
  requiredPayload: "harness_worker_handoff_v1";
  fallback: "synthesize_from_artifact" | "pause_for_review";
}

export interface HarnessHandoffRoute {
  fromStepId: string;
  toStepId: string;
  summary: string;
}
```

Compatibility rules:

- Claude `SendMessage` maps to neutral handoff routes.
- Codex instructions that say to pass context to another skill map to neutral
  handoff routes.
- Existing `harness_worker_handoff_v1` remains the runtime payload for worker
  outputs.
- If a worker omits the structured block, runtime may synthesize context from the
  artifact, as it does today, but validation should record that the package does
  not guarantee structured handoff.

## 10. Failure Policy

```ts
export interface HarnessFailurePolicy {
  defaultMode: "pause_for_review" | "bounded_retry" | "continue_with_warning";
  maxAttempts: number;
  rules: HarnessFailureRule[];
}

export interface HarnessFailureRule {
  trigger:
    | "step_failed"
    | "quality_failed"
    | "artifact_missing"
    | "provider_unavailable"
    | "parse_ambiguous";
  action:
    | "pause_for_review"
    | "retry_step"
    | "backflow_to_step"
    | "continue_with_warning";
  targetStepId?: string;
  instruction?: string;
  maxAttempts?: number;
}
```

Mapping rules:

- Explicit retry/backflow rules may map to existing `WorkerBackflowRule` only
  after dependency reachability is validated.
- Ambiguous prose like "ask the previous agent to fix it" should become
  `pause_for_review` unless the target step is clear.
- Automatic retries require bounded `maxAttempts`.
- A2A refinement is not pipeline backflow and must use the A2A refinement path
  when the failing worker is remote.

## 11. Capability Requirements

```ts
export interface HarnessCapabilityRequirement {
  id: string;
  kind:
    | "tool"
    | "mcp_server"
    | "skill_source"
    | "network"
    | "filesystem"
    | "shell"
    | "git"
    | "model_provider";
  required: boolean;
  description: string;
  providerHint?: "claude" | "codex" | "either";
  risk: "low" | "medium" | "high";
}
```

Rules:

- Capability requirements are not permissions.
- High-risk capabilities must be visible before execution.
- Tool/MCP requirements are matched against `AgentProfile.permissions`.
- Provider-specific tools should be isolated behind provider binding and not
  leaked into the canonical workflow.

## 12. Validation Result

```ts
export interface HarnessValidationResult {
  status: HarnessValidationStatus;
  issues: HarnessValidationIssue[];
  importedAt: string;
  adapterVersion: string;
}

export interface HarnessValidationIssue {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  sourceRef?: HarnessSourceRef;
  blocksExecution: boolean;
}

export interface HarnessSourceRef {
  relativePath: string;
  heading?: string;
  line?: number;
}
```

Status rules:

| Status | Meaning | Execution |
|---|---|---|
| `valid` | Required structure parsed with high confidence | May be converted after user review |
| `valid_with_warnings` | Runnable structure exists, but some optional sections are missing or inferred | May be converted after user review |
| `needs_review` | Important workflow, dependency, artifact, or capability detail is ambiguous | Cannot execute until user resolves |
| `unsupported` | Required package shape is missing or source format is unknown | Cannot execute |

## 13. Import Diagnostics

Adapters must produce diagnostics for:

- missing overview file
- missing skill files
- duplicate skill ids
- duplicate agent ids
- workflow table missing dependency column
- unknown agent reference
- artifact path collision
- dependency cycle
- unsupported side effect request
- provider-specific instruction that cannot be mapped neutrally
- unbounded retry wording
- source package outside trusted roots

## 14. Conversion Rules

### 14.1 HarnessDefinition to AgentPipeline draft

Use this path first for v1 execution.

Mapping:

- `HarnessWorkflowStep.title` -> `AgentPipelineStep.title`
- `instruction` -> `AgentPipelineStep.instruction`
- `artifactContracts.kind` -> `expectedArtifactKinds`
- `dependsOn` -> `AgentPipelineStep.dependsOn`
- `allowedActions` -> `AgentPipelineStep.allowedActions`
- `outputContract` -> `AgentPipelineStep.outputContract`
- bound `AgentProfile.id` -> `AgentPipelineStep.agentProfileId`
- chosen remote endpoint -> `AgentPipelineStep.remoteEndpointId`

This conversion must produce a user-reviewable draft. It must not immediately
create an approved orchestration run.

### 14.1.1 Binding readiness preflight

Before the service returns a package-derived `AgentPipeline` draft, it must run
the binding readiness preflight against the same runtime registries that will be
used later by the worker path:

- persisted `AgentProfile` rows
- persisted MCP server registrations
- persisted Skill source registrations
- persisted capability registry rows
- optional caller-supplied provider availability map

The preflight result shape is:

```ts
export interface HarnessBindingReadinessSummary {
  ok: boolean;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  issues: readonly HarnessBindingReadinessIssue[];
}
```

Rules:

- `errorCount > 0` blocks pipeline draft preview and is surfaced as
  `HARNESS_BINDING_READINESS_FAILED` in the preview issues.
- warnings and info do not block preview, but must remain available to UI and
  non-UI clients through the preview result.
- unknown or missing `AgentProfile` bindings are errors.
- provider hint mismatch, provider unavailability, MCP state, Skill source
  state, and capability allowlist problems are warnings unless the specific
  profile binding is impossible.
- provider probing is not a hidden side effect of preview. A caller that wants
  provider availability included must supply the current provider status map.

### 14.2 AgentPipeline draft to OrchestrationPlan

Use the existing planner path. The current planner already remaps pipeline step
ids to immutable worker step ids and validates topology.

### 14.3 HarnessDefinition to TaskRun draft

This direct path is a later phase. It is useful for one-off execution, but it
has more UI and review risk than saving a pipeline draft first.

## 15. Export Rules

HarnessAgentOS may later export:

- Harness-native packages
- Claude-compatible `.claude` projections
- Codex-compatible skill projections

Exported packages must include:

- declaration files
- role definitions
- workflow descriptions
- artifact contracts
- failure policies
- compatibility warnings

Exported packages must not include:

- live TaskRun state
- secret values
- approval history
- raw provider output unless explicitly exported as an artifact bundle
- SQLite database rows

## 16. Contract Test Plan

Adapter tests should cover:

- Claude-compatible sample with `CLAUDE.md`, agents, and lowercase `skill.md`
- Codex-compatible sample with `AGENTS.md` and uppercase `SKILL.md`
- Harness-native sample with manifest and `SKILL.md`
- missing skill file
- duplicate ids
- ambiguous dependency table
- parallel step extraction
- artifact contract extraction
- failure policy extraction
- provider-specific capability warnings
- conversion to `AgentPipeline` draft

Recommended command shape after implementation:

```bash
node --import tsx --test --test-force-exit packages/core/src/types/harness-package.test.mjs
node --import tsx --test --test-force-exit packages/orchestration/src/harness-import.test.mjs
npm run check
```
