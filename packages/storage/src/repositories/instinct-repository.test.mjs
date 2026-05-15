import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import {
  SqliteEvolutionCandidateRepository,
  SqliteInstinctRepository,
  SqliteObservationRepository,
} from "./instinct-repository.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-instinct-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

test("ObservationRepository stores optional task/thread/project context", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteObservationRepository(db);
    const created = await repo.create({
      projectKey: "proj_a",
      source: "approval",
      eventType: "rejected",
      signal: "file_write_denied",
      summary: "User rejected a file write",
      payload: { approvalId: "apv_1" },
    });
    assert.ok(created.id.startsWith("obs_"));
    assert.equal(created.projectKey, "proj_a");
    assert.deepEqual(created.payload, { approvalId: "apv_1" });

    const listed = await repo.list({ projectKey: "proj_a" });
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], created);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("EvolutionCandidateRepository round-trips status and observation ids", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteEvolutionCandidateRepository(db);
    const created = await repo.create({
      projectKey: "proj_a",
      title: "Respect approval denials",
      proposedRule: "Do not retry rejected file writes automatically.",
      rationale: "Repeated approval rejection signal.",
      confidence: 0.72,
      observationIds: ["obs_a", "obs_b"],
    });
    assert.ok(created.id.startsWith("evo_"));
    assert.equal(created.status, "pending");
    assert.deepEqual(created.observationIds, ["obs_a", "obs_b"]);

    await new Promise((r) => setTimeout(r, 5));
    const updated = await repo.updateStatus(created.id, "approved");
    assert.equal(updated.status, "approved");
    assert.notEqual(updated.updatedAt, created.updatedAt);

    const approved = await repo.list({ projectKey: "proj_a", status: "approved" });
    assert.equal(approved.length, 1);
    assert.equal(approved[0].id, created.id);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("InstinctRepository lists active global and matching project instincts", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteInstinctRepository(db);
    const global = await repo.create({
      scope: "global",
      title: "No hidden side effects",
      rule: "Always require approval before side effects.",
      rationale: "Global safety rule.",
      confidence: 0.9,
      sourceObservationIds: ["obs_global"],
      tags: ["approval"],
    });
    const project = await repo.create({
      projectKey: "proj_a",
      scope: "project",
      title: "Use .test.mjs",
      rule: "Test files must end with .test.mjs.",
      rationale: "Repo convention.",
      confidence: 0.8,
      sourceObservationIds: ["obs_project"],
    });
    await repo.create({
      projectKey: "proj_b",
      scope: "project",
      title: "Other project",
      rule: "Other project rule.",
      rationale: "Different scope.",
      confidence: 0.8,
      sourceObservationIds: ["obs_other"],
    });
    await repo.updateStatus(project.id, "disabled");

    const active = await repo.list({ projectKey: "proj_a" });
    assert.deepEqual(active.map((i) => i.id), [global.id]);

    const withDisabled = await repo.list({
      projectKey: "proj_a",
      includeDisabled: true,
    });
    assert.deepEqual(
      withDisabled.map((i) => i.id).sort(),
      [global.id, project.id].sort(),
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
