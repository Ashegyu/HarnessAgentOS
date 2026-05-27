import {
  APPROVAL_ACTION_TYPES,
  type Approval,
  type ApprovalActionType,
} from "./approval.ts";
import { ARTIFACT_KINDS, type ArtifactKind } from "./artifact.ts";
import type { CreateAgentPipelineInput } from "./agent-pipeline.ts";
import type { Checkpoint } from "./checkpoint.ts";
import {
  WORKER_OUTPUT_CONTRACTS,
  type WorkerOutputContract,
} from "./orchestration.ts";
import type { TaskRun } from "./task-run.ts";
import type { Thread } from "./thread.ts";

export type HarnessSourceFormat = "claude" | "codex" | "harness-native";

export const HARNESS_SOURCE_FORMATS: readonly HarnessSourceFormat[] = [
  "claude",
  "codex",
  "harness-native",
];

export type HarnessSourceDetectionStatus =
  | "detected"
  | "ambiguous"
  | "unsupported";

export interface HarnessSourceDetectionInput {
  rootDir: string;
  relativePaths: readonly string[];
}

export interface HarnessSourceDetectionCandidate {
  format: HarnessSourceFormat;
  score: number;
  complete: boolean;
  evidence: readonly string[];
  missing: readonly string[];
}

export interface HarnessSourceDetectionResult {
  rootDir: string;
  status: HarnessSourceDetectionStatus;
  format?: HarnessSourceFormat;
  candidates: readonly HarnessSourceDetectionCandidate[];
  reasons: readonly string[];
}

export type HarnessValidationStatus =
  | "valid"
  | "valid_with_warnings"
  | "needs_review"
  | "unsupported";

export const HARNESS_VALIDATION_STATUSES: readonly HarnessValidationStatus[] = [
  "valid",
  "valid_with_warnings",
  "needs_review",
  "unsupported",
];

export type HarnessSourceFileKind =
  | "overview"
  | "agent"
  | "skill"
  | "manifest"
  | "policy"
  | "unknown";

export const HARNESS_SOURCE_FILE_KINDS: readonly HarnessSourceFileKind[] = [
  "overview",
  "agent",
  "skill",
  "manifest",
  "policy",
  "unknown",
];

export type HarnessWorkflowPhaseOwner =
  | "orchestrator"
  | "agent"
  | "system"
  | "user";

export const HARNESS_WORKFLOW_PHASE_OWNERS: readonly HarnessWorkflowPhaseOwner[] =
  ["orchestrator", "agent", "system", "user"];

export type HarnessParseConfidence = "high" | "medium" | "low";

export const HARNESS_PARSE_CONFIDENCES: readonly HarnessParseConfidence[] = [
  "high",
  "medium",
  "low",
];

export type HarnessArtifactKind =
  | ArtifactKind
  | "workspace_file"
  | "external_url"
  | "provider_artifact";

export const HARNESS_ARTIFACT_KINDS: readonly HarnessArtifactKind[] = [
  ...ARTIFACT_KINDS,
  "workspace_file",
  "external_url",
  "provider_artifact",
];

export type HarnessHandoffMode =
  | "structured_handoff"
  | "source_message_semantics"
  | "artifact_only"
  | "manual_review";

export const HARNESS_HANDOFF_MODES: readonly HarnessHandoffMode[] = [
  "structured_handoff",
  "source_message_semantics",
  "artifact_only",
  "manual_review",
];

export type HarnessHandoffFallback =
  | "synthesize_from_artifact"
  | "pause_for_review";

export const HARNESS_HANDOFF_FALLBACKS: readonly HarnessHandoffFallback[] = [
  "synthesize_from_artifact",
  "pause_for_review",
];

export type HarnessFailureDefaultMode =
  | "pause_for_review"
  | "bounded_retry"
  | "continue_with_warning";

export const HARNESS_FAILURE_DEFAULT_MODES: readonly HarnessFailureDefaultMode[] =
  ["pause_for_review", "bounded_retry", "continue_with_warning"];

export type HarnessFailureTrigger =
  | "step_failed"
  | "quality_failed"
  | "artifact_missing"
  | "provider_unavailable"
  | "parse_ambiguous";

