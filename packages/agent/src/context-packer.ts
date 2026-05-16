import type { RepoIndexFile } from "@harness/core";

export interface PackedRepoContext {
  section: string;
  selectedFiles: string[];
  indexedFileCount: number;
}

export interface PackRepoContextInput {
  prompt: string;
  files: readonly RepoIndexFile[];
  maxFiles?: number;
  maxBytes?: number;
}

const DEFAULT_MAX_FILES = 10;
const DEFAULT_MAX_BYTES = 10 * 1024;

export const packRepoContext = (input: PackRepoContextInput): PackedRepoContext => {
  const maxFiles = Math.max(1, Math.min(input.maxFiles ?? DEFAULT_MAX_FILES, 30));
  const maxBytes = Math.max(1_024, input.maxBytes ?? DEFAULT_MAX_BYTES);
  const tokens = tokenize(input.prompt);
  const scored = input.files
    .map((file) => ({
      file,
      score: scoreFile(file, tokens),
    }))
    .sort((a, b) => b.score - a.score || a.file.relativePath.localeCompare(b.file.relativePath));
  const pinned = input.files.filter((file) =>
    file.fileKind === "package" ||
    (file.fileKind === "config" && /(^|\/)(tsconfig|vite\.config|package\.json|electron)/i.test(file.relativePath)),
  );
  const selected: RepoIndexFile[] = [];
  for (const file of [...pinned, ...scored.map((entry) => entry.file)]) {
    if (selected.some((existing) => existing.relativePath === file.relativePath)) continue;
    selected.push(file);
    if (selected.length >= maxFiles) break;
  }
  const lines = [
    "REPOSITORY CONTEXT",
    `- indexed files: ${input.files.length}`,
    `- selected files: ${selected.length}`,
    "- Use this as a map only; inspect files before proposing exact edits.",
  ];
  for (const file of selected) {
    lines.push(
      "",
      `### ${file.relativePath}`,
      `- kind: ${file.fileKind}`,
      `- size: ${file.sizeBytes} bytes`,
      `- summary: ${file.summary.slice(0, 500)}`,
    );
    if (file.symbols.length > 0) {
      lines.push(`- symbols: ${file.symbols.slice(0, 12).join(", ")}`);
    }
    if (file.imports.length > 0) {
      lines.push(`- imports: ${file.imports.slice(0, 12).join(", ")}`);
    }
  }
  let section = lines.join("\n");
  if (Buffer.byteLength(section, "utf8") > maxBytes) {
    section = `${section.slice(0, maxBytes - 32)}\n[...repo context truncated]`;
  }
  return {
    section,
    selectedFiles: selected.map((file) => file.relativePath),
    indexedFileCount: input.files.length,
  };
};

const tokenize = (value: string): Set<string> =>
  new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9가-힣_./-]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  );

const scoreFile = (file: RepoIndexFile, tokens: Set<string>): number => {
  let score = 0;
  const haystacks = [
    file.relativePath.toLowerCase(),
    file.summary.toLowerCase(),
    file.symbols.join(" ").toLowerCase(),
    file.imports.join(" ").toLowerCase(),
  ];
  for (const token of tokens) {
    for (const haystack of haystacks) {
      if (haystack.includes(token)) score += token.includes("/") || token.includes(".") ? 8 : 3;
    }
  }
  if (file.fileKind === "package") score += 8;
  if (file.fileKind === "config") score += 5;
  if (file.fileKind === "source") score += 2;
  if (file.fileKind === "test") score += 1;
  if (/readme|package\.json|tsconfig|vite\.config/i.test(file.relativePath)) score += 4;
  return score;
};
