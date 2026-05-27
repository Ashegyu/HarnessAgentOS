import { test } from "node:test";
import assert from "node:assert/strict";
import { detectHarnessSourceFormat } from "./harness-source-detection.ts";

test("detectHarnessSourceFormat detects complete Claude-compatible packages", () => {
  const result = detectHarnessSourceFormat({
    rootDir: "sample",
    relativePaths: [
      ".claude/CLAUDE.md",
      ".claude/agents/profiler.md",
      ".claude/skills/performance-optimizer/skill.md",
    ],
  });

  assert.equal(result.status, "detected");
  assert.equal(result.format, "claude");
  assert.deepEqual(result.candidates.map((candidate) => candidate.format), [
    "claude",
  ]);
});

test("detectHarnessSourceFormat detects complete Codex-compatible packages", () => {
  const result = detectHarnessSourceFormat({
    rootDir: "sample",
    relativePaths: ["AGENTS.md", "skills/performance-optimizer/SKILL.md"],
  });

  assert.equal(result.status, "detected");
  assert.equal(result.format, "codex");
});

test("detectHarnessSourceFormat detects complete Harness-native packages", () => {
  const result = detectHarnessSourceFormat({
    rootDir: "sample",
    relativePaths: [
      ".harness/manifest.json",
      ".harness/agents/profiler.md",
      ".harness/skills/performance-optimizer/SKILL.md",
    ],
  });

  assert.equal(result.status, "detected");
  assert.equal(result.format, "harness-native");
});

test("detectHarnessSourceFormat normalizes Windows separators and case", () => {
  const result = detectHarnessSourceFormat({
    rootDir: "sample",
    relativePaths: [
      ".CLAUDE\\Claude.md",
      ".CLAUDE\\Agents\\Profiler.md",
      ".CLAUDE\\Skills\\Performance-Optimizer\\Skill.md",
    ],
  });

  assert.equal(result.status, "detected");
  assert.equal(result.format, "claude");
  assert.ok(
    result.candidates[0].evidence.includes(
      ".CLAUDE/Skills/Performance-Optimizer/Skill.md",
    ),
  );
});

test("detectHarnessSourceFormat marks multiple complete packages as ambiguous", () => {
  const result = detectHarnessSourceFormat({
    rootDir: "sample",
    relativePaths: [
      ".claude/CLAUDE.md",
      ".claude/skills/performance-optimizer/skill.md",
      "AGENTS.md",
      "skills/performance-optimizer/SKILL.md",
    ],
  });

  assert.equal(result.status, "ambiguous");
  assert.equal(result.format, undefined);
  assert.deepEqual(
    result.candidates
      .filter((candidate) => candidate.complete)
      .map((candidate) => candidate.format)
      .sort(),
    ["claude", "codex"],
  );
});

test("detectHarnessSourceFormat rejects incomplete package markers", () => {
  const result = detectHarnessSourceFormat({
    rootDir: "sample",
    relativePaths: [".claude/CLAUDE.md"],
  });

  assert.equal(result.status, "unsupported");
  assert.equal(result.format, undefined);
  assert.equal(result.candidates[0].format, "claude");
  assert.deepEqual(result.candidates[0].missing, [
    ".claude/skills/*/skill.md",
  ]);
});

test("detectHarnessSourceFormat rejects directories with no known markers", () => {
  const result = detectHarnessSourceFormat({
    rootDir: "sample",
    relativePaths: ["README.md", "src/index.ts"],
  });

  assert.equal(result.status, "unsupported");
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.reasons, ["No supported harness package markers found."]);
});
