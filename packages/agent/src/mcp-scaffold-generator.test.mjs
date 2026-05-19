import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGeneratedMcpServerScaffoldDraft } from "./mcp-scaffold-generator.ts";

test("buildGeneratedMcpServerScaffoldDraft creates a TypeScript stdio MCP scaffold preview", () => {
  const draft = buildGeneratedMcpServerScaffoldDraft({
    userIntent: "Create a repository search MCP server",
    targetDir: "C:\\tmp\\mcp",
  });

  assert.equal(draft.slug, "repository-search");
  assert.equal(draft.targetDir, "C:\\tmp\\mcp");
  assert.deepEqual(
    draft.files.map((file) => file.path),
    [
      "repository-search/package.json",
      "repository-search/tsconfig.json",
      "repository-search/src/index.ts",
      "repository-search/README.md",
      "repository-search/tests/smoke.test.mjs",
    ],
  );
  assert.match(draft.recommendedCommand, /npm install/);
  assert.match(draft.rationale, /approval-gated file proposals/);
});

test("buildGeneratedMcpServerScaffoldDraft keeps stdio server source free of stdout logging", () => {
  const draft = buildGeneratedMcpServerScaffoldDraft({
    userIntent: "Browser MCP",
    targetDir: "/tmp/mcp",
    slug: "browser-tools",
  });
  const source = draft.files.find((file) => file.path.endsWith("src/index.ts"));
  const smoke = draft.files.find((file) =>
    file.path.endsWith("tests/smoke.test.mjs"),
  );

  assert.ok(source);
  assert.ok(smoke);
  assert.doesNotMatch(source.content, /console\.log/);
  assert.match(source.content, /console\.error/);
  assert.match(smoke.content, /console\\.log/);
});

test("buildGeneratedMcpServerScaffoldDraft sanitizes unsafe names and warns for placeholders", () => {
  const draft = buildGeneratedMcpServerScaffoldDraft({
    userIntent: "!!!",
    targetDir: "/tmp/mcp",
    slug: "../bad slug",
  });

  assert.equal(draft.slug, "bad-slug");
  assert.equal(draft.files.every((file) => !file.path.includes("..")), true);
  assert.match(draft.warnings.join("\n"), /placeholder tool implementation/);
});
