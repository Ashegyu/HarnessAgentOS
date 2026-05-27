import assert from "node:assert/strict";
import test from "node:test";
import { importHarnessPackageFromFiles } from "./harness-import.ts";
import { exportHarnessPackage } from "./harness-package-export.ts";

const IMPORTED_AT = "2026-05-27T00:00:00.000Z";

const sampleDefinition = () => {
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
        relativePath: ".claude/skills/youtube-production/skill.md",
        content: [
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
          "| 2 | Script writing | writer | Task 1 | `_workspace/script.md` |",
        ].join("\n"),
      },
    ],
  });
  assert.equal(result.ok, true);
  return result.definition;
};

test("exportHarnessPackage creates native, Claude, and Codex declaration projections that re-import", () => {
  const definition = sampleDefinition();
  for (const targetFormat of ["harness-native", "claude", "codex"]) {
    const preview = exportHarnessPackage({
      definition,
      targetFormat,
      exportedAt: IMPORTED_AT,
    });
    assert.equal(preview.targetFormat, targetFormat);
    assert.equal(preview.packageId, definition.id);
    assert.ok(preview.files.length > 0);
    assert.ok(
      preview.warnings.some((warning) => /declarations only/i.test(warning)),
    );
    assert.equal(
      preview.files.some((file) => /tsk_|appr_|secret\.write/i.test(file.content)),
      false,
    );

    const imported = importHarnessPackageFromFiles({
      rootDir: `C:/roundtrip/${targetFormat}`,
      importedAt: IMPORTED_AT,
      files: preview.files,
    });
    assert.equal(imported.ok, true);
    assert.equal(imported.definition.source.format, targetFormat);
    assert.ok(imported.definition.workflows.length > 0);
  }
});

test("Codex export flattens Claude agent files into AGENTS guidance", () => {
  const definition = sampleDefinition();
  const preview = exportHarnessPackage({
    definition,
    targetFormat: "codex",
    exportedAt: IMPORTED_AT,
  });

  assert.deepEqual(
    preview.files.map((file) => file.relativePath).sort(),
    ["AGENTS.md", "skills/youtube-production/SKILL.md"],
  );
  const agents = preview.files.find((file) => file.relativePath === "AGENTS.md");
  assert.ok(agents);
  assert.match(agents.content, /content-strategist/);
  assert.match(agents.content, /Bind concrete AgentProfiles/);
});
