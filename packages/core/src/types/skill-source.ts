import type { Approval, ApprovalActionType } from "./approval.ts";
import type {
  AgentProfile,
  AgentProfileBindingPreview,
  CapabilityBindingProposal,
} from "./agent-profile.ts";
import type { CapabilityRiskLevel } from "./capability.ts";

/**
 * SkillSource — a trusted-or-not directory under which `<root>/<id>/SKILL.md`
 * files live. See docs/design/agent-detailed-settings.md §4.3.
 *
 * `origin` flags where the row came from. `project` and `user` are seeded
 * with sentinel IDs by the v9 migration; `custom` rows are added by the
 * user via SettingsModal/Skills. Custom rows start with trusted=false so
 * `skill_script` approvals must be promoted explicitly.
 */

export type SkillSourceOrigin = "project" | "user" | "custom";

export const SKILL_SOURCE_ORIGINS: readonly SkillSourceOrigin[] = [
  "project",
  "user",
  "custom",
];

export interface SkillSource {
  id: string;
  name: string;
  origin: SkillSourceOrigin;
  rootDir: string;
  /** User must explicitly promote — false by default for custom sources. */
  trusted: boolean;
  enabled: boolean;
  /** True once path-policy has the rootDir on its sourceDir whitelist. */
  registeredInPathPolicy: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SkillAuthorDraft {
  sourceId: string;
  slug: string;
  name: string;
  description: string;
  triggerTerms: string[];
  riskLevel: CapabilityRiskLevel;
  allowedActions: ApprovalActionType[];
  body: string;
}

export interface SkillGenerationRequest {
  sourceId: string;
  userIntent: string;
  profileIds?: readonly string[];
  evidenceArtifactIds?: readonly string[];
}

export interface GeneratedSkillDraft extends SkillAuthorDraft {
  recommendedProfileIds: string[];
  rationale: string;
}

export interface SkillGenerationPreviewResult {
  draft: GeneratedSkillDraft;
  preview: SkillAuthorPreview;
}

export interface SkillAuthorValidationIssue {
  field: keyof SkillAuthorDraft | "content";
  message: string;
}

export interface SkillAuthorPreview {
  ok: boolean;
  errors: SkillAuthorValidationIssue[];
  warnings: string[];
  riskyActions: ApprovalActionType[];
  sourceId: string;
  relativePath: string;
  content: string;
  wouldOverwrite: boolean;
  parsed?: {
    id: string;
    name: string;
    description: string;
    riskLevel: CapabilityRiskLevel;
    triggerTerms: string[];
    allowedActions: ApprovalActionType[];
  };
}

export interface SkillFileProposalResult {
  threadId: string;
  taskRunId: string;
  approval: Approval;
  preview: SkillAuthorPreview;
}

export interface SkillProfileBindingProposalRequest {
  sourceId: string;
  profileId: string;
  capabilityIds?: readonly string[];
}

export interface SkillProfileBindingProposalResult {
  sourceId: string;
  sourceName: string;
  profileId: string;
  profileName: string;
  proposal: CapabilityBindingProposal;
  preview: AgentProfileBindingPreview;
}

export interface SkillProfileBindingApplyResult
  extends SkillProfileBindingProposalResult {
  profile: AgentProfile;
}

export interface SkillSourceRefreshResult {
  sourceId: string;
  scannedCount: number;
  updatedCount: number;
  skillCount: number;
}

const ORIGIN_SET: ReadonlySet<string> = new Set(SKILL_SOURCE_ORIGINS);

export const isSkillSourceOrigin = (v: unknown): v is SkillSourceOrigin =>
  typeof v === "string" && ORIGIN_SET.has(v);

export const isSkillSource = (v: unknown): v is SkillSource => {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.name === "string" &&
    isSkillSourceOrigin(s.origin) &&
    typeof s.rootDir === "string" &&
    s.rootDir.length > 0 &&
    typeof s.trusted === "boolean" &&
    typeof s.enabled === "boolean" &&
    typeof s.registeredInPathPolicy === "boolean" &&
    typeof s.createdAt === "string" &&
    typeof s.updatedAt === "string"
  );
};
