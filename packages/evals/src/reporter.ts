import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { renderReport } from "./report-template.ts";
import type { EvalCaseResult, EvalRunSummary } from "./types.ts";

export const writeMarkdownReport = async (
  summary: EvalRunSummary,
  outDir: string,
): Promise<string> => {
  await mkdir(outDir, { recursive: true });
  const filePath = path.join(outDir, "report.md");
  await writeFile(filePath, renderReport(summary), "utf8");
  return filePath;
};

export const writeAttemptArtifacts = async (
  caseResult: EvalCaseResult,
  outDir: string,
): Promise<void> => {
  for (const attempt of caseResult.attempts) {
    const attemptDir = path.join(
      outDir,
      caseResult.case.id,
      ...(caseResult.provider ? [caseResult.provider] : []),
      `attempt-${attempt.attemptIdx}`,
    );
    await mkdir(attemptDir, { recursive: true });
    await writeFile(
      path.join(attemptDir, "result.json"),
      `${JSON.stringify(attempt, null, 2)}\n`,
      "utf8",
    );
  }
};
