import { createHash } from "node:crypto";
import type {
  ApprovalActionType,
  HarnessAgentDefinition,
  HarnessArtifactContract,
  HarnessDefinition,
  HarnessOverview,
  HarnessSkillDefinition,
  HarnessSourceFileKind,
  HarnessSourceFileSnapshot,
  HarnessSourceFormat,
  HarnessValidationIssue,
  HarnessWorkflowDefinition,
  HarnessWorkflowStep,
  WorkerOutputContract,
} from "@harness/core";
import {
  detectHarnessSourceFormat,
  type HarnessSourceDetectionResult,
} from "./harness-source-detection.ts";

export const HARNESS_IMPORT_ADAPTER_VERSION = "harness-import-v1";

export interface HarnessSourceFileInput {
  relativePath: string;
  content: string;
}

export interface ImportHarnessPackageInput {
  rootDir: string;
  files: readonly HarnessSourceFileInput[];
  importedAt?: string;
  adapterVersion?: string;
  id?: string;
}

export type ImportHarnessPackageResult =
  | { ok: true; definition: HarnessDefinition; detection: HarnessSourceDetectionResult }
  | { ok: false; detection: HarnessSourceDetectionResult; issues: readonly HarnessValidationIssue[] };

interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

interface NormalizedSourceFile {
  relativePath: string;
  lowerPath: string;
  content: string;
}

export const importHarnessPackageFromFiles = (
  input: ImportHarnessPackageInput,
): ImportHarnessPackageResult => {
  const adapterVersion = input.adapterVersion ?? HARNESS_IMPORT_ADAPTER_VERSION;
  const importedAt = input.importedAt ?? new Date().toISOString();
  const files = input.files.map(normalizeSourceFile).filter(isNotNull);
  const detection = detectHarnessSourceFormat({
    rootDir: input.rootDir,
    relativePaths: files.map((file) => file.relativePath),
  });

  if (detection.status !== "detected" || detection.format === undefined) {
    return {
      ok: false,
      detection,
      issues: [
        {
          severity: "error",
          code:
            detection.status === "ambiguous"
              ? "HARNESS_SOURCE_AMBIGUOUS"
              : "HARNESS_SOURCE_UNSUPPORTED",
          message: detection.reasons.join(" "),
          blocksExecution: true,
        },
      ],
    };
  }

  const sourceFormat = detection.format;
  const sourceFiles = files.map((file) =>
    toSourceFileSnapshot(file, sourceFormat, adapterVersion),
  );
  const overview = buildOverview(files, sourceFormat, input.rootDir);
  const agents = buildAgents(files, sourceFormat);
  const skills = buildSkills(files, sourceFormat);
  const workflows = buildWorkflows(files, sourceFormat, skills, agents);
  const issues = buildMetadataIssues({
    sourceFormat,
    skills,
    agents,
    workflows,
  });
  const status = issues.some((issue) => issue.blocksExecution)
    ? "needs_review"
    : issues.length > 0
      ? "valid_with_warnings"
      : "valid";
  const definition: HarnessDefinition = {
    id: input.id ?? `harness_${slugFromName(overview.title)}`,
    name: overview.title,
    source: {
      format: sourceFormat,
      rootDir: input.rootDir,
      importedAt,
      files: sourceFiles,
    },
    overview,
    agents,
    skills,
    workflows,
    capabilities: [],
    validation: {
      status,
      issues,
      importedAt,
      adapterVersion,
    },
  };
  return { ok: true, definition, detection };
};

const buildOverview = (
  files: readonly NormalizedSourceFile[],
  sourceFormat: HarnessSourceFormat,
  rootDir: string,
): HarnessOverview => {
  const overviewFile = files.find(
    (file) => classifySourceFile(file.lowerPath, sourceFormat) === "overview",
  );
  if (overviewFile) {
    const parsed = parseMarkdown(overviewFile.content);
    const title = firstHeading(parsed.body) ?? basename(rootDir);
    return {
      title,
      summary: firstParagraph(parsed.body, title),
    };
  }
  const firstSkill = buildSkills(files, sourceFormat)[0];
  const fallbackTitle = firstSkill?.name ?? basename(rootDir);
  return {
    title: fallbackTitle,
    summary: firstSkill?.description ?? "",
  };
};

