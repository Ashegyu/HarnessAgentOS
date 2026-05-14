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
  let pendingKey: string | null = null;
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
    pendingKey = null;
    pendingTools = [];
  };

  for (const section of sections) {
    if (section.kind !== "tool") {
      flush();
      grouped.push(section);
      continue;
    }

    const key = toolCommandKey(section);
    if (key === null) {
      flush();
      grouped.push(section);
      continue;
    }

    if (pendingKey !== null && pendingKey !== key) {
      flush();
    }
    pendingKey = key;
    pendingTools.push(section);
  }

  flush();
  return grouped;
};

const toolCommandKey = (section: ToolStreamSection): string | null => {
  const command = commandValue(section.input);
  if (command === null) return null;
  return `${section.name}\u0000${normalizeCommand(command)}`;
};

const commandValue = (input: unknown): string | null => {
  if (typeof input === "string" && input.trim().length > 0) return input;
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const command = record["command"] ?? record["cmd"];
  return typeof command === "string" && command.trim().length > 0
    ? command
    : null;
};

const normalizeCommand = (command: string): string =>
  command.trim().replace(/\s+/g, " ");
