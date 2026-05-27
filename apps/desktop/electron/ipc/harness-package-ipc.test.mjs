import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { HarnessPackageService } from "@harness/orchestration";
import { closeDb, LocalStateService, openDb } from "@harness/storage";
import { buildHarnessPackageHandlers } from "./harness-package-ipc.ts";

const dbTmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-hpkg-ipc-db-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const dirTmp = () => mkdtempSync(join(tmpdir(), "hgos-hpkg-ipc-dir-"));

const setup = () => {
  const t = dbTmp();
  const db = openDb({ filePath: t.file });
  const service = new HarnessPackageService({
    state: new LocalStateService(db),
  });
  return {
    db,
    t,
    handlers: buildHarnessPackageHandlers({ harnessPackages: service }),
  };
};

test("harnessPackages.list returns ok([]) on a fresh DB", async () => {
  const { db, t, handlers } = setup();
  try {
    const result = await handlers.list();
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, []);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("harnessPackages.importDirectory saves a Codex package snapshot", async () => {
  const { db, t, handlers } = setup();
  const root = dirTmp();
  try {
    await writeFixture(root, "AGENTS.md", "# Agent policy");
    await writeFixture(
      root,
      "skills/demo/SKILL.md",
      "---\nname: demo\ndescription: Demo workflow.\n---\n# Demo",
    );

    const imported = await handlers.importDirectory({ rootDir: root });
    assert.equal(imported.ok, true);
    assert.equal(imported.value.ok, true);
    assert.equal(imported.value.definition.source.format, "codex");

    const listed = await handlers.list();
    assert.equal(listed.ok, true);
    assert.equal(listed.value.length, 1);
    assert.equal(listed.value[0].id, imported.value.definition.id);

    const loaded = await handlers.get({
      packageId: imported.value.definition.id,
    });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.value.id, imported.value.definition.id);
  } finally {
    closeDb(db);
    t.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("harnessPackages.importDirectory returns review result for unsupported sources", async () => {
  const { db, t, handlers } = setup();
  const root = dirTmp();
  try {
    await writeFixture(root, "README.md", "# Not a harness");

    const imported = await handlers.importDirectory({ rootDir: root });

    assert.equal(imported.ok, true);
    assert.equal(imported.value.ok, false);
    assert.equal(imported.value.detection.status, "unsupported");
    assert.equal((await handlers.list()).value.length, 0);
  } finally {
    closeDb(db);
    t.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("harnessPackages.get and remove reject unknown packages", async () => {
  const { db, t, handlers } = setup();
  try {
    const get = await handlers.get({ packageId: "harness_missing" });
    assert.equal(get.ok, false);
    assert.equal(get.error.code, "HARNESS_PACKAGE_NOT_FOUND");

    const remove = await handlers.remove({ packageId: "harness_missing" });
    assert.equal(remove.ok, false);
    assert.equal(remove.error.code, "HARNESS_PACKAGE_NOT_FOUND");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("harnessPackages.importDirectory validates rootDir input", async () => {
  const { db, t, handlers } = setup();
  try {
    const result = await handlers.importDirectory({ rootDir: "   " });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "STATE_INVALID_INPUT");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

async function writeFixture(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}
