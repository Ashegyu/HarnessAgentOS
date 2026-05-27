import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, LocalStateService, openDb } from "@harness/storage";
import { HarnessPackageService } from "./harness-package-service.ts";

const dbTmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-hpkg-svc-db-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const dirTmp = () => mkdtempSync(join(tmpdir(), "hgos-hpkg-svc-dir-"));

test("HarnessPackageService imports a directory and persists the snapshot", async () => {
  const dbTemp = dbTmp();
  const root = dirTmp();
  const db = openDb({ filePath: dbTemp.file });
  try {
    await writeFixture(root, ".claude/CLAUDE.md", "# Sample Harness\n\nOverview.");
    await writeFixture(
      root,
      ".claude/skills/demo/skill.md",
      "---\nname: demo\ndescription: Demo workflow.\n---\n# Demo",
    );

    const state = new LocalStateService(db);
    const service = new HarnessPackageService({ state });
    const result = await service.importDirectory({
      rootDir: root,
      importedAt: "2026-05-27T00:00:00.000Z",
    });

    assert.equal(result.ok, true);
    assert.equal(result.definition.source.format, "claude");
    assert.equal(result.definition.validation.status, "needs_review");

    const loaded = await state.harnessPackages.get(result.definition.id);
    assert.deepEqual(loaded, result.definition);
    assert.deepEqual(await service.listPackages(), [result.definition]);
    assert.deepEqual(await service.getPackage(result.definition.id), result.definition);
  } finally {
    closeDb(db);
    dbTemp.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("HarnessPackageService does not persist unsupported imports", async () => {
  const dbTemp = dbTmp();
  const root = dirTmp();
  const db = openDb({ filePath: dbTemp.file });
  try {
    await writeFixture(root, "README.md", "# Not a harness");
    const state = new LocalStateService(db);
    const service = new HarnessPackageService({ state });

    const result = await service.importDirectory({ rootDir: root });

    assert.equal(result.ok, false);
    assert.equal(result.detection.status, "unsupported");
    assert.deepEqual(await service.listPackages(), []);
  } finally {
    closeDb(db);
    dbTemp.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("HarnessPackageService removes persisted package snapshots", async () => {
  const dbTemp = dbTmp();
  const root = dirTmp();
  const db = openDb({ filePath: dbTemp.file });
  try {
    await writeFixture(root, "skills/demo/SKILL.md", "---\nname: demo\ndescription: Demo.\n---");
    const service = new HarnessPackageService({
      state: new LocalStateService(db),
    });
    const result = await service.importDirectory({
      rootDir: root,
      importedAt: "2026-05-27T00:00:00.000Z",
    });
    assert.equal(result.ok, true);

    await service.removePackage(result.definition.id);

    assert.equal(await service.getPackage(result.definition.id), null);
    assert.deepEqual(await service.listPackages(), []);
  } finally {
    closeDb(db);
    dbTemp.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

async function writeFixture(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}
