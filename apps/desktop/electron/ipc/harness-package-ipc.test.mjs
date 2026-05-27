import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { HarnessPackageService } from "@harness/orchestration";
import { closeDb, LocalStateService, openDb } from "@harness/storage";
import { buildHarnessPackageHandlers } from "./harness-package-ipc.ts";

const dbTmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-hpkg-ipc-db-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const dirTmp = () => mkdtempSync(join(tmpdir(), "hgos-hpkg-ipc-dir-"));

const setup = () => {
  const t = dbTmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  const service = new HarnessPackageService({
    state,
  });
  return {
    db,
    t,
    state,
    handlers: buildHarnessPackageHandlers({ harnessPackages: service }),
  };
};

test("harnessPackages.list returns ok([]) on a fresh DB", async () => {
  const { db, t, handlers } = setup();
  try {
    const result = await handlers.list();
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, []);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("harnessPackages.importDirectory saves a Codex package snapshot", async () => {
  const { db, t, handlers } = setup();
  const root = dirTmp();
  try {
    await writeFixture(root, "AGENTS.md", "# Agent policy");
    await writeFixture(
      root,
      "skills/demo/SKILL.md",
      "---\nname: demo\ndescription: Demo workflow.\n---\n# Demo",
    );

    const imported = await handlers.importDirectory({ rootDir: root });
    assert.equal(imported.ok, true);
    assert.equal(imported.value.ok, true);
    assert.equal(imported.value.definition.source.format, "codex");

    const listed = await handlers.list();
    assert.equal(listed.ok, true);
    assert.equal(listed.value.length, 1);
    assert.equal(listed.value[0].id, imported.value.definition.id);

    const loaded = await handlers.get({
      packageId: imported.value.definition.id,
    });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.value.id, imported.value.definition.id);
  } finally {
    closeDb(db);
    t.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("harnessPackages.importDirectory returns review result for unsupported sources", async () => {
  const { db, t, handlers } = setup();
  const root = dirTmp();
  try {
    await writeFixture(root, "README.md", "# Not a harness");

    const imported = await handlers.importDirectory({ rootDir: root });

    assert.equal(imported.ok, true);
    assert.equal(imported.value.ok, false);
    assert.equal(imported.value.detection.status, "unsupported");
    assert.equal((await handlers.list()).value.length, 0);
  } finally {
    closeDb(db);
    t.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("harnessPackages.create saves a direct native starter package", async () => {
  const { db, t, handlers } = setup();
  try {
    const created = await handlers.create({
      package: {
        name: "Direct Harness",
        description: "Created without importing source files.",
        workflowName: "Default workflow",
        agentRef: "planner",
        stepTitle: "Plan work",
        stepInstruction: "Create a scoped implementation plan.",
        outputContract: "plan",
      },
    });

    assert.equal(created.ok, true);
    assert.equal(created.value.name, "Direct Harness");
    assert.equal(created.value.source.format, "harness-native");

    const listed = await handlers.list();
    assert.equal(listed.ok, true);
    assert.equal(listed.value.length, 1);
    assert.equal(listed.value[0].id, created.value.id);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("harnessPackages.create rejects blank direct package fields", async () => {
  const { db, t, handlers } = setup();
  try {
    const created = await handlers.create({
      package: {
        name: "",
        workflowName: "Default workflow",
        agentRef: "planner",
        stepTitle: "Plan work",
        stepInstruction: "Create a scoped implementation plan.",
      },
    });

    assert.equal(created.ok, false);
    assert.match(created.error.message, /name is required/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("harnessPackages.previewPipelineDraft returns a review-only pipeline draft", async () => {
  const { db, t, state, handlers } = setup();
  const root = dirTmp();
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

    const imported = await handlers.importDirectory({ rootDir: root });
    assert.equal(imported.ok, true);
    assert.equal(imported.value.ok, true);
    const profile = await state.agentProfiles.create(agentProfileInput({
      name: "Content Strategist",
      role: "planner",
    }));

    const preview = await handlers.previewPipelineDraft({
      packageId: imported.value.definition.id,
      bindings: [
        {
          harnessAgentRef: "content-strategist",
          agentProfileId: profile.id,
        },
      ],
    });

    assert.equal(preview.ok, true);
    assert.equal(preview.value.ok, true);
    assert.equal(preview.value.pipeline.steps.length, 1);
    assert.equal(
      preview.value.pipeline.steps[0].agentProfileId,
      profile.id,
    );
    assert.equal(preview.value.readiness.ok, true);
    assert.deepEqual(preview.value.pipeline.steps[0].dependsOn, []);
    assert.equal((await handlers.list()).value.length, 1);
  } finally {
    closeDb(db);
    t.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("harnessPackages binding set handlers persist direct orchestration routes", async () => {
  const { db, t, state, handlers } = setup();
  const root = dirTmp();
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
    const imported = await handlers.importDirectory({ rootDir: root });
    assert.equal(imported.ok, true);
    assert.equal(imported.value.ok, true);
    const definition = imported.value.definition;
    const workflowId = definition.workflows[0].id;
    const profile = await state.agentProfiles.create(
      agentProfileInput({
        name: "Content Strategist",
        role: "planner",
      }),
    );

    const saved = await handlers.saveBindingSet({
      bindingSet: {
        packageId: definition.id,
        workflowId,
        name: "Default route",
        bindings: [
          {
            harnessAgentRef: "content-strategist",
            agentProfileId: profile.id,
          },
        ],
      },
    });

    assert.equal(saved.ok, true);
    assert.ok(saved.value.id.startsWith("hbs_"));
    const listed = await handlers.listBindingSets({
      packageId: definition.id,
      workflowId,
    });
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.value, [saved.value]);
    const loaded = await handlers.getBindingSet({
      bindingSetId: saved.value.id,
    });
    assert.equal(loaded.ok, true);
    assert.deepEqual(loaded.value, saved.value);

    const removed = await handlers.removeBindingSet({
      bindingSetId: saved.value.id,
    });
    assert.equal(removed.ok, true);
    assert.deepEqual((await handlers.listBindingSets()).value, []);
  } finally {
    closeDb(db);
    t.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("harnessPackages.previewPipelineDraft forwards caller provider status into readiness", async () => {
  const { db, t, state, handlers } = setup();
  const root = dirTmp();
  try {
    await writeFixture(root, ".claude/CLAUDE.md", "# Provider Check");
    await writeFixture(
      root,
      ".claude/agents/reviewer.md",
      "---\nname: reviewer\ndescription: Review.\n---",
    );
    await writeFixture(
      root,
      ".claude/skills/review/skill.md",
      [
        "---",
        "name: review",
        "description: Review workflow.",
        "---",
        "",
        "## Workflow",
        "",
        "| Order | Task | Owner | Depends On | Deliverable |",
        "|-------|------|-------|------------|-------------|",
        "| 1 | Review | reviewer | None | `_workspace/review.md` |",
      ].join("\n"),
    );

    const imported = await handlers.importDirectory({ rootDir: root });
    assert.equal(imported.ok, true);
    assert.equal(imported.value.ok, true);
    const profile = await state.agentProfiles.create(
      agentProfileInput({
        name: "Claude Reviewer",
        provider: "claude",
        role: "reviewer",
      }),
    );

    const preview = await handlers.previewPipelineDraft({
      packageId: imported.value.definition.id,
      bindings: [
        {
          harnessAgentRef: "reviewer",
          agentProfileId: profile.id,
        },
      ],
      providers: {
        claude: {
          available: false,
          error: "claude unavailable in test",
          queueDepth: 0,
        },
        codex: { available: true, queueDepth: 0 },
      },
    });

    assert.equal(preview.ok, true);
    assert.equal(preview.value.ok, true);
    assert.equal(preview.value.readiness.warningCount, 1);
    assert.deepEqual(
      preview.value.readiness.issues.map((issue) => issue.code),
      ["HARNESS_PROVIDER_UNAVAILABLE"],
    );
  } finally {
    closeDb(db);
    t.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("harnessPackages.previewExport returns declaration-only projection files", async () => {
  const { db, t, handlers } = setup();
  const root = dirTmp();
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

    const imported = await handlers.importDirectory({ rootDir: root });
    assert.equal(imported.ok, true);
    assert.equal(imported.value.ok, true);

    const exported = await handlers.previewExport({
      packageId: imported.value.definition.id,
      targetFormat: "codex",
    });

    assert.equal(exported.ok, true);
    assert.equal(exported.value.targetFormat, "codex");
    assert.deepEqual(
      exported.value.files.map((file) => file.relativePath).sort(),
      ["AGENTS.md", "skills/youtube-production/SKILL.md"],
    );
    assert.ok(exported.value.warnings.length > 0);
  } finally {
    closeDb(db);
    t.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("harnessPackages.proposeExport creates approval-gated file writes", async () => {
  const { db, t, handlers } = setup();
  const root = dirTmp();
  const target = dirTmp();
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
    const imported = await handlers.importDirectory({ rootDir: root });
    assert.equal(imported.ok, true);
    assert.equal(imported.value.ok, true);

    const proposed = await handlers.proposeExport({
      packageId: imported.value.definition.id,
      targetFormat: "harness-native",
      targetDir: target,
    });

    assert.equal(proposed.ok, true);
    assert.equal(proposed.value.taskRun.status, "waiting_for_approval");
    assert.equal(proposed.value.targetDir, target);
    assert.equal(
      proposed.value.approvals.length,
      proposed.value.preview.files.length,
    );
    assert.equal(proposed.value.approvals[0].actionType, "file_write");
  } finally {
    closeDb(db);
    t.cleanup();
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("harnessPackages.previewPipelineDraft returns readiness issues for unbound steps", async () => {
  const { db, t, handlers } = setup();
  const root = dirTmp();
  try {
    await writeFixture(root, ".claude/CLAUDE.md", "# Review");
    await writeFixture(
      root,
      ".claude/agents/reviewer.md",
      "---\nname: reviewer\ndescription: Review.\n---",
    );
    await writeFixture(
      root,
      ".claude/skills/review/skill.md",
      [
        "---",
        "name: review",
        "description: Review workflow.",
        "---",
        "",
        "## Workflow",
        "",
        "| Order | Task | Owner | Depends On | Deliverable |",
        "|-------|------|-------|------------|-------------|",
        "| 1 | Review | reviewer | None | `_workspace/review.md` |",
      ].join("\n"),
    );

    const imported = await handlers.importDirectory({ rootDir: root });
    assert.equal(imported.ok, true);
    assert.equal(imported.value.ok, true);

    const preview = await handlers.previewPipelineDraft({
      packageId: imported.value.definition.id,
      bindings: [],
    });

    assert.equal(preview.ok, true);
    assert.equal(preview.value.ok, false);
    assert.equal(preview.value.readiness.ok, false);
    assert.equal(preview.value.readiness.issues[0].code, "HARNESS_PROFILE_UNBOUND");
    assert.equal(preview.value.issues[0].code, "HARNESS_BINDING_READINESS_FAILED");
  } finally {
    closeDb(db);
    t.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("harnessPackages.repair saves a Harness-owned repaired snapshot", async () => {
  const { db, t, handlers } = setup();
  const root = dirTmp();
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
    const imported = await handlers.importDirectory({ rootDir: root });
    assert.equal(imported.ok, true);
    assert.equal(imported.value.ok, true);
    const definition = imported.value.definition;

    const repaired = await handlers.repair({
      packageId: definition.id,
      note: "Resolved writer owner.",
      workflows: [
        {
          workflowId: definition.workflows[0].id,
          steps: [
            {
              stepId: definition.workflows[0].steps[0].id,
              agentRef: "writer",
            },
          ],
        },
      ],
    });

    assert.equal(repaired.ok, true);
    assert.notEqual(repaired.value.definition.id, definition.id);
    assert.equal(repaired.value.definition.repair.sourcePackageId, definition.id);
    assert.equal(
      repaired.value.definition.workflows[0].steps[0].agentRef,
      "writer",
    );
    assert.equal((await handlers.list()).value.length, 2);
  } finally {
    closeDb(db);
    t.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("harnessPackages.repair validates input and unknown packages", async () => {
  const { db, t, handlers } = setup();
  try {
    const malformed = await handlers.repair({
      packageId: "harness_missing",
      workflows: [],
    });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error.code, "STATE_INVALID_INPUT");

    const missing = await handlers.repair({
      packageId: "harness_missing",
      workflows: [{ workflowId: "workflow" }],
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, "HARNESS_PACKAGE_NOT_FOUND");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("harnessPackages.get and remove reject unknown packages", async () => {
  const { db, t, handlers } = setup();
  try {
    const get = await handlers.get({ packageId: "harness_missing" });
    assert.equal(get.ok, false);
    assert.equal(get.error.code, "HARNESS_PACKAGE_NOT_FOUND");

    const remove = await handlers.remove({ packageId: "harness_missing" });
    assert.equal(remove.ok, false);
    assert.equal(remove.error.code, "HARNESS_PACKAGE_NOT_FOUND");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("harnessPackages.importDirectory validates rootDir input", async () => {
  const { db, t, handlers } = setup();
  try {
    const result = await handlers.importDirectory({ rootDir: "   " });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "STATE_INVALID_INPUT");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("harnessPackages.previewPipelineDraft validates binding input", async () => {
  const { db, t, handlers } = setup();
  try {
    const result = await handlers.previewPipelineDraft({
      packageId: "harness_missing",
      bindings: [
        {
          harnessAgentRef: " ",
          agentProfileId: "profile-reviewer",
        },
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "STATE_INVALID_INPUT");

    const invalidProviders = await handlers.previewPipelineDraft({
      packageId: "harness_missing",
      bindings: [
        {
          harnessAgentRef: "reviewer",
          agentProfileId: "profile-reviewer",
        },
      ],
      providers: {
        claude: { available: false, queueDepth: -1 },
        codex: { available: true, queueDepth: 0 },
      },
    });
    assert.equal(invalidProviders.ok, false);
    assert.equal(invalidProviders.error.code, "STATE_INVALID_INPUT");
    assert.match(invalidProviders.error.message, /providers\.claude\.queueDepth/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

async function writeFixture(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

function agentProfileInput(overrides = {}) {
  return {
    name: "Harness Worker",
    description: "",
    category: "development",
    tags: [],
    provider: "codex",
    role: "planner",
    persona: "",
    tuning: {
      model: "gpt-5.5",
      timeoutMs: 300000,
      stallTimeoutMs: 60000,
      contextDepth: 4,
      systemPromptPrefix: "",
      systemPromptSuffix: "",
    },
    cli: {
      cliPathOverride: "",
      env: {},
      envSecretRefs: {},
    },
    permissions: {
      autoApproveActions: [],
      blockedActions: [],
      allowedSkillIds: [],
      toolAllowlist: [],
      toolDenylist: [],
    },
    mcpServerIds: [],
    skillSourceIds: [],
    isDefault: false,
    ...overrides,
  };
}
