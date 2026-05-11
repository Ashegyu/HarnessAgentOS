import type { CapabilityRiskLevel, SkillResources } from "@harness/core";
import { promises as fs } from "node:fs";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import {
  SkillMetadataError,
  type ParsedSkillFrontmatter,
  type SkillFile,
  type SkillMetadata,
} from "./skill-metadata.ts";
import { classifySkillRisk } from "./skill-risk-policy.ts";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

/**
 * Phase 5 skill loader. Walks a single trusted skill directory and
 * returns parsed SkillMetadata entries. Pure of side effects beyond
 * fs.read; never executes skill scripts.
 *
 * Layout we support: <root>/<skill>/SKILL.md (one level deep).
 */

export interface SkillLoaderInput {
  /** Absolute path of a directory that contains skill subdirectories. */
  rootDir: string;
  /**
   * Whether the rootDir is trusted (project-local skills/ or user-level
   * userData/skills/) — caller decides; loader stamps the metadata.
   */
  trusted: boolean;
}

export const loadSkills = async (
  input: SkillLoaderInput,
): Promise<SkillMetadata[]> => {
  const root = normalizeAbsolute(input.rootDir);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    // Missing directory is non-fatal; just produces no skills.
    return [];
  }
  const out: SkillMetadata[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const dir = join(root, name);
    if (!isWithin(root, dir)) continue;
    let stat;
    try {
      stat = await fs.stat(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const skillPath = join(dir, "SKILL.md");
    let raw: string;
    try {
      raw = await fs.readFile(skillPath, "utf8");
    } catch {
      continue;
    }
    const file: SkillFile = { path: skillPath, content: raw, dir };
    try {
      const parsed = parseSkillFrontmatter(file);
      const riskLevel = classifySkillRisk({
        declared: parsed.riskLevel,
        allowedActions: parsed.allowedActions,
        trusted: input.trusted,
      });
      out.push({
        id: parsed.id,
        name: parsed.name,
        description: parsed.description,
        sourceDir: dir,
        riskLevel,
        allowedActions: parsed.allowedActions,
        triggerTerms: parsed.triggerTerms,
        trusted: input.trusted,
      });
    } catch {
      // Skip malformed skill, do not throw.
    }
  }
  return out;
};

/**
 * Read SKILL.md instructions for one skill. Refuses traversal outside
 * the metadata's sourceDir.
 */
export const readSkillInstructions = async (
  metadata: SkillMetadata,
): Promise<string> => {
  const skillPath = join(metadata.sourceDir, "SKILL.md");
  if (!isWithin(metadata.sourceDir, skillPath)) {
    throw new SkillMetadataError(
      "SKILL_TRAVERSAL_BLOCKED",
      `SKILL.md path escapes sourceDir for ${metadata.id}`,
    );
  }
  return fs.readFile(skillPath, "utf8");
};

export type { SkillResources } from "@harness/core";

/**
 * List the contents of the conventional skill subdirectories.
 * Returns empty arrays for missing directories — never throws on
 * absence so the UI can render "no scripts" cleanly.
 */
export const listSkillResources = async (
  metadata: SkillMetadata,
): Promise<SkillResources> => {
  const [scripts, templates, examples] = await Promise.all([
    listChildren(metadata, "scripts"),
    listChildren(metadata, "templates"),
    listChildren(metadata, "examples"),
  ]);
  return { scripts, templates, examples };
};

const listChildren = async (
  metadata: SkillMetadata,
  subdir: string,
): Promise<string[]> => {
  const dir = join(metadata.sourceDir, subdir);
  if (!isWithin(metadata.sourceDir, dir)) return [];
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    if (!isWithin(metadata.sourceDir, full)) continue;
    try {
      const stat = await fs.stat(full);
      if (stat.isFile()) out.push(name);
    } catch {
      // skip unreadable entries
    }
  }
  return out.sort();
};

