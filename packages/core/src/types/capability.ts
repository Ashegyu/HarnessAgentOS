import type { Approval, ApprovalActionType } from "./approval.ts";

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

export type SkillPlatform = "windows" | "macos" | "linux" | "any";

export interface SkillResourceManifest {
  scripts: string[];
  templates: string[];
  examples: string[];
  references: string[];
}

export interface SkillResources extends SkillResourceManifest {}

export interface SkillMetadataV2 {
  id: string;
  name: string;
  description: string;
  version?: string;
  author?: string;
  license?: string;
  /** Absolute path of the skill directory. Main process only. */
  sourceDir: string;
  trusted: boolean;
  riskLevel: CapabilityRiskLevel;
  allowedActions: ApprovalActionType[];
  requiredApprovals: ApprovalActionType[];
  triggerTerms: string[];
  tags: string[];
  platforms: SkillPlatform[];
  inputs: string[];
  outputs: string[];
  relatedSkills: string[];
  projectScopes: string[];
  resources: SkillResourceManifest;
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
