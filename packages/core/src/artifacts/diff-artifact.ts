/**
 * Phase 3 minimal diff artifact format. We do NOT implement Myers diff
 * here; we save before/after as a simple unified-diff-like block so the
 * UI can render it. Real `git diff` artifacts come from GitRunner.
 */

export interface SimpleDiffInput {
  path: string;
  before?: string | undefined;
  after: string;
}

export const formatSimpleDiff = ({
  path,
  before,
  after,
}: SimpleDiffInput): string => {
  const beforeBody = before ?? "";
  const beforeLines = beforeBody.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);

  const lines: string[] = [];
  lines.push(`--- ${path}\t(before)`);
  lines.push(`+++ ${path}\t(after)`);
  if (beforeBody.length === 0) {
    for (const ln of afterLines) lines.push(`+${ln}`);
    return lines.join("\n");
  }
  // No diff algorithm; print full before as removed, full after as added.
  // This is acceptable for Phase 3 since real diffs come from GitRunner.
  for (const ln of beforeLines) lines.push(`-${ln}`);
  for (const ln of afterLines) lines.push(`+${ln}`);
  return lines.join("\n");
};
