import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import { SqliteRepoIndexRepository } from "./repo-index-repository.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-repo-index-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const file = (patch = {}) => ({
  id: "repoidx_1",
  projectKey: "project",
  targetDir: "/tmp/project",
  relativePath: "src/index.ts",
  fileKind: "source",
  sizeBytes: 123,
  mtimeMs: 456,
  contentHash: "abc",
  summary: "symbols: run",
  symbols: ["run"],
  imports: ["node:path"],
  updatedAt: "2026-05-16T00:00:00.000Z",
  ...patch,
});

test("RepoIndexRepository upserts and lists indexed files", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteRepoIndexRepository(db);
    await repo.upsertMany([file()]);
    await repo.upsertMany([
      file({
        sizeBytes: 200,
        summary: "symbols: run, stop",
        symbols: ["run", "stop"],
      }),
    ]);
    const rows = await repo.listByTarget({
      projectKey: "project",
      targetDir: "/tmp/project",
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sizeBytes, 200);
    assert.deepEqual(rows[0].symbols, ["run", "stop"]);
    assert.deepEqual(rows[0].imports, ["node:path"]);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("RepoIndexRepository deleteMissing prunes stale target rows only", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteRepoIndexRepository(db);
    await repo.upsertMany([
      file({ id: "repoidx_1", relativePath: "src/index.ts" }),
      file({ id: "repoidx_2", relativePath: "src/old.ts" }),
      file({
        id: "repoidx_3",
        projectKey: "other",
        targetDir: "/tmp/other",
        relativePath: "src/old.ts",
      }),
    ]);
    await repo.deleteMissing({
      projectKey: "project",
      targetDir: "/tmp/project",
      keepRelativePaths: ["src/index.ts"],
    });
    const rows = await repo.listByTarget({
      projectKey: "project",
      targetDir: "/tmp/project",
    });
    assert.deepEqual(rows.map((row) => row.relativePath), ["src/index.ts"]);
    const otherRows = await repo.listByTarget({
      projectKey: "other",
      targetDir: "/tmp/other",
    });
    assert.equal(otherRows.length, 1);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
