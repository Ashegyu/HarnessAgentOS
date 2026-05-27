import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { isHarnessDefinition } from "@harness/core";
import {
  importHarnessPackageFromDirectory,
  readHarnessSourceDirectory,
} from "./harness-directory-import.ts";

const TMP_ROOT = path.join(process.cwd(), ".tmp-harness-directory-import-tests");

after(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

test("readHarnessSourceDirectory reads supported files and skips unsafe bulk dirs", async () => {
  const root = path.join(TMP_ROOT, "claude-sample");
  await resetDir(root);
  await writeFixture(root, ".claude/CLAUDE.md", "# Sample Harness\n\nOverview.");
  await writeFixture(
    root,
    ".claude/skills/demo/skill.md",
    "---\nname: demo\ndescription: Demo skill.\n---\n# Demo",
  );
  await writeFixture(root, ".claude/agents/demo.md", "# Demo Agent");
  await writeFixture(root, "node_modules/noise/SKILL.md", "# Noise");
  await writeFixture(root, "README.txt", "ignore me");

  const scan = await readHarnessSourceDirectory(root);

  assert.deepEqual(
    scan.files.map((file) => file.relativePath).sort(),
    [
      ".claude/CLAUDE.md",
      ".claude/agents/demo.md",
      ".claude/skills/demo/skill.md",
    ],
  );
  assert.equal(
    scan.skipped.some(
      (item) => item.relativePath === "node_modules" && item.reason === "directory",
    ),
    true,
  );
  assert.equal(
    scan.skipped.some(
      (item) => item.relativePath === "README.txt" && item.reason === "extension",
    ),
    true,
  );
});

test("importHarnessPackageFromDirectory imports a real directory read-only", async () => {
  const root = path.join(TMP_ROOT, "codex-sample");
  await resetDir(root);
  await writeFixture(root, "AGENTS.md", "# AGENTS\n\nFollow approval policy.");
  await writeFixture(
    root,
    "skills/review/SKILL.md",
    "---\nname: review\ndescription: Review workflow.\n---\n# Review",
  );

  const result = await importHarnessPackageFromDirectory({
    rootDir: root,
    importedAt: "2026-05-27T00:00:00.000Z",
  });

  assert.equal(result.ok, true);
  assert.equal(result.definition.source.format, "codex");
  assert.equal(result.definition.skills[0].id, "review");
  assert.equal(result.definition.validation.status, "needs_review");
  assert.equal(isHarnessDefinition(result.definition), true);
});

test("readHarnessSourceDirectory enforces file count and size bounds", async () => {
  const root = path.join(TMP_ROOT, "bounds-sample");
  await resetDir(root);
  await writeFixture(root, ".claude/CLAUDE.md", "# Bounds");
  await writeFixture(root, ".claude/skills/demo/skill.md", "x".repeat(64));
  await writeFixture(root, ".claude/agents/demo.md", "# Agent");

  const scan = await readHarnessSourceDirectory(root, {
    maxFiles: 1,
    maxFileBytes: 32,
  });

  assert.equal(scan.files.length, 1);
  assert.equal(scan.skipped.some((item) => item.reason === "file_limit"), true);
});

test(
  "importHarnessPackageFromDirectory imports harness-100 samples when available",
  { skip: !existsSync(path.resolve(process.cwd(), "..", "harness-100")) },
  async () => {
    const harness100 = path.resolve(process.cwd(), "..", "harness-100");
    const samples = [
      path.join(harness100, "ko", "01-youtube-production"),
      path.join(harness100, "ko", "29-performance-optimizer"),
    ];

    for (const rootDir of samples) {
      const result = await importHarnessPackageFromDirectory({
        rootDir,
        importedAt: "2026-05-27T00:00:00.000Z",
      });
      assert.equal(result.ok, true, rootDir);
      assert.equal(result.definition.source.format, "claude");
      assert.equal(result.definition.agents.length >= 4, true);
      assert.equal(result.definition.skills.length >= 1, true);
      assert.equal(
        result.definition.validation.issues.some(
          (issue) => issue.code === "HARNESS_WORKFLOW_PARSE_PENDING",
        ),
        true,
      );
      assert.equal(isHarnessDefinition(result.definition), true);
    }
  },
);

async function resetDir(dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

async function writeFixture(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}
