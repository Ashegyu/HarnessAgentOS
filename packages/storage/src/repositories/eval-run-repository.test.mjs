import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, closeDb } from "../db.ts";
import { LocalStateService } from "../services/local-state-service.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-eval-run-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const makeSummary = (runId, suite = "capability") => ({
  runId,
  suite,
  startedAt: "2026-05-17T14:00:00.000Z",
  finishedAt: "2026-05-17T14:01:00.000Z",
  cases: [],
  status: "passed",
  harnessRevisionSha: "abc1234",
});

test("EvalRunRepository.create marks status running and returns a full record", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);

    const record = await state.evalRuns.create({
      suite: "capability",
      harnessSha: "abc1234",
    });

    assert.match(record.id, /^evrun_/);
    assert.equal(record.status, "running");
    assert.equal(record.suite, "capability");
    assert.equal(record.summary.runId, record.id);
    assert.equal(record.summary.status, "running");
    assert.equal(record.harnessSha, "abc1234");
    assert.equal(typeof record.createdAt, "string");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("EvalRunRepository.finish updates status and summary_json", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const created = await state.evalRuns.create({ suite: "capability" });
    const summary = makeSummary(created.id);

    const finished = await state.evalRuns.finish(created.id, {
      status: "passed",
      summary,
    });

    assert.equal(finished.status, "passed");
    assert.ok(finished.finishedAt);
    assert.equal(finished.summary.status, "passed");
    assert.equal(finished.summary.runId, created.id);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("EvalRunRepository.list filters and orders newest first", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const first = await state.evalRuns.create({ suite: "capability" });
    const second = await state.evalRuns.create({ suite: "safety" });
    await state.evalRuns.finish(first.id, {
      status: "failed",
      summary: { ...makeSummary(first.id), status: "failed" },
    });
    await state.evalRuns.finish(second.id, {
      status: "passed",
      summary: makeSummary(second.id, "safety"),
    });

    const all = await state.evalRuns.list();
    assert.deepEqual(
      all.map((record) => record.id),
      [second.id, first.id],
    );
    const safety = await state.evalRuns.list({ suite: "safety" });
    assert.deepEqual(safety.map((record) => record.id), [second.id]);
    const failed = await state.evalRuns.list({ status: "failed" });
    assert.deepEqual(failed.map((record) => record.id), [first.id]);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("EvalRunRepository.delete removes a run", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const record = await state.evalRuns.create({ suite: "all" });

    await state.evalRuns.delete(record.id);

    assert.equal(await state.evalRuns.get(record.id), null);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
