import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDb,
  closeDb,
  LocalStateService,
} from "../../../packages/storage/src/index.ts";
import { CapabilityRegistry } from "./capability-registry.ts";
import { CapabilityService } from "./capability-service.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-cap-svc-"));
  return {
    dir,
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const seedSkill = (rootDir, skillName, opts = {}) => {
  const skillDir = join(rootDir, skillName);
  mkdirSync(skillDir, { recursive: true });
  const lines = [
    "---",
    `name: ${opts.name ?? skillName}`,
    `description: ${opts.description ?? "desc"}`,
    `risk: ${opts.risk ?? "low"}`,
    "allowedActions:",
    "  - file_write",
    "triggerTerms: [refactor, rename]",
    "---",
    "Body",
  ];
  writeFileSync(join(skillDir, "SKILL.md"), lines.join("\n"));
  if (opts.script) {
    const scriptDir = join(skillDir, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(join(scriptDir, opts.script), "#!/bin/sh\necho hi\n");
  }
  return skillDir;
};

const seedTaskRun = async (state) => {
  const thread = await state.createThread({
    title: "t",
    targetDir: "/tmp/proj",
  });
  return state.createTaskRun({
    threadId: thread.id,
    userRequest: "refactor the helper module",
    targetDir: "/tmp/proj",
    status: "running",
  });
};

test("registry refresh upserts capabilities and prunes stale ones", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const skillsRoot = join(t.dir, "skills-a");
    mkdirSync(skillsRoot, { recursive: true });
    seedSkill(skillsRoot, "refactor");
    const registry = new CapabilityRegistry({ state });
    const first = await registry.refresh([
      { source: "skillify:test", rootDir: skillsRoot, trusted: true },
    ]);
    assert.equal(first.length, 1);
    assert.equal(first[0].name, "refactor");

    // Remove the skill on disk and refresh again — capability should be pruned.
    rmSync(join(skillsRoot, "refactor"), { recursive: true, force: true });
    const second = await registry.refresh([
      { source: "skillify:test", rootDir: skillsRoot, trusted: true },
    ]);
    assert.equal(second.length, 0);
    const remaining = await state.listCapabilities();
    assert.equal(remaining.length, 0);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("suggest returns ranked capabilities for a TaskRun prompt", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const skillsRoot = join(t.dir, "skills");
    mkdirSync(skillsRoot, { recursive: true });
    seedSkill(skillsRoot, "refactor");
    const registry = new CapabilityRegistry({ state });
    await registry.refresh([
      { source: "skillify:test", rootDir: skillsRoot, trusted: true },
    ]);
    const service = new CapabilityService({ state, registry });
    const taskRun = await seedTaskRun(state);

    const suggestions = await service.suggest({
      taskRunId: taskRun.id,
      prompt: "rename helper",
    });
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].capability.name, "refactor");
    assert.ok(suggestions[0].matchedTerms.length > 0);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("proposeScriptRun creates an Approval row, never executes", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const skillsRoot = join(t.dir, "skills");
    mkdirSync(skillsRoot, { recursive: true });
    seedSkill(skillsRoot, "refactor", { script: "doit.sh" });
    const registry = new CapabilityRegistry({ state });
    await registry.refresh([
      { source: "skillify:test", rootDir: skillsRoot, trusted: true },
    ]);
    const service = new CapabilityService({ state, registry });
    const taskRun = await seedTaskRun(state);
    const capabilities = await state.listCapabilities();
    const approval = await service.proposeScriptRun({
      capabilityId: capabilities[0].id,
      taskRunId: taskRun.id,
      scriptName: "doit.sh",
    });
    assert.equal(approval.actionType, "skill_script");
    assert.equal(approval.status, "pending");

    // Untrusted variant should be refused.
    const untrustedRoot = join(t.dir, "skills-untrusted");
    mkdirSync(untrustedRoot, { recursive: true });
    seedSkill(untrustedRoot, "shady", { script: "doit.sh" });
    await registry.refresh([
      { source: "skillify:test", rootDir: skillsRoot, trusted: true },
      {
        source: "skillify:untrusted",
        rootDir: untrustedRoot,
        trusted: false,
      },
    ]);
    const untrustedCap = (await state.listCapabilities()).find(
      (c) => c.name === "shady",
    );
    await assert.rejects(
      () =>
        service.proposeScriptRun({
          capabilityId: untrustedCap.id,
          taskRunId: taskRun.id,
          scriptName: "doit.sh",
        }),
      (e) => e.code === "CAPABILITY_UNTRUSTED_SCRIPT",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("proposeScriptRun blocks directory traversal in scriptName", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const skillsRoot = join(t.dir, "skills");
    mkdirSync(skillsRoot, { recursive: true });
    seedSkill(skillsRoot, "refactor", { script: "ok.sh" });
    const registry = new CapabilityRegistry({ state });
    await registry.refresh([
      { source: "skillify:test", rootDir: skillsRoot, trusted: true },
    ]);
    const service = new CapabilityService({ state, registry });
    const taskRun = await seedTaskRun(state);
    const cap = (await state.listCapabilities())[0];
    await assert.rejects(
      () =>
        service.proposeScriptRun({
          capabilityId: cap.id,
          taskRunId: taskRun.id,
          scriptName: "../../etc/passwd",
        }),
      (e) => e.code === "CAPABILITY_SCRIPT_TRAVERSAL",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
