import { test } from "node:test";
import assert from "node:assert/strict";
import { isHarnessDefinition } from "@harness/core";
import { importHarnessPackageFromFiles } from "./harness-import.ts";

const IMPORTED_AT = "2026-05-27T00:00:00.000Z";

test("importHarnessPackageFromFiles imports Claude package metadata without execution", () => {
  const result = importHarnessPackageFromFiles({
    rootDir: "C:/sample/youtube-production",
    importedAt: IMPORTED_AT,
    files: [
      {
        relativePath: ".claude/CLAUDE.md",
        content: [
          "# YouTube Production Harness",
          "",
          "YouTube workflow overview.",
        ].join("\n"),
      },
      {
        relativePath: ".claude/agents/content-strategist.md",
        content: [
          "---",
          "name: content-strategist",
          "description: Strategy agent",
          "---",
          "",
          "# Content Strategist",
          "",
          "You define the content strategy.",
        ].join("\n"),
      },
      {
        relativePath: ".claude/skills/youtube-production/skill.md",
        content: [
          "---",
          "name: youtube-production",
          'description: "YouTube production workflow."',
          "---",
          "",
          "# YouTube Production",
        ].join("\n"),
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.detection.status, "detected");
  assert.equal(result.definition.source.format, "claude");
  assert.equal(result.definition.overview.title, "YouTube Production Harness");
  assert.equal(result.definition.agents[0].id, "content-strategist");
  assert.equal(result.definition.skills[0].id, "youtube-production");
  assert.equal(result.definition.validation.status, "needs_review");
  assert.equal(isHarnessDefinition(result.definition), true);
  assert.deepEqual(
    result.definition.source.files.map((file) => file.kind),
    ["overview", "agent", "skill"],
  );
});

test("importHarnessPackageFromFiles imports Codex skill roots", () => {
  const result = importHarnessPackageFromFiles({
    rootDir: "C:/sample/codex-skill",
    importedAt: IMPORTED_AT,
    files: [
      {
        relativePath: "AGENTS.md",
        content: "# Project agents\n\nFollow approval boundaries.",
      },
      {
        relativePath: "skills/performance-optimizer/SKILL.md",
        content: [
          "---",
          "name: performance-optimizer",
          "description: Performance optimization skill.",
          "---",
          "",
          "# Performance Optimizer",
        ].join("\n"),
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.definition.source.format, "codex");
  assert.equal(result.definition.name, "performance-optimizer");
  assert.equal(result.definition.skills.length, 1);
  assert.equal(result.definition.agents.length, 0);
  assert.equal(
    result.definition.validation.issues.some(
      (issue) => issue.code === "HARNESS_AGENTS_MISSING",
    ),
    false,
  );
  assert.equal(isHarnessDefinition(result.definition), true);
});

test("importHarnessPackageFromFiles parses workflow tables from orchestrator skills", () => {
  const result = importHarnessPackageFromFiles({
    rootDir: "C:/sample/youtube-production",
    importedAt: IMPORTED_AT,
    files: [
      { relativePath: ".claude/CLAUDE.md", content: "# YouTube Production" },
      {
        relativePath: ".claude/agents/content-strategist.md",
        content: "---\nname: content-strategist\ndescription: Strategy.\n---",
      },
      {
        relativePath: ".claude/agents/scriptwriter.md",
        content: "---\nname: scriptwriter\ndescription: Script.\n---",
      },
      {
        relativePath: ".claude/agents/thumbnail-designer.md",
        content: "---\nname: thumbnail-designer\ndescription: Thumbnail.\n---",
      },
      {
        relativePath: ".claude/agents/seo-optimizer.md",
        content: "---\nname: seo-optimizer\ndescription: SEO.\n---",
      },
      {
        relativePath: ".claude/agents/production-reviewer.md",
        content: "---\nname: production-reviewer\ndescription: Review.\n---",
      },
      {
        relativePath: ".claude/skills/youtube-production/skill.md",
        content: [
          "---",
          "name: youtube-production",
          "description: YouTube production workflow.",
          "---",
          "",
          "## Execution Mode",
          "",
          "**Agent Team** — 5 members communicate directly via SendMessage.",
          "",
          "## Workflow",
          "",
          "| Order | Task | Owner | Depends On | Deliverable |",
          "|-------|------|-------|------------|-------------|",
          "| 1 | Content strategy | strategist | None | `_workspace/01_strategist_brief.md` |",
          "| 2a | Script writing | writer | Task 1 | `_workspace/02_scriptwriter_script.md` |",
          "| 2b | Thumbnail design | designer | Task 1 | `_workspace/03_thumbnail_concept.md` |",
          "| 3 | SEO package | seo | Tasks 1, 2a | `_workspace/04_seo_package.md`, `_workspace/subtitle.srt` |",
          "| 4 | Production review | reviewer | Tasks 2a, 2b, 3 | `_workspace/05_review_report.md` |",
          "",
          "On Must Fix: request revision from the responsible agent up to 2 rounds.",
        ].join("\n"),
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.definition.workflows.length, 1);
  const workflow = result.definition.workflows[0];
  assert.equal(workflow.mode, "agent-team");
  assert.equal(workflow.steps.length, 5);
  assert.deepEqual(
    workflow.steps.map((step) => step.id),
    ["step-1", "step-2a", "step-2b", "step-3", "step-4"],
  );
  assert.equal(workflow.steps[0].agentRef, "content-strategist");
  assert.equal(workflow.steps[1].agentRef, "scriptwriter");
  assert.equal(workflow.steps[2].agentRef, "thumbnail-designer");
  assert.deepEqual(workflow.steps[1].dependsOn, ["step-1"]);
  assert.deepEqual(workflow.steps[2].dependsOn, ["step-1"]);
  assert.equal(workflow.steps[1].parallelGroup, "order-2");
  assert.equal(workflow.steps[2].parallelGroup, "order-2");
  assert.deepEqual(workflow.steps[3].dependsOn, ["step-1", "step-2a"]);
  assert.equal(workflow.steps[3].artifactContracts.length, 2);
  assert.equal(
    workflow.steps[3].artifactContracts[1].pathHint,
    "_workspace/subtitle.srt",
  );
  assert.equal(workflow.failurePolicy.maxAttempts, 2);
  assert.equal(workflow.handoffPolicy.routes.length, 7);
  assert.equal(
    result.definition.validation.issues.some(
      (issue) => issue.code === "HARNESS_WORKFLOW_PARSE_PENDING",
    ),
    false,
  );
  assert.equal(
    result.definition.validation.issues.some(
      (issue) => issue.code === "HARNESS_PROFILE_BINDING_REQUIRED",
    ),
    true,
  );
  assert.equal(isHarnessDefinition(result.definition), true);
});

test("importHarnessPackageFromFiles parses aliased and Korean workflow table headers", () => {
  const result = importHarnessPackageFromFiles({
    rootDir: "C:/sample/game-narrative-ko",
    importedAt: IMPORTED_AT,
    files: [
      { relativePath: ".claude/CLAUDE.md", content: "# 게임 내러티브" },
      {
        relativePath: ".claude/agents/worldbuilder.md",
        content: "---\nname: worldbuilder\ndescription: World.\n---",
      },
      {
        relativePath: ".claude/agents/quest-designer.md",
        content: "---\nname: quest-designer\ndescription: Quest.\n---",
      },
      {
        relativePath: ".claude/agents/narrative-reviewer.md",
        content: "---\nname: narrative-reviewer\ndescription: Review.\n---",
      },
      {
        relativePath: ".claude/skills/game-narrative/skill.md",
        content: [
          "---",
          "name: game-narrative",
          "description: 게임 내러티브 워크플로우.",
          "---",
          "",
          "## 워크플로우",
          "",
          "### Phase 2: 팀 구성 및 실행",
          "",
          "| 순서 | 작업 | 담당 | 의존 | 산출물 |",
          "|------|------|------|------|--------|",
          "| 1 | 세계관 설계 | worldbuilder | 없음 | `_workspace/01_worldbuilding.md` |",
          "| 2 | 퀘스트 설계 | quest-designer | 작업 1 | `_workspace/02_quest_design.md` |",
          "| 3 | 내러티브 검증 | narrative-reviewer | 작업 1, 2 | `_workspace/03_review.md` |",
        ].join("\n"),
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.definition.workflows.length, 1);
  const workflow = result.definition.workflows[0];
  assert.equal(workflow.mode, "agent-team");
  assert.deepEqual(
    workflow.steps.map((step) => step.agentRef),
    ["worldbuilder", "quest-designer", "narrative-reviewer"],
  );
  assert.deepEqual(workflow.steps[1].dependsOn, ["step-1"]);
  assert.deepEqual(workflow.steps[2].dependsOn, ["step-1", "step-2"]);
  assert.equal(workflow.steps[0].artifactContracts[0].pathHint, "_workspace/01_worldbuilding.md");
  assert.equal(
    result.definition.validation.issues.some(
      (issue) => issue.code === "HARNESS_WORKFLOW_PARSE_PENDING",
    ),
    false,
  );
  assert.equal(isHarnessDefinition(result.definition), true);
});

test("importHarnessPackageFromFiles recovers positional workflow tables and dependency ranges", () => {
  const result = importHarnessPackageFromFiles({
    rootDir: "C:/sample/performance-optimizer",
    importedAt: IMPORTED_AT,
    files: [
      { relativePath: ".claude/CLAUDE.md", content: "# Performance" },
      {
        relativePath: ".claude/agents/profiler.md",
        content: "---\nname: profiler\ndescription: Profile.\n---",
      },
      {
        relativePath: ".claude/agents/benchmark-manager.md",
        content: "---\nname: benchmark-manager\ndescription: Benchmark.\n---",
      },
      {
        relativePath: ".claude/agents/perf-reviewer.md",
        content: "---\nname: perf-reviewer\ndescription: Review.\n---",
      },
      {
        relativePath: ".claude/skills/performance-optimizer/skill.md",
        content: [
          "---",
          "name: performance-optimizer",
          "description: Performance workflow.",
          "---",
          "",
          "## workflow",
          "",
          "|  |  | responsible | of |  |",
          "|------|------|------|------|--------|",
          "| 1 | profiling | profiler |  | `_workspace/01_profiling.md` |",
          "| 2 | benchmark | benchmark-manager | 1 | `_workspace/02_benchmark.md` |",
          "| 3 | review | perf-reviewer | 1~2 | `_workspace/03_review.md` |",
          "| 4 | summary | 오케스트레이터 | All | `_workspace/04_summary.md` |",
        ].join("\n"),
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.definition.workflows.length, 1);
  const steps = result.definition.workflows[0].steps;
  assert.equal(steps[0].agentRef, "profiler");
  assert.equal(steps[2].agentRef, "perf-reviewer");
  assert.deepEqual(steps[2].dependsOn, ["step-1", "step-2"]);
  assert.equal(steps[3].roleHint, "orchestrator");
  assert.deepEqual(steps[3].dependsOn, ["step-1", "step-2", "step-3"]);
  assert.equal(
    result.definition.validation.issues.some(
      (issue) => issue.code === "HARNESS_AGENT_REFERENCE_UNRESOLVED",
    ),
    false,
  );
});

test("importHarnessPackageFromFiles does not treat action-register tables as workflows", () => {
  const result = importHarnessPackageFromFiles({
    rootDir: "C:/sample/risk-response-patterns",
    importedAt: IMPORTED_AT,
    files: [
      { relativePath: ".claude/CLAUDE.md", content: "# Risk" },
      {
        relativePath: ".claude/skills/risk-response-patterns/skill.md",
        content: [
          "---",
          "name: risk-response-patterns",
          "description: Risk response patterns.",
          "---",
          "",
          "## Response Register",
          "",
          "| # | action | responsible | deadline | cost | status |",
          "|---|--------|-------------|----------|------|--------|",
          "| 1 | [action] | [name] | [date] | [amount] | progress |",
          "| 2 | [action] | [name] | [date] | [amount] | pending |",
        ].join("\n"),
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.definition.workflows.length, 0);
  assert.equal(
    result.definition.validation.issues.some(
      (issue) => issue.code === "HARNESS_WORKFLOW_PARSE_PENDING",
    ),
    true,
  );
});

test("importHarnessPackageFromFiles imports Harness-native packages", () => {
  const result = importHarnessPackageFromFiles({
    rootDir: "C:/sample/native",
    importedAt: IMPORTED_AT,
    files: [
      {
        relativePath: ".harness/HARNESS.md",
        content: "# Native Harness\n\nNeutral package overview.",
      },
      {
        relativePath: ".harness/skills/review/SKILL.md",
        content: "---\nname: review\ndescription: Review skill.\n---\n# Review",
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.definition.source.format, "harness-native");
  assert.equal(result.definition.overview.title, "Native Harness");
  assert.equal(isHarnessDefinition(result.definition), true);
});

test("importHarnessPackageFromFiles reports ambiguous source packages", () => {
  const result = importHarnessPackageFromFiles({
    rootDir: "C:/sample/ambiguous",
    files: [
      { relativePath: ".claude/CLAUDE.md", content: "# Claude" },
      {
        relativePath: ".claude/skills/demo/skill.md",
        content: "---\nname: demo\ndescription: Demo.\n---",
      },
      { relativePath: "AGENTS.md", content: "# Codex" },
      {
        relativePath: "skills/demo/SKILL.md",
        content: "---\nname: demo\ndescription: Demo.\n---",
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.detection.status, "ambiguous");
  assert.equal(result.issues[0].code, "HARNESS_SOURCE_AMBIGUOUS");
});

test("importHarnessPackageFromFiles preserves missing description warnings", () => {
  const result = importHarnessPackageFromFiles({
    rootDir: "C:/sample/missing-description",
    importedAt: IMPORTED_AT,
    files: [
      { relativePath: ".claude/CLAUDE.md", content: "# Missing Description" },
      {
        relativePath: ".claude/skills/demo/skill.md",
        content: "---\nname: demo\n---\n# Demo",
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.definition.skills[0].description, "");
  assert.equal(
    result.definition.validation.issues.some(
      (issue) => issue.code === "HARNESS_SKILL_DESCRIPTION_MISSING",
    ),
    true,
  );
  assert.equal(
    result.definition.validation.issues.some(
      (issue) => issue.code === "HARNESS_WORKFLOW_PARSE_PENDING",
    ),
    true,
  );
});
