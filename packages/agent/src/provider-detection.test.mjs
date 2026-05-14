import { test } from "node:test";
import assert from "node:assert/strict";
import {
  providerForModel,
  defaultModelFor,
  normalizeModelForProvider,
} from "./provider-detection.ts";
import {
  getProviderCommandCandidates,
  resolveProviderCommand,
} from "./provider-executable.ts";

test("claude-* models route to the claude provider", () => {
  assert.equal(providerForModel("claude-sonnet-4-6"), "claude");
  assert.equal(providerForModel("claude-opus-4-7"), "claude");
});

test("gpt/codex/o-prefixed models route to the codex provider", () => {
  assert.equal(providerForModel("gpt-5"), "codex");
  assert.equal(providerForModel("codex-mini"), "codex");
  assert.equal(providerForModel("o4-mini"), "codex");
});

test("unknown models do not resolve to a provider", () => {
  assert.equal(providerForModel("llama-3"), null);
  assert.equal(providerForModel(""), null);
  assert.equal(providerForModel("   "), null);
});

test("defaultModelFor returns a sensible default per provider", () => {
  assert.match(defaultModelFor("claude"), /^claude/);
  assert.equal(defaultModelFor("codex"), "gpt-5.5");
});

test("normalizeModelForProvider upgrades unsupported Codex ChatGPT gpt-5 model", () => {
  assert.equal(normalizeModelForProvider("codex", "gpt-5"), "gpt-5.5");
  assert.equal(normalizeModelForProvider("codex", "gpt-5.5"), "gpt-5.5");
});

test("codex command candidates include the Windows app executable before PATH lookup", () => {
  const localAppData = "C:\\Users\\me\\AppData\\Local";
  const expected = "C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe";
  const candidates = getProviderCommandCandidates("codex", {
    platform: "win32",
    env: { LOCALAPPDATA: localAppData },
    exists: (path) => path === expected,
  });

  assert.deepEqual(candidates, [expected, "codex"]);
});

test("claude command candidates include the Windows local bin executable before PATH lookup", () => {
  const userProfile = "C:\\Users\\me";
  const expected = "C:\\Users\\me\\.local\\bin\\claude.exe";
  const candidates = getProviderCommandCandidates("claude", {
    platform: "win32",
    env: { USERPROFILE: userProfile },
    exists: (path) => path === expected,
  });

  assert.deepEqual(candidates, [expected, "claude"]);
});

test("cliPathOverride wins over provider executable discovery", () => {
  assert.equal(
    resolveProviderCommand("codex", "C:\\Tools\\codex.exe"),
    "C:\\Tools\\codex.exe",
  );
});