export const HARNESS_FAILURE_TRIGGERS: readonly HarnessFailureTrigger[] = [
  "step_failed",
  "quality_failed",
  "artifact_missing",
  "provider_unavailable",
  "parse_ambiguous",
];

export type HarnessFailureAction =
  | "pause_for_review"
  | "retry_step"
  | "backflow_to_step"
  | "continue_with_warning";

export const HARNESS_FAILURE_ACTIONS: readonly HarnessFailureAction[] = [
  "pause_for_review",
  "retry_step",
  "backflow_to_step",
  "continue_with_warning",
];

export type HarnessCapabilityKind =
  | "tool"
  | "mcp_server"
  | "skill_source"
  | "network"
  | "filesystem"
  | "shell"
  | "git"
  | "model_provider";

export const HARNESS_CAPABILITY_KINDS: readonly HarnessCapabilityKind[] = [
  "tool",
  "mcp_server",
  "skill_source",
  "network",
  "filesystem",
  "shell",
  "git",
  "model_provider",
];

export type HarnessProviderHint = "auto" | "claude" | "codex";

export const HARNESS_PROVIDER_HINTS: readonly HarnessProviderHint[] = [
  "auto",
  "claude",
  "codex",
];

export type HarnessCapabilityProviderHint = "claude" | "codex" | "either";

export const HARNESS_CAPABILITY_PROVIDER_HINTS: readonly HarnessCapabilityProviderHint[] =
  ["claude", "codex", "either"];

export type HarnessCapabilityRisk = "low" | "medium" | "high";

export const HARNESS_CAPABILITY_RISKS: readonly HarnessCapabilityRisk[] = [
  "low",
  "medium",
  "high",
];

export type HarnessValidationIssueSeverity = "info" | "warning" | "error";

export const HARNESS_VALIDATION_ISSUE_SEVERITIES: readonly HarnessValidationIssueSeverity[] =
  ["info", "warning", "error"];

export interface HarnessSourceRef {
  relativePath: string;
  heading?: string;
  line?: number;
}

export interface HarnessSourceFileSnapshot {
  relativePath: string;
  kind: HarnessSourceFileKind;
  sha256: string;
  parserVersion: string;
}

export interface HarnessSourceSnapshot {
  format: HarnessSourceFormat;
  rootDir: string;
  importedAt: string;
  files: readonly HarnessSourceFileSnapshot[];
}

export interface HarnessOverview {
  title: string;
  summary: string;
  usage?: string;
  outputPolicy?: string;
}

export interface HarnessSkillDefinition {
  id: string;
  name: string;
  description: string;
  triggerTerms: readonly string[];
  negativeTriggerTerms: readonly string[];
  sourceFile: string;
  workflowRefs: readonly string[];
  relatedSkillRefs: readonly string[];
  rawFrontmatter: Readonly<Record<string, unknown>>;
}

export interface HarnessAgentDefinition {
  id: string;
  name: string;
  description: string;
  roleHint: string;
  sourceFile: string;
  persona: string;
  responsibilities: readonly string[];
  outputTemplate?: string;
  communicationProtocol?: string;
  providerHint?: HarnessProviderHint;
  requiredCapabilities: readonly string[];
}

export interface HarnessWorkflowPhase {
  id: string;
  title: string;
  owner: HarnessWorkflowPhaseOwner;
  summary: string;
}

export interface HarnessArtifactContract {
  id: string;
  pathHint?: string;
  title: string;
  kind: HarnessArtifactKind;
  required: boolean;
  description: string;
  validationHint?: string;
}

export interface HarnessWorkflowStep {
  id: string;
  title: string;
  agentRef?: string;
  roleHint: string;
  phaseId?: string;
  instruction: string;
  dependsOn: readonly string[];
  parallelGroup?: string;
  artifactContracts: readonly HarnessArtifactContract[];
  allowedActions: readonly ApprovalActionType[];
  outputContract: WorkerOutputContract;
  sourceRef: HarnessSourceRef;
}

export interface HarnessHandoffRoute {
  fromStepId: string;
  toStepId: string;
  summary: string;
}

export interface HarnessHandoffPolicy {
  mode: HarnessHandoffMode;
  routes: readonly HarnessHandoffRoute[];
  requiredPayload: "harness_worker_handoff_v1";
  fallback: HarnessHandoffFallback;
}