const buildAgents = (
  files: readonly NormalizedSourceFile[],
  sourceFormat: HarnessSourceFormat,
): HarnessAgentDefinition[] =>
  files
    .filter((file) => classifySourceFile(file.lowerPath, sourceFormat) === "agent")
    .map((file) => {
      const parsed = parseMarkdown(file.content);
      const id = idFromAgentPath(file.relativePath);
      const name = stringFrontmatter(parsed.frontmatter, "name") ?? titleFromId(id);
      const description =
        stringFrontmatter(parsed.frontmatter, "description") ?? "";
      return {
        id,
        name,
        description,
        roleHint: id,
        sourceFile: file.relativePath,
        persona: parsed.body.trim(),
        responsibilities: [],
        requiredCapabilities: [],
      };
    });

const buildSkills = (
  files: readonly NormalizedSourceFile[],
  sourceFormat: HarnessSourceFormat,
): HarnessSkillDefinition[] =>
  files
    .filter((file) => classifySourceFile(file.lowerPath, sourceFormat) === "skill")
    .map((file) => {
      const parsed = parseMarkdown(file.content);
      const id =
        stringFrontmatter(parsed.frontmatter, "name") ??
        idFromSkillPath(file.relativePath);
      const description =
        stringFrontmatter(parsed.frontmatter, "description") ?? "";
      return {
        id,
        name: id,
        description,
        triggerTerms: [],
        negativeTriggerTerms: [],
        sourceFile: file.relativePath,
        workflowRefs: [],
        relatedSkillRefs: [],
        rawFrontmatter: parsed.frontmatter,
      };
    });

const buildWorkflows = (
  files: readonly NormalizedSourceFile[],
  sourceFormat: HarnessSourceFormat,
  skills: readonly HarnessSkillDefinition[],
  agents: readonly HarnessAgentDefinition[],
): HarnessWorkflowDefinition[] => {
  const workflows: HarnessWorkflowDefinition[] = [];
  for (const file of files) {
    if (classifySourceFile(file.lowerPath, sourceFormat) !== "skill") {
      continue;
    }
    const skill = skills.find((item) => item.sourceFile === file.relativePath);
    if (!skill) continue;
    const workflow = buildWorkflowFromSkillFile(file, skill, agents);
    if (workflow) workflows.push(workflow);
  }
  return workflows;
};

const buildWorkflowFromSkillFile = (
  file: NormalizedSourceFile,
  skill: HarnessSkillDefinition,
  agents: readonly HarnessAgentDefinition[],
): HarnessWorkflowDefinition | null => {
  const parsed = parseMarkdown(file.content);
  const table = findWorkflowTable(parsed.body);
  if (!table) return null;
  const steps = workflowRowsToSteps(table.rows, file, agents);
  if (steps.length === 0) return null;
  return {
    id: `${skill.id}-workflow`,
    skillId: skill.id,
    name: `${skill.name} workflow`,
    mode: extractExecutionMode(parsed.body) ?? "agent-team",
    description: skill.description,
    sourceFile: file.relativePath,
    phases: [
      {
        id: "workflow",
        title: "Workflow",
        owner: "orchestrator",
        summary: "Parsed from the source package workflow table.",
      },
    ],
    steps,
    handoffPolicy: {
      mode: "source_message_semantics",
      routes: steps.flatMap((step) =>
        step.dependsOn.map((fromStepId) => ({
          fromStepId,
          toStepId: step.id,
          summary: `${fromStepId} -> ${step.id}`,
        })),
      ),
      requiredPayload: "harness_worker_handoff_v1",
      fallback: "synthesize_from_artifact",
    },
    failurePolicy: {
      defaultMode: "pause_for_review",
      maxAttempts: detectMaxAttempts(parsed.body),
      rules: [],
    },
    testScenarios: [],
    parseConfidence: "medium",
  };
};

interface MarkdownTable {
  headers: readonly string[];
  rows: readonly Readonly<Record<string, string>>[];
}

const findWorkflowTable = (body: string): MarkdownTable | null => {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length - 1; i += 1) {
    const header = splitMarkdownTableRow(lines[i] ?? "");
    if (header.length === 0) continue;
    if (!isMarkdownTableSeparator(lines[i + 1] ?? "")) continue;
      const normalizedHeaders = canonicalizeWorkflowHeaders(header);
      if (!isWorkflowTableHeader(normalizedHeaders)) continue;

    const rows: Array<Record<string, string>> = [];
    for (let j = i + 2; j < lines.length; j += 1) {
      const cells = splitMarkdownTableRow(lines[j] ?? "");
      if (cells.length === 0) break;
      const row: Record<string, string> = {};
      for (let c = 0; c < normalizedHeaders.length; c += 1) {
        row[normalizedHeaders[c]!] = cells[c] ?? "";
      }
      rows.push(row);
    }
    return { headers: normalizedHeaders, rows };
  }
  return null;
};