export const parseSkillFrontmatter = (
  file: SkillFile,
): ParsedSkillFrontmatter => {
  const match = FRONTMATTER_RE.exec(file.content);
  if (!match) {
    throw new SkillMetadataError(
      "SKILL_FRONTMATTER_MISSING",
      `${file.path} has no YAML frontmatter`,
    );
  }
  const yaml = match[1] ?? "";
  const fields = parseSimpleYaml(yaml);
  const name = pickString(fields, "name") ?? defaultName(file.dir);
  const description = pickString(fields, "description") ?? "";
  const declaredRisk = (pickString(fields, "risk") ??
    pickString(fields, "riskLevel") ??
    "low") as CapabilityRiskLevel;
  const allowedActions = pickStringArray(fields, "allowedActions") ?? [];
  const triggerTerms =
    pickStringArray(fields, "triggerTerms") ??
    pickStringArray(fields, "triggers") ??
    [];
  const explicitId = pickString(fields, "id");
  const id = explicitId ?? deterministicId(file.dir);
  return {
    id,
    name,
    description,
    riskLevel: normalizeRisk(declaredRisk),
    allowedActions,
    triggerTerms,
  };
};

const normalizeRisk = (raw: string): CapabilityRiskLevel => {
  const v = raw.trim().toLowerCase();
  if (v === "low" || v === "medium" || v === "high") return v;
  return "low";
};

const defaultName = (dir: string): string => {
  const base = dir.split(/[\\/]/).pop() ?? "skill";
  return base;
};

const deterministicId = (dir: string): string => {
  const hash = createHash("sha1").update(dir).digest("hex").slice(0, 12);
  return `cap_${hash}`;
};

/** Tiny YAML reader supporting `key: value` and `key:\n  - item` lists. */
const parseSimpleYaml = (yaml: string): Record<string, string | string[]> => {
  const out: Record<string, string | string[]> = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0 || line.trim().startsWith("#")) {
      i += 1;
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!m) {
      i += 1;
      continue;
    }
    const key = m[1] ?? "";
    const inlineValue = (m[2] ?? "").trim();
    if (inlineValue.length === 0) {
      // Possibly a list on subsequent indented lines.
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j] ?? "";
        const item = /^\s+-\s+(.*)$/.exec(next);
        if (!item) break;
        items.push(stripQuotes((item[1] ?? "").trim()));
        j += 1;
      }
      if (items.length > 0) {
        out[key] = items;
        i = j;
        continue;
      }
      out[key] = "";
      i += 1;
      continue;
    }
    if (inlineValue.startsWith("[") && inlineValue.endsWith("]")) {
      const inner = inlineValue.slice(1, -1).trim();
      const items =
        inner.length === 0
          ? []
          : inner.split(",").map((s) => stripQuotes(s.trim()));
      out[key] = items;
    } else {
      out[key] = stripQuotes(inlineValue);
    }
    i += 1;
  }
  return out;
};

const stripQuotes = (s: string): string => {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
};

const pickString = (
  fields: Record<string, string | string[]>,
  key: string,
): string | undefined => {
  const v = fields[key];
  if (typeof v === "string" && v.length > 0) return v;
  return undefined;
};

const pickStringArray = (
  fields: Record<string, string | string[]>,
  key: string,
): string[] | undefined => {
  const v = fields[key];
  if (Array.isArray(v)) return v.filter((x) => x.length > 0);
  return undefined;
};

const normalizeAbsolute = (p: string): string => {
  if (!isAbsolute(p)) {
    throw new SkillMetadataError(
      "SKILL_PATH_NOT_ABSOLUTE",
      `Skill root must be absolute, got ${p}`,
    );
  }
  return resolve(normalize(p));
};

const isWithin = (parent: string, child: string): boolean => {
  const normalizedParent = resolve(normalize(parent));
  const normalizedChild = resolve(normalize(child));
  if (normalizedChild === normalizedParent) return true;
  const withSep = normalizedParent.endsWith(sep)
    ? normalizedParent
    : normalizedParent + sep;
  return normalizedChild.startsWith(withSep);
};
