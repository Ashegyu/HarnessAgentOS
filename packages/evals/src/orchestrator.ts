import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { LocalStateService } from "@harness/storage";

import { CaseRunner, type CaseRunnerDeps } from "./case-runner.ts";
import { evalCaseSchema } from "./fixture-schema.ts";
import { writeAttemptArtifacts, writeMarkdownReport } from "./reporter.ts";
import {
  evaluateThresholds,
  type EvalSuite,
  type SuiteThresholdResult,
} from "./thresholds.ts";
import type {
  EvalCase,
  EvalCaseResult,
  EvalProvider,
  EvalRunMode,
  EvalRunSummary,
} from "./types.ts";
import { normalizeEvalProviders } from "./v2-contracts.ts";

export interface EvalOrchestratorOptions {
  readonly suite: EvalSuite;
  readonly caseId?: string;
  readonly fixturesRoot: string;
  readonly outDir: string;
  readonly state: LocalStateService;
  readonly inMemoryDbFactory: () => LocalStateService;
  readonly adapterFactory?: CaseRunnerDeps["adapterFactory"];
  readonly judgeAdapterFactory?: CaseRunnerDeps["judgeAdapterFactory"];
  readonly harnessSha?: string;
  readonly providers?: ReadonlyArray<EvalProvider>;
  readonly llmJudgeEnabled?: boolean;
  readonly attemptsOverride?: number;
  readonly timeoutMs?: number;
  readonly stallTimeoutMs?: number;
  readonly clock?: () => number;
}

export interface EvalOrchestratorResult {
  readonly summary: EvalRunSummary;
  readonly thresholdResults: ReadonlyArray<SuiteThresholdResult>;
  readonly overallPassed: boolean;
  readonly outDir: string;
}

export class EvalOrchestrator {
  private readonly options: EvalOrchestratorOptions;

  constructor(options: EvalOrchestratorOptions) {
    this.options = options;
  }

  async run(): Promise<EvalOrchestratorResult> {
    const runRecord = await this.options.state.evalRuns.create({
      suite: this.options.suite,
      ...(this.options.harnessSha ? { harnessSha: this.options.harnessSha } : {}),
    });
    const outDir = resolveEvalRunOutDir(this.options.outDir, runRecord.id);
    await mkdir(outDir, { recursive: true });

    const loadedCases = await this.loadCases();
    const cases = this.expandProviderCases(loadedCases);
    const mode = this.inferRunMode(loadedCases);
    const caseRunner = new CaseRunner({
      workspaceRoot: outDir,
      runRoot: outDir,
      runId: runRecord.id,
      dbFactory: this.options.inMemoryDbFactory,
      ...(this.options.adapterFactory
        ? { adapterFactory: this.options.adapterFactory }
        : {}),
      ...(this.options.judgeAdapterFactory
        ? { judgeAdapterFactory: this.options.judgeAdapterFactory }
        : {}),
      ...(this.options.llmJudgeEnabled
        ? { llmJudgeEnabled: this.options.llmJudgeEnabled }
        : {}),
      ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
      ...(this.options.stallTimeoutMs
        ? { stallTimeoutMs: this.options.stallTimeoutMs }
        : {}),
      ...(this.options.clock ? { clock: this.options.clock } : {}),
    });
    const caseResults: EvalCaseResult[] = [];

    for (const testCase of cases) {
      const result = await caseRunner.run(testCase);
      caseResults.push(result);
      await writeAttemptArtifacts(result, outDir);
    }

    const thresholdResults = evaluateProviderAwareThresholds(
      this.options.suite,
      caseResults,
    );
    const overallPassed = thresholdResults.every((result) => result.passed);
    const finalStatus = overallPassed ? "passed" : "failed";
    const summary: EvalRunSummary = {
      runId: runRecord.id,
      suite: this.options.suite,
      startedAt: runRecord.startedAt,
      finishedAt: this.finishedAt(),
      cases: caseResults,
      status: finalStatus,
      ...(mode ? { mode } : {}),
      ...(this.options.harnessSha
        ? { harnessRevisionSha: this.options.harnessSha }
        : {}),
    };

    await this.options.state.evalRuns.finish(runRecord.id, {
      status: finalStatus,
      summary,
    });
    await writeMarkdownReport(summary, outDir);

    return {
      summary,
      thresholdResults,
      overallPassed,
      outDir,
    };
  }

