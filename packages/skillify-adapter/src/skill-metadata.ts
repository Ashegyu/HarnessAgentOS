import {
  APPROVAL_ACTION_TYPES,
  type ApprovalActionType,
  type CapabilityRiskLevel,
  type SkillMetadataV2,
  type SkillPlatform,
  type SkillResourceManifest,
} from "@harness/core";

/**
 * Phase 5 SkillMetadata. Mirrors the Skillify SKILL.md frontmatter
 * concept but does not reuse Skillify runtime: we read metadata only.
 *
 * Source: docs/implementation/phase-05-skillify-capability-adapter.md
 */
export interface SkillMetadata extends SkillMetadataV2 {}

export interface ParsedSkillFrontmatter {
  /** stable id derived from the file path or `id` frontmatter field. */
  id: string;
  name: string;
  description: string;
  version?: string;
  author?: string;
  license?: string;
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

export interface SkillFile {
  /** Absolute path to the skill's SKILL.md. */
  path: string;
  /** Content of SKILL.md. */
  content: string;
  /** Absolute path of the skill directory (parent of SKILL.md). */
  dir: string;
}

export class SkillMetadataError extends Error {
  readonly code: string;
  constructor(
    code: string,
    message: string,
  ) {
    super(message);
    this.name = "SkillMetadataError";
    this.code = code;
  }
}

export const EMPTY_SKILL_RESOURCE_MANIFEST: SkillResourceManifest = {
  scripts: [],
  templates: [],
  examples: [],
  references: [],
};

export const isApprovalActionType = (
  value: string,
): value is ApprovalActionType =>
  (APPROVAL_ACTION_TYPES as readonly string[]).includes(value);
