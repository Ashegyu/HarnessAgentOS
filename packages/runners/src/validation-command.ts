import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ValidationKind } from "@harness/core";
import { simpleNpmArgs } from "./windows-command.ts";

export interface ValidationCommandInput {
  command: string;
  args?: readonly string[];
  cwd: string;
}
export interface ValidationCommandIdentity {
  checkerId: string;
  kinds: ValidationKind[];
  reason?: string;
}
interface Invocation { command: string; args: string[] }
interface Resolution { kinds: ValidationKind[]; identity: unknown; reason?: string }
interface PackageScripts { scripts: Record<string, string>; digest: string }
interface ResolutionBudget { remaining: number }

const MAX_COMMAND_CHARS = 64 * 1024;
const MAX_PACKAGE_BYTES = 256 * 1024;
const MAX_RECURSION = 8;
const MAX_CHAIN_LENGTH = 16;
const UNKNOWN = "Command cannot be verified as a supported checker invocation";
const kindOrder: readonly ValidationKind[] = ["build", "test", "smoke"];
const executableName = (command: string): string =>
  command.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, "") ?? "";
const supportedExecutableName = (command: string): string => {
  if (!/[\\/]/.test(command) && !isAbsolute(command)) return executableName(command);
  const runtime = process.platform === "win32" ? process.execPath.toLowerCase() : process.execPath;
  const candidate = process.platform === "win32" ? resolve(command).toLowerCase() : resolve(command);
  // The host's exact runtime also supports ELECTRON_RUN_AS_NODE. Other explicit paths are unverified.
  return isAbsolute(command) && candidate === runtime ? "node" : "";
};
const orderedKinds = (values: readonly ValidationKind[]): ValidationKind[] => kindOrder.filter(kind => values.includes(kind));
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const unknown = (identity: unknown, reason = UNKNOWN): Resolution => ({ kinds: [], identity, reason });

/**
 * Classify the approved executable/argv, never words in a display title.
 * Recognized process success is not a claim about assertion count or coverage.
 */
export const resolveValidationCommand = async (input: ValidationCommandInput): Promise<ValidationCommandIdentity> => {
  const cwd = await realpath(resolve(input.cwd)).catch(() => resolve(input.cwd));
  const canonicalCwd = process.platform === "win32" ? cwd.toLowerCase() : cwd;
  const cache = new Map<string, PackageScripts | null>();
  const raw = input.args === undefined
    ? parseSimpleCommands(input.command, topLevelNpm(input.command))
    : validArgv(input) ? [{ command: input.command, args: [...input.args] }] : null;
  const mode = input.args === undefined ? "shell" : "argv";
  const original = raw ?? { command: input.command, args: input.args ?? null };
  const resolved = raw
    ? await resolveChain(raw, cwd, cache, new Set(), 0, { remaining: 128 })
    : unknown(original, "Shell syntax or argument boundaries are not verifiable");
  return {
    checkerId: digest(JSON.stringify({ version: 1, cwd: canonicalCwd, mode, original, resolution: resolved.identity })),
    kinds: resolved.kinds,
    ...(resolved.reason ? { reason: resolved.reason } : {}),
  };
};

const validArgv = (input: ValidationCommandInput): boolean =>
  typeof input.command === "string" && input.command.length > 0 && input.command.length <= MAX_COMMAND_CHARS &&
  !/[\0\r\n]/.test(input.command) && Array.isArray(input.args) &&
  input.args.every(arg => typeof arg === "string" && !arg.includes("\0")) &&
  input.args.reduce((size, arg) => size + arg.length, input.command.length) <= MAX_COMMAND_CHARS;

// Share the execution path decision with ShellRunner; cmd.exe treats single quotes literally.
const topLevelNpm = (text: string): boolean => simpleNpmArgs(text) !== null;

