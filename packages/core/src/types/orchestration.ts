import type { ApprovalActionType } from "./approval.ts";
import type { WorkerBackflowRule } from "./pipeline-backflow.ts";

export type OrchestrationMode =
  | "single_worker"
  | "planner_worker"
  | "multi_worker";

export const ORCHESTRATION_MODES: readonly OrchestrationMode[] = [
  "single_worker",
  "planner_worker",
  "multi_worker",
];

export type WorkerRole =
  | "planner"
  | "coder"
  | "reviewer"
  | "tester"
  | "orchestrator"
  | "security-reviewer"
  | "build-error-resolver"
  | "refactor-cleaner"
  | "performance-reviewer"
  | "documenter";

export const WORKER_ROLES: readonly WorkerRole[] = [
  "planner",
  "coder",
  "reviewer",
  "tester",
  "orchestrator",
  "security-reviewer",
  "build-error-resolver",
  "refactor-cleaner",
  "performance-reviewer",
  "documenter",
];

export type WorkerOutputContract =
  | "plan"
  | "diff_proposal"
  | "review"
  | "test_result";

export const WORKER_OUTPUT_CONTRACTS: readonly WorkerOutputContract[] = [
  "plan",
  "diff_proposal",
  "review",
  "test_result",
];

export type WorkerStepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export type WorkerSourceKind = "harness_package";

export type WorkerSourceFormat = "claude" | "codex" | "harness-native";

export interface WorkerSourceRef {
  relativePath: string;
  heading?: string;
  line?: number;
}

export interface WorkerSourceMetadata {
  kind: WorkerSourceKind;
  /** Concrete HarnessDefinition snapshot used to create this worker step. */
  packageId: string;
  /** Original imported package id when the concrete snapshot is repaired. */
  sourcePackageId?: string;
  packageName: string;
  sourceFormat: WorkerSourceFormat;
  workflowId: string;
  workflowName: string;
  stepId: string;
  sourceRef?: WorkerSourceRef;
}

export interface WorkerStep {
  id: string;
  title: string;
  role: WorkerRole;
  /**
   * Display-only summary, truncated for the plan UI / artifact headers.
   * The full user-request text used by the CLI lives in `instruction`.
   */
  inputSummary: string;
  /**
   * Full text passed to the agent CLI as the worker's userRequest at
   * runtime. For pipeline-driven plans this is `AgentPipelineStep
   * .instruction` verbatim (no truncation). For legacy mode-driven
   * plans this is the TaskRun.userRequest, also untruncated.
   *
   * Optional for backward compatibility with plans drafted before v12 —
   * worker-runner falls back to `inputSummary` when `instruction` is
   * missing.
   */
  instruction?: string;
  expectedArtifactKinds: string[];
  status: WorkerStepStatus;
  /**
   * When set, the worker-runner invokes this specific AgentProfile
   * instead of resolving the active/default by role. Synthesized from
   * pipeline steps; legacy `mode`-driven plans omit it.
   */
  agentProfileId?: string;
  /**
   * Optional A2A endpoint override for pipeline-driven steps. The
   * AgentProfile remains the approved persona/permission source; this
   * selects a trusted remote worker transport.
   */
  remoteEndpointId?: string;
  /**
   * WorkerStep ids that must complete before this step runs. Missing
   * means legacy linear handoff behavior; an empty array means the step
   * is explicitly independent.
   */
  dependsOn?: readonly string[];
  /**
   * Side-effect proposal classes this worker may surface as downstream
   * approvals. The worker still cannot execute them directly.
   */
  allowedActions?: readonly ApprovalActionType[];
  /**
   * Advisory output shape expected from the worker. This is used for UI
   * and audit traces; quality gates still validate concrete artifacts.
   */
  outputContract?: WorkerOutputContract;
  /**
   * Optional provenance for worker steps synthesized from imported harness
   * declarations. Legacy and hand-authored pipelines may omit this.
   */
  source?: WorkerSourceMetadata;
}

export interface OrchestrationHarnessSourceMetadata {
  packageId: string;
  packageName: string;
  workflowId: string;
  workflowName: string;
  bindingSetId: string;
  bindingSetName: string;
}

export interface OrchestrationPlan {
  id: string;
  taskRunId: string;
  mode: OrchestrationMode;
  workerSteps: WorkerStep[];
  requiresApproval: true;
  /**
   * If the plan was synthesized from an AgentPipeline template, the
   * pipeline's id is preserved here for audit/replay. The plan itself
   * is still the immutable snapshot — later edits to the pipeline do
   * NOT affect already-synthesized plans.
   */
  sourcePipelineId?: string;
  /**
   * If the plan was synthesized directly from an imported harness package
   * plus a saved binding set, this preserves the source declaration and
   * binding provenance. No AgentPipeline row is created for this path.
   */
  sourceHarness?: OrchestrationHarnessSourceMetadata;
  /**
   * Conditional runtime edges. These do not participate in the normal
   * dependsOn DAG cycle check; the runner uses them only after a failure
   * trigger.
   */
  backflowRules?: WorkerBackflowRule[];
}

export interface OrchestrationRunResult {
  planId: string;
  taskRunId: string;
  workerStepArtifactIds: string[];
  workerSteps: WorkerStep[];
  proposedApprovalIds: string[];
}

const WORKER_SOURCE_FORMATS: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "harness-native",
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

export const isWorkerSourceRef = (v: unknown): v is WorkerSourceRef => {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.relativePath)) return false;
  if (v.heading !== undefined && typeof v.heading !== "string") return false;
  if (v.line !== undefined && typeof v.line !== "number") return false;
  return true;
};

export const isWorkerSourceMetadata = (
  v: unknown,
): v is WorkerSourceMetadata => {
  if (!isRecord(v)) return false;
  if (v.kind !== "harness_package") return false;
  if (!isNonEmptyString(v.packageId)) return false;
  if (v.sourcePackageId !== undefined && !isNonEmptyString(v.sourcePackageId)) {
    return false;
  }
  if (!isNonEmptyString(v.packageName)) return false;
  if (
    typeof v.sourceFormat !== "string" ||
    !WORKER_SOURCE_FORMATS.has(v.sourceFormat)
  ) {
    return false;
  }
  if (!isNonEmptyString(v.workflowId)) return false;
  if (!isNonEmptyString(v.workflowName)) return false;
  if (!isNonEmptyString(v.stepId)) return false;
  if (v.sourceRef !== undefined && !isWorkerSourceRef(v.sourceRef)) {
    return false;
  }
  return true;
};
