import { statSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, delimiter } from "node:path";

const fileExists = (path: string): boolean => {
  try { return statSync(path).isFile(); } catch { return false; }
};

/** No workspace/current-directory executable search; explicit paths or trusted host PATH only. */
export const resolveWindowsCommand = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { command: string; args: string[]; nodeDir?: string } => {
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path");
  const paths = (env[pathKey ?? "PATH"] ?? "").split(delimiter).filter(isAbsolute);
  const find = (name: string): string | undefined => paths.map(path => join(path, name)).find(fileExists);
  const name = basename(command).toLowerCase();
  if (name === "npm" || name === "npm.cmd" || name === "npx" || name === "npx.cmd") {
    const tool = name.startsWith("npx") ? "npx" : "npm";
    const explicit = isAbsolute(command);
    const shim = explicit ? command : find(`${tool}.cmd`);
    const nodeCandidate = env.HARNESS_NODE_PATH ?? (shim && fileExists(join(dirname(shim), "node.exe")) ? join(dirname(shim), "node.exe") : find("node.exe"));
    const node = nodeCandidate && isAbsolute(nodeCandidate) && fileExists(nodeCandidate) ? nodeCandidate : undefined;
    const candidates = [
      ...(explicit ? [] : [env[tool === "npm" ? "HARNESS_NPM_CLI_PATH" : "HARNESS_NPX_CLI_PATH"]]),
      ...(shim ? [join(dirname(shim), `node_modules/npm/bin/${tool}-cli.js`)] : []),
      ...(!explicit && node ? [join(dirname(realpathSync(node)), `node_modules/npm/bin/${tool}-cli.js`), join(dirname(node), `../lib/node_modules/npm/bin/${tool}-cli.js`)] : []),
      ...(!explicit && env.ProgramFiles ? [join(env.ProgramFiles, `nodejs/node_modules/npm/bin/${tool}-cli.js`)] : []),
    ];
    const cli = candidates.find((candidate): candidate is string => Boolean(candidate && isAbsolute(candidate) && fileExists(candidate)));
    if (!node || !isAbsolute(node) || !fileExists(node) || !cli) {
      throw new Error("RUNNER_CLI_NOT_FOUND: Node.js/npm을 찾을 수 없습니다. Node.js 설치 경로를 PATH에 추가하거나 HARNESS_NODE_PATH 및 HARNESS_NPM_CLI_PATH를 지정하세요. / Configure Node.js/npm or an explicit executable path.");
    }
    return { command: node, args: [cli, ...args], nodeDir: dirname(node) };
  }
  if (/\.(?:cmd|bat)$/i.test(command)) {
    throw new Error("RUNNER_BATCH_ARGUMENTS_UNSUPPORTED: 구조화된 인수는 .cmd/.bat로 전달하지 않습니다. 실제 .exe 또는 Node + 스크립트 경로를 지정하세요.");
  }
  return { command, args };
};

export const decodeCommandOutput = (bytes: Buffer): string => {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return new TextDecoder("euc-kr").decode(bytes); }
};

/** Parse only a simple npm command. Shell syntax stays an explicitly approved raw command. */
export const simpleNpmArgs = (command: string): { command: string; args: string[] } | null => {
  if (!/^(npm|npx)(?:\s|$)/i.test(command) || /[&|<>^%!`$()\r\n]/.test(command)) return null;
  const words = command.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/g);
  if (!words || words.join(" ").replace(/\s+/g, " ") !== command.trim().replace(/\s+/g, " ")) return null;
  return { command: words[0]!, args: words.slice(1).map(word => /^['"]/.test(word) ? word.slice(1, -1) : word) };
};
