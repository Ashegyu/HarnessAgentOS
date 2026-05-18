import { promises as fs } from "node:fs";
import path from "node:path";

import { defaultModelFor, type ModelCliAdapter } from "@harness/agent";
import { z } from "zod";

import type { LlmJudgeGrader } from "../grader-types.ts";
import type { GraderResult } from "./code-grader.ts";

export interface LlmJudgeParsedOutput {
  readonly score: number;
  readonly passed?: boolean;
  readonly rubric: ReadonlyArray<{
    readonly id: string;
    readonly score: number;
    readonly reason: string;
  }>;
  readonly risks: ReadonlyArray<string>;
}

export interface LlmJudgeGraderContext {
  readonly enabled: boolean;
  readonly targetDir: string;
  readonly taskRunId: string;
  readonly judgeAdapter?: ModelCliAdapter;
  readonly timeoutMs?: number;
  readonly stallTimeoutMs?: number;
}

const DEFAULT_PASS_THRESHOLD = 0.8;
const DEFAULT_JUDGE_ATTEMPTS = 3;
const DEFAULT_JUDGE_PROVIDER = "claude";
const MAX_SNAPSHOT_FILES = 20;
const MAX_SNAPSHOT_CHARS = 20_000;

const judgeOutputSchema = z.object({
  score: z.number().min(0).max(1),
  passed: z.boolean().optional(),
  rubric: z
    .array(
      z.object({
        id: z.string().min(1),
        score: z.number().min(0).max(1),
        reason: z.string(),
      }),
    )
    .default([]),
  risks: z.array(z.string()).default([]),
});

export const parseLlmJudgeOutput = (text: string): LlmJudgeParsedOutput => {
  let value: unknown;
  try {
    value = JSON.parse(extractJsonPayload(text));
  } catch {
    throw new Error("LLM judge output is not valid JSON");
  }

  const parsed = judgeOutputSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `LLM judge output schema invalid: ${parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
  return parsed.data;
};

export const runLlmJudgeGrader = async (
  grader: LlmJudgeGrader,
  ctx: LlmJudgeGraderContext,
): Promise<GraderResult> => {
  if (!ctx.enabled) {
    return {
      passed: false,
      reason: "LLM judge disabled; set EVAL_LLM_JUDGE=1 or pass --llm-judge",
    };
  }
  if (!ctx.judgeAdapter) {
    return { passed: false, reason: "LLM judge adapter is not configured" };
  }

  const judgeAttempts = grader.judgeAttempts ?? DEFAULT_JUDGE_ATTEMPTS;
  const passThreshold = grader.passThreshold ?? DEFAULT_PASS_THRESHOLD;
  const provider = grader.judgeProvider ?? DEFAULT_JUDGE_PROVIDER;
  const model = defaultModelFor(provider);
  const prompt = await buildJudgePrompt(grader, ctx.targetDir);
  const outputs: LlmJudgeParsedOutput[] = [];

  for (let idx = 0; idx < judgeAttempts; idx += 1) {
    try {
      const result = await ctx.judgeAdapter.invoke(
        {
          invocationId: `judge-${ctx.taskRunId}-${idx}`,
          taskRunId: ctx.taskRunId,
          cwd: ctx.targetDir,
          prompt,
          modelConfig: {
            provider,
            model,
            timeoutMs: ctx.timeoutMs ?? 60_000,
            stallTimeoutMs: ctx.stallTimeoutMs ?? 10_000,
            ...(grader.maxJudgeTokens
              ? { maxTokens: grader.maxJudgeTokens }
              : {}),
          },
          sandbox: {
            primaryDir: ctx.targetDir,
            enforceInPrompt: true,
          },
        },
        () => undefined,
      );
      outputs.push(parseLlmJudgeOutput(result.stdout));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { passed: false, reason: `LLM judge failed: ${message}` };
    }
  }

  const averageScore =
    outputs.reduce((sum, output) => sum + output.score, 0) / outputs.length;
  const explicitFailure = outputs.some((output) => output.passed === false);
  const passed = averageScore >= passThreshold && !explicitFailure;

  return passed
    ? { passed: true }
    : {
        passed: false,
        reason: explicitFailure
          ? `LLM judge explicit failure at average score ${formatScore(
              averageScore,
            )}`
          : `LLM judge average score ${formatScore(
              averageScore,
            )} below threshold ${formatScore(passThreshold)}`,
      };
};

const buildJudgePrompt = async (
  grader: LlmJudgeGrader,
  targetDir: string,
): Promise<string> => {
  const snapshot = await collectTargetSnapshot(targetDir);
  return [
    "You are an evaluation judge for HarnessAgentOS.",
    "Return JSON only with score, passed, rubric, and risks fields.",
    "Scores must be numbers between 0 and 1.",
    "",
    "## Rubric",
    ...grader.rubric.map(
      (item) => `- ${item.id} (weight ${item.weight}): ${item.description}`,
    ),
    "",
    "## Target Files",
    snapshot,
  ].join("\n");
};

const collectTargetSnapshot = async (targetDir: string): Promise<string> => {
  const root = path.resolve(targetDir);
  const files: string[] = [];
  let remainingChars = MAX_SNAPSHOT_CHARS;

  const visit = async (dir: string): Promise<void> => {
    if (files.length >= MAX_SNAPSHOT_FILES || remainingChars <= 0) return;
    const entries = await fs
      .readdir(dir, { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (files.length >= MAX_SNAPSHOT_FILES || remainingChars <= 0) return;
      if (entry.name === ".harness-eval-artifacts") continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const relativePath = path.relative(root, fullPath);
      const content = await fs.readFile(fullPath, "utf8").catch(() => "");
      const excerpt = content.slice(0, remainingChars);
      remainingChars -= excerpt.length;
      files.push(`### ${relativePath}\n${excerpt}`);
    }
  };

  await visit(root);
  return files.length === 0 ? "(no files)" : files.join("\n\n");
};

const extractJsonPayload = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
};

const formatScore = (value: number): string =>
  Number(value.toFixed(2)).toString();
