import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import { SqliteSkillSourceRepository } from "./skill-source-repository.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-ss-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

test("SkillSourceRepository.list returns [] on an empty DB", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSkillSourceRepository(db);
    assert.deepEqual(await repo.list(), []);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SkillSourceRepository.add stamps origin=custom, trusted=false by default", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSkillSourceRepository(db);
    const added = await repo.add({
      name: "My Skills",
      rootDir: "C:\\Users\\me\\skills",
    });
    assert.ok(added.id.startsWith("ss_"));
    assert.equal(added.origin, "custom");
    assert.equal(added.trusted, false);
    assert.equal(added.enabled, true);
    assert.equal(added.registeredInPathPolicy, false);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SkillSourceRepository.add rejects duplicate root_dir", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSkillSourceRepository(db);
    await repo.add({ name: "A", rootDir: "/tmp/skills" });
    await assert.rejects(
      () => repo.add({ name: "B", rootDir: "/tmp/skills" }),
      /already registered|UNIQUE/,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SkillSourceRepository.update flips trusted/enabled and bumps updatedAt", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSkillSourceRepository(db);
    const added = await repo.add({ name: "A", rootDir: "/tmp/skills" });
    await new Promise((r) => setTimeout(r, 5));
    const updated = await repo.update({
      ...added,
      trusted: true,
      enabled: false,
      registeredInPathPolicy: true,
    });
    assert.equal(updated.trusted, true);
    assert.equal(updated.enabled, false);
    assert.equal(updated.registeredInPathPolicy, true);
    assert.notEqual(updated.updatedAt, added.updatedAt);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SkillSourceRepository.remove deletes the row", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSkillSourceRepository(db);
    const added = await repo.add({ name: "A", rootDir: "/tmp/skills" });
    await repo.remove(added.id);
    assert.deepEqual(await repo.list(), []);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SkillSourceRepository.ensureSeed seeds project + user sentinels exactly once", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteSkillSourceRepository(db);
    await repo.ensureSeed({
      projectRootDir: "C:\\app\\skills",
      userRootDir: "C:\\AppData\\harness\\skills",
    });
    let all = await repo.list();
    assert.equal(all.length, 2);
    const project = all.find((s) => s.origin === "project");
    const user = all.find((s) => s.origin === "user");
    assert.ok(project, "project sentinel must exist");
    assert.ok(user, "user sentinel must exist");
    assert.equal(project.id, "ss_project");
    assert.equal(user.id, "ss_user");
    assert.equal(project.trusted, true);
    assert.equal(user.trusted, true);

    // Second call must NOT duplicate rows or overwrite user edits.
    await repo.update({ ...project, name: "Renamed project root" });
    await repo.ensureSeed({
      projectRootDir: "C:\\app\\skills",
      userRootDir: "C:\\AppData\\harness\\skills",
    });
    all = await repo.list();
    assert.equal(all.length, 2, "ensureSeed must be idempotent");
    const refreshed = all.find((s) => s.id === "ss_project");
    assert.equal(
      refreshed.name,
      "Renamed project root",
      "ensureSeed must not overwrite user edits",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