export interface HarnessFailureRule {
  trigger: HarnessFailureTrigger;
  action: HarnessFailureAction;
  targetStepId?: string;
  retryStepId?: string;
  instruction?: string;
  maxAttempts?: number;
}

export interface HarnessFailurePolicy {
  defaultMode: HarnessFailureDefaultMode;
  maxAttempts: number;
  rules: readonly HarnessFailureRule[];
}

export interface HarnessTestScenario {
  id: string;
  title: string;
  prompt: string;
  expected: readonly string[];
}

export interface HarnessWorkflowDefinition {
  id: string;
  skillId: string;
  name: string;
  mode: string;
  description: string;
  sourceFile: string;
  phases: readonly HarnessWorkflowPhase[];
  steps: readonly HarnessWorkflowStep[];
  handoffPolicy: HarnessHandoffPolicy;
  failurePolicy: HarnessFailurePolicy;
  testScenarios: readonly HarnessTestScenario[];
  parseConfidence: HarnessParseConfidence;
}

export interface HarnessCapabilityRequirement {
  id: string;
  kind: HarnessCapabilityKind;
  required: boolean;
  description: string;
  providerHint?: HarnessCapabilityProviderHint;
  risk: HarnessCapabilityRisk;
}

export interface HarnessValidationIssue {
  severity: HarnessValidationIssueSeverity;
  code: string;
  message: string;
  sourceRef?: HarnessSourceRef;
  blocksExecution: boolean;
}

export interface HarnessPackageImportDirectoryInput {
  rootDir: string;
}

export interface HarnessRepairMetadata {
  sourcePackageId: string;
  repairedAt: string;
  note?: string;
}

export interface HarnessWorkflowStepRepairInput {
  stepId: string;
  title?: string;
  agentRef?: string | null;
  roleHint?: string;
  instruction?: string;
  dependsOn?: readonly string[];
  artifactContracts?: readonly HarnessArtifactContract[];
  allowedActions?: readonly ApprovalActionType[];
  outputContract?: WorkerOutputContract;
}

export interface HarnessWorkflowRepairInput {
  workflowId: string;
  name?: string;
  description?: string;
  steps?: readonly HarnessWorkflowStepRepairInput[];
}

export interface HarnessPackageRepairInput {
  packageId: string;
  note?: string;
  workflows: readonly HarnessWorkflowRepairInput[];
}

export interface HarnessPackageRepairResult {
  definition: HarnessDefinition;
  issuesResolved: number;
}

export interface HarnessPackageExportFile {
  relativePath: string;
  content: string;
  kind: HarnessSourceFileKind;
}

export interface HarnessPackageExportPreview {
  packageId: string;
  packageName: string;
  targetFormat: HarnessSourceFormat;
  files: readonly HarnessPackageExportFile[];
  warnings: readonly string[];
}

export interface HarnessPackageExportPreviewInput {
  packageId: string;
  targetFormat: HarnessSourceFormat;
}

export interface HarnessPackageExportProposalInput
  extends HarnessPackageExportPreviewInput {
  targetDir: string;
}

export interface HarnessPackageExportProposalResult {
  preview: HarnessPackageExportPreview;
  thread: Thread;
  taskRun: TaskRun;
  checkpoint: Checkpoint;
  approvals: readonly Approval[];
  targetDir: string;
}

export type HarnessPackageImportDirectoryResult =
  | {
      ok: true;
      definition: HarnessDefinition;
      detection: HarnessSourceDetectionResult;
    }
  | {
      ok: false;
      detection: HarnessSourceDetectionResult;
      issues: readonly HarnessValidationIssue[];
    };

export interface HarnessAgentProfileBinding {
  harnessAgentRef: string;
  agentProfileId: string;
  remoteEndpointId?: string;
}

export type HarnessPipelineDraftIssueCode =
  | "HARNESS_WORKFLOW_NOT_FOUND"
  | "HARNESS_WORKFLOW_TOO_LARGE"
  | "HARNESS_STEP_PROFILE_UNBOUND"
  | "HARNESS_ARTIFACT_KIND_MAPPED"
  | "HARNESS_FAILURE_POLICY_REVIEW_REQUIRED"
  | "HARNESS_BINDING_READINESS_FAILED";