const workflowRowsToSteps = (
  rows: readonly Readonly<Record<string, string>>[],
  file: NormalizedSourceFile,
  agents: readonly HarnessAgentDefinition[],
): HarnessWorkflowStep[] => {
  const orderToStepId = new Map<string, string>();
  for (const row of rows) {
    const order = normalizeOrder(row.order);
    if (order) orderToStepId.set(order, `step-${slugFromName(order)}`);
  }
  const parallelGroups = countOrderGroups([...orderToStepId.keys()]);

  return rows
    .map((row): HarnessWorkflowStep | null => {
      const order = normalizeOrder(row.order);
      if (!order) return null;
      const id = orderToStepId.get(order);
      if (!id) return null;
      const title = stripMarkdown(row.task ?? "") || `Task ${order}`;
      const owner = stripMarkdown(row.owner ?? "") || "agent";
      const roleHint = roleHintFromOwner(owner);
      const artifactContracts = deliverablesToArtifactContracts(
        row.deliverable,
        id,
      );
      const allowedActions: ApprovalActionType[] =
        artifactContracts.length > 0 ? ["file_write"] : [];
      const orderGroup = order.match(/^(\d+)/)?.[1];
      const parallelGroup =
        orderGroup && (parallelGroups.get(orderGroup) ?? 0) > 1
          ? `order-${orderGroup}`
          : undefined;
      return {
        id,
        title,
        agentRef:
          roleHint === "orchestrator"
            ? undefined
            : (resolveAgentRef(owner, agents) ?? undefined),
        roleHint,
        phaseId: "workflow",
        instruction: buildStepInstruction(title, owner, artifactContracts),
        dependsOn: parseDependsOn(row["depends on"], orderToStepId, id),
        ...(parallelGroup ? { parallelGroup } : {}),
        artifactContracts,
        allowedActions,
        outputContract: inferOutputContract(title, owner),
        sourceRef: {
          relativePath: file.relativePath,
          heading: "Workflow",
        },
      };
    })
    .filter(isNotNull);
};

const buildMetadataIssues = (input: {
  sourceFormat: HarnessSourceFormat;
  skills: readonly HarnessSkillDefinition[];
  agents: readonly HarnessAgentDefinition[];
  workflows: readonly HarnessWorkflowDefinition[];
}): HarnessValidationIssue[] => {
  const issues: HarnessValidationIssue[] = [];
  if (input.skills.length === 0) {
    issues.push({
      severity: "error",
      code: "HARNESS_SKILLS_MISSING",
      message: "No skill files were imported from the detected harness package.",
      blocksExecution: true,
    });
  }
  for (const skill of input.skills) {
    if (skill.description.trim().length === 0) {
      issues.push({
        severity: "warning",
        code: "HARNESS_SKILL_DESCRIPTION_MISSING",
        message: `Skill ${skill.id} does not declare a description.`,
        sourceRef: { relativePath: skill.sourceFile },
        blocksExecution: false,
      });
    }
  }
  if (input.sourceFormat !== "codex" && input.agents.length === 0) {
    issues.push({
      severity: "warning",
      code: "HARNESS_AGENTS_MISSING",
      message:
        "No agent role files were imported. AgentProfile binding will require manual setup.",
      blocksExecution: false,
    });
  }
  if (input.workflows.length === 0) {
    issues.push({
      severity: "warning",
      code: "HARNESS_WORKFLOW_PARSE_PENDING",
      message:
        "Workflow tables and dependency edges were not parsed, so execution requires manual repair.",
      blocksExecution: true,
    });
  } else {
    for (const workflow of input.workflows) {
      for (const step of workflow.steps) {
        if (!step.agentRef && step.roleHint !== "orchestrator") {
          issues.push({
            severity: "warning",
            code: "HARNESS_AGENT_REFERENCE_UNRESOLVED",
            message: `Workflow step ${step.id} owner "${step.roleHint}" could not be mapped to an imported agent.`,
            sourceRef: step.sourceRef,
            blocksExecution: true,
          });
        }
      }
    }
    issues.push({
      severity: "warning",
      code: "HARNESS_PROFILE_BINDING_REQUIRED",
      message:
        "Workflow steps were parsed, but abstract agents still require explicit AgentProfile binding before conversion or execution.",
      blocksExecution: true,
    });
  }
  return issues;
};

