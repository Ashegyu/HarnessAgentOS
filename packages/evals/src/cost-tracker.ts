import { estimateModelUsage } from "@harness/agent";
import type { LocalStateService } from "@harness/storage";

export const sumTokensForTaskRun = async (
  state: LocalStateService,
  taskRunId: string,
): Promise<number> => {
  const invocations = await state.listAgentInvocationsByTaskRun(taskRunId);
  let total = 0;

  for (const invocation of invocations) {
    const promptArtifact = await state.artifacts.get(invocation.promptArtifactId);
    const outputArtifact = invocation.rawOutputArtifactId
      ? await state.artifacts.get(invocation.rawOutputArtifactId)
      : null;
    const outputSummary = outputArtifact?.summary ?? "";
    const usageTokens = extractUsageTokens(outputSummary);
    if (usageTokens !== null) {
      total += usageTokens;
      continue;
    }

    const estimate = estimateModelUsage({
      provider: invocation.provider,
      model: invocation.model,
      prompt: promptArtifact?.summary ?? "",
      output: extractAssistantText(outputSummary),
      rawOutput: outputSummary,
    });
    total += estimate.totalTokens;
  }

  return total;
};

const extractUsageTokens = (summary: string): number | null => {
  for (const event of parseJsonLines(summary)) {
    const usage = recordValue(event["usage"]);
    if (!usage) continue;
    const total =
      numberValue(usage["total_tokens"]) ?? numberValue(usage["totalTokens"]);
    if (total !== undefined) return total;
    const input =
      numberValue(usage["input_tokens"]) ??
      numberValue(usage["inputTokens"]) ??
      0;
    const output =
      numberValue(usage["output_tokens"]) ??
      numberValue(usage["outputTokens"]) ??
      0;
    if (input > 0 || output > 0) return input + output;
  }
  return null;
};

const extractAssistantText = (summary: string): string => {
  const parts: string[] = [];
  for (const event of parseJsonLines(summary)) {
    if (event["type"] === "assistant_text" && typeof event["text"] === "string") {
      parts.push(event["text"]);
    }
  }
  return parts.join("\n");
};

const parseJsonLines = (summary: string): ReadonlyArray<Record<string, unknown>> => {
  const events: Record<string, unknown>[] = [];
  for (const line of summary.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isRecord(parsed)) events.push(parsed);
    } catch {
      // Ignore non-JSON transcript lines.
    }
  }
  return events;
};

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const recordValue = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
