import { execFile } from "node:child_process";
import { mkdtemp, writeFile, unlink, rmdir, realpath, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CodexOutputSchemaInput {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  schema: object;
}

export interface PreparedCodexOutputSchema {
  path: string;
  cliVersion: string;
  dispose(): Promise<void>;
}

/** Read-only CLI capability probes; neither command starts a model session. */
export const prepareCodexOutputSchema = async (
  input: CodexOutputSchemaInput,
  deps: { execFile?: typeof execFile } = {},
): Promise<PreparedCodexOutputSchema> => {
  const run = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
    if (input.signal?.aborted) { reject(unavailable()); return; }
    (deps.execFile ?? execFile)(input.command, args, {
      cwd: input.cwd, env: input.env, encoding: "utf8", shell: false, windowsHide: true,
      timeout: 10_000, maxBuffer: 256 * 1024,
      ...(input.signal ? { signal: input.signal } : {}),
    }, (error, stdout) => error ? reject(unavailable()) : resolve(stdout));
  });
  const versionText = await run(["--version"]);
  const cliVersion = /^codex-cli (\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/.exec(versionText.trim())?.[1];
  if (!cliVersion) throw unavailable();
  const help = await run(["exec", "--help"]);
  if (!/^\s*--output-schema\s+<[^>]+>/m.test(help) || input.signal?.aborted) throw unavailable();

  // Derived execution configuration only; SQLite remains the canonical state.
  // Unique directories avoid cross-invocation races. Never recursively delete:
  // cleanup owns exactly this generated file and its otherwise empty directory.
  const directory = await mkdtemp(join(tmpdir(), "harness-output-schema-"));
  const ownedDirectory = await realpath(directory);
  const path = join(directory, "output.schema.json");
  const dispose = async (): Promise<void> => {
    try {
      if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== ownedDirectory) {
        throw new Error("Output schema directory ownership changed; cleanup refused");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await unlink(path).catch(ignoreMissing);
    await rmdir(directory).catch(ignoreMissing);
  };
  try {
    await writeFile(path, JSON.stringify(input.schema), { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (input.signal?.aborted) throw unavailable();
    return { path, cliVersion, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
};

const ignoreMissing = (error: NodeJS.ErrnoException): void => {
  if (error.code !== "ENOENT") throw error;
};

const unavailable = (): Error => new Error(
  "Codex CLI의 버전과 출력 스키마 지원을 확인할 수 없습니다. CLI 설치 또는 실행 경로를 확인하세요.",
);