const toSourceFileSnapshot = (
  file: NormalizedSourceFile,
  sourceFormat: HarnessSourceFormat,
  parserVersion: string,
): HarnessSourceFileSnapshot => ({
  relativePath: file.relativePath,
  kind: classifySourceFile(file.lowerPath, sourceFormat),
  sha256: sha256(file.content),
  parserVersion,
});

const classifySourceFile = (
  lowerPath: string,
  sourceFormat: HarnessSourceFormat,
): HarnessSourceFileKind => {
  switch (sourceFormat) {
    case "claude":
      if (lowerPath === ".claude/claude.md") return "overview";
      if (/^\.claude\/agents\/[^/]+\.md$/.test(lowerPath)) return "agent";
      if (/^\.claude\/skills\/[^/]+\/skill\.md$/.test(lowerPath)) {
        return "skill";
      }
      return "unknown";
    case "codex":
      if (lowerPath === "agents.md") return "policy";
      if (/^skills\/[^/]+\/skill\.md$/.test(lowerPath)) return "skill";
      return "unknown";
    case "harness-native":
      if (lowerPath === ".harness/harness.md") return "overview";
      if (lowerPath === ".harness/manifest.json") return "manifest";
      if (/^\.harness\/agents\/[^/]+\.md$/.test(lowerPath)) return "agent";
      if (/^\.harness\/skills\/[^/]+\/skill\.md$/.test(lowerPath)) {
        return "skill";
      }
      return "unknown";
  }
};

const parseMarkdown = (content: string): ParsedMarkdown => {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized };
  }
  const closeIndex = normalized.indexOf("\n---\n", 4);
  if (closeIndex === -1) {
    return { frontmatter: {}, body: normalized };
  }
  const frontmatterText = normalized.slice(4, closeIndex);
  const body = normalized.slice(closeIndex + "\n---\n".length);
  return {
    frontmatter: parseSimpleFrontmatter(frontmatterText),
    body,
  };
};

const splitMarkdownTableRow = (line: string): string[] => {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return [];
  const cells = trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
  return cells.some((cell) => cell.length > 0) ? cells : [];
};

const isMarkdownTableSeparator = (line: string): boolean => {
  const cells = splitMarkdownTableRow(line);
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")))
  );
};

const canonicalizeWorkflowHeaders = (headers: readonly string[]): string[] => {
  const normalized = headers.map(normalizeTableHeader);
  if (isWorkflowTableHeader(normalized)) return normalized;
  if (isPositionalWorkflowTableHeader(normalized)) {
    return [
      "order",
      "task",
      "owner",
      "depends on",
      "deliverable",
      ...normalized.slice(5),
    ];
  }
  return normalized;
};

const normalizeTableHeader = (value: string): string => {
  const normalized = stripMarkdown(value).toLowerCase().replace(/\s+/g, " ");
  switch (normalized) {
    case "order":
    case "step":
    case "sequence":
    case "순서":
      return "order";
    case "task":
    case "작업":
      return "task";
    case "owner":
    case "assigned to":
    case "assignee":
    case "agent":
    case "responsible":
    case "담당":
      return "owner";
    case "depends on":
    case "depends":
    case "dependency":
    case "dependencies":
    case "의존":
      return "depends on";
    case "deliverable":
    case "deliverables":
    case "output":
    case "outputs":
    case "artifact":
    case "artifacts":
    case "산출물":
      return "deliverable";
    default:
      return normalized;
  }
};

const isWorkflowTableHeader = (headers: readonly string[]): boolean =>
  headers.includes("order") &&
  headers.includes("task") &&
  headers.includes("owner") &&
  headers.includes("depends on") &&
  headers.includes("deliverable");

const isPositionalWorkflowTableHeader = (
  headers: readonly string[],
): boolean =>
  headers.length === 5 &&
  (headers[0] === "order" ||
    headers[3] === "depends on" ||
    headers[3] === "of");

const normalizeOrder = (value: string | undefined): string =>
  stripMarkdown(value ?? "").toLowerCase().replace(/\s+/g, "");

const countOrderGroups = (orders: readonly string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const order of orders) {
    const group = order.match(/^(\d+)/)?.[1];
    if (!group) continue;
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return counts;
};