export interface HarnessPipelineDraftIssue {
  severity: "warning" | "error";
  code: HarnessPipelineDraftIssueCode;
  message: string;
  workflowId?: string;
  stepId?: string;
  sourceRef?: HarnessSourceRef;
}

export type HarnessBindingReadinessSeverity = "error" | "warning" | "info";

export interface HarnessBindingReadinessIssue {
  severity: HarnessBindingReadinessSeverity;
  code: string;
  message: string;
  harnessAgentRef?: string;
  stepId?: string;
  profileId?: string;
}

export interface HarnessBindingReadinessSummary {
  ok: boolean;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  issues: readonly HarnessBindingReadinessIssue[];
}

export type HarnessPipelineDraftPreviewResult =
  | {
      ok: true;
      workflowId: string;
      pipeline: CreateAgentPipelineInput;
      issues: readonly HarnessPipelineDraftIssue[];
      readiness?: HarnessBindingReadinessSummary;
    }
  | {
      ok: false;
      issues: readonly HarnessPipelineDraftIssue[];
      readiness?: HarnessBindingReadinessSummary;
    };

export interface HarnessValidationResult {
  status: HarnessValidationStatus;
  issues: readonly HarnessValidationIssue[];
  importedAt: string;
  adapterVersion: string;
}

export interface HarnessDefinition {
  id: string;
  name: string;
  version?: string;
  source: HarnessSourceSnapshot;
  overview: HarnessOverview;
  agents: readonly HarnessAgentDefinition[];
  skills: readonly HarnessSkillDefinition[];
  workflows: readonly HarnessWorkflowDefinition[];
  capabilities: readonly HarnessCapabilityRequirement[];
  validation: HarnessValidationResult;
  repair?: HarnessRepairMetadata;
}

const SOURCE_FORMAT_SET: ReadonlySet<string> = new Set(HARNESS_SOURCE_FORMATS);
const VALIDATION_STATUS_SET: ReadonlySet<string> = new Set(
  HARNESS_VALIDATION_STATUSES,
);
const SOURCE_FILE_KIND_SET: ReadonlySet<string> = new Set(
  HARNESS_SOURCE_FILE_KINDS,
);
const PHASE_OWNER_SET: ReadonlySet<string> = new Set(
  HARNESS_WORKFLOW_PHASE_OWNERS,
);
const PARSE_CONFIDENCE_SET: ReadonlySet<string> = new Set(
  HARNESS_PARSE_CONFIDENCES,
);
const ARTIFACT_KIND_SET: ReadonlySet<string> = new Set(HARNESS_ARTIFACT_KINDS);
const HANDOFF_MODE_SET: ReadonlySet<string> = new Set(HARNESS_HANDOFF_MODES);
const HANDOFF_FALLBACK_SET: ReadonlySet<string> = new Set(
  HARNESS_HANDOFF_FALLBACKS,
);
const FAILURE_DEFAULT_MODE_SET: ReadonlySet<string> = new Set(
  HARNESS_FAILURE_DEFAULT_MODES,
);
const FAILURE_TRIGGER_SET: ReadonlySet<string> = new Set(
  HARNESS_FAILURE_TRIGGERS,
);
const FAILURE_ACTION_SET: ReadonlySet<string> = new Set(
  HARNESS_FAILURE_ACTIONS,
);
const CAPABILITY_KIND_SET: ReadonlySet<string> = new Set(
  HARNESS_CAPABILITY_KINDS,
);
const PROVIDER_HINT_SET: ReadonlySet<string> = new Set(HARNESS_PROVIDER_HINTS);
const CAPABILITY_PROVIDER_HINT_SET: ReadonlySet<string> = new Set(
  HARNESS_CAPABILITY_PROVIDER_HINTS,
);
const CAPABILITY_RISK_SET: ReadonlySet<string> = new Set(
  HARNESS_CAPABILITY_RISKS,
);
const ISSUE_SEVERITY_SET: ReadonlySet<string> = new Set(
  HARNESS_VALIDATION_ISSUE_SEVERITIES,
);
const ACTION_TYPE_SET: ReadonlySet<string> = new Set(APPROVAL_ACTION_TYPES);
const OUTPUT_CONTRACT_SET: ReadonlySet<string> = new Set(
  WORKER_OUTPUT_CONTRACTS,
);

