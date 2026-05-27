import type {
  HarnessDefinition,
  HarnessSourceFormat,
  HarnessValidationIssue,
  HarnessValidationStatus,
} from "@harness/core";

export const HARNESS_SOURCE_FORMAT_LABELS: Record<HarnessSourceFormat, string> =
  {
    claude: "Claude",
    codex: "Codex",
    "harness-native": "Harness native",
  };

export const HARNESS_VALIDATION_STATUS_LABELS: Record<
  HarnessValidationStatus,
  string
> = {
  valid: "Valid",
  valid_with_warnings: "Warnings",
  needs_review: "Needs review",
  unsupported: "Unsupported",
};

export interface HarnessPackageSummary {
  formatLabel: string;
  statusLabel: string;
  files: number;
  agents: number;
  skills: number;
  workflows: number;
  capabilities: number;
  issueCounts: Record<HarnessValidationIssue["severity"], number>;
  blocksExecution: boolean;
}

export const summarizeHarnessPackage = (
  definition: HarnessDefinition,
): HarnessPackageSummary => {
  const issueCounts = {
    info: 0,
    warning: 0,
    error: 0,
  };
  let blocksExecution = false;
  for (const issue of definition.validation.issues) {
    issueCounts[issue.severity] += 1;
    if (issue.blocksExecution) blocksExecution = true;
  }
  return {
    formatLabel: HARNESS_SOURCE_FORMAT_LABELS[definition.source.format],
    statusLabel: HARNESS_VALIDATION_STATUS_LABELS[definition.validation.status],
    files: definition.source.files.length,
    agents: definition.agents.length,
    skills: definition.skills.length,
    workflows: definition.workflows.length,
    capabilities: definition.capabilities.length,
    issueCounts,
    blocksExecution,
  };
};

export const primaryHarnessPackageIssue = (
  definition: HarnessDefinition,
): HarnessValidationIssue | null =>
  definition.validation.issues.find((issue) => issue.blocksExecution) ??
  definition.validation.issues[0] ??
  null;
