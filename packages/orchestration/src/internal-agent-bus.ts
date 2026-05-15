import { newId } from "@harness/storage";
import type { WorkerRole } from "./orchestration-types.ts";

export interface InternalAgentMessage {
  id: string;
  taskRunId: string;
  planId: string;
  fromStepId: string;
  fromRole: WorkerRole;
  fromTitle: string;
  toStepId?: string;
  content: string;
  artifactId: string;
  createdAt: string;
}

export interface CreateInternalAgentMessageInput {
  taskRunId: string;
  planId: string;
  fromStepId: string;
  fromRole: WorkerRole;
  fromTitle: string;
  toStepId?: string;
  content: string;
  artifactId: string;
  maxContentChars?: number;
  now?: () => string;
  createId?: () => string;
}

const DEFAULT_MAX_CONTENT_CHARS = 12_000;

export const createInternalAgentMessage = (
  input: CreateInternalAgentMessageInput,
): InternalAgentMessage => {
  const maxContentChars = input.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  return {
    id: input.createId?.() ?? newId("artifact"),
    taskRunId: input.taskRunId,
    planId: input.planId,
    fromStepId: input.fromStepId,
    fromRole: input.fromRole,
    fromTitle: input.fromTitle,
    ...(input.toStepId !== undefined ? { toStepId: input.toStepId } : {}),
    content: truncate(input.content, maxContentChars),
    artifactId: input.artifactId,
    createdAt: input.now?.() ?? new Date().toISOString(),
  };
};

export const formatHandoffMessages = (
  messages: readonly InternalAgentMessage[],
): string => {
  if (messages.length === 0) return "";
  const lines = ["## Internal Agent Handoff", ""];
  for (const [index, message] of messages.entries()) {
    if (index > 0) lines.push("");
    lines.push(`### ${message.fromRole}: ${message.fromTitle}`);
    lines.push(`artifact: ${message.artifactId}`);
    lines.push("");
    lines.push(message.content);
  }
  return lines.join("\n");
};

const truncate = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
};
