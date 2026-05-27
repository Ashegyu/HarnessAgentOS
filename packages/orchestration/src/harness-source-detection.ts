import type {
  HarnessSourceDetectionCandidate,
  HarnessSourceDetectionInput,
  HarnessSourceDetectionResult,
} from "@harness/core";
export type {
  HarnessSourceDetectionCandidate,
  HarnessSourceDetectionInput,
  HarnessSourceDetectionResult,
  HarnessSourceDetectionStatus,
} from "@harness/core";

interface NormalizedPathSet {
  lower: ReadonlySet<string>;
  byLower: ReadonlyMap<string, string>;
}

export const detectHarnessSourceFormat = (
  input: HarnessSourceDetectionInput,
): HarnessSourceDetectionResult => {
  const paths = normalizePaths(input.relativePaths);
  const candidates = [
    detectClaudeCandidate(paths),
    detectCodexCandidate(paths),
    detectNativeCandidate(paths),
  ]
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.format.localeCompare(b.format));

  const completeCandidates = candidates.filter((candidate) => candidate.complete);
  if (completeCandidates.length === 1) {
    const winner = completeCandidates[0]!;
    return {
      rootDir: input.rootDir,
      status: "detected",
      format: winner.format,
      candidates,
      reasons: [`Detected ${winner.format} harness package.`],
    };
  }

  if (completeCandidates.length > 1) {
    return {
      rootDir: input.rootDir,
      status: "ambiguous",
      candidates,
      reasons: [
        `Multiple complete harness package formats found: ${completeCandidates
          .map((candidate) => candidate.format)
          .join(", ")}.`,
      ],
    };
  }

  return {
    rootDir: input.rootDir,
    status: "unsupported",
    candidates,
    reasons:
      candidates.length > 0
        ? candidates.map(
            (candidate) =>
              `${candidate.format} candidate is incomplete: missing ${candidate.missing.join(", ")}.`,
          )
        : ["No supported harness package markers found."],
  };
};

const detectClaudeCandidate = (
  paths: NormalizedPathSet,
): HarnessSourceDetectionCandidate => {
  const overview = findExact(paths, ".claude/claude.md");
  const skills = findAny(paths, /^\.claude\/skills\/[^/]+\/skill\.md$/);
  const agents = findAny(paths, /^\.claude\/agents\/[^/]+\.md$/);
  const evidence = [overview, skills, agents].filter(isString);
  const missing = [
    ...(overview ? [] : [".claude/CLAUDE.md"]),
    ...(skills ? [] : [".claude/skills/*/skill.md"]),
  ];
  return {
    format: "claude",
    score: (overview ? 3 : 0) + (skills ? 3 : 0) + (agents ? 1 : 0),
    complete: overview !== null && skills !== null,
    evidence,
    missing,
  };
};

const detectCodexCandidate = (
  paths: NormalizedPathSet,
): HarnessSourceDetectionCandidate => {
  const agents = findExact(paths, "agents.md");
  const skills = findAny(paths, /^skills\/[^/]+\/skill\.md$/);
  const evidence = [agents, skills].filter(isString);
  const missing = skills ? [] : ["skills/*/SKILL.md"];
  return {
    format: "codex",
    score: (agents ? 2 : 0) + (skills ? 3 : 0),
    complete: skills !== null,
    evidence,
    missing,
  };
};

const detectNativeCandidate = (
  paths: NormalizedPathSet,
): HarnessSourceDetectionCandidate => {
  const overview = findExact(paths, ".harness/harness.md");
  const manifest = findExact(paths, ".harness/manifest.json");
  const skills = findAny(paths, /^\.harness\/skills\/[^/]+\/skill\.md$/);
  const agents = findAny(paths, /^\.harness\/agents\/[^/]+\.md$/);
  const evidence = [overview, manifest, skills, agents].filter(isString);
  const hasOverviewOrManifest = overview !== null || manifest !== null;
  const missing = [
    ...(hasOverviewOrManifest
      ? []
      : [".harness/HARNESS.md or .harness/manifest.json"]),
    ...(skills ? [] : [".harness/skills/*/SKILL.md"]),
  ];
  return {
    format: "harness-native",
    score:
      (overview ? 3 : 0) +
      (manifest ? 3 : 0) +
      (skills ? 3 : 0) +
      (agents ? 1 : 0),
    complete: hasOverviewOrManifest && skills !== null,
    evidence,
    missing,
  };
};

const normalizePaths = (
  relativePaths: readonly string[],
): NormalizedPathSet => {
  const byLower = new Map<string, string>();
  for (const rawPath of relativePaths) {
    const normalized = normalizeRelativePath(rawPath);
    if (!normalized) continue;
    const lower = normalized.toLowerCase();
    if (!byLower.has(lower)) byLower.set(lower, normalized);
  }
  return {
    lower: new Set(byLower.keys()),
    byLower,
  };
};

const normalizeRelativePath = (path: string): string =>
  path
    .replaceAll("\\", "/")
    .replaceAll(/\/+/g, "/")
    .replace(/^\.?\//, "")
    .replace(/\/$/, "")
    .trim();

const findExact = (
  paths: NormalizedPathSet,
  lowerPath: string,
): string | null => paths.byLower.get(lowerPath) ?? null;

const findAny = (
  paths: NormalizedPathSet,
  pattern: RegExp,
): string | null => {
  for (const lowerPath of paths.lower) {
    if (pattern.test(lowerPath)) {
      return paths.byLower.get(lowerPath) ?? lowerPath;
    }
  }
  return null;
};

const isString = (value: string | null): value is string => value !== null;
