import type { Approval } from "./approval.ts";

export type CapabilityRiskLevel = "low" | "medium" | "high";

export const CAPABILITY_RISK_LEVELS: readonly CapabilityRiskLevel[] = [
  "low",
  "medium",
  "high",
];

export interface Capability {
  id: string;
  /** e.g. "skillify:project" or "skillify:user" — categorizes where it came from. */
  source: string;
  name: string;
  description: string;
  triggerTerms: string[];
  riskLevel: CapabilityRiskLevel;
  requiresApproval: boolean;
}

export interface CreateCapabilityInput {
  id?: string;
  source: string;
  name: string;
  description: string;
  triggerTerms: string[];
  riskLevel: CapabilityRiskLevel;
  requiresApproval: boolean;
}

export interface CapabilitySuggestion {
  capability: Capability;
  score: number;
  reason: string;
  matchedTerms: string[];
}

export interface CapabilityUsageForTrace {
  capabilityId: string;
  suggestionReason: string;
  score?: number;
  decision: "accepted" | "rejected";
}

export interface SkillResources {
  scripts: string[];
  templates: string[];
  examples: string[];
}

export interface CapabilityCandidateApprovalResult {
  suggestions: CapabilitySuggestion[];
  approvals: Approval[];
  skipped: CapabilitySuggestion[];
}

export interface CapabilityPromptContext {
  capability: Capability;
  reason: string;
  instructions: string;
}
