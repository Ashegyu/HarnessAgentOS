import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDb, LocalStateService, openDb } from "@harness/storage";

import { EvalOrchestrator } from "./orchestrator.ts";

const makeDbFactory = () => {
  const dbs = [];
  return {
    create: () => {
      const db = openDb({ filePath: ":memory:" });
      dbs.push(db);
      return new LocalStateService(db);
    },
    closeAll: () => {
      for (const db of dbs) closeDb(db);
    },
  };
};

const writeFixture = async (root, suite, fixture) => {
  const dir = path.join(root, suite);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${fixture.id}.eval.json`), JSON.stringify(fixture), "utf8");
};

const fileWriteFixture = {
  id: "file-write-readme",
  kind: "capability",
  title: "write readme",
  instruction: "현재 폴더에 README.md를 만들고 '# Hello' 한 줄을 적어라.",
  scenario: "ok-file-write-readme",
  attempts: 1,
  grader: {
    kind: "code",
    assertion: {
      type: "file_contains",
      path: "README.md",
      pattern: "^# Hello",
    },
  },
};

test("EvalOrchestrator creates a run row, report, and final status", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hgos-orch-"));
  const db = openDb({ filePath: path.join(root, "eval.db") });
  const dbFactory = makeDbFactory();
  try {
    await writeFixture(root, "capability", fileWriteFixture);
    const state = new LocalStateService(db);
    const outDir = path.join(root, "out");
    const orchestrator = new EvalOrchestrator({
      suite: "capability",
      fixturesRoot: root,
      outDir,
      state,
      inMemoryDbFactory: dbFactory.create,
      harnessSha: "abc1234",
      clock: () => 1_765_000_000_000,
    });

    const result = await orchestrator.run();

    assert.equal(result.overallPassed, true);
    assert.equal(result.summary.status, "passed");
    assert.match(result.summary.runId, /^evrun_/);
    assert.equal((await state.evalRuns.get(result.summary.runId))?.status, "passed");
    assert.equal((await stat(path.join(outDir, "report.md"))).isFile(), true);
    assert.match(await readFile(path.join(outDir, "report.md"), "utf8"), /Eval Report - capability/);
  } finally {
    dbFactory.closeAll();
    closeDb(db);
    await rm(root, { recursive: true, force: true });
  }
});

test("EvalOrchestrator filters a single case id", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hgos-orch-"));
  const db = openDb({ filePath: path.join(root, "eval.db") });
  const dbFactory = makeDbFactory();
  try {
    await writeFixture(root, "capability", fileWriteFixture);
    await writeFixture(root, "capability", {
      ...fileWriteFixture,
      id: "file-write-readme-second",
    });
    const state = new LocalStateService(db);
    const orchestrator = new EvalOrchestrator({
      suite: "capability",
      caseId: "file-write-readme-second",
      fixturesRoot: root,
      outDir: path.join(root, "out"),
      state,
      inMemoryDbFactory: dbFactory.create,
      clock: () => 1_765_000_000_000,
    });

    const result = await orchestrator.run();

    assert.deepEqual(
      result.summary.cases.map((caseResult) => caseResult.case.id),
      ["file-write-readme-second"],
    );
  } finally {
    dbFactory.closeAll();
    closeDb(db);
    await rm(root, { recursive: true, force: true });
  }
});

test("EvalOrchestrator can override attempts for real CLI smoke", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hgos-orch-"));
  const db = openDb({ filePath: path.join(root, "eval.db") });
  const dbFactory = makeDbFactory();
  try {
    await writeFixture(root, "capability", {
      ...fileWriteFixture,
      attempts: 3,
    });
    const state = new LocalStateService(db);
    const orchestrator = new EvalOrchestrator({
      suite: "capability",
      caseId: "file-write-readme",
      fixturesRoot: root,
      outDir: path.join(root, "out"),
      state,
      inMemoryDbFactory: dbFactory.create,
      attemptsOverride: 1,
      clock: () => 1_765_000_000_000,
    });

    const result = await orchestrator.run();

    assert.equal(result.summary.cases.length, 1);
    assert.equal(result.summary.cases[0].case.attempts, 1);
    assert.equal(result.summary.cases[0].attempts.length, 1);
  } finally {
    dbFactory.closeAll();
    closeDb(db);
    await rm(root, { recursive: true, force: true });
  }
});

test("EvalOrchestrator finalizes failed status when thresholds fail", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hgos-orch-"));
  const db = openDb({ filePath: path.join(root, "eval.db") });
  const dbFactory = makeDbFactory();
  try {
    await writeFixture(root, "capability", {
      ...fileWriteFixture,
      scenario: "parse-error",
    });
    const state = new LocalStateService(db);
    const orchestrator = new EvalOrchestrator({
      suite: "capability",
      fixturesRoot: root,
      outDir: path.join(root, "out"),
      state,
      inMemoryDbFactory: dbFactory.create,
      clock: () => 1_765_000_000_000,
    });

    const result = await orchestrator.run();

    assert.equal(result.overallPassed, false);
    assert.equal((await state.evalRuns.get(result.summary.runId))?.status, "failed");
  } finally {
    dbFactory.closeAll();
    closeDb(db);
    await rm(root, { recursive: true, force: true });
  }
});

test("EvalOrchestrator finalizes failed status when no case id matches", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hgos-orch-"));
  const db = openDb({ filePath: path.join(root, "eval.db") });
  const dbFactory = makeDbFactory();
  try {
    await writeFixture(root, "capability", fileWriteFixture);
    const state = new LocalStateService(db);
    const orchestrator = new EvalOrchestrator({
      suite: "capability",
      caseId: "missing-case",
      fixturesRoot: root,
      outDir: path.join(root, "out"),
      state,
      inMemoryDbFactory: dbFactory.create,
      clock: () => 1_765_000_000_000,
    });

    const result = await orchestrator.run();

    assert.equal(result.overallPassed, false);
    assert.equal(result.summary.cases.length, 0);
    assert.equal((await state.evalRuns.get(result.summary.runId))?.status, "failed");
  } finally {
    dbFactory.closeAll();
    closeDb(db);
    await rm(root, { recursive: true, force: true });
  }
});