export const isHarnessSourceFormat = (
  v: unknown,
): v is HarnessSourceFormat =>
  typeof v === "string" && SOURCE_FORMAT_SET.has(v);

export const isHarnessValidationStatus = (
  v: unknown,
): v is HarnessValidationStatus =>
  typeof v === "string" && VALIDATION_STATUS_SET.has(v);

export const isHarnessDefinition = (v: unknown): v is HarnessDefinition => {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.id)) return false;
  if (!isNonEmptyString(v.name)) return false;
  if (v.version !== undefined && typeof v.version !== "string") return false;
  if (!isHarnessSourceSnapshot(v.source)) return false;
  if (!isHarnessOverview(v.overview)) return false;
  if (!isArrayOf(v.agents, isHarnessAgentDefinition)) return false;
  if (!isArrayOf(v.skills, isHarnessSkillDefinition)) return false;
  if (!isArrayOf(v.workflows, isHarnessWorkflowDefinition)) return false;
  if (!isArrayOf(v.capabilities, isHarnessCapabilityRequirement)) {
    return false;
  }
  if (!isHarnessValidationResult(v.validation)) return false;
  if (v.repair !== undefined && !isHarnessRepairMetadata(v.repair)) {
    return false;
  }
  if (!hasUniqueIds(v.agents)) return false;
  if (!hasUniqueIds(v.skills)) return false;
  if (!hasUniqueIds(v.workflows)) return false;
  if (!hasUniqueIds(v.capabilities)) return false;
  return true;
};

export const isHarnessRepairMetadata = (
  v: unknown,
): v is HarnessRepairMetadata => {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.sourcePackageId)) return false;
  if (!isNonEmptyString(v.repairedAt)) return false;
  if (v.note !== undefined && typeof v.note !== "string") return false;
  return true;
};

export const isHarnessSourceRef = (v: unknown): v is HarnessSourceRef => {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.relativePath)) return false;
  if (v.heading !== undefined && typeof v.heading !== "string") return false;
  if (
    v.line !== undefined &&
    (!Number.isInteger(v.line) || Number(v.line) < 1)
  ) {
    return false;
  }
  return true;
};

export const isHarnessSourceFileSnapshot = (
  v: unknown,
): v is HarnessSourceFileSnapshot => {
  if (!isRecord(v)) return false;
  return (
    isNonEmptyString(v.relativePath) &&
    typeof v.kind === "string" &&
    SOURCE_FILE_KIND_SET.has(v.kind) &&
    isNonEmptyString(v.sha256) &&
    isNonEmptyString(v.parserVersion)
  );
};

export const isHarnessSourceSnapshot = (
  v: unknown,
): v is HarnessSourceSnapshot => {
  if (!isRecord(v)) return false;
  return (
    isHarnessSourceFormat(v.format) &&
    isNonEmptyString(v.rootDir) &&
    isNonEmptyString(v.importedAt) &&
    isArrayOf(v.files, isHarnessSourceFileSnapshot)
  );
};

export const isHarnessOverview = (v: unknown): v is HarnessOverview => {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.title)) return false;
  if (typeof v.summary !== "string") return false;
  if (v.usage !== undefined && typeof v.usage !== "string") return false;
  if (
    v.outputPolicy !== undefined &&
    typeof v.outputPolicy !== "string"
  ) {
    return false;
  }
  return true;
};

export const isHarnessSkillDefinition = (
  v: unknown,
): v is HarnessSkillDefinition => {
  if (!isRecord(v)) return false;
  return (
    isNonEmptyString(v.id) &&
    isNonEmptyString(v.name) &&
    typeof v.description === "string" &&
    isStringArray(v.triggerTerms) &&
    isStringArray(v.negativeTriggerTerms) &&
    isNonEmptyString(v.sourceFile) &&
    isStringArray(v.workflowRefs) &&
    isStringArray(v.relatedSkillRefs) &&
    isRecord(v.rawFrontmatter)
  );
};

