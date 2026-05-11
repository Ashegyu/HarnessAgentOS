import type { CapabilityRiskLevel } from "@harness/core";

/**
 * Phase 5 SkillMetadata. Mirrors the Skillify SKILL.md frontmatter
 * concept but does not reuse Skillify runtime: we read metadata only.
 *
 * Source: docs/implementation/phase-05-skillify-capability-adapter.md
 */
export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  /** Absolute path of the skill directory. */
  sourceDir: string;
  riskLevel: CapabilityRiskLevel;
  /** Action types this skill is allowed to propose (e.g. file_write, shell). */
  allowedActions: string[];
  triggerTerms: string[];
  /**
   * `trusted=true` means the skill came from a directory the user has
   * marked safe (project-local skills/, or user-level userData/skills/).
   * Untrusted skills can still be listed but never executed.
   */
  trusted: boolean;
}

export interface ParsedSkillFrontmatter {
  /** stable id derived from the file path or `id` frontmatter field. */
  id: string;
  name: string;
  description: string;
  riskLevel: CapabilityRiskLevel;
  allowedActions: string[];
  triggerTerms: string[];
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
