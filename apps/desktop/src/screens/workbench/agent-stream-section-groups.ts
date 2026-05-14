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
  return commandFamilyKey(command);
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

const commandFamilyKey = (command: string): string => {
  const normalized = normalizeCommand(command);
  const script = extractPowerShellCommand(normalized) ?? normalized;
  const segment = firstCommandSegment(script);
  const tokens = tokenizeCommand(segment);
  if (tokens.length === 0) return normalized.toLowerCase();

  const first = normalizeToken(tokens[0]!);
  const second = tokens[1] ? normalizeToken(tokens[1]) : "";
  const third = tokens[2] ? normalizeToken(tokens[2]) : "";

  if (first === "npm" && second === "run" && third.length > 0) {
    return `${first} ${second} ${third}`;
  }
  if (first === "git" && second.length > 0) return `${first} ${second}`;
  if (first === "node" && second.length > 0) return `${first} ${second}`;
  if (first === "rg" && second.startsWith("-")) return `${first} ${second}`;
  return first;
};

const extractPowerShellCommand = (command: string): string | null => {
  const match = command.match(/(?:^|\s)-Command\s+(['"])([\s\S]*)\1\s*$/i);
  return match?.[2]?.trim() || null;
};

const firstCommandSegment = (script: string): string => {
  const segments = script
    .split(";")
    .map((segment) => segment.trim())
    .filter(Boolean);
  for (const segment of segments) {
    if (/^\$[\w:.-]+\s*=/.test(segment)) continue;
    return segment;
  }
  return script.trim();
};

const tokenizeCommand = (command: string): string[] =>
  command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];

const normalizeToken = (token: string): string =>
  token.replace(/^['"]|['"]$/g, "").toLowerCase();
