import assert from "node:assert/strict";
import test from "node:test";
import { access, readFile, mkdtemp, writeFile, unlink, rmdir, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { prepareCodexOutputSchema } from "./codex-output-schema.ts";

const input = { command: "owned-codex.exe", cwd: process.cwd(), env: {}, schema: { type: "object" } };
const mockExec = (calls, { version = "codex-cli 0.153.4", help = "      --output-schema <FILE>\n      --json", error } = {}) =>
  (command, args, options, callback) => {
    calls.push({ command, args, options });
    queueMicrotask(() => callback(error, args[0] === "--version" ? version : help, "secret stderr"));
    return {};
  };

test("probes version/help without a model, owns a unique schema file and cleans up", async () => {
  const calls = [];
  const prepared = await prepareCodexOutputSchema(input, { execFile: mockExec(calls) });
  assert.equal(isAbsolute(prepared.path), true);
  assert.equal(prepared.cliVersion, "0.153.4");
  assert.deepEqual(JSON.parse(await readFile(prepared.path, "utf8")), input.schema);
  assert.deepEqual(calls.map(c => c.args), [["--version"], ["exec", "--help"]]);
  assert.ok(calls.every(c => c.command === input.command && c.options.windowsHide && c.options.shell === false && c.options.timeout === 10000));
  await prepared.dispose();
  await prepared.dispose();
  await assert.rejects(access(prepared.path));
  await assert.rejects(access(dirname(prepared.path)));
});

for (const scenario of [
  { version: "unknown executable" },
  { help: "exec --json" },
  { help: "Do not use --output-schema (removed)" },
  { error: new Error("secret provider credentials") },
]) {
  test(`fails closed for unsupported CLI ${JSON.stringify(scenario)}`, async () => {
    await assert.rejects(prepareCodexOutputSchema(input, { execFile: mockExec([], scenario) }), error =>
      !error.message.includes("secret") && /출력 스키마/.test(error.message));
  });
}

test("schema files are invocation-specific and cleanup cannot remove another invocation", async () => {
  const [a, b] = await Promise.all([1, 2].map(() => prepareCodexOutputSchema(input, { execFile: mockExec([]) })));
  try {
    assert.notEqual(a.path, b.path);
    await a.dispose();
    await access(b.path);
  } finally { await a.dispose(); await b.dispose(); }
});

test("pre-cancelled preparation runs no subprocess and creates no schema file", async () => {
  const calls = [];
  await assert.rejects(prepareCodexOutputSchema({ ...input, signal: AbortSignal.abort() }, { execFile: mockExec(calls) }));
  assert.equal(calls.length, 0);
});

test("cleanup does not recursively delete unowned files", async () => {
  const prepared = await prepareCodexOutputSchema(input, { execFile: mockExec([]) });
  const extra = join(dirname(prepared.path), "unowned.txt");
  await writeFile(extra, "preserve");
  try {
    await assert.rejects(prepared.dispose());
    assert.equal(await readFile(extra, "utf8"), "preserve");
  } finally { await unlink(extra); await prepared.dispose(); }
});

test("cleanup refuses a replaced directory junction without touching its target", async () => {
  const prepared = await prepareCodexOutputSchema(input, { execFile: mockExec([]) });
  const directory = dirname(prepared.path);
  const target = await mkdtemp(join(tmpdir(), "harness-schema-junction-test-"));
  const targetFile = join(target, "output.schema.json");
  await writeFile(targetFile, "preserve");
  await prepared.dispose();
  await symlink(target, directory, process.platform === "win32" ? "junction" : "dir");
  try {
    await assert.rejects(prepared.dispose(), /ownership changed/);
    assert.equal(await readFile(targetFile, "utf8"), "preserve");
  } finally {
    if (process.platform === "win32") await rmdir(directory);
    else await unlink(directory);
    await unlink(targetFile);
    await rmdir(target);
  }
});
