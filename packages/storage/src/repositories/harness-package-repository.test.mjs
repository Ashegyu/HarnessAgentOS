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

test("HarnessPackageRepository seeds eighteen useful workflow templates idempotently", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteHarnessPackageRepository(db);
    await repo.ensureSeed();

    const seeded = await repo.list();
    assert.equal(seeded.length, 18);
    assert.equal(seeded.every((item) => item.validation.status === "valid"), true);
    assert.equal(seeded.every((item) => item.agents.length >= 1), true);
    assert.equal(seeded.filter((item) => item.workflows[0].steps.length > 1).length, 8);
    assert.equal(seeded.every((item) => item.skills.length === 1), true);
    assert.equal(seeded.every((item) => item.workflows.length === 1), true);
    assert.equal(seeded.some((item) => item.name === "기능 개발 하네스"), true);
    assert.equal(seeded.some((item) => item.name === "릴리스 준비 하네스"), true);
    const localized = seeded.find(
      (item) => item.id === "harness_seed_feature_delivery",
    );
    assert.equal(
      localized?.skills[0]?.rawFrontmatter.harnessLocalization.key,
      "builtin.harness.featureDelivery",
    );
    assert.equal(
      localized?.skills[0]?.rawFrontmatter.harnessLocalization.en.name,
      "Feature Delivery Harness",
    );
    assert.equal(
      localized?.skills[0]?.rawFrontmatter.harnessLocalization.ko.name,
      "기능 개발 하네스",
    );

    const legacy = {
      ...seeded.find((item) => item.id === "harness_seed_feature_delivery"),
      name: "Feature Delivery Harness",
    };
    await repo.save(legacy);
    await repo.ensureSeed();
    assert.equal((await repo.get("harness_seed_feature_delivery"))?.name, "기능 개발 하네스");

    const customized = {
      ...seeded[0],
      name: "My Customized Harness",
    };
    await repo.save(customized);
    await repo.ensureSeed();

    assert.equal((await repo.list()).length, 18);
    assert.equal((await repo.get(customized.id))?.name, "My Customized Harness");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("seed refresh preserves custom instructions even when the built-in name is unchanged", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteHarnessPackageRepository(db);
    await repo.ensureSeed();
    const customized = await repo.get("harness_seed_documentation");
    customized.workflows[0].steps[0].instruction = "사용자 지정 문서 정책을 반드시 보존하세요.";
    await repo.save(customized);
    const before = db.prepare("SELECT * FROM harness_packages ORDER BY id").all();
    await repo.ensureSeed();
    assert.deepEqual(await repo.get(customized.id), customized);
    assert.deepEqual(db.prepare("SELECT * FROM harness_packages ORDER BY id").all(), before);
  } finally { closeDb(db); t.cleanup(); }
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
