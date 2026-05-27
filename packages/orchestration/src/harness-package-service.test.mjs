import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, LocalStateService, openDb } from "@harness/storage";
import { HarnessPackageService } from "./harness-package-service.ts";

const dbTmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-hpkg-svc-db-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const dirTmp = () => mkdtempSync(join(tmpdir(), "hgos-hpkg-svc-dir-"));

test("HarnessPackageService imports a directory and persists the snapshot", async () => {
  const dbTemp = dbTmp();
  const root = dirTmp();
  const db = openDb({ filePath: dbTemp.file });
  try {
    await writeFixture(root, ".claude/CLAUDE.md", "# Sample Harness\n\nOverview.");
    await writeFixture(
      root,
      ".claude/skills/demo/skill.md",
      "---\nname: demo\ndescription: Demo workflow.\n---\n# Demo",
    );

    const state = new LocalStateService(db);
    const service = new HarnessPackageService({ state });
    const result = await service.importDirectory({
      rootDir: root,
      importedAt: "2026-05-27T00:00:00.000Z",
    });

    assert.equal(result.ok, true);
    assert.equal(result.definition.source.format, "claude");
    assert.equal(result.definition.validation.status, "needs_review");

    const loaded = await state.harnessPackages.get(result.definition.id);
    assert.deepEqual(loaded, result.definition);
    assert.deepEqual(await service.listPackages(), [result.definition]);
    assert.deepEqual(await service.getPackage(result.definition.id), result.definition);
  } finally {
    closeDb(db);
    dbTemp.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("HarnessPackageService does not persist unsupported imports", async () => {
  const dbTemp = dbTmp();
  const root = dirTmp();
  const db = openDb({ filePath: dbTemp.file });
  try {
    await writeFixture(root, "README.md", "# Not a harness");
    const state = new LocalStateService(db);
    const service = new HarnessPackageService({ state });

    const result = await service.importDirectory({ rootDir: root });

    assert.equal(result.ok, false);
    assert.equal(result.detection.status, "unsupported");
    assert.deepEqual(await service.listPackages(), []);
  } finally {
    closeDb(db);
    dbTemp.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("HarnessPackageService creates a native starter harness snapshot", async () => {
  const dbTemp = dbTmp();
  const db = openDb({ filePath: dbTemp.file });
  try {
    const state = new LocalStateService(db);
    const service = new HarnessPackageService({ state });

    const created = await service.createPackage({
      name: "Video Production",
      description: "Create a video production workflow.",
      workflowName: "Default workflow",
      agentRef: "scriptwriter",
      agentName: "Script Writer",
      agentDescription: "Drafts the script.",
      stepTitle: "Draft script",
      stepInstruction: "Write a short script and return a plan.",
      outputContract: "plan",
      providerHint: "codex",
    });

    assert.equal(created.name, "Video Production");
    assert.equal(created.source.format, "harness-native");
    assert.equal(created.source.rootDir, "harness://manual");
    assert.equal(created.validation.status, "valid");
    assert.equal(created.agents.length, 1);
    assert.equal(created.agents[0].id, "scriptwriter");
    assert.equal(created.agents[0].providerHint, "codex");
    assert.equal(created.workflows.length, 1);
    assert.equal(created.workflows[0].steps.length, 1);
    assert.equal(created.workflows[0].steps[0].agentRef, "scriptwriter");
    assert.equal(created.workflows[0].steps[0].outputContract, "plan");

    assert.deepEqual(await state.harnessPackages.get(created.id), created);
  } finally {
    closeDb(db);
    dbTemp.cleanup();
  }
});

test("HarnessPackageService removes persisted package snapshots", async () => {
  const dbTemp = dbTmp();
  const root = dirTmp();
  const db = openDb({ filePath: dbTemp.file });
  try {
    await writeFixture(root, "skills/demo/SKILL.md", "---\nname: demo\ndescription: Demo.\n---");
    const service = new HarnessPackageService({
      state: new LocalStateService(db),
    });
    const result = await service.importDirectory({
      rootDir: root,
      importedAt: "2026-05-27T00:00:00.000Z",
    });
    assert.equal(result.ok, true);

    await service.removePackage(result.definition.id);

    assert.equal(await service.getPackage(result.definition.id), null);
    assert.deepEqual(await service.listPackages(), []);
  } finally {
    closeDb(db);
    dbTemp.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("HarnessPackageService saves manual repairs as separate snapshots", async () => {
  const dbTemp = dbTmp();
  const root = dirTmp();
  const db = openDb({ filePath: dbTemp.file });
  try {
    await writeFixture(root, "AGENTS.md", "# Agent policy");
    await writeFixture(
      root,
      "skills/demo/SKILL.md",
      [
        "---",
        "name: demo",
        "description: Demo workflow.",
        "---",
        "",
        "## Workflow",
        "",
        "| Order | Task | Owner | Depends On | Deliverable |",
        "|-------|------|-------|------------|-------------|",
        "| 1 | Draft plan | writer | None | `_workspace/plan.md` |",
      ].join("\n"),
    );
    const state = new LocalStateService(db);
    const service = new HarnessPackageService({ state });
    const imported = await service.importDirectory({
      rootDir: root,
      importedAt: "2026-05-27T00:00:00.000Z",
    });
    assert.equal(imported.ok, true);
    const original = imported.definition;

    const repaired = await service.repairPackage({
      packageId: original.id,
      note: "Resolved writer owner.",
      workflows: [
        {
          workflowId: original.workflows[0].id,
          steps: [
            {
              stepId: original.workflows[0].steps[0].id,
              agentRef: "writer",
            },
          ],
        },
      ],
    });

    assert.notEqual(repaired.definition.id, original.id);
    assert.equal(repaired.definition.repair.sourcePackageId, original.id);
    assert.equal(repaired.definition.repair.note, "Resolved writer owner.");
    assert.equal(repaired.definition.workflows[0].steps[0].agentRef, "writer");
    assert.equal((await service.getPackage(original.id)).repair, undefined);
    assert.equal((await service.listPackages()).length, 2);
  } finally {
    closeDb(db);
    dbTemp.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("HarnessPackageService blocks pipeline preview when readiness has binding errors", async () => {
  const dbTemp = dbTmp();
  const root = dirTmp();
  const db = openDb({ filePath: dbTemp.file });
  try {
    await writeFixture(root, ".claude/CLAUDE.md", "# YouTube Production");
    await writeFixture(
      root,
      ".claude/agents/content-strategist.md",
      "---\nname: content-strategist\ndescription: Strategy.\n---",
    );
    await writeFixture(
      root,
      ".claude/skills/youtube-production/skill.md",
      [
        "---",
        "name: youtube-production",
        "description: YouTube production workflow.",
        "---",
        "",
        "## Workflow",
        "",
        "| Order | Task | Owner | Depends On | Deliverable |",
        "|-------|------|-------|------------|-------------|",
        "| 1 | Content strategy | strategist | None | `_workspace/brief.md` |",
      ].join("\n"),
    );

    const state = new LocalStateService(db);
    const service = new HarnessPackageService({ state });
    const imported = await service.importDirectory({
      rootDir: root,
      importedAt: "2026-05-27T00:00:00.000Z",
    });
    assert.equal(imported.ok, true);

    const preview = await service.previewPipelineDraft({
      packageId: imported.definition.id,
      bindings: [
        {
          harnessAgentRef: "content-strategist",
          agentProfileId: "missing-profile",
        },
      ],
    });

    assert.equal(preview.ok, false);
    assert.equal(preview.readiness.ok, false);
    assert.equal(preview.readiness.errorCount, 1);
    assert.deepEqual(
      preview.readiness.issues.map((issue) => issue.code),
      ["HARNESS_PROFILE_UNKNOWN"],
    );
    assert.equal(preview.issues[0].code, "HARNESS_BINDING_READINESS_FAILED");
  } finally {
    closeDb(db);
    dbTemp.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("HarnessPackageService proposes export files as pending file_write approvals", async () => {
  const dbTemp = dbTmp();
  const root = dirTmp();
  const target = dirTmp();
  const db = openDb({ filePath: dbTemp.file });
  try {
    await writeFixture(root, "AGENTS.md", "# Agent policy");
    await writeFixture(
      root,
      "skills/demo/SKILL.md",
      [
        "---",
        "name: demo",
        "description: Demo workflow.",
        "---",
        "",
        "## Workflow",
        "",
        "| Order | Task | Owner | Depends On | Deliverable |",
        "|-------|------|-------|------------|-------------|",
        "| 1 | Draft plan | writer | None | `_workspace/plan.md` |",
      ].join("\n"),
    );
    const state = new LocalStateService(db);
    const service = new HarnessPackageService({ state });
    const imported = await service.importDirectory({
      rootDir: root,
      importedAt: "2026-05-27T00:00:00.000Z",
    });
    assert.equal(imported.ok, true);

    const proposed = await service.proposeExportPackage({
      packageId: imported.definition.id,
      targetFormat: "claude",
      targetDir: target,
    });

    assert.equal(proposed.preview.targetFormat, "claude");
    assert.equal(proposed.taskRun.status, "waiting_for_approval");
    assert.equal(proposed.targetDir, target);
    assert.equal(proposed.approvals.length, proposed.preview.files.length);
    assert.equal(
      proposed.approvals.every(
        (approval) =>
          approval.status === "pending" &&
          approval.actionType === "file_write" &&
          approval.proposedAction?.filePatch?.after.length > 0,
      ),
      true,
    );
    assert.deepEqual(
      proposed.approvals.map(
        (approval) => approval.proposedAction?.filePatch?.path,
      ),
      proposed.preview.files.map((file) => file.relativePath),
    );
  } finally {
    closeDb(db);
    dbTemp.cleanup();
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

async function writeFixture(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}