export const isHarnessAgentDefinition = (
  v: unknown,
): v is HarnessAgentDefinition => {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.id)) return false;
  if (!isNonEmptyString(v.name)) return false;
  if (typeof v.description !== "string") return false;
  if (!isNonEmptyString(v.roleHint)) return false;
  if (!isNonEmptyString(v.sourceFile)) return false;
  if (typeof v.persona !== "string") return false;
  if (!isStringArray(v.responsibilities)) return false;
  if (
    v.outputTemplate !== undefined &&
    typeof v.outputTemplate !== "string"
  ) {
    return false;
  }
  if (
    v.communicationProtocol !== undefined &&
    typeof v.communicationProtocol !== "string"
  ) {
    return false;
  }
  if (
    v.providerHint !== undefined &&
    (typeof v.providerHint !== "string" || !PROVIDER_HINT_SET.has(v.providerHint))
  ) {
    return false;
  }
  if (!isStringArray(v.requiredCapabilities)) return false;
  return true;
};

export const isHarnessWorkflowDefinition = (
  v: unknown,
): v is HarnessWorkflowDefinition => {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.id)) return false;
  if (!isNonEmptyString(v.skillId)) return false;
  if (!isNonEmptyString(v.name)) return false;
  if (!isNonEmptyString(v.mode)) return false;
  if (typeof v.description !== "string") return false;
  if (!isNonEmptyString(v.sourceFile)) return false;
  if (!isArrayOf(v.phases, isHarnessWorkflowPhase)) return false;
  if (!isArrayOf(v.steps, isHarnessWorkflowStep)) return false;
  if (!hasUniqueIds(v.phases)) return false;
  if (!hasUniqueIds(v.steps)) return false;
  if (!isHarnessHandoffPolicy(v.handoffPolicy)) return false;
  if (!isHarnessFailurePolicy(v.failurePolicy)) return false;
  if (!isArrayOf(v.testScenarios, isHarnessTestScenario)) return false;
  return (
    typeof v.parseConfidence === "string" &&
    PARSE_CONFIDENCE_SET.has(v.parseConfidence)
  );
};

export const isHarnessWorkflowPhase = (
  v: unknown,
): v is HarnessWorkflowPhase => {
  if (!isRecord(v)) return false;
  return (
    isNonEmptyString(v.id) &&
    isNonEmptyString(v.title) &&
    typeof v.owner === "string" &&
    PHASE_OWNER_SET.has(v.owner) &&
    typeof v.summary === "string"
  );
};

export const isHarnessWorkflowStep = (
  v: unknown,
): v is HarnessWorkflowStep => {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.id)) return false;
  if (!isNonEmptyString(v.title)) return false;
  if (v.agentRef !== undefined && !isNonEmptyString(v.agentRef)) return false;
  if (!isNonEmptyString(v.roleHint)) return false;
  if (v.phaseId !== undefined && !isNonEmptyString(v.phaseId)) return false;
  if (typeof v.instruction !== "string") return false;
  if (!isStringArray(v.dependsOn)) return false;
  if (
    v.parallelGroup !== undefined &&
    !isNonEmptyString(v.parallelGroup)
  ) {
    return false;
  }
  if (!isArrayOf(v.artifactContracts, isHarnessArtifactContract)) return false;
  if (!isActionArray(v.allowedActions)) return false;
  if (
    typeof v.outputContract !== "string" ||
    !OUTPUT_CONTRACT_SET.has(v.outputContract)
  ) {
    return false;
  }
  if (!isHarnessSourceRef(v.sourceRef)) return false;
  return true;
};

export const isHarnessArtifactContract = (
  v: unknown,
): v is HarnessArtifactContract => {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.id)) return false;
  if (v.pathHint !== undefined && typeof v.pathHint !== "string") return false;
  if (!isNonEmptyString(v.title)) return false;
  if (typeof v.kind !== "string" || !ARTIFACT_KIND_SET.has(v.kind)) {
    return false;
  }
  if (typeof v.required !== "boolean") return false;
  if (typeof v.description !== "string") return false;
  if (
    v.validationHint !== undefined &&
    typeof v.validationHint !== "string"
  ) {
    return false;
  }
  return true;
};

export const isHarnessHandoffPolicy = (
  v: unknown,
): v is HarnessHandoffPolicy => {
  if (!isRecord(v)) return false;
  return (
    typeof v.mode === "string" &&
    HANDOFF_MODE_SET.has(v.mode) &&
    isArrayOf(v.routes, isHarnessHandoffRoute) &&
    v.requiredPayload === "harness_worker_handoff_v1" &&
    typeof v.fallback === "string" &&
    HANDOFF_FALLBACK_SET.has(v.fallback)
  );
};

