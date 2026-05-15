import type { ArtifactKind } from "./artifact.ts";

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
}

export interface AgentPipeline {
  id: string;
  name: string;
  description: string;
  steps: readonly AgentPipelineStep[];
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
  return true;
};

export type CreateAgentPipelineInput = Omit<
  AgentPipeline,
  "id" | "createdAt" | "updatedAt"
>;
