import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import * as runners from "./index.ts";

const resolve = input => runners.resolveValidationCommand({ cwd: process.cwd(), ...input });
const fixture = async (t, scripts, extra = {}) => {
  const cwd = await mkdtemp(join(tmpdir(), "hgos-check-command-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "package.json"), JSON.stringify({ private: true, scripts, ...extra }));
  return cwd;
};

test("direct checker invocations preserve real argv and distinguish build, test and smoke", async () => {
  for (const [command, args, kinds] of [
    ["dotnet", ["test", "Project.csproj", "-c", "Release"], ["test"]],
    ["dotnet", ["build", "Project.csproj"], ["build"]],
    ["node", ["--import", "tsx", "--test", "tests/*.test.mjs"], ["test"]],
    ["python", ["-m", "pytest", "-q"], ["test"]],
    ["cargo", ["test", "--all"], ["test"]],
    ["go", ["build", "./..."], ["build"]],
    ["tsc", ["--noEmit", "-p", "tsconfig.json"], ["build"]],
    ["playwright", ["test"], ["test", "smoke"]],
    ["cypress", ["run"], ["test", "smoke"]],
  ]) {
    const actual = await resolve({ command, args });
    assert.deepEqual(actual.kinds, kinds, `${command} ${args.join(" ")}`);
    assert.match(actual.checkerId, /^[a-f0-9]{64}$/);
  }
});

test("print, discovery and ambiguous shell modes never become execution evidence", async () => {
  for (const command of [
    'echo "test build smoke"', 'printf "npm test"', "npm test || true", "npm test > output.log",
    "pytest | tee result.txt", "node --test; echo passed", "$(echo pytest)", "pytest # test",
    "node --test --help", "node --test --version", "cargo test --no-run", "pytest --collect-only",
    "jest --listTests", "jest --clearCache", "playwright test --list", "tsc --showConfig", "vitest --watch", "cypress open",
    "node script.mjs --test", "node -- --test", "pytest -V", "pytest --fixtures", "pytest --markers",
    "vitest bench --run", "ctest --print-labels", "msbuild /t:Help", "dotnet msbuild /t:Restore", "msbuild /version",
    "cmake --build . --target help", "cmake --build . --target clean", "go test -list .", "go test -c", "go test -exec echo",
    "pytest --setup-plan", "pytest --setup-only",
  ]) assert.deepEqual((await resolve({ command })).kinds, [], command);
});

test("structured arguments are data while raw shell operators remain unverified", async () => {
  assert.deepEqual((await resolve({ command: "node", args: ["--test", "literal&name.test.mjs"] })).kinds, ["test"]);
  assert.deepEqual((await resolve({ command: 'node --test "literal&name.test.mjs"' })).kinds, []);
  assert.deepEqual((await resolve({ command: "dotnet", args: ["test", "../other/Project.csproj"] })).kinds, []);
  assert.deepEqual((await resolve({ command: "node", args: ["--test", "--test-name-pattern=a b"] })).kinds, ["test"]);
  assert.deepEqual((await resolve({ command: "go", args: ["test", "-v", "./..."] })).kinds, ["test"]);
  assert.deepEqual((await resolve({ command: "pytest", args: ["-v"] })).kinds, ["test"]);
});

test("script names do not claim a check and actual package scripts must reach known runners", async t => {
  const cwd = await fixture(t, {
    test: 'echo "test build smoke"', build: "tsc --noEmit && vite build", smoke: "playwright test",
    unit: "npm run inner", inner: "vitest run", custom: "node scripts/check.mjs",
  });
  assert.deepEqual((await resolve({ cwd, command: "npm test" })).kinds, []);
  assert.deepEqual((await resolve({ cwd, command: "npm run build" })).kinds, ["build"]);
  assert.deepEqual((await resolve({ cwd, command: "npm run smoke" })).kinds, ["test", "smoke"]);
  assert.deepEqual((await resolve({ cwd, command: "npm run unit" })).kinds, ["test"]);
  assert.deepEqual((await resolve({ cwd, command: "npm run custom" })).kinds, []);
  assert.deepEqual((await resolve({ cwd, command: "npm run missing" })).kinds, []);
});

test("lifecycle hooks, recursion and workspace switches are resolved conservatively", async t => {
  const cwd = await fixture(t, { test: "vitest run", pretest: 'echo "preparing"', loop: "npm run loop" });
  assert.deepEqual((await resolve({ cwd, command: "npm test" })).kinds, []);
  assert.deepEqual((await resolve({ cwd, command: "npm run loop" })).kinds, []);
  assert.deepEqual((await resolve({ cwd, command: "npm --workspace other test" })).kinds, []);
  assert.deepEqual((await resolve({ cwd, command: "npm run test --if-present" })).kinds, []);
  assert.deepEqual((await resolve({ cwd, command: "yarn test" })).kinds, []);
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run", pretest: "tsc --noEmit" } }));
  assert.deepEqual((await resolve({ cwd, command: "npm test" })).kinds, ["test"]);
});

test("Windows raw shell quoting agrees with the actual simple npm execution path", { skip: process.platform !== "win32" }, async t => {
  const cwd = await fixture(t, { test: "node --test", "'test'": "echo skipped" });
  assert.deepEqual((await resolve({ cwd, command: "npm run 'test'" })).kinds, ["test"]);
  for (const command of ["npm.cmd run 'test'", " npm run 'test'", "npm run 'test' && node --test"]) {
    assert.deepEqual((await resolve({ cwd, command })).kinds, [], command);
  }
});

test("only supported actual tool modes can supply execution evidence", async t => {
  for (const [command, args] of [
    ["tsc", ["-b", "--clean"]], ["tsc", ["-b", "--dry"]],
    ["go", ["test", "-n"]], ["go", ["build", "-n"]],
    ["msbuild", ["/pp"]], ["msbuild", ["/pp:expanded.xml"]], ["dotnet", ["msbuild", "/pp"]],
    ["jest", ["-v"]], ["pytest", ["-VV"]], ["python", ["-m", "pytest", "-VV"]],
    ["ctest", ["-S", "noop.cmake"]], ["ctest", ["--build-and-test", "src", "out"]],
    ["cmake", ["--build", ".", "--target=help"]], ["cmake", ["--build", ".", "-t", "help"]],
    ["cmake", ["--build", ".", "--", "-n"]],
  ]) await t.test(`${command} ${args.join(" ")}`, async () => {
    assert.deepEqual((await resolve({ command, args })).kinds, []);
  });
});

test("npm lifecycle hooks affect identity but contribute no possibly skipped checker kind", async t => {
  const cwd = await fixture(t, { pretest: "tsc --noEmit", test: "node --test", posttest: "playwright test" });
  const original = await resolve({ cwd, command: "npm test" });
  assert.deepEqual(original.kinds, ["test"]);
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  const withoutHooks = await resolve({ cwd, command: "npm test" });
  assert.deepEqual(withoutHooks.kinds, ["test"]);
  assert.notEqual(original.checkerId, withoutHooks.checkerId);
});

test("an explicit arbitrary executable path cannot impersonate a supported checker basename", async t => {
  const cwd = await fixture(t, {});
  for (const command of [join(cwd, "pytest.exe"), join(cwd, "node.exe"), ".\\node_modules\\.bin\\pytest.exe"]) {
    assert.deepEqual((await resolve({ cwd, command, args: command.includes("node.exe") ? ["--test"] : [] })).kinds, []);
  }
  assert.deepEqual((await resolve({ cwd, command: process.execPath, args: ["--test"] })).kinds, ["test"]);
});

test("the host runtime exception never resolves an executable relative to the host cwd", async t => {
  const cwd = await fixture(t, {});
  const command = relative(process.cwd(), process.execPath);
  assert.deepEqual((await resolve({ cwd, command, args: ["--test"] })).kinds, []);
});

test("checker identity is stable but flags, argv boundaries, cwd and script body remain distinct", async t => {
  const cwd = await fixture(t, { test: "vitest run" });
  const initial = await resolve({ cwd, command: "npm", args: ["test"] });
  assert.equal(initial.checkerId, (await resolve({ cwd, command: "npm", args: ["test"] })).checkerId);
  assert.notEqual(initial.checkerId, (await resolve({ cwd, command: "npm", args: ["test", "--", "--runInBand"] })).checkerId);
  const one = await resolve({ cwd, command: "node", args: ["--test", "a b"] });
  const two = await resolve({ cwd, command: "node", args: ["--test", "a", "b"] });
  assert.notEqual(one.checkerId, two.checkerId);
  await mkdir(join(cwd, "nested"));
  assert.notEqual(one.checkerId, (await resolve({ cwd: join(cwd, "nested"), command: "node", args: ["--test", "a b"] })).checkerId);
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "jest --runInBand" } }));
  const changed = await resolve({ cwd, command: "npm", args: ["test"] });
  assert.notEqual(initial.checkerId, changed.checkerId);
});

test("npm exec and npx only unwrap an explicit known checker", async () => {
  assert.deepEqual((await resolve({ command: "npx --no-install vitest run" })).kinds, ["test"]);
  assert.deepEqual((await resolve({ command: "npm exec -- playwright test" })).kinds, ["test", "smoke"]);
  assert.deepEqual((await resolve({ command: "npx --package other vitest run" })).kinds, []);
  assert.deepEqual((await resolve({ command: "npx echo test" })).kinds, []);
});

test("acyclic wrapper expansion is bounded as well as recursive depth", async t => {
  const repeat = value => Array.from({ length: 8 }, () => value).join(" && ");
  const cwd = await fixture(t, { test: repeat("npm run level1"), level1: repeat("npm run level2"), level2: repeat("vitest run") });
  const result = await resolve({ cwd, command: "npm test" });
  assert.deepEqual(result.kinds, []);
  assert.match(result.reason, /limit|budget/i);
});
