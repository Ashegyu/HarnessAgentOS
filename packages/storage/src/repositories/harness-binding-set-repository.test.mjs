import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHarnessBindingSet } from "@harness/core";
import { openDb, closeDb } from "../db.ts";
import { SqliteHarnessPackageRepository } from "./harness-package-repository.ts";
import { SqliteHarnessBindingSetRepository } from "./harness-binding-set-repository.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-hbinding-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const input = (overrides = {}) => ({
  packageId: "harness_youtube",
  workflowId: "workflow_youtube",
  name: "Default YouTube bindings",
  bindings: [
    {
      harnessAgentRef: "content-strategist",
      agentProfileId: "ap_strategy",
    },
    {
      harnessAgentRef: "scriptwriter",
      agentProfileId: "ap_writer",
      remoteEndpointId: "a2a_writer",
    },
  ],
  ...overrides,
});

const packageDefinition = () => ({
  id: "harness_youtube",
  name: "YouTube Harness",
  source: {
    format: "claude",
    rootDir: "C:/sample/youtube",
    importedAt: "2026-05-27T00:00:00.000Z",
    files: [],
  },
  overview: {
    title: "YouTube Harness",
    summary: "Sample package.",
  },
  agents: [],
  skills: [],
  workflows: [],
  capabilities: [],
  validation: {
    status: "needs_review",
    issues: [],
    importedAt: "2026-05-27T00:00:00.000Z",
    adapterVersion: "test",
  },
});

const seedPackage = async (db) => {
  await new SqliteHarnessPackageRepository(db).save(packageDefinition());
};

test("HarnessBindingSetRepository saves and reloads profile bindings", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    await seedPackage(db);
    const repo = new SqliteHarnessBindingSetRepository(db);

    const saved = await repo.save(input());

    assert.ok(saved.id.startsWith("hbs_"));
    assert.equal(isHarnessBindingSet(saved), true);
    assert.equal(saved.createdAt, saved.updatedAt);
    assert.deepEqual(await repo.get(saved.id), saved);
    assert.deepEqual(await repo.list({ packageId: "harness_youtube" }), [saved]);
    assert.deepEqual(
      await repo.list({
        packageId: "harness_youtube",
        workflowId: "workflow_youtube",
      }),
      [saved],
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("HarnessBindingSetRepository updates an existing binding set by id", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    await seedPackage(db);
    const repo = new SqliteHarnessBindingSetRepository(db);
    const saved = await repo.save(input());
    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = await repo.save({
      ...saved,
      name: "Reviewed bindings",
      bindings: [
        {
          harnessAgentRef: "content-strategist",
          agentProfileId: "ap_strategy_v2",
        },
      ],
    });

    assert.equal(updated.id, saved.id);
    assert.equal(updated.createdAt, saved.createdAt);
    assert.notEqual(updated.updatedAt, saved.updatedAt);
    assert.deepEqual(await repo.get(saved.id), updated);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("findByReferencedAgentProfileId returns only binding sets using the profile", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    await seedPackage(db);
    const repo = new SqliteHarnessBindingSetRepository(db);
    const referenced = await repo.save(input({ name: "Referenced bindings" }));
    await repo.save(
      input({
        name: "Other bindings",
        bindings: [
          {
            harnessAgentRef: "reviewer",
            agentProfileId: "ap_other",
          },
        ],
      }),
    );

    assert.deepEqual(
      await repo.findByReferencedAgentProfileId("ap_strategy"),
      [referenced],
    );
    assert.deepEqual(
      await repo.findByReferencedAgentProfileId("ap_missing"),
      [],
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("HarnessBindingSetRepository rejects malformed binding sets", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    await seedPackage(db);
    const repo = new SqliteHarnessBindingSetRepository(db);
    await assert.rejects(
      () => repo.save(input({ name: "" })),
      /HarnessBindingSet.name/,
    );
    await assert.rejects(
      () =>
        repo.save(
          input({
            bindings: [{ harnessAgentRef: "", agentProfileId: "ap_writer" }],
          }),
        ),
      /bindings/,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("HarnessBindingSetRepository.remove deletes binding sets", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    await seedPackage(db);
    const repo = new SqliteHarnessBindingSetRepository(db);
    const saved = await repo.save(input());

    await repo.remove(saved.id);

    assert.equal(await repo.get(saved.id), null);
    assert.deepEqual(await repo.list(), []);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
