import assert from "node:assert/strict";
import test from "node:test";
import { getProviderCommandCandidates } from "./provider-executable.ts";

const root = "C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin";
const options = {
  platform: "win32",
  env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", Path: "C:\\Windows\\System32" },
  exists: path => path === `${root}\\old-build\\codex.exe` || path === `${root}\\new-build\\codex.exe`,
  listDirectories: path => {
    assert.equal(path, root);
    return [{ name: "old-build", modifiedAt: 1 }, { name: "new-build", modifiedAt: 2 }];
  },
};

test("Explorer PATH discovers versioned desktop CLI installations, newest first", () => {
  assert.deepEqual(getProviderCommandCandidates("codex", options), [
    `${root}\\new-build\\codex.exe`, `${root}\\old-build\\codex.exe`, "codex",
  ]);
});

test("desktop discovery ignores incomplete installs and names outside the install directory", () => {
  assert.deepEqual(getProviderCommandCandidates("codex", {
    ...options,
    listDirectories: () => [
      { name: "..\\outside", modifiedAt: 100 }, { name: "C:\\outside", modifiedAt: 99 },
      { name: "missing", modifiedAt: 3 }, { name: "new-build", modifiedAt: 2 },
    ],
    exists: path => !path.includes("missing"),
  }).filter(path => path.includes("outside") || path.includes("missing")), []);
});

test("unreadable installation directory leaves PATH discovery available", () => {
  assert.deepEqual(getProviderCommandCandidates("codex", {
    ...options, exists: () => false, listDirectories: () => { throw new Error("EACCES"); },
  }), ["codex"]);
});

test("explicit overrides and non-Windows discovery do not enumerate desktop installs", () => {
  const listDirectories = () => { assert.fail("unexpected installation scan"); };
  assert.deepEqual(getProviderCommandCandidates("codex", { ...options, listDirectories, cliPathOverride: " C:\\Tools\\codex.exe " }), ["C:\\Tools\\codex.exe"]);
  assert.deepEqual(getProviderCommandCandidates("codex", { ...options, listDirectories, platform: "linux" }), ["codex"]);
});
