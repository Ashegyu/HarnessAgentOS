import { createHash } from "node:crypto";
import type {
  HarnessAgentDefinition,
  HarnessDefinition,
  HarnessOverview,
  HarnessSkillDefinition,
  HarnessSourceFileKind,
  HarnessSourceFileSnapshot,
  HarnessSourceFormat,
  HarnessValidationIssue,
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
  const issues = buildMetadataIssues({ sourceFormat, skills, agents });
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
    workflows: [],
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

const buildMetadataIssues = (input: {
  sourceFormat: HarnessSourceFormat;
  skills: readonly HarnessSkillDefinition[];
  agents: readonly HarnessAgentDefinition[];
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
  issues.push({
    severity: "warning",
    code: "HARNESS_WORKFLOW_PARSE_PENDING",
    message:
      "Workflow tables and dependency edges are not parsed in this import slice, so execution requires manual review.",
    blocksExecution: true,
  });
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

const isNotNull = <T>(value: T | null): value is T => value !== null;
