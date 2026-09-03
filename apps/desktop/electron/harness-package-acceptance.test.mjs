import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { test } from "node:test";
import { TaskRunCompletionService } from "@harness/core";
import {
  HarnessPackageService,
  OrchestrationService,
  convertHarnessWorkflowToPipelineDraft,
} from "@harness/orchestration";
import { QualityEvaluator } from "@harness/quality";
import { closeDb, LocalStateService, openDb } from "@harness/storage";

const dbTmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-hpkg-accept-db-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const dirTmp = () => mkdtempSync(join(tmpdir(), "hgos-hpkg-accept-dir-"));

const writeFixture = async (root, relativePath, content) => {
  const fullPath = path.join(root, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
};

const seedTaskRun = async (state, targetDir) => {
  const thread = await state.createThread({
    title: "Harness package acceptance",
    targetDir,
  });
  return state.createTaskRun({
    threadId: thread.id,
    userRequest:
      "Plan a 10-minute YouTube video about AI prompt engineering for beginners.",
    targetDir,
    status: "running",
  });
};

const validProfileInput = (overrides = {}) => ({
  name: "HarnessWorker",
  description: "",
  category: "harness-package-acceptance",
  tags: ["harness-package"],
  provider: "codex",
  role: "coder",
  persona: "",
  tuning: {
    model: "gpt-5.6-sol",
    timeoutMs: 300_000,
    stallTimeoutMs: 60_000,
    contextDepth: 5,
    systemPromptPrefix: "",
    systemPromptSuffix: "",
  },
  cli: { cliPathOverride: "", env: {}, envSecretRefs: {} },
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
});

const writeYoutubeHarnessFixture = async (root) => {
  await writeFixture(
    root,
    ".claude/CLAUDE.md",
    [
      "# YouTube Production Harness",
      "",
      "A harness-100 style package where an agent team collaborates through strategy, script, thumbnail, SEO, and review.",
      "",
      "## Deliverables",
      "",
      "- `_workspace/01_strategist_brief.md`",
      "- `_workspace/02_scriptwriter_script.md`",
      "- `_workspace/03_thumbnail_concept.md`",
      "- `_workspace/04_seo_package.md`",
      "- `_workspace/05_review_report.md`",
    ].join("\n"),
  );
  await writeFixture(
    root,
    ".claude/agents/content-strategist.md",
    "---\nname: content-strategist\ndescription: Content strategy.\n---\n",
  );
  await writeFixture(
    root,
    ".claude/agents/scriptwriter.md",
    "---\nname: scriptwriter\ndescription: Script writing.\n---\n",
  );
  await writeFixture(
    root,
    ".claude/agents/thumbnail-designer.md",
    "---\nname: thumbnail-designer\ndescription: Thumbnail concept.\n---\n",
  );
  await writeFixture(
    root,
    ".claude/agents/seo-optimizer.md",
    "---\nname: seo-optimizer\ndescription: SEO package.\n---\n",
  );
  await writeFixture(
    root,
    ".claude/agents/production-reviewer.md",
    "---\nname: production-reviewer\ndescription: Production review.\n---\n",
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
      "# YouTube Production",
      "",
      "## Execution Mode",
      "",
      "**Agent Team**",
      "",
      "## Workflow",
      "",
      "| Order | Task | Owner | Depends On | Deliverable |",
      "|-------|------|-------|------------|-------------|",
      "| 1 | Content strategy | strategist | None | `_workspace/01_strategist_brief.md` |",
      "| 2a | Script writing | writer | Task 1 | `_workspace/02_scriptwriter_script.md` |",
      "| 2b | Thumbnail design & generation | designer | Task 1 | `_workspace/03_thumbnail_concept.md` |",
      "| 3 | SEO package | seo | Tasks 1, 2a | `_workspace/04_seo_package.md`, `_workspace/subtitle.srt` |",
      "| 4 | Production review | reviewer | Tasks 2a, 2b, 3 | `_workspace/05_review_report.md` |",
    ].join("\n"),
  );
};