/** No substitutions, comments, redirection, pipes, expansion, or ambiguous escapes. */
const parseSimpleCommands = (text: string, npmRaw = false): Invocation[] | null => {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_COMMAND_CHARS || /[|<>;`$#\r\n\0^%!]/.test(text)) return null;
  const commands: Invocation[] = [];
  let words: string[] = [];
  let word = "";
  let token = false;
  let quote: '"' | "'" | null = null;
  let closedQuote = false;
  const endWord = (): void => { if (token) words.push(word); word = ""; token = false; closedQuote = false; };
  const endCommand = (): boolean => {
    endWord();
    const command = words[0];
    if (!command || commands.length >= MAX_CHAIN_LENGTH) return false;
    commands.push({ command, args: words.slice(1) });
    words = [];
    return true;
  };
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quote) {
      if (character === "&") return null;
      if (character === quote) { quote = null; closedQuote = true; }
      else {
        if (character === "\\" && text[index + 1] === quote) return null;
        word += character;
      }
      continue;
    }
    if (character === " " || character === "\t") { endWord(); continue; }
    if (character === "&") {
      if (text[index + 1] !== "&" || !endCommand()) return null;
      index += 1;
      continue;
    }
    if (closedQuote) return null;
    if (character === '"' || character === "'") {
      if (token || (character === "'" && process.platform === "win32" && !npmRaw)) return null;
      quote = character; token = true; continue;
    }
    if (character === "\\" && process.platform !== "win32") return null;
    token = true;
    word += character;
  }
  if (quote || !endCommand()) return null;
  return commands;
};

const resolveChain = async (
  commands: readonly Invocation[], cwd: string, cache: Map<string, PackageScripts | null>, stack: Set<string>, depth: number,
  budget: ResolutionBudget,
): Promise<Resolution> => {
  if (depth > MAX_RECURSION || commands.length === 0) return unknown(commands, "Checker script recursion limit reached");
  const results: Resolution[] = [];
  for (const command of commands) results.push(await resolveInvocation(command, cwd, cache, stack, depth, budget));
  const identity = results.map(result => result.identity);
  const rejected = results.find(result => result.kinds.length === 0);
  return rejected ? unknown(identity, rejected.reason) : { kinds: orderedKinds(results.flatMap(result => result.kinds)), identity };
};

const resolveInvocation = async (
  invocation: Invocation, cwd: string, cache: Map<string, PackageScripts | null>, stack: Set<string>, depth: number,
  budget: ResolutionBudget,
): Promise<Resolution> => {
  const { command, args } = invocation;
  const name = supportedExecutableName(command);
  if (budget.remaining-- <= 0) return unknown(invocation, "Checker resolution budget limit reached");
  if (depth > MAX_RECURSION || args.some(arg => outsideWorkspaceArgument(arg, cwd))) return unknown(invocation, "Checker inputs leave the captured workspace");
  if (name === "npx") {
    const forwarded = args[0] === "--no-install" ? args.slice(1) : args;
    if (!forwarded[0] || forwarded[0].startsWith("-")) return unknown(invocation);
    const nested = await resolveInvocation({ command: forwarded[0], args: forwarded.slice(1) }, cwd, cache, stack, depth + 1, budget);
    return { ...nested, identity: { invocation, exec: nested.identity } };
  }
  if (name === "npm" || name === "pnpm" || name === "yarn") {
    if (args[0] === "exec") {
      const forwarded = name === "npm" ? args[1] === "--" ? args.slice(2) : [] : args.slice(1);
      if (!forwarded[0] || forwarded[0].startsWith("-")) return unknown(invocation);
      const nested = await resolveInvocation({ command: forwarded[0], args: forwarded.slice(1) }, cwd, cache, stack, depth + 1, budget);
      return { ...nested, identity: { invocation, exec: nested.identity } };
    }
    const call = scriptCall(name, args);
    if (!call) return unknown(invocation, "Package-manager flags or workspace selection are not verifiable");
    const manifest = await readScripts(cwd, cache);
    const body = manifest?.scripts[call.name];
    if (!manifest || body === undefined) return unknown(invocation, "A matching package script is required");
    const key = `${cwd}\0${call.name}`;
    if (stack.has(key)) return unknown(invocation, "Recursive package script cannot establish check execution");
    const hooks = [`pre${call.name}`, call.name, `post${call.name}`].filter(script => manifest.scripts[script] !== undefined);
    if (name !== "npm" && hooks.length !== 1) return unknown(invocation, "Package-manager lifecycle hooks are ambiguous");
    stack.add(key);
    try {
      const results: Resolution[] = [];
      let main: Resolution | undefined;
      for (const script of hooks) {
        const parsed = parseSimpleCommands(manifest.scripts[script]!);
        if (!parsed || (call.forwarded.length > 0 && script === call.name && parsed.length !== 1)) return unknown(invocation, "Package script shell syntax is not verifiable");
        if (script === call.name && call.forwarded.length > 0) parsed[0]!.args.push(...call.forwarded);
        const result = await resolveChain(parsed, cwd, cache, stack, depth + 1, budget);
        results.push(result);
        if (script === call.name) main = result;
      }
      const identity = { invocation, packageDigest: manifest.digest, scripts: results.map(result => result.identity) };
      const rejected = results.find(result => result.kinds.length === 0);
      // npm ignore-scripts skips hooks while still running an explicitly requested main script.
      return rejected || !main ? unknown(identity, rejected?.reason) : { kinds: main.kinds, identity };
    } finally { stack.delete(key); }
  }
  const kinds = directKinds(command, args);
  return kinds.length > 0 ? { kinds, identity: invocation } : unknown(invocation);
};

const scriptCall = (manager: string, input: readonly string[]): { name: string; forwarded: string[] } | null => {
  const divider = input.indexOf("--");
  const managerArgs = divider < 0 ? input : input.slice(0, divider);
  const args = [...managerArgs.filter(arg => arg !== "--silent" && arg !== "--quiet"),
    ...(divider < 0 ? [] : ["--", ...input.slice(divider + 1)])];
  const offset = args[0] === "run" || args[0] === "run-script" ? 1 : 0;
  const name = args[offset];
  if (!name || name.startsWith("-") || ["install", "i", "add", "remove", "exec", "help", "version", "list", "config", "dlx"].includes(name)) return null;
  if (manager === "npm" && offset === 0 && !["test", "start", "stop", "restart"].includes(name)) return null;
  const extra = args.slice(offset + 1);
  if (extra.length > 0 && extra[0] !== "--") return null;
  return { name, forwarded: extra.slice(1) };
};

const readScripts = async (cwd: string, cache: Map<string, PackageScripts | null>): Promise<PackageScripts | null> => {
  if (cache.has(cwd)) return cache.get(cwd)!;
  let result: PackageScripts | null = null;
  try {
    const handle = await open(join(cwd, "package.json"), "r");
    try {
      const before = await handle.stat({ bigint: true });
      if (before.isFile() && before.size <= BigInt(MAX_PACKAGE_BYTES)) {
        const buffer = Buffer.alloc(MAX_PACKAGE_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const after = await handle.stat({ bigint: true });
        if (bytesRead <= MAX_PACKAGE_BYTES && before.size === BigInt(bytesRead) && before.size === after.size &&
            before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs) {
          const text = buffer.subarray(0, bytesRead).toString("utf8");
          const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const scripts = (parsed as { scripts?: unknown }).scripts;
            if (scripts && typeof scripts === "object" && !Array.isArray(scripts) && Object.values(scripts).every(value => typeof value === "string")) {
              result = { scripts: scripts as Record<string, string>, digest: digest(text) };
            }
          }
        }
      }
    } finally { await handle.close(); }
  } catch { /* Missing, unstable, unreadable or malformed scripts are unverified. */ }
  cache.set(cwd, result);
  return result;
};

const outsideWorkspaceArgument = (argument: string, cwd: string): boolean => {
  if (/(?:^|[=:\s])\.\.(?:[\\/]|$)|[\\/]\.\.(?:[\\/]|$)/.test(argument)) return true;
  const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : argument;
  if (!isAbsolute(value)) return false;
  if (/^\/[a-z][^\\/]*:/i.test(value)) return false; // MSBuild /p: and /t: switches.
  const delta = relative(cwd, resolve(value));
  return delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta);
};

const NON_EXECUTION_FLAGS = new Set([
  "--help", "-h", "-?", "/?", "/help", "--version", "--list", "--list-tests", "--listtests",
  "--collect-only", "--co", "--no-run", "--showconfig", "--show-config", "--listfilesonly", "--list-files-only",
  "--show-only", "--init", "--passwithnotests", "--pass-with-no-tests", "--dry-run", "--dryrun", "--clearcache",
  "--fixtures", "--fixtures-per-test", "--markers", "--print-labels", "--help-command", "--help-module", "--help-policy",
  "--setup-plan", "--setup-only", "-list", "/version", "-version", "-help",
]);
const nonExecution = (args: readonly string[]): boolean => args.some(arg => {
  const flag = arg.split("=", 1)[0]!.toLowerCase();
  return NON_EXECUTION_FLAGS.has(flag) || arg === "-V" || flag.startsWith("--watch") || flag.startsWith("--help-");
});

const nodeTestMode = (args: readonly string[]): boolean => {
  let testing = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const flag = arg.split("=", 1)[0]!;
    if (["-e", "--eval", "-p", "--print", "-v", "--run"].includes(flag) || /^-[ep].+/.test(arg)) return false;
    if (arg === "--") return testing;
    if (arg === "--test") { testing = true; continue; }
    if (flag === "--import" || flag === "--loader" || flag === "--require" || flag === "-r") {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++index];
      // Arbitrary preloads can exit successfully before the test runner starts.
      if (value !== "tsx" && value !== "ts-node/register" && value !== "ts-node/esm") return false;
      continue;
    }
    if (!arg.startsWith("-") && !testing) return false;
  }
  return testing;
};

/** Positive option grammar: unsupported flags stay unknown instead of guessing a tool's mode. */
const knownOptions = (args: readonly string[], switches: readonly string[], values: readonly string[]): boolean => {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (!argument.startsWith("-")) continue;
    const equals = argument.indexOf("=");
    const flag = equals < 0 ? argument : argument.slice(0, equals);
    if (switches.includes(flag)) {
      if (equals >= 0 && !["true", "false"].includes(argument.slice(equals + 1))) return false;
    } else if (values.includes(flag)) {
      const value = equals < 0 ? args[++index] : argument.slice(equals + 1);
      if (!value || value.startsWith("-")) return false;
    } else return false;
  }
  return true;
};

const pytestMode = (args: readonly string[]): boolean => knownOptions(args,
  ["-v", "-vv", "-vvv", "-q", "-qq", "-x", "-s", "--verbose", "--quiet", "--exitfirst", "--disable-warnings", "--strict-markers"],
  ["-k", "-m", "-c", "--maxfail", "--tb", "--capture", "--rootdir", "--confcutdir", "--junitxml"]);
const jestMode = (args: readonly string[]): boolean => knownOptions(args,
  ["--runInBand", "-i", "--ci", "--coverage", "--verbose", "--silent", "--no-cache", "--bail", "--runTestsByPath"],
  ["--config", "-c", "--testNamePattern", "-t", "--testPathPattern", "--testPathPatterns", "--maxWorkers", "-w", "--projects", "--selectProjects"]);
const tscMode = (args: readonly string[]): boolean => knownOptions(args,
  ["-b", "--build", "--noEmit", "--incremental", "--composite", "--force", "-f", "--pretty", "--strict", "--skipLibCheck"],
  ["-p", "--project", "--target", "--module", "--outDir", "--rootDir", "--lib", "--moduleResolution"]);
const goMode = (args: readonly string[], testing: boolean): boolean => knownOptions(args,
  ["-v", "-race", "-trimpath", "-a", ...(testing ? ["-short", "-failfast", "-json", "-cover", "-benchmem", "-fullpath"] : [])],
  ["-o", "-tags", "-mod", ...(testing ? ["-count", "-timeout", "-run", "-bench", "-benchtime", "-shuffle", "-covermode", "-coverprofile", "-cpu", "-parallel", "-vet"] : [])]);
const ctestMode = (args: readonly string[]): boolean => knownOptions(args,
  ["--output-on-failure", "--stop-on-failure", "--verbose", "--extra-verbose", "--progress", "--schedule-random"],
  ["-C", "--build-config", "-R", "--tests-regex", "-E", "--exclude-regex", "-L", "--label-regex", "-LE", "--label-exclude", "-j", "--parallel", "--timeout", "--test-dir", "--output-junit"]);
const cmakeBuildMode = (args: readonly string[]): boolean => {
  if (args[0] !== "--build" || !args[1] || args[1].startsWith("-")) return false;
  const options = args.slice(2);
  if (!knownOptions(options, ["--verbose", "-v", "--clean-first"], ["--config", "--parallel", "-j", "--target", "-t"])) return false;
  // Only the default aggregate build target has supported semantics; no arbitrary target or native-tool passthrough.
  return options.every((arg, index) => !["--target", "-t"].includes(arg.split("=", 1)[0]!) ||
    (arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : options[index + 1]) === "all");
};
const msbuildMode = (args: readonly string[]): boolean => args.every(arg => {
  if (!/^[-/]/.test(arg)) return true;
  return /^[-/](?:t|target):(?:build|rebuild)$/i.test(arg) ||
    /^[-/](?:p|property):(?:configuration|platform)=[^;]+$/i.test(arg) ||
    /^[-/](?:nologo|restore|m(?::\d+)?|maxcpucount(?::\d+)?|(?:v|verbosity):(?:q|quiet|m|minimal|n|normal|d|detailed|diag|diagnostic))$/i.test(arg);
});

const directKinds = (command: string, args: readonly string[]): ValidationKind[] => {
  const name = supportedExecutableName(command);
  if (nonExecution(args)) return [];
  const first = args[0]?.toLowerCase();
  if (name === "dotnet") return first === "test" || first === "vstest" ? ["test"]
    : first === "build" || (first === "msbuild" && msbuildMode(args.slice(1))) ? ["build"] : [];
  if (name === "node" || name === "nodejs") return nodeTestMode(args) ? ["test"] : [];
  if (name === "python" || name === "python3" || name === "py") return args[0] === "-m" && args[1] === "pytest" && pytestMode(args.slice(2)) ? ["test"] : [];
  if (name === "pytest") return pytestMode(args) ? ["test"] : [];
  if (name === "jest") return jestMode(args) ? ["test"] : [];
  if (name === "mocha") return ["test"];
  if (name === "vitest") return first === "run" || (first?.startsWith("-") && args.includes("--run")) ? ["test"] : [];
  if (name === "playwright") return first === "test" ? ["test", "smoke"] : [];
  if (name === "cypress") return first === "run" ? ["test", "smoke"] : [];
  if (name === "go" || name === "cargo") {
    if (name === "go" && !goMode(args.slice(1), first === "test")) return [];
    return first === "test" ? ["test"] : first === "build" || (name === "cargo" && first === "check") ? ["build"] : [];
  }
  if (name === "ctest") return ctestMode(args) ? ["test"] : [];
  if (name === "cmake") return cmakeBuildMode(args) ? ["build"] : [];
  if (name === "tsc") return tscMode(args) ? ["build"] : [];
  if (name === "vite") return first === "build" ? ["build"] : [];
  if (name === "msbuild") return msbuildMode(args) ? ["build"] : [];
  return [];
};

/** Legacy timeline hint only. Actual quality evidence uses the async resolver. */
export const isTestInvocationHint = (command: string): boolean => {
  const parsed = parseSimpleCommands(command, topLevelNpm(command));
  if (!parsed || parsed.length !== 1) return false;
  const invocation = parsed[0]!;
  const name = supportedExecutableName(invocation.command);
  if (name === "npx") {
    const args = invocation.args[0] === "--no-install" ? invocation.args.slice(1) : invocation.args;
    return args[0] !== undefined && !args[0].startsWith("-") && directKinds(args[0], args.slice(1)).includes("test");
  }
  if (name === "npm" || name === "pnpm" || name === "yarn") {
    const call = scriptCall(name, invocation.args);
    return call?.name === "test" && !nonExecution(call.forwarded);
  }
  return directKinds(invocation.command, invocation.args).includes("test");
};
