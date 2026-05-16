import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, LocalStateService } from "@harness/storage";
import { buildSkillSourceHandlers } from "./skill-source-ipc.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-ss-ipc-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const setupCtx = (file) => {
  const db = openDb({ filePath: file });
  const state = new LocalStateService(db);
  const skillSources = state.skillSources;
  // The handlers refresh the path-policy registry after add/update/remove
  // so callers can rely on "added → invocation sees it" semantics.
  const policyEvents = [];
  const pathPolicy = {
    registerSourceDir: (dir) => policyEvents.push({ kind: "register", dir }),
    unregisterSourceDir: (dir) => policyEvents.push({ kind: "unregister", dir }),
  };
  // The handlers also kick CapabilityRegistry.refresh() when sources change
  // or when the user explicitly hits refresh.
  const registryEvents = [];
  const capabilityRegistry = {
    refresh: async (source) => {
      registryEvents.push({ kind: "refresh", sourceId: source.id });
      return {
        sourceId: source.id,
        scannedCount: 0,
        updatedCount: 0,
        skillCount: 0,
      };
    },
  };
  return {
    db,
    ctx: { state, skillSources, pathPolicy, capabilityRegistry },
    policyEvents,
    registryEvents,
  };
};

test("skillSource.list returns ok([]) on a fresh DB", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildSkillSourceHandlers(ctx);
    const r = await h.list();
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, []);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("skillSource.add stamps custom + trusted=false + registers path policy", async () => {
  const t = tmp();
  const { db, ctx, policyEvents } = setupCtx(t.file);
  try {
    const h = buildSkillSourceHandlers(ctx);
    const r = await h.add({ name: "Mine", rootDir: "/tmp/skills" });
    assert.equal(r.ok, true);
    assert.equal(r.value.origin, "custom");
    assert.equal(r.value.trusted, false);
    assert.equal(r.value.registeredInPathPolicy, true);
    // The path-policy registry must see the registration so invocation
    // immediately picks up the new root.
    assert.deepEqual(policyEvents, [
      { kind: "register", dir: "/tmp/skills" },
    ]);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("skillSource.add rejects an empty rootDir", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildSkillSourceHandlers(ctx);
    const r = await h.add({ name: "X", rootDir: "" });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "STATE_INVALID_INPUT");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("skillSource.add rejects duplicate rootDir", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildSkillSourceHandlers(ctx);
    await h.add({ name: "A", rootDir: "/tmp/skills" });
    const dup = await h.add({ name: "B", rootDir: "/tmp/skills" });
    assert.equal(dup.ok, false);
    assert.equal(dup.error.code, "STATE_INVALID_INPUT");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("skillSource.update persists trust flips", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildSkillSourceHandlers(ctx);
    const added = (await h.add({ name: "A", rootDir: "/tmp/skills" })).value;
    const r = await h.update({ source: { ...added, trusted: true } });
    assert.equal(r.ok, true);
    assert.equal(r.value.trusted, true);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("skillSource.remove unregisters path policy", async () => {
  const t = tmp();
  const { db, ctx, policyEvents } = setupCtx(t.file);
  try {
    const h = buildSkillSourceHandlers(ctx);
    const added = (await h.add({ name: "A", rootDir: "/tmp/skills" })).value;
    const r = await h.remove({ sourceId: added.id });
    assert.equal(r.ok, true);
    assert.deepEqual(policyEvents.slice(-1), [
      { kind: "unregister", dir: "/tmp/skills" },
    ]);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("skillSource.refresh delegates to capabilityRegistry.refresh", async () => {
  const t = tmp();
  const { db, ctx, registryEvents } = setupCtx(t.file);
  try {
    const h = buildSkillSourceHandlers(ctx);
    const added = (await h.add({ name: "A", rootDir: "/tmp/skills" })).value;
    const r = await h.refresh({ sourceId: added.id });
    assert.equal(r.ok, true);
    assert.equal(typeof r.value.skillCount, "number");
    assert.deepEqual(registryEvents, [
      { kind: "refresh", sourceId: added.id },
    ]);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("skillSource.previewSkillDraft validates generated SKILL.md before write", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildSkillSourceHandlers(ctx);
    const added = (await h.add({ name: "A", rootDir: t.file + "-skills" })).value;
    const r = await h.previewSkillDraft({
      draft: {
        sourceId: added.id,
        slug: "review-helper",
        name: "Review Helper",
        description: "Summarize risky diffs before approval.",
        triggerTerms: ["review", "diff"],
        riskLevel: "low",
        allowedActions: [],
        body: "Use this skill to review a proposed patch.",
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.value.ok, true);
    assert.equal(r.value.relativePath, "review-helper/SKILL.md");
    assert.match(r.value.content, /name: "Review Helper"/);
    assert.equal(r.value.parsed.name, "Review Helper");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("skillSource.proposeSkillFile creates a pending file_write approval without writing the file", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildSkillSourceHandlers(ctx);
    const added = (await h.add({ name: "A", rootDir: t.file + "-skills" })).value;
    const r = await h.proposeSkillFile({
      draft: {
        sourceId: added.id,
        slug: "repair-helper",
        name: "Repair Helper",
        description: "Draft repair plans from failed quality gates.",
        triggerTerms: ["repair"],
        riskLevel: "medium",
        allowedActions: ["file_write"],
        body: "Use this skill when a quality gate fails.",
      },
    });

    assert.equal(r.ok, true);
    assert.equal(r.value.approval.actionType, "file_write");
    assert.equal(r.value.approval.status, "pending");
    assert.equal(
      r.value.approval.proposedAction.filePatch.path,
      "repair-helper/SKILL.md",
    );
    assert.match(
      r.value.approval.proposedAction.filePatch.after,
      /Draft repair plans/,
    );
    const detail = await ctx.state.getThreadDetail(r.value.threadId);
    assert.equal(detail.taskRuns[0].status, "waiting_for_approval");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
