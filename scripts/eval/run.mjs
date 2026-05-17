#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createEvalAdapterFactory,
  EvalOrchestrator,
  parseEvalCliArgs,
  resolveEvalRunOutDir,
} from "@harness/evals";
import { closeDb, LocalStateService, openDb } from "@harness/storage";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "../..");

const resolvePath = (value) =>
  path.isAbsolute(value) ? value : path.resolve(repoRoot, value);

const readHarnessSha = () => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
};

const main = async () => {
  const args = parseEvalCliArgs(process.argv.slice(2), process.env);

  const outDirTemplate = args.outDir
    ? resolvePath(args.outDir)
    : path.join(repoRoot, "workspace", "eval-runs", "{runId}");
  const fixturesRoot = args.fixturesRoot
    ? resolvePath(args.fixturesRoot)
    : path.join(repoRoot, "packages", "evals", "fixtures");
  const persistentDbPath = args.dbPath
    ? resolvePath(args.dbPath)
    : path.join(repoRoot, "workspace", "eval-runs", "eval.db");
  await mkdir(path.dirname(persistentDbPath), { recursive: true });

  const persistentDb = openDb({ filePath: persistentDbPath });
  const attemptDbs = [];
  try {
    const state = new LocalStateService(persistentDb);
    const harnessSha = readHarnessSha();
    const orchestrator = new EvalOrchestrator({
      suite: args.suite,
      ...(args.caseId ? { caseId: args.caseId } : {}),
      fixturesRoot,
      outDir: outDirTemplate,
      state,
      inMemoryDbFactory: () => {
        const db = openDb({ filePath: ":memory:" });
        attemptDbs.push(db);
        return new LocalStateService(db);
      },
      adapterFactory: createEvalAdapterFactory({
        realCli: args.realCli,
        fakeChunkDelayMs: 0,
      }),
      ...(harnessSha ? { harnessSha } : {}),
      ...(args.attemptsOverride
        ? { attemptsOverride: args.attemptsOverride }
        : {}),
      ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
      ...(args.stallTimeoutMs
        ? { stallTimeoutMs: args.stallTimeoutMs }
        : {}),
    });

    const { summary, thresholdResults, overallPassed } = await orchestrator.run();
    const outDir = resolveEvalRunOutDir(outDirTemplate, summary.runId);

    console.log("");
    console.log(`Run ID: ${summary.runId}`);
    console.log(`Report: ${path.join(outDir, "report.md")}`);
    console.log("");
    for (const result of thresholdResults) {
      console.log(`${result.passed ? "PASS" : "FAIL"} ${result.reason}`);
    }
    console.log("");
    console.log(overallPassed ? "PASSED" : "FAILED");
    process.exitCode = overallPassed ? 0 : 1;
  } finally {
    for (const db of attemptDbs) {
      closeDb(db);
    }
    closeDb(persistentDb);
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
