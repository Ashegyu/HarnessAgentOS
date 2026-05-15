import type { ParsedStreamSection } from "./agent-stream-parser";

export type ToolStreamSection = Extract<
  ParsedStreamSection,
  { kind: "tool" }
>;

export interface GroupedToolStreamSection {
  id: string;
  kind: "tool_group";
  name: string;
  input: unknown;
  tools: ToolStreamSection[];
}

export type AgentStreamDisplaySection =
  | ParsedStreamSection
  | GroupedToolStreamSection;

export const groupConsecutiveToolSections = (
  sections: readonly ParsedStreamSection[],
): AgentStreamDisplaySection[] => {
  const grouped: AgentStreamDisplaySection[] = [];
  let pendingTools: ToolStreamSection[] = [];

  const flush = (): void => {
    if (pendingTools.length === 0) return;
    if (pendingTools.length === 1) {
      grouped.push(pendingTools[0]!);
    } else {
      const first = pendingTools[0]!;
      const last = pendingTools[pendingTools.length - 1]!;
      grouped.push({
        id: `${first.id}-group-${pendingTools.length}`,
        kind: "tool_group",
        name: last.name,
        input: last.input,
        tools: pendingTools,
      });
    }
    pendingTools = [];
  };

  for (const section of sections) {
    if (section.kind !== "tool") {
      flush();
      grouped.push(section);
      continue;
    }

    pendingTools.push(section);
  }

  flush();
  return grouped;
};
