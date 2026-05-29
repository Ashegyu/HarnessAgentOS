export interface ApplyUnifiedPatchInput {
  path: string;
  patch: string;
  currentContent: string;
}

export interface ApplyUnifiedPatchResult {
  afterContent: string;
  normalizedPatch: string;
}

interface HunkHeader {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export class UnifiedPatchError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "UnifiedPatchError";
    this.code = code;
  }
}

export const applySingleFileUnifiedPatch = (
  input: ApplyUnifiedPatchInput,
): ApplyUnifiedPatchResult => {
  const normalizedPatch = normalizeNewlines(input.patch);
  const patchLines = normalizedPatch.split("\n");
  if (patchLines.at(-1) === "") patchLines.pop();
  const header = parseFileHeader(patchLines, input.path);
  let patchIndex = header.nextIndex;
  const currentLines = splitContentLines(input.currentContent);
  const outputLines: string[] = [];
  let currentIndex = 0;
  let sawHunk = false;

  while (patchIndex < patchLines.length) {
    const line = patchLines[patchIndex] ?? "";
    if (line.startsWith("--- ") || line.startsWith("diff --git ")) {
      throw invalid("file_patch supports exactly one file per unified diff");
    }
    const hunk = parseHunkHeader(line);
    const isBareHunk = isBareHunkHeader(line);
    if (!hunk && !isBareHunk) throw invalid(`Expected hunk header, got: ${line}`);
    sawHunk = true;
    patchIndex += 1;

    const hunkLines: string[] = [];
    while (patchIndex < patchLines.length) {
      const hunkLine = patchLines[patchIndex] ?? "";
      if (isHunkHeaderLine(hunkLine)) break;
      if (hunkLine.startsWith("--- ") || hunkLine.startsWith("diff --git ")) {
        throw invalid("file_patch supports exactly one file per unified diff");
      }
      hunkLines.push(hunkLine);
      patchIndex += 1;
    }

    const oldLines = oldLinesForHunk(hunkLines);
    const hunkStartIndex = hunk
      ? resolveNumberedHunkStartIndex({
          currentLines,
          hunk,
          oldLines,
          searchFromIndex: currentIndex,
        })
      : findContextHunkStartIndex({
          currentLines,
          oldLines,
          searchFromIndex: currentIndex,
        });
    if (hunkStartIndex < currentIndex) {
      throw contextMismatch("Hunk overlaps already-applied content");
    }
    while (currentIndex < hunkStartIndex) {
      outputLines.push(currentLines[currentIndex] ?? "");
      currentIndex += 1;
    }

    let oldSeen = 0;
    let newSeen = 0;
    for (const hunkLine of hunkLines) {
      if (hunkLine.startsWith("\\ No newline at end of file")) {
        continue;
      }
      if (hunkLine.length === 0) {
        throw invalid("Unified diff hunk line must start with space, +, or -");
      }
      const marker = hunkLine[0];
      const content = hunkLine.slice(1);
      if (marker === " ") {
        assertCurrentLine(currentLines, currentIndex, content);
        outputLines.push(content);
        currentIndex += 1;
        oldSeen += 1;
        newSeen += 1;
      } else if (marker === "-") {
        assertCurrentLine(currentLines, currentIndex, content);
        currentIndex += 1;
        oldSeen += 1;
      } else if (marker === "+") {
        outputLines.push(content);
        newSeen += 1;
      } else {
        throw invalid("Unified diff hunk line must start with space, +, or -");
      }
    }

    // Model-generated patches sometimes carry stale line counts. The explicit
    // hunk body is still safe when every old/context line matched exactly.
  }

  if (!sawHunk) throw invalid("Unified diff must contain at least one hunk");
  outputLines.push(...currentLines.slice(currentIndex));
  return {
    afterContent: outputLines.join("\n"),
    normalizedPatch,
  };
};