const parseDependsOn = (
  value: string | undefined,
  orderToStepId: ReadonlyMap<string, string>,
  currentStepId: string,
): string[] => {
  const normalized = stripMarkdown(value ?? "").toLowerCase();
  if (
    normalized.length === 0 ||
    normalized === "none" ||
    normalized === "n/a" ||
    normalized === "없음"
  ) {
    return [];
  }
  const stepIds = [...orderToStepId.values()];
  if (normalized === "all" || normalized === "전체") {
    return stepIds.filter((stepId) => stepId !== currentStepId);
  }
  const out: string[] = [];
  const rangePattern = /\b(\d+[a-z]?)(?:\s*(?:-|~|to|through)\s*)(\d+[a-z]?)\b/g;
  for (const match of normalized.matchAll(rangePattern)) {
    for (const stepId of stepIdsInRange(match[1], match[2], orderToStepId)) {
      if (stepId !== currentStepId && !out.includes(stepId)) out.push(stepId);
    }
  }
  const withoutRanges = normalized.replace(rangePattern, " ");
  for (const match of withoutRanges.matchAll(/\b\d+[a-z]?\b/g)) {
    const stepId = orderToStepId.get(match[0]);
    if (stepId && stepId !== currentStepId && !out.includes(stepId)) {
      out.push(stepId);
    }
  }
  return out;
};

const stepIdsInRange = (
  fromOrder: string | undefined,
  toOrder: string | undefined,
  orderToStepId: ReadonlyMap<string, string>,
): string[] => {
  if (!fromOrder || !toOrder) return [];
  const orders = [...orderToStepId.keys()];
  const fromIndex = orders.indexOf(fromOrder);
  const toIndex = orders.indexOf(toOrder);
  if (fromIndex < 0 || toIndex < 0 || fromIndex > toIndex) return [];
  return orders
    .slice(fromIndex, toIndex + 1)
    .map((order) => orderToStepId.get(order))
    .filter(isString);
};

const deliverablesToArtifactContracts = (
  value: string | undefined,
  stepId: string,
): HarnessArtifactContract[] => {
  const raw = value ?? "";
  const codeSpans = [...raw.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((item) => item.length > 0);
  const items =
    codeSpans.length > 0
      ? codeSpans
      : raw
          .split(",")
          .map((item) => stripMarkdown(item))
          .filter((item) => item.length > 0);
  return items.map((item, index) => ({
    id: `${stepId}-artifact-${index + 1}`,
    pathHint: item,
    title: artifactTitle(item),
    kind: "workspace_file",
    required: true,
    description: item,
  }));
};

const buildStepInstruction = (
  title: string,
  owner: string,
  artifactContracts: readonly HarnessArtifactContract[],
): string => {
  const deliverables = artifactContracts.map((item) => item.pathHint).filter(isString);
  const parts = [`${owner}: ${title}`];
  if (deliverables.length > 0) {
    parts.push(`Expected deliverables: ${deliverables.join(", ")}`);
  }
  return parts.join("\n");
};

const resolveAgentRef = (
  owner: string,
  agents: readonly HarnessAgentDefinition[],
): string | null => {
  const ownerId = slugFromName(owner);
  if (ownerId.length === 0) return null;
  const exact = agents.find((agent) => agent.id === ownerId);
  if (exact) return exact.id;
  const partial = agents.find((agent) => {
    const parts = agent.id.split(/[-_]/).filter(Boolean);
    return agent.id.includes(ownerId) || parts.includes(ownerId);
  });
  if (partial) return partial.id;
  const ownerTokens = ownerId.split(/[-_]/).filter(Boolean);
  const tokenMatches = agents.filter((agent) => {
    const agentTokens = agent.id.split(/[-_]/).filter(Boolean);
    return ownerTokens.every((ownerToken) =>
      agentTokens.some((agentToken) => tokensMatch(ownerToken, agentToken)),
    );
  });
  return tokenMatches.length === 1 ? tokenMatches[0]!.id : null;
};

const roleHintFromOwner = (owner: string): string => {
  const normalized = stripMarkdown(owner).toLowerCase();
  if (
    normalized === "orchestrator" ||
    normalized === "오케스트레이터" ||
    normalized === "system" ||
    normalized === "user"
  ) {
    return "orchestrator";
  }
  return slugFromName(owner);
};

const tokensMatch = (ownerToken: string, agentToken: string): boolean => {
  if (ownerToken === agentToken) return true;
  const aliases = TOKEN_ALIASES[ownerToken] ?? [];
  if (aliases.includes(agentToken)) return true;
  if (aliases.some((alias) => agentToken.startsWith(alias))) return true;
  if (ownerToken.length >= 4 && agentToken.startsWith(ownerToken.slice(0, 4))) {
    return true;
  }
  if (agentToken.length >= 4 && ownerToken.startsWith(agentToken.slice(0, 4))) {
    return true;
  }
  return false;
};

const TOKEN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  comm: ["communication"],
  obs: ["observability"],
  mgr: ["manager"],
  integrator: ["integration"],
  tester: ["test"],
  optimizer: ["optimization"],
  evaluator: ["evaluation"],
};

