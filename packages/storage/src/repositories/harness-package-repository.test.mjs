import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHarnessDefinition } from "@harness/core";
import { openDb, closeDb } from "../db.ts";
import { SqliteHarnessPackageRepository } from "./harness-package-repository.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-hpkg-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const definition = (overrides = {}) => ({
  id: "harness_perf",
  name: "Performance Harness",
  source: {
    format: "claude",
    rootDir: "C:/sample/perf",
    importedAt: "2026-05-27T00:00:00.000Z",
    files: [
      {
        relativePath: ".claude/CLAUDE.md",
        kind: "overview",
        sha256: "abc",
        parserVersion: "test",
      },
    ],
  },
  overview: {
    title: "Performance Harness",
    summary: "Performance package.",
  },
  agents: [],
  skills: [
    {
      id: "performance",
      name: "performance",
      description: "Performance skill.",
      triggerTerms: [],
      negativeTriggerTerms: [],
      sourceFile: ".claude/skills/performance/skill.md",
      workflowRefs: [],
      relatedSkillRefs: [],
      rawFrontmatter: {},
    },
  ],
  workflows: [],
  capabilities: [],
  validation: {
    status: "needs_review",
    issues: [
      {
        severity: "warning",
        code: "HARNESS_WORKFLOW_PARSE_PENDING",
        message: "Workflow parse pending.",
        blocksExecution: true,
      },
    ],
    importedAt: "2026-05-27T00:00:00.000Z",
    adapterVersion: "test",
  },
  ...overrides,
});

test("HarnessPackageRepository saves and reloads a definition snapshot", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteHarnessPackageRepository(db);
    const input = definition();
    assert.equal(isHarnessDefinition(input), true);
    await repo.save(input);

    const loaded = await repo.get(input.id);
    assert.deepEqual(loaded, input);
    assert.deepEqual(await repo.list(), [input]);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("HarnessPackageRepository updates existing snapshots by id", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteHarnessPackageRepository(db);
    const first = definition();
    const second = definition({
      name: "Performance Harness Updated",
      validation: {
        ...definition().validation,
        status: "valid_with_warnings",
      },
    });

    await repo.save(first);
    await repo.save(second);

    assert.deepEqual(await repo.list(), [second]);
    assert.deepEqual(await repo.get(first.id), second);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("HarnessPackageRepository rejects invalid definitions", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteHarnessPackageRepository(db);
    await assert.rejects(
      () => repo.save({ ...definition(), validation: { status: "maybe" } }),
      /Invalid HarnessDefinition/,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("HarnessPackageRepository.remove deletes snapshots", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteHarnessPackageRepository(db);
    const input = definition();
    await repo.save(input);
    await repo.remove(input.id);
    assert.equal(await repo.get(input.id), null);
    assert.deepEqual(await repo.list(), []);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
