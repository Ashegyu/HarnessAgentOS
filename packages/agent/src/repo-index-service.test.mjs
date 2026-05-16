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
  return {
    upsertMany: async (files) => {
      rows = files;
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