test("package-derived harness pipeline runs only after approval and yields artifacts, handoffs, and a quality gate", async () => {
  const t = dbTmp();
  const root = dirTmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    await writeYoutubeHarnessFixture(root);
    const harnessPackages = new HarnessPackageService({ state });
    const imported = await harnessPackages.importDirectory({
      rootDir: root,
      importedAt: "2026-05-27T00:00:00.000Z",
    });
    assert.equal(imported.ok, true);
    assert.equal(imported.definition.source.format, "claude");
    assert.equal((await harnessPackages.listPackages()).length, 1);

    const profiles = {
      "content-strategist": await state.agentProfiles.create(
        validProfileInput({ name: "Strategist", role: "planner" }),
      ),
      scriptwriter: await state.agentProfiles.create(
        validProfileInput({ name: "Writer", role: "coder" }),
      ),
      "thumbnail-designer": await state.agentProfiles.create(
        validProfileInput({ name: "Designer", role: "coder" }),
      ),
      "seo-optimizer": await state.agentProfiles.create(
        validProfileInput({ name: "Seo", role: "reviewer" }),
      ),
      "production-reviewer": await state.agentProfiles.create(
        validProfileInput({ name: "Reviewer", role: "reviewer" }),
      ),
    };
    const draft = convertHarnessWorkflowToPipelineDraft({
      definition: imported.definition,
      bindings: Object.entries(profiles).map(([harnessAgentRef, profile]) => ({
        harnessAgentRef,
        agentProfileId: profile.id,
      })),
    });
    assert.equal(draft.ok, true);
    assert.equal(draft.pipeline.steps.length, 5);

    const pipeline = await state.agentPipelines.create(draft.pipeline);
    const taskRun = await seedTaskRun(state, root);
    const invocations = [];
    const orchestration = new OrchestrationService({
      state,
      enabled: () => true,
      agentPlanning: {
        async invokeForWorker(input) {
          invocations.push({
            profileName: input.profile.name,
            userRequest: input.userRequest,
            handoffMessages: input.handoffMessages ?? [],
          });
          return { outputText: workerOutputForProfile(input.profile.name) };
        },
      },
    });

    const draftedPlan = await orchestration.draftPlan({
      taskRunId: taskRun.id,
      mode: "multi_worker",
      pipelineId: pipeline.id,
    });
    assert.equal(draftedPlan.plan.sourcePipelineId, pipeline.id);
    assert.equal(draftedPlan.approval.actionType, "orchestration_plan");
    assert.equal(draftedPlan.approval.status, "pending");
    assert.equal(invocations.length, 0, "workers must not run before approval");

    await state.decideApproval(draftedPlan.approval.id, "approved");
    const run = await orchestration.runApproved({
      approvalId: draftedPlan.approval.id,
    });

    assert.equal(run.taskRunId, taskRun.id);
    assert.equal(run.workerSteps.length, 5);
    assert.equal(
      run.workerSteps.every((step) => step.status === "succeeded"),
      true,
    );
    assert.equal(invocations.length, 5);

    const callsByProfile = new Map(
      invocations.map((call) => [call.profileName, call]),
    );
    assert.equal(callsByProfile.get("Strategist")?.handoffMessages.length, 0);
    assert.match(
      callsByProfile.get("Writer")?.handoffMessages[0]?.content ?? "",
      /Strategy brief complete/,
    );
    assert.match(
      callsByProfile.get("Designer")?.handoffMessages[0]?.content ?? "",
      /Strategy brief complete/,
    );
    assert.match(
      callsByProfile.get("Seo")?.handoffMessages.map((m) => m.content).join("\n") ?? "",
      /Script draft complete/,
    );
    assert.equal(callsByProfile.get("Reviewer")?.handoffMessages.length, 3);
    assert.match(
      callsByProfile.get("Reviewer")?.handoffMessages.map((m) => m.content).join("\n") ?? "",
      /SEO package complete/,
    );

    const artifacts = await state.listArtifactsByTaskRun(taskRun.id);
    assert.ok(
      artifacts.some((a) => a.kind === "orchestration_plan"),
      "plan artifact must be persisted for approval recovery",
    );
    const workerArtifacts = artifacts.filter((a) =>
      a.title.startsWith("Worker output:"),
    );
    assert.equal(workerArtifacts.length, 5);
    assert.ok(
      workerArtifacts.some((a) =>
        (a.summary ?? "").includes(
          `**Source package**: ${imported.definition.name}`,
        ),
      ),
      "worker artifacts must expose source package metadata",
    );

    const approval = await state.getApproval(draftedPlan.approval.id);
    assert.equal(approval?.status, "executed");
    assert.equal((await state.getTaskRun(taskRun.id))?.status, "ready_for_review");

    const gate = await new QualityEvaluator({ state }).evaluate({
      taskRunId: taskRun.id,
      requireBuild: true,
    });
    assert.equal(gate.status, "passed");
    assert.equal(gate.buildPassed, true);
    assert.equal(gate.knownRisks.length, 0);
    await new TaskRunCompletionService({ state }).applyQualityGateResult(gate);
    assert.equal(
      (await state.getLatestQualityGateResult(taskRun.id))?.id,
      gate.id,
    );
    assert.equal((await state.getTaskRun(taskRun.id))?.status, "ready_for_review");
  } finally {
    closeDb(db);
    t.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

const workerOutputForProfile = (profileName) => {
  switch (profileName) {
    case "Strategist":
      return "Strategy brief complete. build exit=0";
    case "Writer":
      return "Script draft complete.";
    case "Designer":
      return "Thumbnail concept complete.";
    case "Seo":
      return "SEO package complete.";
    case "Reviewer":
      return "Review report complete.";
    default:
      return `${profileName} complete.`;
  }
};