  private expandProviderCases(
    cases: ReadonlyArray<EvalCase>,
  ): ReadonlyArray<EvalCase> {
    const expanded: EvalCase[] = [];
    for (const testCase of cases) {
      const providers = this.providersFor(testCase);
      if (providers.length === 0) {
        expanded.push(testCase);
        continue;
      }
      for (const provider of providers) {
        expanded.push({ ...testCase, provider });
      }
    }
    return expanded;
  }

  private providersFor(testCase: EvalCase): ReadonlyArray<EvalProvider> {
    if (this.options.providers && this.options.providers.length > 0) {
      return this.options.providers;
    }
    return normalizeEvalProviders(testCase);
  }

  private inferRunMode(cases: ReadonlyArray<EvalCase>): EvalRunMode | null {
    if (this.options.providers && this.options.providers.length > 1) {
      return "head_to_head";
    }
    return cases.some((testCase) => normalizeEvalProviders(testCase).length > 1)
      ? "head_to_head"
      : null;
  }

  private async loadCases(): Promise<ReadonlyArray<EvalCase>> {
    const suites =
      this.options.suite === "all"
        ? (["capability", "regression", "safety"] as const)
        : ([this.options.suite] as const);
    const cases: EvalCase[] = [];

    for (const suite of suites) {
      const suiteDir = path.join(this.options.fixturesRoot, suite);
      const files = (await readdir(suiteDir).catch(() => []))
        .filter((file) => file.endsWith(".eval.json"))
        .sort();
      for (const file of files) {
        const raw = JSON.parse(await readFile(path.join(suiteDir, file), "utf8"));
        const parsed = evalCaseSchema.parse(raw);
        if (this.options.caseId && parsed.id !== this.options.caseId) continue;
        cases.push(
          this.options.attemptsOverride
            ? { ...parsed, attempts: this.options.attemptsOverride }
            : parsed,
        );
      }
    }

    return cases;
  }

  private finishedAt(): string {
    return new Date((this.options.clock ?? Date.now)()).toISOString();
  }
}

export const resolveEvalRunOutDir = (outDir: string, runId: string): string =>
  outDir.includes("{runId}") ? outDir.replaceAll("{runId}", runId) : outDir;

const evaluateProviderAwareThresholds = (
  suite: EvalSuite,
  caseResults: ReadonlyArray<EvalCaseResult>,
): ReadonlyArray<SuiteThresholdResult> => {
  const providerResults = caseResults.filter(
    (caseResult): caseResult is EvalCaseResult & { provider: EvalProvider } =>
      caseResult.provider !== undefined,
  );
  if (providerResults.length === 0) {
    return evaluateThresholds(suite, caseResults);
  }

  const providers = Array.from(
    new Set(providerResults.map((caseResult) => caseResult.provider)),
  );
  const thresholdResults: SuiteThresholdResult[] = [];
  for (const provider of providers) {
    for (const result of evaluateThresholds(
      suite,
      providerResults.filter((caseResult) => caseResult.provider === provider),
    )) {
      thresholdResults.push({
        ...result,
        provider,
        reason: `${provider} ${result.reason}`,
      });
    }
  }

  const unscopedResults = caseResults.filter(
    (caseResult) => caseResult.provider === undefined,
  );
  if (unscopedResults.length > 0) {
    thresholdResults.push(...evaluateThresholds(suite, unscopedResults));
  }
  return thresholdResults;
};
