import type { CapabilityRiskLevel } from "@harness/core";

/**
 * Phase 5 risk policy. Decides the conservative riskLevel for a skill
 * based on its declared allowed actions and trust status. Pure helper.
 */

const HIGH_RISK_ACTIONS = new Set([
  "shell",
  "dependency_install",
  "git_commit",
  "network",
  "skill_script",
  "orchestration_plan",
]);

const MEDIUM_RISK_ACTIONS = new Set(["file_write"]);

export const classifySkillRisk = (input: {
  declared: CapabilityRiskLevel;
  allowedActions: string[];
  trusted: boolean;
}): CapabilityRiskLevel => {
  const declaredRank = rank(input.declared);
  let actionRank = rank("low");
  for (const action of input.allowedActions) {
    if (HIGH_RISK_ACTIONS.has(action)) {
      actionRank = Math.max(actionRank, rank("high"));
    } else if (MEDIUM_RISK_ACTIONS.has(action)) {
      actionRank = Math.max(actionRank, rank("medium"));
    }
  }
  // Untrusted skills are floored at medium.
  let trustRank = input.trusted ? rank("low") : rank("medium");

  return fromRank(Math.max(declaredRank, actionRank, trustRank));
};

const rank = (level: CapabilityRiskLevel): number => {
  switch (level) {
    case "low":
      return 0;
    case "medium":
      return 1;
    case "high":
      return 2;
    default:
      return 0;
  }
};

const fromRank = (n: number): CapabilityRiskLevel => {
  if (n >= 2) return "high";
  if (n === 1) return "medium";
  return "low";
};

/**
 * Phase 5 boundary check: skill_script execution against an untrusted
 * skill must be refused outright. Caller still produces an Approval row
 * for trusted high-risk scripts so the user has explicit consent.
 */
export const isScriptExecutionAllowed = (input: {
  trusted: boolean;
  riskLevel: CapabilityRiskLevel;
}): boolean => input.trusted;