export const isHarnessHandoffRoute = (
  v: unknown,
): v is HarnessHandoffRoute => {
  if (!isRecord(v)) return false;
  return (
    isNonEmptyString(v.fromStepId) &&
    isNonEmptyString(v.toStepId) &&
    typeof v.summary === "string"
  );
};

export const isHarnessFailurePolicy = (
  v: unknown,
): v is HarnessFailurePolicy => {
  if (!isRecord(v)) return false;
  return (
    typeof v.defaultMode === "string" &&
    FAILURE_DEFAULT_MODE_SET.has(v.defaultMode) &&
    isBoundedAttemptCount(v.maxAttempts) &&
    isArrayOf(v.rules, isHarnessFailureRule)
  );
};

export const isHarnessFailureRule = (
  v: unknown,
): v is HarnessFailureRule => {
  if (!isRecord(v)) return false;
  if (typeof v.trigger !== "string" || !FAILURE_TRIGGER_SET.has(v.trigger)) {
    return false;
  }
  if (typeof v.action !== "string" || !FAILURE_ACTION_SET.has(v.action)) {
    return false;
  }
  if (v.targetStepId !== undefined && !isNonEmptyString(v.targetStepId)) {
    return false;
  }
  if (v.retryStepId !== undefined && !isNonEmptyString(v.retryStepId)) {
    return false;
  }
  if (v.instruction !== undefined && typeof v.instruction !== "string") {
    return false;
  }
  if (v.maxAttempts !== undefined && !isBoundedAttemptCount(v.maxAttempts)) {
    return false;
  }
  return true;
};

export const isHarnessTestScenario = (
  v: unknown,
): v is HarnessTestScenario => {
  if (!isRecord(v)) return false;
  return (
    isNonEmptyString(v.id) &&
    isNonEmptyString(v.title) &&
    typeof v.prompt === "string" &&
    isStringArray(v.expected)
  );
};

export const isHarnessCapabilityRequirement = (
  v: unknown,
): v is HarnessCapabilityRequirement => {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.id)) return false;
  if (typeof v.kind !== "string" || !CAPABILITY_KIND_SET.has(v.kind)) {
    return false;
  }
  if (typeof v.required !== "boolean") return false;
  if (typeof v.description !== "string") return false;
  if (
    v.providerHint !== undefined &&
    (typeof v.providerHint !== "string" ||
      !CAPABILITY_PROVIDER_HINT_SET.has(v.providerHint))
  ) {
    return false;
  }
  if (typeof v.risk !== "string" || !CAPABILITY_RISK_SET.has(v.risk)) {
    return false;
  }
  return true;
};

export const isHarnessValidationIssue = (
  v: unknown,
): v is HarnessValidationIssue => {
  if (!isRecord(v)) return false;
  if (
    typeof v.severity !== "string" ||
    !ISSUE_SEVERITY_SET.has(v.severity)
  ) {
    return false;
  }
  if (!isNonEmptyString(v.code)) return false;
  if (typeof v.message !== "string") return false;
  if (
    v.sourceRef !== undefined &&
    !isHarnessSourceRef(v.sourceRef)
  ) {
    return false;
  }
  return typeof v.blocksExecution === "boolean";
};

export const isHarnessValidationResult = (
  v: unknown,
): v is HarnessValidationResult => {
  if (!isRecord(v)) return false;
  return (
    isHarnessValidationStatus(v.status) &&
    isArrayOf(v.issues, isHarnessValidationIssue) &&
    isNonEmptyString(v.importedAt) &&
    isNonEmptyString(v.adapterVersion)
  );
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

const isStringArray = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every((item) => typeof item === "string");

const isArrayOf = <T>(
  v: unknown,
  guard: (item: unknown) => item is T,
): v is readonly T[] => Array.isArray(v) && v.every(guard);

const isActionArray = (v: unknown): v is readonly ApprovalActionType[] =>
  Array.isArray(v) &&
  v.every((item) => typeof item === "string" && ACTION_TYPE_SET.has(item));

const isBoundedAttemptCount = (v: unknown): v is number =>
  typeof v === "number" &&
  Number.isInteger(v) &&
  v >= 1 &&
  v <= 5;

const hasUniqueIds = (items: readonly { id: string }[]): boolean => {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
  }
  return true;
};
