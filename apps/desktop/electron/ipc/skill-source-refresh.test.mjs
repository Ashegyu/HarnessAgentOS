import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDb,
  FilesystemArtifactStore,
  LocalStateService,
  openDb,
} from "@harness/storage";
import { RunnerService } from "@harness/runners";
import { CapabilityRegistry } from "@harness/skillify-adapter";
import { buildSkillSourceHandlers } from "./skill-source-ipc.ts";
import { refreshGeneratedSkillSourceAfterRunner } from "./skill-source-refresh.ts";

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-ss-refresh-"));
  const db = openDb({ filePath: join(dir, "test.db") });
  const state = new LocalStateService(db);
  const capabilityRegistry = new CapabilityRegistry({ state });
  const artifactStore = new FilesystemArtifactStore({
    rootDir: join(dir, "artifacts"),
  });
  const runner = new RunnerService({ state, artifactStore });
  return {
    dir,
    db,
    state,
    runner,
    capabilityRegistry,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

test("refreshGeneratedSkillSourceAfterRunner refreshes capabilities after approved SKILL.md write", async () => {
  const t = setup();
  try {
    const h = buildSkillSourceHandlers({
      state: t.state,
      skillSources: t.state.skillSources,
      pathPolicy: {
        registerSourceDir: () => {},
        unregisterSourceDir: () => {},
      },
      capabilityRegistry: {
        refresh: async (source) => ({
          sourceId: source.id,
          scannedCount: 0,
          updatedCount: 0,
          skillCount: 0,
        }),
      },
    });
    const rootDir = join(t.dir, "skills");
    const source = (await h.add({ name: "Generated", rootDir })).value;
    const proposed = await h.proposeSkillFile({
      draft: {
        sourceId: source.id,
        slug: "review-helper",
        name: "Review Helper",
        description: "Reviews diffs before approval.",
        triggerTerms: ["review", "diff"],
        riskLevel: "low",
        allowedActions: [],
        body: "Use this skill to review proposed changes.",
      },
    });
    assert.equal(proposed.ok, true);
    assert.deepEqual(await t.state.listCapabilities(), []);

    await t.state.decideApproval(proposed.value.approval.id, "approved", "test");
    await t.runner.executeApproved(proposed.value.approval.id);
    assert.deepEqual(await t.state.listCapabilities(), []);

    await refreshGeneratedSkillSourceAfterRunner(
      { state: t.state, capabilityRegistry: t.capabilityRegistry },
      proposed.value.approval.id,
    );
    const capabilities = await t.state.listCapabilities();
    assert.equal(capabilities.length, 1);
    assert.equal(capabilities[0].name, "Review Helper");
  } finally {
    closeDb(t.db);
    t.cleanup();
  }
});
