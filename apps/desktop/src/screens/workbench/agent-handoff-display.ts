import type { Artifact } from "@harness/core";

export interface AgentHandoffDisplayEntry {
  fromRole: string;
  fromTitle: string;
  artifactId: string;
  createdAt?: string;
  content: string;
  preview: string;
}

export interface AgentHandoffDelivery {
  promptArtifactId: string;
  promptArtifactTitle: string;
  targetLabel: string;
  createdAt: string;
  entries: AgentHandoffDisplayEntry[];
}

const PROMPT_TITLE_PREFIX = "Worker prompt — ";
const HANDOFF_SECTION_HEADING = "INTERNAL AGENT HANDOFF";
const NEXT_PROMPT_SECTIONS = new Set([
  "QUALITY RISKS TO ADDRESS",
  "APPROVED SKILL CAPABILITIES",
  "RECENT ARTIFACTS",
  "OUTPUT CONTRACT",
]);
const MAX_PREVIEW_CHARS = 280;

export const deriveInternalAgentHandoffs = (
  artifacts: readonly Artifact[],
): AgentHandoffDelivery[] => {
  const deliveries: AgentHandoffDelivery[] = [];
  for (const artifact of artifacts) {
    if (artifact.kind !== "log") continue;
    if (!artifact.title.startsWith(PROMPT_TITLE_PREFIX)) continue;
    if (!artifact.summary?.includes(HANDOFF_SECTION_HEADING)) continue;
    const entries = parseHandoffEntries(artifact.summary);
    if (entries.length === 0) continue;
    deliveries.push({
      promptArtifactId: artifact.id,
      promptArtifactTitle: artifact.title,
      targetLabel: artifact.title.slice(PROMPT_TITLE_PREFIX.length).trim() || artifact.title,
      createdAt: artifact.createdAt,
      entries,
    });
  }
  return deliveries;
};

const parseHandoffEntries = (summary: string): AgentHandoffDisplayEntry[] => {
  const lines = summary.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === HANDOFF_SECTION_HEADING);
  if (start < 0) return [];
  const entries: AgentHandoffDisplayEntry[] = [];
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    if (NEXT_PROMPT_SECTIONS.has(line)) break;
    if (!line.startsWith("### ")) {
      index += 1;
      continue;
    }
    const header = line.slice(4).trim();
    const separator = header.indexOf(":");
    const fromRole = separator >= 0 ? header.slice(0, separator).trim() : "agent";
    const fromTitle = separator >= 0 ? header.slice(separator + 1).trim() : header;
    index += 1;

    let artifactId = "";
    let createdAt: string | undefined;
    while (index < lines.length) {
      const metaLine = lines[index]?.trim() ?? "";
      if (metaLine.length === 0) {
        index += 1;
        break;
      }
      if (metaLine.startsWith("- artifact:")) {
        artifactId = metaLine.slice("- artifact:".length).trim();
        index += 1;
        continue;
      }
      if (metaLine.startsWith("- createdAt:")) {
        createdAt = metaLine.slice("- createdAt:".length).trim();
        index += 1;
        continue;
      }
      break;
    }

    const contentLines: string[] = [];
    while (index < lines.length) {
      const contentLine = lines[index] ?? "";
      const trimmed = contentLine.trim();
      if (trimmed.startsWith("### ")) break;
      if (NEXT_PROMPT_SECTIONS.has(trimmed)) break;
      contentLines.push(contentLine);
      index += 1;
    }
    const content = contentLines.join("\n").trim();
    if (content.length > 0 || artifactId.length > 0) {
      entries.push({
        fromRole,
        fromTitle,
        artifactId,
        ...(createdAt ? { createdAt } : {}),
        content,
        preview: preview(content),
      });
    }
  }
  return entries;
};

const preview = (content: string): string => {
  const compact = content.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_PREVIEW_CHARS) return compact;
  return `${compact.slice(0, MAX_PREVIEW_CHARS - 1)}…`;
};
