import type { ArtifactKind } from "./artifact.ts";
import { APPROVAL_ACTION_TYPES, type ApprovalActionType } from "./approval.ts";
import {
  WORKER_OUTPUT_CONTRACTS,
  type WorkerOutputContract,
} from "./orchestration.ts";
import {
  isAgentPipelineBackflowRule,
  type AgentPipelineBackflowRule,
} from "./pipeline-backflow.ts";

export { isAgentPipelineBackflowRule } from "./pipeline-backflow.ts";
export type { AgentPipelineBackflowRule } from "./pipeline-backflow.ts";

/**
 * Linear pipeline of AgentProfile invocations — see
 * docs/design/agent-detailed-settings.md and the orchestration extension
 * plan. Each step is a 1:1 reference to an AgentProfile plus the
 * step-local instruction the orchestrator passes to it.
 *
 * Pipelines are reusable templates. They are referenced (not copied) into
 * an OrchestrationPlan via `OrchestrationPlan.sourcePipelineId`; the plan
 * itself remains the immutable snapshot used for approval + execution.
 */

/** Upper bound to keep UI / token costs predictable. Adjust if proven too small in practice. */
export const MAX_PIPELINE_STEPS = 20;

export interface AgentPipelineStep {
  id: string;
  agentProfileId: string;
  /**
   * Optional A2A endpoint override. The AgentProfile still controls the
   * role/persona/permissions; this only chooses where the worker runs.
   */
  remoteEndpointId?: string;
  title: string;
  instruction: string;
  expectedArtifactKinds: readonly ArtifactKind[];
  /**
   * Pipeline step ids that must complete before this step runs. Missing
   * preserves the legacy default: linear dependency on the previous step.
   */
  dependsOn?: readonly string[];
  /**
   * Side-effect proposal classes this worker may surface as approvals.
   * Workers still cannot execute these actions directly.
   */
  allowedActions?: readonly ApprovalActionType[];
  outputContract?: WorkerOutputContract;
}

export interface AgentPipeline {
  id: string;
  name: string;
  description: string;
  steps: readonly AgentPipelineStep[];
  backflowRules?: readonly AgentPipelineBackflowRule[];
  createdAt: string;
  updatedAt: string;
}

const isString = (v: unknown): v is string => typeof v === "string";
const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;
const hasOptionalNonEmptyString = (
  obj: Record<string, unknown>,
  key: string,
): boolean => obj[key] === undefined || isNonEmptyString(obj[key]);
const ACTION_TYPE_SET: ReadonlySet<string> = new Set(APPROVAL_ACTION_TYPES);
const OUTPUT_CONTRACT_SET: ReadonlySet<string> = new Set(
  WORKER_OUTPUT_CONTRACTS,
);

const isNonEmptyStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.every((item) => typeof item === "string" && item.length > 0);

const hasOptionalNonEmptyStringArray = (
  obj: Record<string, unknown>,
  key: string,
): boolean => obj[key] === undefined || isNonEmptyStringArray(obj[key]);

const hasOptionalApprovalActionArray = (
  obj: Record<string, unknown>,
  key: string,
): boolean =>
  obj[key] === undefined ||
  (Array.isArray(obj[key]) &&
    obj[key].every(
      (item) => typeof item === "string" && ACTION_TYPE_SET.has(item),
    ));

const hasOptionalOutputContract = (
  obj: Record<string, unknown>,
  key: string,
): boolean =>
  obj[key] === undefined ||
  (typeof obj[key] === "string" && OUTPUT_CONTRACT_SET.has(obj[key]));

export const isAgentPipelineStep = (v: unknown): v is AgentPipelineStep => {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  if (!isNonEmptyString(s.id)) return false;
  if (!isNonEmptyString(s.agentProfileId)) return false;
  if (!hasOptionalNonEmptyString(s, "remoteEndpointId")) return false;
  if (!isNonEmptyString(s.title)) return false;
  if (!isString(s.instruction)) return false;
  if (!Array.isArray(s.expectedArtifactKinds)) return false;
  if (!s.expectedArtifactKinds.every(isString)) return false;
  if (!hasOptionalNonEmptyStringArray(s, "dependsOn")) return false;
  if (!hasOptionalApprovalActionArray(s, "allowedActions")) return false;
  if (!hasOptionalOutputContract(s, "outputContract")) return false;
  return true;
};

export const isAgentPipeline = (v: unknown): v is AgentPipeline => {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  if (!isNonEmptyString(p.id)) return false;
  if (!isNonEmptyString(p.name)) return false;
  if (!isString(p.description)) return false;
  if (!isString(p.createdAt)) return false;
  if (!isString(p.updatedAt)) return false;
  if (!Array.isArray(p.steps)) return false;
  if (p.steps.length < 1 || p.steps.length > MAX_PIPELINE_STEPS) return false;
  if (!p.steps.every(isAgentPipelineStep)) return false;
  if (
    p.backflowRules !== undefined &&
    (!Array.isArray(p.backflowRules) ||
      !p.backflowRules.every(isAgentPipelineBackflowRule))
  ) {
    return false;
  }
  return true;
};

export type CreateAgentPipelineInput = Omit<
  AgentPipeline,
  "id" | "createdAt" | "updatedAt"
>;
