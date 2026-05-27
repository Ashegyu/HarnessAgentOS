import type {
  HarnessAgentDefinition,
  HarnessDefinition,
  HarnessPackageExportFile,
  HarnessPackageExportPreview,
  HarnessSourceFormat,
  HarnessWorkflowDefinition,
  HarnessWorkflowStep,
} from "@harness/core";

export interface ExportHarnessPackageInput {
  definition: HarnessDefinition;
  targetFormat: HarnessSourceFormat;
  exportedAt?: string;
}

export const exportHarnessPackage = (
  input: ExportHarnessPackageInput,
): HarnessPackageExportPreview => {
  const exportedAt = input.exportedAt ?? new Date().toISOString();
  const files =
    input.targetFormat === "claude"
      ? exportClaudeProjection(input.definition)
      : input.targetFormat === "codex"
        ? exportCodexProjection(input.definition)
        : exportNativeProjection(input.definition, exportedAt);
  return {
    packageId: input.definition.id,
    packageName: input.definition.name,
    targetFormat: input.targetFormat,
    files,
    warnings: exportWarnings(input.definition, input.targetFormat),
  };
};

const exportNativeProjection = (
  definition: HarnessDefinition,
  exportedAt: string,
): HarnessPackageExportFile[] => [
  {
    relativePath: ".harness/harness.md",
    kind: "overview",
    content: renderOverview(definition),
  },
  {
    relativePath: ".harness/manifest.json",
    kind: "manifest",
    content: `${JSON.stringify(nativeManifest(definition, exportedAt), null, 2)}\n`,
  },
  ...definition.agents.map((agent) => ({
    relativePath: `.harness/agents/${safeSegment(agent.id)}.md`,
    kind: "agent" as const,
    content: renderAgent(agent),
  })),
  ...definition.skills.map((skill) => ({
    relativePath: `.harness/skills/${safeSegment(skill.name)}/skill.md`,
    kind: "skill" as const,
    content: renderSkill({
      name: skill.name,
      description: skill.description,
      workflows: workflowsForSkill(definition, skill.id),
    }),
  })),
];

const exportClaudeProjection = (
  definition: HarnessDefinition,
): HarnessPackageExportFile[] => [
  {
    relativePath: ".claude/CLAUDE.md",
    kind: "overview",
    content: renderOverview(definition),
  },
  ...definition.agents.map((agent) => ({
    relativePath: `.claude/agents/${safeSegment(agent.id)}.md`,
    kind: "agent" as const,
    content: renderAgent(agent),
  })),
  ...definition.skills.map((skill) => ({
    relativePath: `.claude/skills/${safeSegment(skill.name)}/skill.md`,
    kind: "skill" as const,
    content: renderSkill({
      name: skill.name,
      description: skill.description,
      workflows: workflowsForSkill(definition, skill.id),
    }),
  })),
];

const exportCodexProjection = (
  definition: HarnessDefinition,
): HarnessPackageExportFile[] => [
  {
    relativePath: "AGENTS.md",
    kind: "policy",
    content: renderCodexAgents(definition),
  },
  ...definition.skills.map((skill) => ({
    relativePath: `skills/${safeSegment(skill.name)}/SKILL.md`,
    kind: "skill" as const,
    content: renderSkill({
      name: skill.name,
      description: skill.description,
      workflows: workflowsForSkill(definition, skill.id),
    }),
  })),
];

const renderOverview = (definition: HarnessDefinition): string =>
  [
    `# ${definition.name}`,
    "",
    definition.overview.summary || "(no summary)",
    "",
    "## Source",
    "",
    `- Package ID: \`${definition.id}\``,
    `- Source format: \`${definition.source.format}\``,
    `- Validation: \`${definition.validation.status}\``,
    "",
    "## Workflows",
    "",
    ...definition.workflows.flatMap((workflow) => [
      `- ${workflow.name} (${workflow.steps.length} steps)`,
    ]),
    "",
  ].join("\n");

const renderAgent = (agent: HarnessAgentDefinition): string =>
  [
    "---",
    `name: ${frontmatterString(agent.name)}`,
    `description: ${frontmatterString(agent.description)}`,
    "---",
    "",
    `# ${agent.name}`,
    "",
    agent.persona || agent.description || "(no persona)",
    "",
    ...(agent.responsibilities.length > 0
      ? [
          "## Responsibilities",
          "",
          ...agent.responsibilities.map((item) => `- ${item}`),
          "",
        ]
      : []),
  ].join("\n");

