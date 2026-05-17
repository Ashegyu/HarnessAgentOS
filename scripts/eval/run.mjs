#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FakeModelCliAdapter } from "@harness/agent";
import { EvalOrchestrator, resolveEvalRunOutDir } from "@harness/evals";
import { closeDb, LocalStateService, openDb } from "@harness/storage";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "../..");
const validSuites = new Set(["capability", "regression", "safety", "all"]);

const parseArgs = (argv) => {
  const args = {
    suite: "all",
    caseId: null,
    outDir: null,
    fixturesRoot: null,
    dbPath: null,
    realCli: process.env.EVAL_REAL_CLI === "1",
  };

  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === "--real-cli") {
      args.realCli = true;
      continue;
    }
    if (arg === "--suite") {
      args.suite = requiredValue(argv, idx, arg);
      idx += 1;
      continue;
    }
    if (arg.startsWith("--suite=")) {
      args.suite = arg.slice("--suite=".length);
      continue;
    }
    if (arg === "--case") {
      args.caseId = requiredValue(argv, idx, arg);
      idx += 1;
      continue;
    }
    if (arg.startsWith("--case=")) {
      args.caseId = arg.slice("--case=".length);
      continue;
    }
    if (arg === "--out") {
      args.outDir = requiredValue(argv, idx, arg);
      idx += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      args.outDir = arg.slice("--out=".length);
      continue;
    }
    if (arg === "--fixtures") {
      args.fixturesRoot = requiredValue(argv, idx, arg);
      idx += 1;
      continue;
    }
    if (arg.startsWith("--fixtures=")) {
      args.fixturesRoot = arg.slice("--fixtures=".length);
      continue;
    }
    if (arg === "--db") {
      args.dbPath = requiredValue(argv, idx, arg);
      idx += 1;
      continue;
    }
    if (arg.startsWith("--db=")) {
      args.dbPath = arg.slice("--db=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!validSuites.has(args.suite)) {
    throw new Error(`Invalid --suite=${args.suite}`);
  }
  return args;
};

const requiredValue = (argv, idx, flag) => {
  const value = argv[idx + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
};

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
  const args = parseArgs(process.argv.slice(2));
  if (args.realCli) {
    throw new Error("Real CLI eval is not wired yet; use fake eval until Phase 6.");
  }

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
      adapterFactory: ({ testCase }) =>
        new FakeModelCliAdapter({
          scenario: testCase.scenario,
          chunkDelayMs: 0,
        }),
      ...(harnessSha ? { harnessSha } : {}),
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
