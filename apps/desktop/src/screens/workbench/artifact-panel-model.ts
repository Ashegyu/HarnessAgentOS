import type { Artifact } from "@harness/core";

export const filterArtifacts = (
  artifacts: readonly Artifact[],
  query: string,
): Artifact[] => {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return [...artifacts];
  const terms = normalized.split(/\s+/).filter(Boolean);
  return artifacts.filter((artifact) => {
    const haystack = [
      artifact.id,
      artifact.kind,
      artifact.title,
      artifact.uri,
      artifact.summary ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
};
