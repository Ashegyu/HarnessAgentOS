import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RepoIndexService,
  classifyPath,
  extractImports,
  extractSymbols,
  summarizeFile,
} from "./repo-index-service.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-repo-service-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const makeStore = () => {
  let rows = [];
  const stats = { upsertCount: 0, upsertedFileCounts: [] };
  return {
    stats,
    upsertMany: async (files) => {
      stats.upsertCount += 1;
      stats.upsertedFileCounts.push(files.length);
      const byPath = new Map(rows.map((row) => [row.relativePath, row]));
      for (const file of files) byPath.set(file.relativePath, file);
      rows = [...byPath.values()];
    },
    deleteMissing: async ({ keepRelativePaths }) => {
      rows = rows.filter((row) => keepRelativePaths.includes(row.relativePath));
    },
    listByTarget: async () => rows,
  };
};

test("RepoIndexService refresh scans text project files and ignores heavy dirs", async () => {
  const t = tmp();
  try {
    mkdirSync(join(t.dir, "src"), { recursive: true });
    mkdirSync(join(t.dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(t.dir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node --test" } }));
    writeFileSync(join(t.dir, "src", "index.ts"), "import { join } from 'node:path';\nexport function run() { return join('a', 'b'); }\n");
    writeFileSync(join(t.dir, "node_modules", "x", "index.js"), "export const ignored = true;");
    const store = makeStore();
    const svc = new RepoIndexService({ store, now: () => "2026-05-16T00:00:00.000Z" });
    const rows = await svc.refresh({ projectKey: "demo", targetDir: t.dir });
    assert.deepEqual(rows.map((row) => row.relativePath).sort(), ["package.json", "src/index.ts"]);
    const source = rows.find((row) => row.relativePath === "src/index.ts");
    assert.equal(source.fileKind, "source");
    assert.deepEqual(source.symbols, ["run"]);
    assert.deepEqual(source.imports, ["node:path"]);
  } finally {
    t.cleanup();
  }
});

test("repo index helpers classify and summarize common files", () => {
  assert.equal(classifyPath("package.json"), "package");
  assert.equal(classifyPath("src/app.test.mjs"), "test");
  assert.equal(classifyPath("README.md"), "doc");
  assert.deepEqual(extractSymbols("export class Runner {}\nexport { Runner as DefaultRunner }"), ["Runner"]);
  assert.deepEqual(extractImports("const fs = require('node:fs');\nexport { x } from './x';"), ["node:fs", "./x"]);
  assert.equal(
    summarizeFile("package.json", JSON.stringify({ name: "demo", scripts: { build: "tsc" } }), 20),
    "package demo; scripts: build",
  );
});

test("RepoIndexService shares one in-flight refresh for the same target", async () => {
  const t = tmp();
  try {
    writeFileSync(join(t.dir, "index.ts"), "export const value = 1;\n");
    const store = makeStore();
    const svc = new RepoIndexService({ store });

    const [first, second] = await Promise.all([
      svc.refresh({ projectKey: "demo", targetDir: t.dir }),
      svc.refresh({ projectKey: "demo", targetDir: t.dir }),
    ]);

    assert.deepEqual(first, second);
    assert.equal(store.stats.upsertCount, 1);
  } finally {
    t.cleanup();
  }
});

test("RepoIndexService skips persistence for unchanged files on a warm refresh", async () => {
  const t = tmp();
  try {
    writeFileSync(join(t.dir, "index.ts"), "export const value = 1;\n");
    const store = makeStore();
    let tick = 0;
    const svc = new RepoIndexService({
      store,
      now: () => `2026-05-16T00:00:0${tick++}.000Z`,
    });

    const first = await svc.refresh({ projectKey: "demo", targetDir: t.dir });
    const second = await svc.refresh({ projectKey: "demo", targetDir: t.dir });

    assert.equal(store.stats.upsertCount, 1);
    assert.deepEqual(store.stats.upsertedFileCounts, [1]);
    assert.equal(second[0]?.updatedAt, first[0]?.updatedAt);
  } finally {
    t.cleanup();
  }
});

test("RepoIndexService upserts only files whose metadata changed", async () => {
  const t = tmp();
  try {
    writeFileSync(join(t.dir, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(t.dir, "b.ts"), "export const b = 1;\n");
    const store = makeStore();
    const svc = new RepoIndexService({ store });
    await svc.refresh({ projectKey: "demo", targetDir: t.dir });

    writeFileSync(join(t.dir, "b.ts"), "export const b = 200;\n");
    const rows = await svc.refresh({ projectKey: "demo", targetDir: t.dir });

    assert.deepEqual(store.stats.upsertedFileCounts, [2, 1]);
    assert.equal(rows.find((row) => row.relativePath === "a.ts")?.summary, "symbols: a");
    assert.equal(rows.find((row) => row.relativePath === "b.ts")?.summary, "symbols: b");
  } finally {
    t.cleanup();
  }
});
