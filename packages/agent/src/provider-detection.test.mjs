import { test } from "node:test";
import assert from "node:assert/strict";
import {
  providerForModel,
  defaultModelFor,
  normalizeModelForProvider,
  probeProvider,
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

test("codex command candidates prefer the npm native executable used by CMD shims", () => {
  const appData = "C:\\Users\\me\\AppData\\Roaming";
  const localAppData = "C:\\Users\\me\\AppData\\Local";
  const npmNative =
    "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe";
  const windowsApps =
    "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\codex.exe";
  const localApp =
    "C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe";
  const candidates = getProviderCommandCandidates("codex", {
    platform: "win32",
    env: {
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      Path: `${appData}\\npm;${localAppData}\\Microsoft\\WindowsApps`,
    },
    exists: (path) =>
      path === npmNative || path === windowsApps || path === localApp,
  });

  assert.deepEqual(candidates, [npmNative, windowsApps, localApp, "codex"]);
});

test("codex command candidates do not use npm cmd shims directly", () => {
  const appData = "C:\\Users\\me\\AppData\\Roaming";
  const localAppData = "C:\\Users\\me\\AppData\\Local";
  const cmdShim = "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd";
  const localApp =
    "C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe";
  const candidates = getProviderCommandCandidates("codex", {
    platform: "win32",
    env: {
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      Path: `${appData}\\npm`,
    },
    exists: (path) => path === cmdShim || path === localApp,
  });

  assert.deepEqual(candidates, [localApp, "codex"]);
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

test("probeProvider reports the command used for diagnostics", async () => {
  const probe = await probeProvider(process.execPath, { timeoutMs: 3_000 });

  assert.equal(probe.available, true);
  assert.equal(probe.command, process.execPath);
  assert.match(probe.version ?? "", /^v\d+\./);
});