const parseFileHeader = (
  lines: readonly string[],
  expectedPath: string,
): { nextIndex: number } => {
  if (!lines[0]?.startsWith("--- ") || !lines[1]?.startsWith("+++ ")) {
    throw invalid("Unified diff must start with --- and +++ file headers");
  }
  const oldPath = parseHeaderPath(lines[0]);
  const newPath = parseHeaderPath(lines[1]);
  if (oldPath === "/dev/null" || newPath === "/dev/null") {
    throw invalid("file_patch cannot create or delete files");
  }
  const expected = normalizePatchPath(expectedPath);
  if (
    normalizePatchPath(stripDiffPrefix(oldPath)) !== expected ||
    normalizePatchPath(stripDiffPrefix(newPath)) !== expected
  ) {
    throw invalid(
      `Unified diff headers must match target path ${expectedPath}`,
    );
  }
  return { nextIndex: 2 };
};

const parseHeaderPath = (line: string): string =>
  line.slice(4).trim().split(/\s+/)[0] ?? "";

const stripDiffPrefix = (path: string): string =>
  path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;

const normalizePatchPath = (path: string): string =>
  path.replace(/\\/g, "/").replace(/^\.\/+/, "");

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const isBareHunkHeader = (line: string): boolean => line.trim() === "@@";

const isHunkHeaderLine = (line: string): boolean =>
  isBareHunkHeader(line) || parseHunkHeader(line) !== null;

const parseHunkHeader = (line: string): HunkHeader | null => {
  const match = HUNK_RE.exec(line);
  if (!match) return null;
  return {
    oldStart: Number.parseInt(match[1] ?? "0", 10),
    oldCount: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
    newStart: Number.parseInt(match[3] ?? "0", 10),
    newCount: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
  };
};

const splitContentLines = (content: string): string[] =>
  normalizeNewlines(content).split("\n");

const normalizeNewlines = (value: string): string =>
  value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const resolveNumberedHunkStartIndex = (input: {
  currentLines: readonly string[];
  hunk: HunkHeader;
  oldLines: readonly string[];
  searchFromIndex: number;
}): number => {
  const headerStartIndex = Math.max(input.hunk.oldStart - 1, 0);
  if (
    input.oldLines.length === 0 ||
    sequenceMatches(input.currentLines, headerStartIndex, input.oldLines)
  ) {
    return headerStartIndex;
  }
  return findContextHunkStartIndex({
    currentLines: input.currentLines,
    oldLines: input.oldLines,
    searchFromIndex: input.searchFromIndex,
  });
};

const findContextHunkStartIndex = (input: {
  currentLines: readonly string[];
  oldLines: readonly string[];
  searchFromIndex: number;
}): number => {
  if (input.oldLines.length === 0) {
    throw invalid("Bare hunk header requires at least one context or removed line");
  }

  let matchIndex = -1;
  for (
    let index = input.searchFromIndex;
    index <= input.currentLines.length - input.oldLines.length;
    index += 1
  ) {
    if (!sequenceMatches(input.currentLines, index, input.oldLines)) continue;
    if (matchIndex !== -1) {
      throw contextMismatch("Patch hunk context matched multiple locations");
    }
    matchIndex = index;
  }
  if (matchIndex === -1) {
    throw contextMismatch("Patch hunk context did not match current file");
  }
  return matchIndex;
};

const oldLinesForHunk = (hunkLines: readonly string[]): string[] => {
  const oldLines: string[] = [];
  for (const line of hunkLines) {
    if (line.startsWith("\\ No newline at end of file")) continue;
    if (line.length === 0) {
      throw invalid("Unified diff hunk line must start with space, +, or -");
    }
    const marker = line[0];
    if (marker === " " || marker === "-") {
      oldLines.push(line.slice(1));
    } else if (marker !== "+") {
      throw invalid("Unified diff hunk line must start with space, +, or -");
    }
  }
  return oldLines;
};

const sequenceMatches = (
  currentLines: readonly string[],
  startIndex: number,
  expectedLines: readonly string[],
): boolean =>
  expectedLines.every(
    (line, offset) => currentLines[startIndex + offset] === line,
  );

const assertCurrentLine = (
  currentLines: readonly string[],
  index: number,
  expected: string,
): void => {
  if (currentLines[index] !== expected) {
    throw contextMismatch(
      `Patch context mismatch at line ${index + 1}: expected ${JSON.stringify(expected)}`,
    );
  }
};

const invalid = (message: string): UnifiedPatchError =>
  new UnifiedPatchError("RUNNER_PATCH_INVALID", message);

const contextMismatch = (message: string): UnifiedPatchError =>
  new UnifiedPatchError("RUNNER_PATCH_CONTEXT_MISMATCH", message);
