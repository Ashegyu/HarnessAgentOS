import type { EvalSuite } from "./thresholds.ts";
import type { EvalProvider } from "./types.ts";
import { isEvalProvider } from "./v2-contracts.ts";

export interface EvalCliOptions {
  readonly suite: EvalSuite;
  readonly caseId?: string;
  readonly outDir?: string;
  readonly fixturesRoot?: string;
  readonly dbPath?: string;
  readonly realCli: boolean;
  readonly llmJudge: boolean;
  readonly providers?: ReadonlyArray<EvalProvider>;
  readonly attemptsOverride?: number;
  readonly timeoutMs?: number;
  readonly stallTimeoutMs?: number;
}

const VALID_SUITES: ReadonlySet<string> = new Set([
  "capability",
  "regression",
  "safety",
  "all",
]);

export const parseEvalCliArgs = (
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): EvalCliOptions => {
  const draft: {
    suite: string;
    caseId?: string;
    outDir?: string;
    fixturesRoot?: string;
    dbPath?: string;
    realCli: boolean;
    llmJudge: boolean;
    providers?: ReadonlyArray<EvalProvider>;
    attemptsOverride?: number;
    timeoutMs?: number;
    stallTimeoutMs?: number;
  } = {
    suite: "all",
    realCli: env["EVAL_REAL_CLI"] === "1",
    llmJudge: env["EVAL_LLM_JUDGE"] === "1",
  };

  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx] ?? "";
    if (arg === "--real-cli") {
      draft.realCli = true;
      continue;
    }
    if (arg === "--llm-judge") {
      draft.llmJudge = true;
      continue;
    }
    if (arg === "--suite" || arg.startsWith("--suite=")) {
      const [value, nextIdx] = readOption(argv, idx, "--suite");
      draft.suite = value;
      idx = nextIdx;
      continue;
    }
    if (arg === "--case" || arg.startsWith("--case=")) {
      const [value, nextIdx] = readOption(argv, idx, "--case");
      draft.caseId = value;
      idx = nextIdx;
      continue;
    }
    if (arg === "--out" || arg.startsWith("--out=")) {
      const [value, nextIdx] = readOption(argv, idx, "--out");
      draft.outDir = value;
      idx = nextIdx;
      continue;
    }
    if (arg === "--fixtures" || arg.startsWith("--fixtures=")) {
      const [value, nextIdx] = readOption(argv, idx, "--fixtures");
      draft.fixturesRoot = value;
      idx = nextIdx;
      continue;
    }
    if (arg === "--db" || arg.startsWith("--db=")) {
      const [value, nextIdx] = readOption(argv, idx, "--db");
      draft.dbPath = value;
      idx = nextIdx;
      continue;
    }
    if (arg === "--providers" || arg.startsWith("--providers=")) {
      const [value, nextIdx] = readOption(argv, idx, "--providers");
      draft.providers = parseProviders(value);
      idx = nextIdx;
      continue;
    }
    if (arg === "--attempts" || arg.startsWith("--attempts=")) {
      const [value, nextIdx] = readOption(argv, idx, "--attempts");
      draft.attemptsOverride = parseBoundedInteger(value, "--attempts", 1, 10);
      idx = nextIdx;
      continue;
    }
    if (arg === "--timeout-ms" || arg.startsWith("--timeout-ms=")) {
      const [value, nextIdx] = readOption(argv, idx, "--timeout-ms");
      draft.timeoutMs = parseBoundedInteger(value, "--timeout-ms", 1_000, 3_600_000);
      idx = nextIdx;
      continue;
    }
    if (
      arg === "--stall-timeout-ms" ||
      arg.startsWith("--stall-timeout-ms=")
    ) {
      const [value, nextIdx] = readOption(argv, idx, "--stall-timeout-ms");
      draft.stallTimeoutMs = parseBoundedInteger(
        value,
        "--stall-timeout-ms",
        1_000,
        3_600_000,
      );
      idx = nextIdx;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!VALID_SUITES.has(draft.suite)) {
    throw new Error(`Invalid --suite=${draft.suite}`);
  }

  return {
    suite: draft.suite as EvalSuite,
    ...(draft.caseId ? { caseId: draft.caseId } : {}),
    ...(draft.outDir ? { outDir: draft.outDir } : {}),
    ...(draft.fixturesRoot ? { fixturesRoot: draft.fixturesRoot } : {}),
    ...(draft.dbPath ? { dbPath: draft.dbPath } : {}),
    realCli: draft.realCli,
    llmJudge: draft.llmJudge,
    ...(draft.providers ? { providers: draft.providers } : {}),
    ...(draft.attemptsOverride !== undefined
      ? { attemptsOverride: draft.attemptsOverride }
      : {}),
    ...(draft.timeoutMs !== undefined ? { timeoutMs: draft.timeoutMs } : {}),
    ...(draft.stallTimeoutMs !== undefined
      ? { stallTimeoutMs: draft.stallTimeoutMs }
      : {}),
  };
};

const parseProviders = (value: string): ReadonlyArray<EvalProvider> => {
  const providers = value
    .split(",")
    .map((provider) => provider.trim())
    .filter((provider) => provider.length > 0);
  if (providers.length === 0) {
    throw new Error("--providers requires at least one provider");
  }

  const parsed: EvalProvider[] = [];
  for (const provider of providers) {
    if (!isEvalProvider(provider)) {
      throw new Error(`--providers contains invalid provider: ${provider}`);
    }
    parsed.push(provider);
  }

  if (new Set(parsed).size !== parsed.length) {
    throw new Error("--providers must not contain duplicates");
  }

  return parsed;
};

const readOption = (
  argv: ReadonlyArray<string>,
  idx: number,
  flag: string,
): [string, number] => {
  const current = argv[idx] ?? "";
  if (current.startsWith(`${flag}=`)) {
    const value = current.slice(flag.length + 1);
    if (value.length === 0) throw new Error(`${flag} requires a value`);
    return [value, idx];
  }
  const value = argv[idx + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return [value, idx + 1];
};

const parseBoundedInteger = (
  value: string,
  flag: string,
  min: number,
  max: number,
): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  }
  return parsed;
};