const inferOutputContract = (
  title: string,
  owner: string,
): WorkerOutputContract => {
  const text = `${title} ${owner}`.toLowerCase();
  if (/\b(review|validate|검증|리뷰)\b/.test(text)) return "review";
  if (/\b(test|qa|테스트)\b/.test(text)) return "test_result";
  return "plan";
};

const extractExecutionMode = (body: string): string | null => {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const index = lines.findIndex((line) =>
    /^##\s+execution mode/i.test(line.trim()),
  );
  if (index < 0) return null;
  for (const line of lines.slice(index + 1, index + 6)) {
    const bold = /\*\*([^*]+)\*\*/.exec(line);
    if (bold?.[1]) return slugFromName(bold[1]);
    const stripped = stripMarkdown(line);
    if (stripped.length > 0) return slugFromName(stripped);
  }
  return null;
};

const detectMaxAttempts = (body: string): number => {
  const lower = body.toLowerCase();
  const roundMatch = /up to\s+(\d+)\s+rounds?/.exec(lower);
  const retryMatch = /retry\s+(\d+)\s+times?/.exec(lower);
  const numeric = Number(roundMatch?.[1] ?? retryMatch?.[1] ?? NaN);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 5) {
    return numeric;
  }
  if (/retry once/.test(lower)) return 1;
  return 2;
};

const stripMarkdown = (value: string): string =>
  value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

const artifactTitle = (path: string): string => {
  const normalized = path.replaceAll("\\", "/");
  const name = normalized.split("/").filter(Boolean).at(-1) ?? normalized;
  return name.replace(/\.[^.]+$/, "") || path;
};

const parseSimpleFrontmatter = (raw: string): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    if (!key) continue;
    out[key] = unquoteFrontmatterValue(rawValue);
  }
  return out;
};

const unquoteFrontmatterValue = (value: string): string => {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
};

const firstHeading = (body: string): string | null => {
  const line = body
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.startsWith("# "));
  return line ? line.replace(/^#\s+/, "").trim() : null;
};

const firstParagraph = (body: string, fallback: string): string => {
  const paragraph = body
    .split(/\n\s*\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0 && !item.startsWith("#"));
  return paragraph ?? fallback;
};

const normalizeSourceFile = (
  input: HarnessSourceFileInput,
): NormalizedSourceFile | null => {
  const relativePath = normalizeRelativePath(input.relativePath);
  if (!relativePath) return null;
  return {
    relativePath,
    lowerPath: relativePath.toLowerCase(),
    content: input.content,
  };
};

const normalizeRelativePath = (path: string): string =>
  path
    .trim()
    .replaceAll("\\", "/")
    .replaceAll(/\/+/g, "/")
    .replace(/^\.?\//, "")
    .replace(/\/$/, "");

const idFromAgentPath = (relativePath: string): string => {
  const name = basename(relativePath).replace(/\.md$/i, "");
  return slugFromName(name);
};

const idFromSkillPath = (relativePath: string): string => {
  const parts = relativePath.replaceAll("\\", "/").split("/");
  const skillIndex = parts.findIndex((part) => part.toLowerCase() === "skills");
  const name = skillIndex >= 0 ? parts[skillIndex + 1] : basename(relativePath);
  return slugFromName(name ?? "skill");
};

const basename = (path: string): string => {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
  const last = normalized.split("/").filter(Boolean).at(-1);
  return last && last.length > 0 ? last : "harness";
};

const titleFromId = (id: string): string =>
  id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");

const slugFromName = (value: string): string => {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "harness";
};

const stringFrontmatter = (
  frontmatter: Record<string, unknown>,
  key: string,
): string | null => {
  const value = frontmatter[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const sha256 = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

const isString = (value: string | undefined): value is string =>
  value !== undefined;

const isNotNull = <T>(value: T | null): value is T => value !== null;