const renderSkill = (input: {
  name: string;
  description: string;
  workflows: readonly HarnessWorkflowDefinition[];
}): string =>
  [
    "---",
    `name: ${frontmatterString(input.name)}`,
    `description: ${frontmatterString(input.description)}`,
    "---",
    "",
    `# ${input.name}`,
    "",
    input.description || "(no description)",
    "",
    ...input.workflows.flatMap(renderWorkflow),
  ].join("\n");

const renderWorkflow = (workflow: HarnessWorkflowDefinition): string[] => [
  `## ${workflow.name}`,
  "",
  workflow.description || "(no workflow description)",
  "",
  "## Execution Mode",
  "",
  `**${workflow.mode}**`,
  "",
  "## Workflow",
  "",
  "| Order | Task | Owner | Depends On | Deliverable |",
  "|-------|------|-------|------------|-------------|",
  ...workflow.steps.map((step, index) => workflowStepRow(workflow.steps, step, index)),
  "",
];

const workflowStepRow = (
  steps: readonly HarnessWorkflowStep[],
  step: HarnessWorkflowStep,
  index: number,
): string => {
  const orderByStepId = new Map(
    steps.map((candidate, candidateIndex) => [
      candidate.id,
      orderLabel(candidate, candidateIndex),
    ]),
  );
  const dependsOn =
    step.dependsOn.length === 0
      ? "None"
      : step.dependsOn
          .map((id) => `Task ${orderByStepId.get(id) ?? id}`)
          .join(", ");
  const deliverable =
    step.artifactContracts
      .map((artifact) => artifact.pathHint ?? artifact.title)
      .filter((value) => value.trim().length > 0)
      .join(", ") || "(advisory output)";
  const owner = (step.agentRef ?? step.roleHint) || "agent";
  return `| ${orderLabel(step, index)} | ${escapeTableCell(step.title)} | ${escapeTableCell(owner)} | ${escapeTableCell(dependsOn)} | ${escapeTableCell(deliverable)} |`;
};

const renderCodexAgents = (definition: HarnessDefinition): string =>
  [
    "# AGENTS.md",
    "",
    "## Mission",
    "",
    definition.overview.summary || definition.name,
    "",
    "## Imported Agent Roles",
    "",
    ...(definition.agents.length > 0
      ? definition.agents.map(
          (agent) => `- ${agent.name}: ${agent.description || agent.roleHint}`,
        )
      : ["- No dedicated agent role files were present in the source package."]),
    "",
    "## Policy",
    "",
    "- Treat generated files as declarations only.",
    "- Do not execute side effects without HarnessAgentOS approval.",
    "- Bind concrete AgentProfiles before running package-derived workflows.",
    "",
  ].join("\n");

const workflowsForSkill = (
  definition: HarnessDefinition,
  skillId: string,
): HarnessWorkflowDefinition[] =>
  definition.workflows.filter((workflow) => workflow.skillId === skillId);

const nativeManifest = (
  definition: HarnessDefinition,
  exportedAt: string,
): Record<string, unknown> => ({
  schema: "harness.agentos.package.v1",
  exportedAt,
  package: {
    id: definition.id,
    name: definition.name,
    version: definition.version,
    overview: definition.overview,
    agents: definition.agents,
    skills: definition.skills,
    workflows: definition.workflows,
    capabilities: definition.capabilities,
    validation: definition.validation,
    repair: definition.repair,
  },
});

const exportWarnings = (
  definition: HarnessDefinition,
  targetFormat: HarnessSourceFormat,
): string[] => {
  const warnings: string[] = [
    "Export preview contains declarations only; it excludes TaskRun state, approvals, runtime artifacts, and secrets.",
  ];
  if (targetFormat === "codex" && definition.agents.length > 0) {
    warnings.push(
      "Codex projection flattens source agent role files into AGENTS.md guidance because Codex skills do not carry Claude-style per-agent markdown files.",
    );
  }
  if (targetFormat === "claude" && definition.source.format !== "claude") {
    warnings.push(
      "Claude projection is a compatibility view and may not preserve source-specific Codex or native policy semantics.",
    );
  }
  if (targetFormat === "harness-native") {
    warnings.push(
      "Native manifest is advisory for round-trip metadata; markdown files remain the current import source.",
    );
  }
  return warnings;
};

const orderLabel = (step: HarnessWorkflowStep, index: number): string =>
  step.id.match(/^step-(.+)$/)?.[1] ?? String(index + 1);

const frontmatterString = (value: string): string =>
  JSON.stringify(value.replace(/\r\n/g, "\n"));

const safeSegment = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "item";
};

const escapeTableCell = (value: string): string =>
  value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
